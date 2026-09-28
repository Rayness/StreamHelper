import type { ChatLeader, ChatMessage, HypeSettings, OverlayMessage, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';
import type { StageDeps } from './stage';

const TICK_MS = 1000;
const LEADERS_KEPT = 20;

/** How many hype points an event is worth. */
export function hypePoints(e: StreamEvent, cfg: HypeSettings, mainCurrency: string): number {
  const p = cfg.points;
  switch (e.type) {
    case 'follow':
      return p.follow;
    case 'sub':
    case 'resub':
      return p.sub;
    case 'giftsub':
      return p.sub * e.count;
    case 'cheer':
      return (p.bitsPer100 * e.bits) / 100;
    case 'raid':
      return p.raidPerViewer * e.viewers;
    case 'donation': {
      const amount = e.amountMain ?? (!e.currency || e.currency.toUpperCase() === mainCurrency.toUpperCase() ? e.amount : 0);
      return p.donationPerUnit * amount;
    }
    case 'redemption':
      return p.redemption;
  }
}

/** Level and progress for a point total: every `levelPoints` is one level, capped at `maxLevel`. */
export function hypeLevel(points: number, cfg: Pick<HypeSettings, 'levelPoints' | 'maxLevel'>): { level: number; progress: number; points: number } {
  const per = Math.max(1, cfg.levelPoints);
  const maxLevel = Math.max(1, Math.floor(cfg.maxLevel));
  const capped = Math.max(0, Math.min(points, per * maxLevel));
  if (capped <= 0) return { level: 0, progress: 0, points: 0 };
  const level = Math.min(maxLevel, Math.floor(capped / per) + 1);
  const progress = level === maxLevel && capped >= per * maxLevel ? 1 : (capped % per) / per;
  return { level, progress, points: capped };
}

/**
 * Hype meter (a hype train that works for any channel): events and chat fill it, it cools down
 * when nothing happens. Also keeps the "most active chatters" board for the leaders overlay.
 */
export class HypeService {
  private timer: NodeJS.Timeout | null = null;
  private lastSent = '';
  private counts = new Map<string, ChatLeader>();
  private leadersDirty = false;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
  ) {
    ctx.bus.on('event', (e) => {
      if (e.source === 'test') return;
      this.add(hypePoints(e, this.cfg, ctx.settings.get('currency')));
    });
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('chat:clearUser', ({ userId }) => {
      if (this.counts.delete(userId)) this.leadersDirty = true;
    });
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'hype' || key === 'language') {
        this.add(0);
        this.pushHype(true);
      }
      if (key === 'leadersOverlay' || key === 'language') {
        this.leadersDirty = true;
        this.pushLeaders(true);
      }
    });
  }

  private get cfg(): HypeSettings {
    return this.ctx.settings.get('hype');
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  hypeMessage(): OverlayMessage {
    return { type: 'hype', hype: this.ctx.state.current.hype, style: this.cfg, lang: this.ctx.settings.get('language') };
  }

  leadersMessage(): OverlayMessage {
    return { type: 'leaders', leaders: this.ctx.state.current.chatLeaders, style: this.ctx.settings.get('leadersOverlay'), lang: this.ctx.settings.get('language') };
  }

  /** Add points (negative removes); a manual test or an event. */
  add(points: number, now = Date.now()): void {
    if (!Number.isFinite(points)) return;
    const state = this.ctx.state.current.hype;
    const next = hypeLevel(state.points + points, this.cfg);
    this.ctx.state.replace('hype', { ...next, lastBumpAt: points > 0 ? now : state.lastBumpAt });
    if (points !== 0) this.pushHype();
  }

  reset(): void {
    this.ctx.state.replace('hype', { points: 0, level: 0, progress: 0, lastBumpAt: 0 });
    this.pushHype(true);
  }

  resetLeaders(): void {
    this.counts.clear();
    this.leadersDirty = true;
    this.pushLeaders(true);
  }

  private onChat(m: ChatMessage): void {
    if (m.fromSelf) return;
    const prefix = this.ctx.settings.get('bot').prefix;
    const text = m.text.trim();
    if (!text) return;
    const isCommand = !!prefix && text.startsWith(prefix);
    if (!isCommand && this.cfg.points.chatMessage) this.add(this.cfg.points.chatMessage);
    const excluded = this.ctx.settings.get('leadersOverlay').exclude.map((x) => x.trim().toLowerCase());
    if (isCommand || m.roles.broadcaster || excluded.includes(m.userLogin.toLowerCase())) return;
    const key = m.userId || m.userLogin.toLowerCase();
    const prev = this.counts.get(key);
    this.counts.set(key, { userId: key, userName: m.userName, color: m.color, messages: (prev?.messages ?? 0) + 1 });
    this.leadersDirty = true;
  }

  tick(now = Date.now()): void {
    const state = this.ctx.state.current.hype;
    // Cool down only after a short grace period, so a burst of events stays visible.
    if (state.points > 0 && now - state.lastBumpAt > 5000) {
      const loss = Math.max(0.05, (state.points * Math.max(0, this.cfg.decayPerMin)) / 100 / 60);
      const next = hypeLevel(state.points - loss, this.cfg);
      this.ctx.state.replace('hype', { ...next, lastBumpAt: state.lastBumpAt });
    }
    this.pushHype();
    this.pushLeaders();
  }

  private pushHype(force = false): void {
    const msg = this.hypeMessage();
    const h = this.ctx.state.current.hype;
    // The overlay animates between updates: send when the bar visibly moves.
    const key = `${h.level}:${Math.round(h.progress * 200)}:${JSON.stringify(this.cfg)}:${this.ctx.settings.get('language')}`;
    if (!force && key === this.lastSent) return;
    this.lastSent = key;
    this.deps.broadcast('hype', msg);
  }

  private pushLeaders(force = false): void {
    if (!this.leadersDirty && !force) return;
    this.leadersDirty = false;
    const leaders = [...this.counts.values()].sort((a, b) => b.messages - a.messages).slice(0, LEADERS_KEPT);
    const prev = this.ctx.state.current.chatLeaders;
    if (force || JSON.stringify(prev) !== JSON.stringify(leaders)) {
      this.ctx.state.replace('chatLeaders', leaders);
      this.deps.broadcast('leaders', this.leadersMessage());
    }
  }
}
