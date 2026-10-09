import type { ChatMessage, ClipMoment, ClipReason, ClipperSettings } from '@shared/types';
import { renderTemplate } from '@shared/template';
import { errorMessage, type AppContext } from '../core/context';
import { parseCommand } from '../bot/variables';

/** How far back the "usual chat speed" is measured. */
const BASELINE_MS = 5 * 60_000;
const SAMPLE_KEEP = 5;

interface Seen { at: number; userId: string; user: string; text: string; keyword: boolean }

export function hasKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => {
    const w = k.trim().toLowerCase();
    return !!w && lower.includes(w);
  });
}

export interface Measure {
  /** Messages in the current window. */
  rate: number;
  /** Usual messages per window, measured over the last few minutes (excluding the current window). */
  baseline: number;
  keywordHits: number;
  voters: number;
}

/**
 * Notices "moments": chat suddenly much faster than usual, a wave of reaction words, or viewers
 * voting for a clip. Pure and clock-driven, so it can be tested without timers.
 */
export class MomentDetector {
  private seen: Seen[] = [];
  private votes = new Map<string, number>();
  private firstAt: number | null = null;

  push(m: { at: number; userId: string; user: string; text: string }, cfg: ClipperSettings, prefix: string): void {
    this.firstAt ??= m.at;
    const vote = cfg.voteCommand.trim() ? parseCommand(m.text, prefix) : null;
    if (vote && vote.name === cfg.voteCommand.trim().toLowerCase().replace(/^[!/]+/, '')) {
      this.votes.set(m.userId, m.at);
      return;
    }
    this.seen.push({ ...m, keyword: hasKeyword(m.text, cfg.keywords) });
    this.prune(m.at);
  }

  private prune(now: number): void {
    const cutoff = now - BASELINE_MS;
    let drop = 0;
    while (drop < this.seen.length && this.seen[drop].at < cutoff) drop++;
    if (drop) this.seen.splice(0, drop);
    for (const [user, at] of this.votes) if (at < cutoff) this.votes.delete(user);
  }

  measure(now: number, cfg: ClipperSettings): Measure {
    const windowMs = Math.max(3, cfg.windowSec) * 1000;
    const start = now - windowMs;
    let rate = 0;
    let keywordHits = 0;
    let older = 0;
    for (const s of this.seen) {
      if (s.at > now) continue;
      if (s.at >= start) {
        rate++;
        if (s.keyword) keywordHits++;
      } else older++;
    }
    let voters = 0;
    for (const at of this.votes.values()) if (at >= start && at <= now) voters++;
    // Until there is history, assume the chat is as fast as the quiet-chat floor.
    const span = Math.min(BASELINE_MS, now - (this.firstAt ?? now)) - windowMs;
    const baseline = span >= windowMs * 2 ? (older * windowMs) / span : Math.max(1, cfg.minMessages);
    return { rate, baseline, keywordHits, voters };
  }

  check(now: number, cfg: ClipperSettings): { reason: ClipReason; score: number; messages: number } | null {
    const m = this.measure(now, cfg);
    const score = Math.round((m.rate / Math.max(1, m.baseline)) * 10) / 10;
    if (cfg.voteThreshold > 0 && cfg.voteCommand.trim() && m.voters >= cfg.voteThreshold) return { reason: 'vote', score: Math.max(score, m.voters), messages: m.rate };
    if (cfg.keywordHits > 0 && m.keywordHits >= cfg.keywordHits) return { reason: 'keywords', score, messages: m.rate };
    if (m.rate >= Math.max(1, cfg.minMessages) && m.rate >= cfg.sensitivity * Math.max(1, m.baseline)) return { reason: 'burst', score, messages: m.rate };
    return null;
  }

  /** The latest messages: what chat was saying at the moment. */
  sample(now: number, windowSec: number): { user: string; text: string }[] {
    const start = now - windowSec * 1000;
    return this.seen.filter((s) => s.at >= start && s.at <= now).slice(-SAMPLE_KEEP).map((s) => ({ user: s.user, text: s.text.slice(0, 120) }));
  }

  /** After a clip: forget the votes so the same wave doesn't clip twice. */
  clearVotes(): void {
    this.votes.clear();
  }
}

export interface ClipperDeps {
  createClip(): Promise<{ id: string; url: string; editUrl: string }>;
  createMarker(description: string): Promise<number | null>;
  say(text: string): Promise<void>;
  discord?(text: string): Promise<void>;
}

/** Turns Twitch API failures into something the streamer can act on. */
export function clipErrorText(err: unknown, ru: boolean): string {
  const status = (err as { status?: number })?.status;
  const msg = errorMessage(err);
  if (status === 401 || status === 403 || /scope/i.test(msg)) return ru ? 'Нет права создавать клипы. Переподключите Twitch в «Подключениях».' : 'No permission to create clips. Reconnect Twitch in Connections.';
  if (status === 404 || /offline/i.test(msg)) return ru ? 'Клип можно сделать только во время эфира.' : 'Clips can only be made while live.';
  return msg;
}

/** "Moment!": watches chat for spikes and saves a clip and a stream marker on its own. */
export class ClipperService {
  private detector = new MomentDetector();
  private lastClipAt = -Infinity;
  private stateTimer: NodeJS.Timeout | null = null;

  constructor(private ctx: AppContext, private deps: ClipperDeps, private now: () => number = Date.now) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => { if (key === 'clipper') this.syncTimer(); });
    this.syncTimer();
  }

  private get cfg(): ClipperSettings {
    return this.ctx.settings.get('clipper');
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  private syncTimer(): void {
    if (this.cfg.enabled && !this.stateTimer) this.stateTimer = setInterval(() => this.publishRate(), 2000);
    if (!this.cfg.enabled && this.stateTimer) {
      clearInterval(this.stateTimer);
      this.stateTimer = null;
      this.ctx.state.patch('clipper', { rate: 0, baseline: 0 });
    }
  }

  private publishRate(): void {
    const m = this.detector.measure(this.now(), this.cfg);
    this.ctx.state.patch('clipper', { rate: m.rate, baseline: Math.round(m.baseline * 10) / 10 });
  }

  private onChat(m: ChatMessage): void {
    const cfg = this.cfg;
    if (!cfg.enabled || m.fromSelf) return;
    const at = m.timestamp || this.now();
    this.detector.push({ at, userId: `${m.platform}:${m.userId}`, user: m.userName, text: m.text }, cfg, this.ctx.settings.get('bot').prefix);
    if (this.ctx.state.current.clipper.busy) return;
    if (at - this.lastClipAt < Math.max(10, cfg.cooldownSec) * 1000) return;
    if (cfg.onlyWhenLive && !this.ctx.state.current.stream.live) return;
    const hit = this.detector.check(at, cfg);
    if (hit) void this.capture(hit.reason, hit.score, hit.messages);
  }

  /** The streamer's button / hotkey: clip right now, no detection and no cooldown. */
  async clipNow(): Promise<ClipMoment> {
    const m = this.detector.measure(this.now(), this.cfg);
    return this.capture('manual', Math.round((m.rate / Math.max(1, m.baseline)) * 10) / 10, m.rate);
  }

  private async capture(reason: ClipReason, score: number, messages: number): Promise<ClipMoment> {
    const cfg = this.cfg;
    const at = this.now();
    this.lastClipAt = at;
    this.detector.clearVotes();
    const moment: ClipMoment = { id: `moment_${at.toString(36)}`, at, reason, score, messages, sample: this.detector.sample(at, Math.max(3, cfg.windowSec)) };
    this.ctx.state.patch('clipper', { busy: true });
    const errors: string[] = [];
    try {
      if (cfg.createClip || reason === 'manual') {
        try {
          const clip = await this.deps.createClip();
          Object.assign(moment, { clipId: clip.id, clipUrl: clip.url, editUrl: clip.editUrl });
        } catch (err) { errors.push(clipErrorText(err, this.ru)); }
      }
      if (cfg.createMarker) {
        const label = { burst: this.ru ? 'Взрыв чата' : 'Chat burst', keywords: this.ru ? 'Реакция чата' : 'Chat reaction', vote: this.ru ? 'Зрители просят клип' : 'Viewers asked for a clip', manual: this.ru ? 'Момент' : 'Moment' }[reason];
        try {
          const sec = await this.deps.createMarker(`StreamHelper: ${label}`);
          if (sec !== null) moment.markerSec = sec;
        } catch (err) { errors.push(clipErrorText(err, this.ru)); }
      }
    } finally {
      if (errors.length) moment.error = [...new Set(errors)].join(' ');
      const saved = !!moment.clipUrl || moment.markerSec !== undefined;
      this.ctx.state.patch('clipper', {
        busy: false,
        lastError: saved ? null : moment.error ?? null,
        moments: [moment, ...this.ctx.state.current.clipper.moments].slice(0, 50),
      });
    }
    if (moment.clipUrl || moment.markerSec !== undefined) {
      this.ctx.bus.emit('clip:moment', moment);
      this.ctx.toast('success', 'toast.momentSaved', { reason: this.reasonLabel(reason) });
      const text = moment.clipUrl && cfg.announce.trim() ? renderTemplate(cfg.announce, { url: moment.clipUrl, reason: this.reasonLabel(reason) }) : '';
      if (text) void this.deps.say(text).catch(() => undefined);
      if (cfg.sendToDiscord && moment.clipUrl && this.deps.discord) void this.deps.discord(`🎬 ${this.reasonLabel(reason)}: ${moment.clipUrl}`).catch(() => undefined);
    } else if (moment.error) {
      this.ctx.toast('error', 'toast.momentFailed', { error: moment.error });
    }
    return moment;
  }

  private reasonLabel(reason: ClipReason): string {
    const ru = this.ru;
    return { burst: ru ? 'взрыв чата' : 'chat burst', keywords: ru ? 'реакция чата' : 'chat reaction', vote: ru ? 'зрители попросили' : 'viewers asked', manual: ru ? 'вручную' : 'manual' }[reason];
  }

  dispose(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = null;
  }
}
