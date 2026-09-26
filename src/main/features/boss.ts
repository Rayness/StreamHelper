import type { BossSettings, BossState, ChatMessage, OverlayMessage } from '@shared/types';
import type { AppContext } from '../core/context';
import type { StageDeps } from './stage';

/** Cooperative chat game: each viewer can damage a shared boss after a personal cooldown. */
export class BossService {
  private lastHit = new Map<string, number>();
  private damageByUser = new Map<string, { user: string; damage: number }>();
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(private ctx: AppContext, private deps: StageDeps) {
    ctx.bus.on('chat:message', (message) => this.onChat(message));
    ctx.bus.on('event', (event) => {
      const reward = this.cfg.redemptionTitle.trim().toLowerCase();
      if (event.type === 'redemption' && reward && event.rewardTitle.trim().toLowerCase() === reward) {
        this.hit(event.userName, `reward:${event.id}`, event.timestamp, true);
      }
    });
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'boss' || key === 'language') this.push();
    });
  }

  private get cfg(): BossSettings {
    return this.ctx.settings.get('boss');
  }

  overlayMessage(): OverlayMessage {
    return { type: 'boss', boss: this.ctx.state.current.boss, style: this.cfg, lang: this.ctx.settings.get('language') };
  }

  start(): void {
    const maxHp = Math.max(1, Math.floor(this.cfg.maxHp));
    this.lastHit.clear();
    this.damageByUser.clear();
    this.ctx.state.replace('boss', { status: 'running', hp: maxHp, maxHp, hits: 0, lastHit: null, top: [] });
    this.push();
    if (this.cfg.announce) {
      const ru = this.ctx.settings.get('language') === 'ru';
      const command = `${this.ctx.settings.get('bot').prefix}${this.cfg.command}`;
      void this.deps.say(ru ? `${this.cfg.name}: ${maxHp} HP! Пишите ${command}, чтобы атаковать.` : `${this.cfg.name}: ${maxHp} HP! Type ${command} to attack.`);
    }
  }

  reset(): void {
    this.lastHit.clear();
    this.damageByUser.clear();
    this.ctx.state.replace('boss', { status: 'idle', hp: 0, maxHp: 0, hits: 0, lastHit: null, top: [] });
    this.push();
  }

  hit(user = 'Streamer', key = 'manual', now = Date.now(), bypassCooldown = true): boolean {
    const state = this.ctx.state.current.boss;
    if (state.status !== 'running') return false;
    const cooldownMs = Math.max(0, this.cfg.cooldownSec) * 1000;
    if (!bypassCooldown && now - (this.lastHit.get(key) ?? -Infinity) < cooldownMs) return false;
    this.lastHit.set(key, now);
    const damage = Math.min(state.hp, Math.max(1, Math.floor(this.cfg.damage)));
    const sum = (this.damageByUser.get(key)?.damage ?? 0) + damage;
    this.damageByUser.set(key, { user, damage: sum });
    const hp = Math.max(0, state.hp - damage);
    const top = [...this.damageByUser.values()].sort((a, b) => b.damage - a.damage).slice(0, 5);
    const next: BossState = { status: hp === 0 ? 'defeated' : 'running', hp, maxHp: state.maxHp, hits: state.hits + 1, lastHit: { user, damage }, top };
    this.ctx.state.replace('boss', next);
    this.schedulePush();
    if (hp === 0 && this.cfg.announce) {
      const ru = this.ctx.settings.get('language') === 'ru';
      void this.deps.say(ru ? `${this.cfg.name} побеждён! Последний удар: ${user}.` : `${this.cfg.name} was defeated! Final hit: ${user}.`);
    }
    return true;
  }

  private onChat(message: ChatMessage): void {
    if (message.fromSelf || !this.cfg.command.trim()) return;
    const trigger = `${this.ctx.settings.get('bot').prefix}${this.cfg.command.trim()}`.toLowerCase();
    if (message.text.trim().toLowerCase() !== trigger) return;
    this.hit(message.userName, `${message.platform}:${message.userId}`, message.timestamp, false);
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.push();
    }, 150);
  }

  private push(): void {
    this.deps.broadcast('boss', this.overlayMessage());
  }

  dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
