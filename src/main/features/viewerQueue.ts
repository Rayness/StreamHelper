import type { ChatMessage, OverlayMessage, QueueEntry, ViewerQueueSettings, ViewerQueueState } from '@shared/types';
import { hasPermission } from '../bot/permissions';
import { parseCommand } from '../bot/variables';
import type { AppContext } from '../core/context';
import type { StageDeps } from './stage';

const PICKED_HISTORY = 10;

/** Where a new entrant goes: at the end, or after the last subscriber when subs have priority. */
export function insertEntry(entries: QueueEntry[], entry: QueueEntry, subPriority: boolean): QueueEntry[] {
  if (!subPriority || !entry.sub) return [...entries, entry];
  const firstNonSub = entries.findIndex((e) => !e.sub);
  if (firstNonSub < 0) return [...entries, entry];
  return [...entries.slice(0, firstNonSub), entry, ...entries.slice(firstNonSub)];
}

/** "Play with viewers" queue: chat joins with a command, the streamer takes the next one (or a random one). */
export class ViewerQueueService {
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private rand: () => number = Math.random,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'viewerQueue' || key === 'language' || key === 'bot') this.push();
    });
  }

  private get cfg(): ViewerQueueSettings {
    return this.ctx.settings.get('viewerQueue');
  }

  private get state(): ViewerQueueState {
    return this.ctx.state.current.viewerQueue;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  private set(patch: Partial<ViewerQueueState>): void {
    this.ctx.state.replace('viewerQueue', { ...this.state, ...patch });
    this.schedulePush();
  }

  overlayMessage(): OverlayMessage {
    return { type: 'queue', state: this.state, style: this.cfg, lang: this.ctx.settings.get('language'), prefix: this.ctx.settings.get('bot').prefix };
  }

  setOpen(open: boolean): void {
    if (this.state.open === open) return;
    this.set({ open });
    this.push();
    if (this.cfg.announce) {
      const cmd = `${this.ctx.settings.get('bot').prefix}${this.cfg.joinCommand}`;
      void this.deps.say(open
        ? (this.ru ? `Очередь открыта! Пишите ${cmd}, чтобы записаться` : `The queue is open! Type ${cmd} to join`)
        : (this.ru ? 'Запись в очередь закрыта' : 'The queue is closed'));
    }
  }

  /** Take the first viewer in line (or a random one). Returns who was picked. */
  next(random = false): QueueEntry | null {
    const entries = this.state.entries;
    if (!entries.length) throw new Error(this.ru ? 'Очередь пуста' : 'The queue is empty');
    const index = random ? Math.floor(this.rand() * entries.length) : 0;
    const picked = entries[index];
    this.set({ entries: entries.filter((_, i) => i !== index), picked: [picked, ...this.state.picked].slice(0, PICKED_HISTORY) });
    this.push();
    if (this.cfg.announce) void this.deps.say(this.ru ? `@${picked.userName}, твоя очередь!` : `@${picked.userName}, you're up!`);
    return picked;
  }

  remove(userId: string): void {
    this.set({ entries: this.state.entries.filter((e) => e.userId !== userId) });
  }

  clear(): void {
    this.set({ entries: [], picked: [] });
    this.push();
  }

  private onChat(m: ChatMessage): void {
    if (m.fromSelf) return;
    const parsed = parseCommand(m.text, this.ctx.settings.get('bot').prefix);
    if (!parsed) return;
    const cfg = this.cfg;
    const is = (cmd: string) => !!cmd.trim() && cmd.trim().toLowerCase() === parsed.name;
    if (is(cfg.leaveCommand)) {
      if (this.state.entries.some((e) => e.userId === m.userId)) this.remove(m.userId);
      return;
    }
    if (!is(cfg.joinCommand) || !this.state.open || !hasPermission(m.roles, cfg.eligible)) return;
    const entries = this.state.entries;
    const at = entries.findIndex((e) => e.userId === m.userId && e.platform === m.platform);
    if (at >= 0) {
      if (cfg.announce) void this.deps.say(this.ru ? `@${m.userName}, ты уже в очереди: ${at + 1}-й` : `@${m.userName}, you're already in line: #${at + 1}`);
      return;
    }
    if (cfg.maxSize > 0 && entries.length >= cfg.maxSize) return;
    const entry: QueueEntry = { userId: m.userId, userName: m.userName, platform: m.platform, sub: m.roles.subscriber, joinedAt: m.timestamp };
    this.set({ entries: insertEntry(entries, entry, cfg.subPriority) });
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.push();
    }, 250);
  }

  private push(): void {
    this.deps.broadcast('queue', this.overlayMessage());
  }

  dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
