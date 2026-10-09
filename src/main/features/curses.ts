import type { ChatMessage, Curse, CurseSettings, CurseState, CurseStep, OverlayMessage } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';
import type { StageDeps } from './stage';
import { assertNoOtherNumberVote } from './chatVotes';

/** What a curse can change in OBS. Each call returns the previous value so it can be undone. */
export interface CurseObs {
  setFilterEnabled(source: string, filter: string, enabled: boolean): Promise<boolean>;
  setSourceVisible(scene: string, source: string, visible: boolean): Promise<boolean>;
  setMute(input: string, muted: boolean): Promise<boolean>;
}

/** "2", "#2", "2!" → 2. Only small numbers, anything else is chat. */
export function parseVote(text: string, max: number): number | null {
  const m = /^\s*#?(\d{1,2})\s*!*\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

/** Shuffle copy (Fisher–Yates). */
export function shuffled<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function stepReady(step: CurseStep): boolean {
  switch (step.type) {
    case 'filter': return !!step.source.trim() && !!step.filter.trim();
    case 'source': return !!step.source.trim();
    case 'mute': return !!step.input.trim();
  }
}

/**
 * Chat votes which handicap the streamer gets: muted game, black-and-white screen, no camera,
 * or a plain challenge. Every OBS change is recorded and undone when the curse ends.
 */
export class CurseService {
  private votes = new Map<string, number>();
  private voteTimer: NodeJS.Timeout | null = null;
  private liftTimer: NodeJS.Timeout | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private undo: (() => Promise<unknown>)[] = [];
  private lastFinishedAt = Date.now();

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private obs: CurseObs,
    private rand: () => number = Math.random,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => { if (key === 'curses' || key === 'language') this.push(); });
    ctx.bus.on('event', (e) => {
      const title = this.cfg.redemptionTitle.trim().toLowerCase();
      if (e.type !== 'redemption' || !title || e.rewardTitle.trim().toLowerCase() !== title) return;
      try { this.startVote(); } catch { /* a curse is already running: the redemption just doesn't stack */ }
    });
    this.autoTimer = setInterval(() => this.autoTick(), 30_000);
  }

  private get cfg(): CurseSettings {
    return this.ctx.settings.get('curses');
  }

  private get state(): CurseState {
    return this.ctx.state.current.curse;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  overlayMessage(): OverlayMessage {
    return { type: 'curse', curse: this.state, style: this.cfg, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  private autoTick(): void {
    const every = this.cfg.autoEveryMin;
    if (every <= 0 || this.state.status !== 'idle' || !this.ctx.state.current.stream.live) return;
    if (Date.now() - this.lastFinishedAt < every * 60_000) return;
    try { this.startVote(); } catch { /* no curses enabled */ }
  }

  startVote(): void {
    if (this.state.status === 'active') throw new Error(this.ru ? 'Сначала закончится текущее проклятие' : 'Wait for the current curse to end');
    if (this.state.status === 'voting') return;
    assertNoOtherNumberVote(this.ctx.state.current, 'curse', this.ru);
    const pool = this.cfg.curses.filter((c) => c.enabled && c.name.trim());
    if (!pool.length) throw new Error(this.ru ? 'Включите хотя бы одно проклятие' : 'Enable at least one curse');
    const picked = shuffled(pool, this.rand).slice(0, Math.max(1, Math.min(5, this.cfg.choices)));
    const endsAt = Date.now() + Math.max(5, this.cfg.voteSec) * 1000;
    this.votes.clear();
    this.ctx.state.replace('curse', {
      status: 'voting',
      options: picked.map((c) => ({ id: c.id, name: c.name, description: c.description, durationSec: c.durationSec, votes: 0 })),
      total: 0, endsAt, active: null, lastError: null,
    });
    this.push();
    this.clear('vote');
    this.voteTimer = setTimeout(() => void this.finishVote(), endsAt - Date.now());
    if (this.cfg.announce) {
      const list = picked.map((c, i) => `${i + 1} — ${c.name}`).join(' · ');
      void this.deps.say(this.ru ? `😈 Выбираем проклятие для стримера! Пишите номер: ${list}` : `😈 Pick a curse for the streamer! Type a number: ${list}`);
    }
  }

  cancel(): void {
    if (this.state.status !== 'voting') return;
    this.clear('vote');
    this.votes.clear();
    this.ctx.state.replace('curse', { ...this.state, status: 'idle', options: [], total: 0, endsAt: null });
    this.push();
  }

  private onChat(m: ChatMessage): void {
    if (this.state.status !== 'voting' || m.fromSelf) return;
    const n = parseVote(m.text, this.state.options.length);
    if (n === null) return;
    this.votes.set(`${m.platform}:${m.userId}`, n - 1);
    const counts = this.state.options.map(() => 0);
    for (const i of this.votes.values()) counts[i]++;
    this.ctx.state.replace('curse', { ...this.state, options: this.state.options.map((o, i) => ({ ...o, votes: counts[i] })), total: this.votes.size });
    this.schedulePush();
  }

  /** Most votes wins; a tie (or silence) is settled by chance. */
  async finishVote(): Promise<void> {
    if (this.state.status !== 'voting') return;
    this.clear('vote');
    const options = this.state.options;
    const best = Math.max(...options.map((o) => o.votes));
    const leaders = options.filter((o) => o.votes === best);
    const winner = leaders[Math.floor(this.rand() * leaders.length)];
    await this.apply(winner.id);
  }

  /** Put a curse on right away (the streamer's own pick, or the vote result). */
  async apply(curseId: string): Promise<void> {
    if (this.state.status === 'active') throw new Error(this.ru ? 'Проклятие уже действует' : 'A curse is already active');
    const curse = this.cfg.curses.find((c) => c.id === curseId);
    if (!curse) throw new Error('Curse not found');
    this.clear('vote');
    const errors = await this.runSteps(curse);
    const startedAt = Date.now();
    const endsAt = startedAt + Math.max(10, curse.durationSec) * 1000;
    this.ctx.state.replace('curse', {
      ...this.state,
      status: 'active',
      endsAt,
      active: { id: curse.id, name: curse.name, description: curse.description, startedAt, endsAt },
      lastError: errors.length ? errors.join('; ') : null,
    });
    this.push();
    this.clear('lift');
    this.liftTimer = setTimeout(() => void this.lift(), endsAt - Date.now());
    if (this.cfg.announce) {
      const min = Math.round(curse.durationSec / 6) / 10;
      void this.deps.say(this.ru ? `😈 Проклятие «${curse.name}» на ${min} мин.! ${curse.description}` : `😈 Curse "${curse.name}" for ${min} min! ${curse.description}`);
    }
  }

  private async runSteps(curse: Curse): Promise<string[]> {
    const errors: string[] = [];
    this.undo = [];
    for (const step of curse.steps) {
      if (!stepReady(step)) {
        errors.push(this.ru ? 'шаг не настроен' : 'a step is not set up');
        continue;
      }
      try {
        switch (step.type) {
          case 'filter': {
            const was = await this.obs.setFilterEnabled(step.source, step.filter, true);
            this.undo.push(() => this.obs.setFilterEnabled(step.source, step.filter, was));
            break;
          }
          case 'source': {
            const was = await this.obs.setSourceVisible(step.scene, step.source, step.show);
            this.undo.push(() => this.obs.setSourceVisible(step.scene, step.source, was));
            break;
          }
          case 'mute': {
            const was = await this.obs.setMute(step.input, true);
            this.undo.push(() => this.obs.setMute(step.input, was));
            break;
          }
        }
      } catch (err) {
        errors.push(errorMessage(err));
      }
    }
    return errors;
  }

  /** End the curse early or on time: undo every OBS change in reverse order. */
  async lift(): Promise<void> {
    this.clear('lift');
    const undo = this.undo.reverse();
    this.undo = [];
    const errors: string[] = [];
    for (const fn of undo) {
      try { await fn(); } catch (err) { errors.push(errorMessage(err)); }
    }
    const was = this.state.active;
    this.lastFinishedAt = Date.now();
    this.ctx.state.replace('curse', { status: 'idle', options: [], total: 0, endsAt: null, active: null, lastError: errors.length ? errors.join('; ') : null });
    this.push();
    if (was && this.cfg.announce) void this.deps.say(this.ru ? `✨ Проклятие «${was.name}» снято!` : `✨ The "${was.name}" curse is lifted!`);
  }

  private clear(which: 'vote' | 'lift'): void {
    if (which === 'vote' && this.voteTimer) { clearTimeout(this.voteTimer); this.voteTimer = null; }
    if (which === 'lift' && this.liftTimer) { clearTimeout(this.liftTimer); this.liftTimer = null; }
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; this.push(); }, 200);
  }

  private push(): void {
    this.deps.broadcast('curse', this.overlayMessage());
  }

  /** A curse changed OBS: quitting has to undo it first. */
  get needsShutdown(): boolean {
    return this.state.status === 'active' && this.undo.length > 0;
  }

  /** Quitting mid-curse must not leave the game muted: undo while OBS is still connected. */
  async shutdown(): Promise<void> {
    if (this.state.status === 'active') await this.lift();
  }

  dispose(): void {
    this.clear('vote');
    this.clear('lift');
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
