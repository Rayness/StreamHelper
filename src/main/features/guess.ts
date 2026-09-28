import type { ChatMessage, GuessSettings, GuessState, OverlayMessage } from '@shared/types';
import type { AppContext } from '../core/context';
import type { StageDeps } from './stage';

/** A chat line that is just a whole number ("42"), or null. */
export function parseGuess(text: string): number | null {
  const m = /^\s*(-?\d{1,9})\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * "Guess the number": chat types numbers, the overlay narrows the possible range after every
 * wrong guess ("higher" / "lower"), the first exact guess wins.
 */
export class GuessService {
  private secret = 0;
  private lastGuess = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private rand: () => number = Math.random,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'guess' || key === 'language') this.push();
    });
  }

  private get cfg(): GuessSettings {
    return this.ctx.settings.get('guess');
  }

  private get state(): GuessState {
    return this.ctx.state.current.guess;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  overlayMessage(): OverlayMessage {
    return { type: 'guess', guess: this.state, style: this.cfg, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  start(): void {
    const min = Math.floor(Math.min(this.cfg.min, this.cfg.max));
    const max = Math.floor(Math.max(this.cfg.min, this.cfg.max));
    if (max - min < 2) throw new Error(this.ru ? 'Диапазон слишком маленький' : 'The range is too small');
    this.clearTimer();
    this.lastGuess.clear();
    this.secret = min + Math.floor(this.rand() * (max - min + 1));
    const durationMs = Math.max(0, this.cfg.durationSec) * 1000;
    this.ctx.state.replace('guess', { status: 'running', min, max, low: min, high: max, attempts: 0, endsAt: durationMs ? Date.now() + durationMs : null, winner: null, answer: null, lastGuess: null });
    this.push();
    if (durationMs) this.timer = setTimeout(() => this.stop(), durationMs);
    if (this.cfg.announce) void this.deps.say(this.ru ? `Угадайте число от ${min} до ${max}! Пишите число в чат` : `Guess the number from ${min} to ${max}! Type a number in chat`);
  }

  /** End the round without a winner and reveal the number. */
  stop(): void {
    if (this.state.status !== 'running') {
      this.clearTimer();
      this.ctx.state.replace('guess', { ...this.state, status: 'idle' });
      this.push();
      return;
    }
    this.clearTimer();
    this.ctx.state.replace('guess', { ...this.state, status: 'ended', endsAt: null, answer: this.secret });
    this.push();
    if (this.cfg.announce) void this.deps.say(this.ru ? `Никто не угадал — это было ${this.secret}` : `Nobody got it — it was ${this.secret}`);
  }

  private onChat(m: ChatMessage): void {
    const s = this.state;
    if (s.status !== 'running' || m.fromSelf || m.roles.broadcaster) return;
    const value = parseGuess(m.text);
    if (value === null || value < s.min || value > s.max) return;
    const key = `${m.platform}:${m.userId}`;
    const now = m.timestamp || Date.now();
    if (now - (this.lastGuess.get(key) ?? -Infinity) < Math.max(0, this.cfg.cooldownSec) * 1000) return;
    this.lastGuess.set(key, now);
    const attempts = s.attempts + 1;
    if (value === this.secret) {
      this.clearTimer();
      this.ctx.state.replace('guess', { ...s, status: 'won', attempts, endsAt: null, winner: m.userName, answer: this.secret, low: value, high: value, lastGuess: { user: m.userName, value, hint: 'exact' } });
      this.push();
      this.ctx.toast('success', 'toast.guessWinner', { name: m.userName, value });
      if (this.cfg.announce) void this.deps.say(this.ru ? `@${m.userName} угадал(а) число ${value} с ${attempts}-й попытки чата!` : `@${m.userName} guessed ${value} after ${attempts} tries!`);
      return;
    }
    const hint = value < this.secret ? 'higher' : 'lower';
    this.ctx.state.replace('guess', {
      ...s,
      attempts,
      low: hint === 'higher' ? Math.max(s.low, value + 1) : s.low,
      high: hint === 'lower' ? Math.min(s.high, value - 1) : s.high,
      lastGuess: { user: m.userName, value, hint },
    });
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.push();
    }, 200);
  }

  private push(): void {
    this.deps.broadcast('guess', this.overlayMessage());
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.clearTimer();
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
