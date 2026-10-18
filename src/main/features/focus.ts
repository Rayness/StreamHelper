import type { ChatMessage, FocusPhase, FocusSettings, FocusState, OverlayMessage, StreamEvent } from '@shared/types';
import { renderTemplate } from '@shared/template';
import { resolveStreamVar } from '@shared/vars';
import { errorMessage, type AppContext } from '../core/context';
import { parseCommand } from '../bot/variables';
import type { StageDeps } from './stage';

const MINUTE = 60_000;
const COMMAND_COOLDOWN_MS = 10_000;

export interface FocusDeps extends StageDeps {
  /** OBS: the scene on air now ('' when OBS isn't connected). */
  currentScene(): string;
  setScene(scene: string): Promise<void>;
}

/** Length of a phase in ms (at least a minute). */
export function phaseMs(cfg: FocusSettings, phase: FocusPhase): number {
  const min = phase === 'focus' ? cfg.focusMin : phase === 'long' ? cfg.longBreakMin : cfg.breakMin;
  return Math.max(1, Math.round(min || 0)) * MINUTE;
}

/** What comes after `phase` once `done` focus sessions are finished. */
export function nextPhase(phase: FocusPhase, done: number, longEvery: number): FocusPhase {
  if (phase !== 'focus') return 'focus';
  return longEvery > 0 && done > 0 && done % longEvery === 0 ? 'long' : 'break';
}

/** 1500000 → "25:00", 3725000 → "1:02:05". */
export function formatLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** How many minutes chat may still add to a phase that already got `extended`. */
export function allowedExtension(minutes: number, extended: number, cap: number): number {
  return Math.max(0, Math.min(minutes, Math.max(0, cap) - extended));
}

/**
 * A pomodoro timer for co-working and study streams: focus and break phases on an overlay,
 * a long break every few sessions, chat can buy extra minutes with channel points.
 * During breaks OBS can show another scene; the one on air before comes back afterwards.
 */
export class FocusService {
  private timer: NodeJS.Timeout | null = null;
  /** Scene to go back to after a break ('' = we didn't switch). */
  private sceneBeforeBreak = '';
  private commandAt = 0;
  /** The next phase is ready but waits for the streamer (autoContinue off). */
  private waiting = false;

  constructor(
    private ctx: AppContext,
    private deps: FocusDeps,
  ) {
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'focus' || key === 'language' || key === 'stats') this.push();
    });
    ctx.bus.on('stream:update', () => {
      if (/\{/.test(this.cfg.task)) this.push();
    });
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('event', (e) => this.onEvent(e));
  }

  private get cfg(): FocusSettings {
    return this.ctx.settings.get('focus');
  }

  private get state(): FocusState {
    return this.ctx.state.current.focus;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  /** Time left in the current phase. */
  left(now = Date.now()): number {
    const s = this.state;
    if (s.status === 'running' && s.endsAt) return Math.max(0, s.endsAt - now);
    return s.status === 'paused' ? s.leftMs : 0;
  }

  overlayMessage(): OverlayMessage {
    const task = renderTemplate(this.cfg.task, (name, arg) => resolveStreamVar(name, arg, this.ctx.settings.all, this.ctx.state.current));
    return { type: 'focus', focus: this.state, style: this.cfg, task, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  /** Idle → start a focus session, running → pause, paused → go on. */
  toggle(): void {
    const s = this.state;
    if (s.status === 'idle') this.begin('focus', true);
    else if (s.status === 'running') this.pause();
    else this.resume();
  }

  pause(): void {
    const s = this.state;
    if (s.status !== 'running') return;
    this.clearTimer();
    this.ctx.state.replace('focus', { ...s, status: 'paused', leftMs: this.left(), endsAt: null });
    this.push();
  }

  resume(): void {
    const s = this.state;
    if (s.status !== 'paused') return;
    this.ctx.state.replace('focus', { ...s, status: 'running', endsAt: Date.now() + s.leftMs });
    this.schedule();
    // A phase that waited for the streamer starts for real now: chime, scene, announcement.
    if (this.waiting) this.started(s.phase, s.leftMs);
    this.waiting = false;
    this.push();
  }

  /** End the current phase now and go to the next one. */
  skip(): void {
    if (this.state.status === 'idle') return;
    this.finish(false);
  }

  stop(): void {
    this.clearTimer();
    this.waiting = false;
    const s = this.state;
    this.ctx.state.replace('focus', { ...s, status: 'idle', phase: 'focus', endsAt: null, leftMs: 0, durationMs: 0, extendedMin: 0, lastExtend: null });
    this.push();
    void this.restoreScene();
  }

  /**
   * Add (or with a negative number, take) minutes. Chat extensions (`user` set) are capped per phase;
   * the streamer's own clicks are not.
   */
  add(minutes: number, user?: string): number {
    const s = this.state;
    if (s.status === 'idle' || !Number.isFinite(minutes) || minutes === 0) return 0;
    const granted = user ? allowedExtension(Math.round(minutes), s.extendedMin, this.cfg.maxExtendMin) : Math.round(minutes);
    if (!granted) return 0;
    const delta = granted * MINUTE;
    const left = this.left() + delta;
    if (left <= 0) {
      this.finish(false);
      return granted;
    }
    this.ctx.state.replace('focus', {
      ...s,
      endsAt: s.status === 'running' ? Date.now() + left : null,
      leftMs: s.status === 'paused' ? left : s.leftMs,
      durationMs: Math.max(MINUTE, s.durationMs + delta),
      extendedMin: user ? s.extendedMin + granted : s.extendedMin,
      lastExtend: user ? { user, minutes: granted, at: Date.now() } : s.lastExtend,
    });
    if (s.status === 'running') this.schedule();
    this.push();
    return granted;
  }

  private begin(phase: FocusPhase, run: boolean): void {
    this.clearTimer();
    const durationMs = phaseMs(this.cfg, phase);
    const s = this.state;
    this.ctx.state.replace('focus', {
      ...s,
      status: run ? 'running' : 'paused',
      phase,
      endsAt: run ? Date.now() + durationMs : null,
      leftMs: run ? 0 : durationMs,
      durationMs,
      extendedMin: 0,
      lastExtend: null,
    });
    this.waiting = !run;
    if (run) {
      this.schedule();
      this.started(phase, durationMs);
    }
    this.push();
  }

  private started(phase: FocusPhase, ms: number): void {
    this.deps.broadcast('focus', { type: 'focusChime', phase });
    void this.applyScene(phase);
    if (this.cfg.announce) void this.deps.say(this.announcement(phase, ms));
  }

  /** The phase is over: count it and move on. */
  private finish(natural: boolean): void {
    const s = this.state;
    if (s.status === 'idle') return;
    this.clearTimer();
    let { done, focusMs } = s;
    if (s.phase === 'focus') {
      // A skipped session counts only the time actually spent.
      focusMs += natural ? s.durationMs : Math.max(0, s.durationMs - this.left());
      if (natural || s.durationMs - this.left() >= s.durationMs / 2) done += 1;
    }
    this.ctx.state.replace('focus', { ...s, done, focusMs });
    const next = nextPhase(s.phase, done, this.cfg.longEvery);
    this.begin(next, this.cfg.autoContinue || !natural);
  }

  private announcement(phase: FocusPhase, ms: number): string {
    const min = Math.round(ms / MINUTE);
    const label = this.cfg.labels[phase] || phase;
    if (phase === 'focus') return this.ru ? `🍅 ${label}: ${min} мин. Работаем!` : `🍅 ${label}: ${min} min. Let's go!`;
    return this.ru ? `☕ ${label}: ${min} мин. Можно размяться.` : `☕ ${label}: ${min} min. Time to stretch.`;
  }

  /** Breaks get their own scene; focus returns to the scene that was on air. */
  private async applyScene(phase: FocusPhase): Promise<void> {
    const scene = this.cfg.breakScene.trim();
    if (phase === 'focus') return this.restoreScene();
    if (!scene) return;
    const current = this.deps.currentScene();
    if (!current) return;
    try {
      if (current !== scene) {
        if (!this.sceneBeforeBreak) this.sceneBeforeBreak = current;
        await this.deps.setScene(scene);
      }
    } catch (err) {
      this.ctx.toast('error', 'toast.focusScene', { error: errorMessage(err) });
    }
  }

  private async restoreScene(): Promise<void> {
    const back = this.sceneBeforeBreak;
    this.sceneBeforeBreak = '';
    // The streamer moved on to another scene by hand during the break: leave it.
    if (!back || this.deps.currentScene() !== this.cfg.breakScene.trim()) return;
    try {
      await this.deps.setScene(back);
    } catch (err) {
      this.ctx.toast('error', 'toast.focusScene', { error: errorMessage(err) });
    }
  }

  private onEvent(e: StreamEvent): void {
    const reward = this.cfg.rewardTitle.trim().toLowerCase();
    if (e.type !== 'redemption' || !reward || e.rewardTitle.trim().toLowerCase() !== reward) return;
    if (this.state.status === 'idle') return;
    const granted = this.add(this.cfg.rewardMinutes, e.userName);
    if (!this.cfg.announce) return;
    const label = this.cfg.labels[this.state.phase] || this.state.phase;
    if (granted) void this.deps.say(this.ru ? `⏱️ ${e.userName} добавляет ${granted} мин: ${label.toLowerCase()} — ещё ${formatLeft(this.left())}` : `⏱️ ${e.userName} adds ${granted} min: ${label.toLowerCase()} — ${formatLeft(this.left())} left`);
    else void this.deps.say(this.ru ? `@${e.userName} эту фазу уже не продлить: лимит ${this.cfg.maxExtendMin} мин` : `@${e.userName} this phase can't be extended any more: the limit is ${this.cfg.maxExtendMin} min`);
  }

  private onChat(m: ChatMessage): void {
    const command = this.cfg.command.trim().toLowerCase().replace(/^[!/]+/, '');
    if (!command || m.fromSelf) return;
    const parsed = parseCommand(m.text, this.ctx.settings.get('bot').prefix);
    if (!parsed || parsed.name !== command) return;
    const now = Date.now();
    if (now - this.commandAt < COMMAND_COOLDOWN_MS) return;
    this.commandAt = now;
    void this.deps.say(this.statusText());
  }

  /** "Focus: 12:34 left, session 3" for the chat command. */
  statusText(): string {
    const s = this.state;
    const ru = this.ru;
    if (s.status === 'idle') return ru ? 'Таймер фокуса сейчас не запущен' : 'The focus timer is not running';
    const label = this.cfg.labels[s.phase] || s.phase;
    const session = s.phase === 'focus' ? s.done + 1 : s.done;
    const paused = s.status === 'paused' ? (ru ? ' (на паузе)' : ' (paused)') : '';
    return ru
      ? `${label}${paused}: осталось ${formatLeft(this.left())}. Сессий за стрим: ${session}`
      : `${label}${paused}: ${formatLeft(this.left())} left. Sessions this stream: ${session}`;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    // Long timeouts drift and are capped by Node; re-check at most every minute.
    const wait = Math.min(this.left(), MINUTE);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state.status !== 'running') return;
      if (this.left() <= 0) this.finish(true);
      else this.schedule();
    }, wait);
  }

  private push(): void {
    this.deps.broadcast('focus', this.overlayMessage());
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Put the scene back before quitting if a break switched it. */
  get needsShutdown(): boolean {
    return !!this.sceneBeforeBreak;
  }

  async shutdown(): Promise<void> {
    this.clearTimer();
    await this.restoreScene();
  }

  dispose(): void {
    this.clearTimer();
  }
}
