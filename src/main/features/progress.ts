import { timerAdd, timerPause, timerReset, timerStart } from '@shared/timer';
import type { ChatMessage, Goal, OverlayTimer, StreamEvent } from '@shared/types';
import { emptyStats } from '@shared/defaults';
import { donationAmount } from '@shared/events';
import type { AppContext } from '../core/context';
import { appendDonation, donationRecord } from '@shared/donations';
import { applyEventToStats } from './vars';

/** How much an event moves a goal of the given kind. */
export function goalIncrement(goal: Goal, e: StreamEvent): number {
  switch (goal.kind) {
    case 'followers':
      return e.type === 'follow' ? 1 : 0;
    case 'subs':
      return e.type === 'sub' || e.type === 'resub' ? 1 : e.type === 'giftsub' ? e.count : 0;
    case 'bits':
      return e.type === 'cheer' ? e.bits : 0;
    case 'donations':
      if (e.type !== 'donation') return 0;
      if (goal.donationSources && ['donationalerts', 'streamlabs', 'streamelements'].includes(e.source)
        && !goal.donationSources.includes(e.source as import('@shared/types').DonationSource)) return 0;
      // Prefer the provider's conversion into the streamer's currency; otherwise only count matching currency.
      {
        const amount = donationAmount(e, goal.currency) ?? 0;
        if (amount < (goal.donationMinAmount ?? 0)) return 0;
        return goal.donationMaxAmount ? Math.min(amount, goal.donationMaxAmount) : amount;
      }
    default:
      return 0;
  }
}

/** Seconds a subathon timer gains from an event. */
export function subathonSeconds(t: OverlayTimer, e: StreamEvent, mainCurrency: string): number {
  const a = t.addSec;
  switch (e.type) {
    case 'follow':
      return a.follow;
    case 'sub':
    case 'resub':
      return a.sub;
    case 'giftsub':
      return a.giftsubPerSub * e.count;
    case 'cheer':
      return (a.bitsPer100 * e.bits) / 100;
    case 'donation': {
      const amount = donationAmount(e, mainCurrency) ?? 0;
      return a.donationPerUnit * amount;
    }
    default:
      return 0;
  }
}

export type TimerOp = 'start' | 'pause' | 'reset' | 'add';

/** Goals and overlay timers react to real (non-test) events. */
export class ProgressTracker {
  private chatSeen = new Set<string>();
  private chatOrder: string[] = [];

  constructor(private ctx: AppContext) {
    ctx.bus.on('event', (e) => {
      if (e.source === 'test') return;
      this.applyToGoals(e);
      this.applyToTimers(e);
      this.applyToStats(e);
      if (e.type === 'donation') this.ctx.settings.update('donationLog', (log) => appendDonation(log ?? [], donationRecord(e, this.ctx.settings.get('currency'))));
    });
    ctx.bus.on('chat:message', (message) => this.applyToChatGoals(message));
  }

  private applyToChatGoals(message: ChatMessage): void {
    const prefix = this.ctx.settings.get('bot').prefix;
    if (message.fromSelf || !message.text.trim() || (prefix && message.text.trim().startsWith(prefix))) return;
    if (this.chatSeen.has(message.id)) return;
    this.chatSeen.add(message.id);
    this.chatOrder.push(message.id);
    if (this.chatOrder.length > 1000) this.chatSeen.delete(this.chatOrder.shift()!);
    const key = `${message.platform}:${message.userId || message.userLogin.toLowerCase()}`;
    let changed = false;
    const goals = this.ctx.settings.get('goals').map((goal) => {
      if (goal.kind === 'chatMessages') {
        changed = true;
        return { ...goal, current: goal.current + 1 };
      }
      if (goal.kind === 'chatters' && !(goal.chattersSeen ?? []).includes(key)) {
        changed = true;
        return { ...goal, current: goal.current + 1, chattersSeen: [...(goal.chattersSeen ?? []), key] };
      }
      return goal;
    });
    if (changed) this.ctx.settings.set('goals', goals);
  }

  private applyToStats(e: StreamEvent): void {
    const next = applyEventToStats(this.ctx.settings.get('stats'), e, this.ctx.settings.get('currency'));
    if (next) this.ctx.settings.set('stats', next);
  }

  resetStats(): void {
    this.ctx.settings.set('stats', emptyStats());
  }

  clearDonations(): void {
    this.ctx.settings.set('donationLog', []);
  }

  private applyToGoals(e: StreamEvent): void {
    const goals = this.ctx.settings.get('goals');
    let changed = false;
    const next = goals.map((g) => {
      const inc = goalIncrement(g, e);
      if (!inc) return g;
      changed = true;
      return { ...g, current: Math.round((g.current + inc) * 100) / 100 };
    });
    if (changed) this.ctx.settings.set('goals', next);
  }

  private applyToTimers(e: StreamEvent): void {
    const now = Date.now();
    const currency = this.ctx.settings.get('currency');
    let changed = false;
    const next = this.ctx.settings.get('timers').map((t) => {
      if (t.mode !== 'countdown') return t;
      const sec = subathonSeconds(t, e, currency);
      if (!sec) return t;
      changed = true;
      return timerAdd(t, sec, now);
    });
    if (changed) this.ctx.settings.set('timers', next);
  }

  addToGoal(goalId: string, amount: number): void {
    this.ctx.settings.update('goals', (goals) => goals.map((g) => {
      if (g.id !== goalId) return g;
      const current = Math.max(0, g.current + amount);
      return { ...g, current, ...(g.kind === 'chatters' && current === 0 ? { chattersSeen: [] } : {}) };
    }));
  }

  controlTimer(timerId: string, op: TimerOp, seconds = 0): void {
    const now = Date.now();
    this.ctx.settings.update('timers', (timers) =>
      timers.map((t) => {
        if (t.id !== timerId) return t;
        switch (op) {
          case 'start':
            return timerStart(t, now);
          case 'pause':
            return timerPause(t, now);
          case 'reset':
            return timerReset(t);
          case 'add':
            return timerAdd(t, seconds, now);
        }
      }),
    );
  }

  toggleTimer(timerId: string): void {
    const t = this.ctx.settings.get('timers').find((x) => x.id === timerId);
    if (t) this.controlTimer(timerId, t.running ? 'pause' : 'start');
  }
}
