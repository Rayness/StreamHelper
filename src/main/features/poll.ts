import type { ChatMessage, PollSettings, PollState } from '@shared/types';
import type { AppContext } from '../core/context';
import { normalizeText, type StageDeps } from './stage';
import { assertNoOtherNumberVote } from './chatVotes';

const PUSH_THROTTLE_MS = 250;

/** Which option a chat line votes for: a bare number ("2") or the option's exact text. -1 = not a vote. */
export function parseVote(text: string, options: string[]): number {
  const t = text.trim();
  const num = /^#?(\d{1,2})$/.exec(t);
  if (num) {
    const i = Number(num[1]) - 1;
    return i >= 0 && i < options.length ? i : -1;
  }
  const n = normalizeText(t);
  if (!n) return -1;
  return options.findIndex((o) => normalizeText(o) === n);
}

export function leadersOf(options: { votes: number }[]): number[] {
  const max = Math.max(0, ...options.map((o) => o.votes));
  if (max === 0) return [];
  return options.flatMap((o, i) => (o.votes === max ? [i] : []));
}

/** Chat poll: works on any platform and any channel (Twitch native polls need affiliate + extra scopes). */
export class PollService {
  private votes = new Map<string, number>();
  private endTimer: NodeJS.Timeout | null = null;
  private clearTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => key === 'poll' && this.pushNow());
  }

  get poll(): PollState | null {
    return this.ctx.state.current.poll;
  }

  private get cfg(): PollSettings {
    return this.ctx.settings.get('poll');
  }

  overlayMessage() {
    return { type: 'poll' as const, poll: this.poll, style: this.cfg, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  start(): void {
    const cfg = this.cfg;
    const options = cfg.options.map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) throw new Error('a poll needs at least two options');
    assertNoOtherNumberVote(this.ctx.state.current, 'poll', this.ctx.settings.get('language') === 'ru');
    this.clearTimers();
    this.votes.clear();
    const durationMs = Math.max(0, cfg.durationSec) * 1000;
    const poll: PollState = {
      id: `poll_${Date.now().toString(36)}`,
      question: cfg.question.trim(),
      options: options.map((label) => ({ label, votes: 0 })),
      total: 0,
      status: 'running',
      endsAt: durationMs ? Date.now() + durationMs : null,
      leaders: [],
    };
    this.ctx.state.replace('poll', poll);
    this.pushNow();
    if (durationMs) this.endTimer = setTimeout(() => this.end(), durationMs);
    if (cfg.announce) {
      const list = options.map((o, i) => `${i + 1} — ${o}`).join(', ');
      const lang = this.ctx.settings.get('language');
      void this.deps.say(lang === 'ru' ? `Голосование: ${poll.question} Пишите номер в чат: ${list}` : `Poll: ${poll.question} Type a number: ${list}`);
    }
  }

  end(): void {
    const poll = this.poll;
    if (!poll || poll.status !== 'running') return;
    this.clearTimers();
    const ended: PollState = { ...poll, status: 'ended', endsAt: null, leaders: leadersOf(poll.options) };
    this.ctx.state.replace('poll', ended);
    this.pushNow();
    const cfg = this.cfg;
    if (cfg.announce) {
      const lang = this.ctx.settings.get('language');
      const ru = lang === 'ru';
      const text =
        ended.leaders.length === 0
          ? ru
            ? 'Голосование закончилось — никто не проголосовал'
            : 'The poll ended with no votes'
          : ended.leaders
              .map((i) => `«${ended.options[i].label}» (${Math.round((ended.options[i].votes / ended.total) * 100)}%)`)
              .join(ru ? ' и ' : ' and ');
      if (ended.leaders.length) void this.deps.say(ru ? `Итог голосования: ${text}` : `Poll result: ${text}`);
      else void this.deps.say(text);
    }
    if (cfg.resultSec > 0) this.clearTimer = setTimeout(() => this.clear(), cfg.resultSec * 1000);
  }

  clear(): void {
    this.clearTimers();
    this.votes.clear();
    this.ctx.state.replace('poll', null);
    this.pushNow();
  }

  private onChat(m: ChatMessage): void {
    const poll = this.poll;
    if (!poll || poll.status !== 'running' || m.fromSelf) return;
    const choice = parseVote(m.text, poll.options.map((o) => o.label));
    if (choice < 0) return;
    const key = `${m.platform}:${m.userId}`;
    const prev = this.votes.get(key);
    if (prev === choice) return;
    if (prev !== undefined && !this.cfg.allowChange) return;
    this.votes.set(key, choice);
    const options = poll.options.map((o, i) => ({ ...o, votes: o.votes + (i === choice ? 1 : 0) - (i === prev ? 1 : 0) }));
    this.ctx.state.replace('poll', { ...poll, options, total: poll.total + (prev === undefined ? 1 : 0), leaders: leadersOf(options) });
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
    this.deps.broadcast('poll', this.overlayMessage());
  }

  private clearTimers(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.endTimer = this.clearTimer = null;
  }

  dispose(): void {
    this.clearTimers();
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
