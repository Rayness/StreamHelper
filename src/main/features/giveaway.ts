import { renderTemplate } from '@shared/template';
import type { ChatMessage, GiveawayEntrant, GiveawayOverlayState, GiveawaySettings, GiveawayState } from '@shared/types';
import { hasPermission } from '../bot/permissions';
import type { AppContext } from '../core/context';
import { normalizeText, pickWeighted, type StageDeps } from './stage';

/** How long the overlay shuffles names before revealing the winner. */
export const ROLL_MS = 4500;
const PUSH_THROTTLE_MS = 400;
const WINNER_MESSAGES = 10;

/** Does this chat line enter the giveaway? Exact keyword, optionally followed by more words. */
export function isEntry(text: string, keyword: string): boolean {
  const k = normalizeText(keyword);
  if (!k) return false;
  const t = normalizeText(text);
  return t === k || t.startsWith(k + ' ');
}

export class GiveawayService {
  private rollTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private rand: () => number = Math.random,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => key === 'giveaway' && this.pushNow());
  }

  private get state(): GiveawayState {
    return this.ctx.state.current.giveaway;
  }

  private get cfg(): GiveawaySettings {
    return this.ctx.settings.get('giveaway');
  }

  private set(patch: Partial<GiveawayState>): void {
    this.ctx.state.replace('giveaway', { ...this.state, ...patch });
  }

  overlayMessage() {
    const s = this.state;
    const shown = s.status === 'rolling' || s.status === 'done' ? s.winner : null;
    // A sample of names is enough for the shuffle; thousands of entrants don't need to cross the socket.
    const names = [...s.entrants]
      .sort(() => this.rand() - 0.5)
      .slice(0, 40)
      .map((e) => e.userName);
    if (shown && !names.includes(shown.userName)) names.push(shown.userName);
    const state: GiveawayOverlayState = { status: s.status, count: s.entrants.length, names, winner: s.status === 'done' ? (s.winner?.userName ?? null) : null };
    return { type: 'giveaway' as const, state, style: this.cfg, lang: this.ctx.settings.get('language') };
  }

  open(): void {
    if (!normalizeText(this.cfg.keyword)) throw new Error('set a keyword first');
    this.clearRoll();
    this.ctx.state.replace('giveaway', { status: 'open', entrants: [], winner: null, winnerMessages: [] });
    this.pushNow();
    if (this.cfg.announceOpen.trim()) void this.deps.say(renderTemplate(this.cfg.announceOpen, { keyword: this.cfg.keyword, title: this.cfg.title }));
  }

  close(): void {
    if (this.state.status !== 'open') return;
    this.set({ status: 'closed' });
    this.pushNow();
  }

  /** Pick a winner. Rolling again after a win re-rolls without the previous winner. */
  roll(): void {
    const s = this.state;
    if (s.status === 'rolling') return;
    const pool = s.status === 'done' && s.winner ? s.entrants.filter((e) => e.userId !== s.winner!.userId) : s.entrants;
    const i = pickWeighted(pool, (e) => e.tickets, this.rand);
    if (i < 0) throw new Error('no entrants');
    const winner = pool[i];
    this.set({ status: 'rolling', entrants: pool, winner, winnerMessages: [] });
    this.pushNow();
    this.rollTimer = setTimeout(() => {
      this.rollTimer = null;
      this.set({ status: 'done' });
      this.pushNow();
      this.ctx.toast('success', 'toast.giveawayWinner', { name: winner.userName });
      if (this.cfg.announceWinner.trim()) void this.deps.say(renderTemplate(this.cfg.announceWinner, { winner: winner.userName, user: winner.userName, title: this.cfg.title }));
    }, ROLL_MS);
  }

  reset(): void {
    this.clearRoll();
    this.ctx.state.replace('giveaway', { status: 'idle', entrants: [], winner: null, winnerMessages: [] });
    this.pushNow();
  }

  private onChat(m: ChatMessage): void {
    if (m.fromSelf) return;
    const s = this.state;
    if (s.status === 'done' && s.winner && s.winner.userId === m.userId && s.winner.platform === m.platform) {
      this.set({ winnerMessages: [...s.winnerMessages, { text: m.text, at: m.timestamp }].slice(-WINNER_MESSAGES) });
      return;
    }
    if (s.status !== 'open' || m.roles.broadcaster) return;
    if (!isEntry(m.text, this.cfg.keyword) || !hasPermission(m.roles, this.cfg.eligible)) return;
    if (s.entrants.some((e) => e.userId === m.userId && e.platform === m.platform)) return;
    const entrant: GiveawayEntrant = {
      userId: m.userId,
      userName: m.userName,
      platform: m.platform,
      tickets: m.roles.subscriber ? Math.max(1, this.cfg.subLuck) : 1,
    };
    this.set({ entrants: [...s.entrants, entrant] });
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushNow();
    }, PUSH_THROTTLE_MS);
  }

  private pushNow(): void {
    this.deps.broadcast('giveaway', this.overlayMessage());
  }

  private clearRoll(): void {
    if (this.rollTimer) clearTimeout(this.rollTimer);
    this.rollTimer = null;
  }

  dispose(): void {
    this.clearRoll();
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
