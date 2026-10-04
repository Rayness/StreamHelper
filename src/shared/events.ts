import { tierLabel } from './template';
import type { StreamEvent } from './types';

/** Twitch activity has exactly one authority; donation providers only supply donations. */
export function isTrustedStreamEvent(e: StreamEvent): boolean {
  if (e.source === 'test') return true;
  return e.type === 'donation'
    ? ['donationalerts', 'streamlabs', 'streamelements'].includes(e.source)
    : e.source === 'twitch';
}

/** A provider conversion is usable only in the currency it actually describes. */
export function donationAmount(e: Extract<StreamEvent, { type: 'donation' }>, currency: string): number | null {
  if (e.amountMain !== undefined && (!e.amountMainCurrency || e.amountMainCurrency.toUpperCase() === currency.toUpperCase())) return e.amountMain;
  return !e.currency || e.currency.toUpperCase() === currency.toUpperCase() ? e.amount : null;
}

/** Template variables available for an event in alerts and bot event messages. */
export function eventVars(e: StreamEvent): Record<string, string | number> {
  const vars: Record<string, string | number> = { user: e.userName, name: e.userName, message: '', amount: '' };
  switch (e.type) {
    case 'sub':
      vars.tier = tierLabel(e.tier);
      break;
    case 'resub':
      Object.assign(vars, { tier: tierLabel(e.tier), months: e.months, amount: e.months, streak: e.streak ?? '', message: e.message });
      break;
    case 'giftsub':
      Object.assign(vars, { tier: tierLabel(e.tier), count: e.count, amount: e.count, total: e.total ?? '' });
      break;
    case 'cheer':
      Object.assign(vars, { bits: e.bits, amount: e.bits, message: e.message });
      break;
    case 'raid':
      Object.assign(vars, { viewers: e.viewers, amount: e.viewers });
      break;
    case 'donation':
      Object.assign(vars, { amount: formatAmount(e.amount), currency: e.currency, message: e.message });
      break;
    case 'redemption':
      Object.assign(vars, { reward: e.rewardTitle, cost: e.cost, amount: e.cost, message: e.input, input: e.input });
      break;
  }
  return vars;
}

/** The number an alert's "minimum amount" threshold is compared against. */
export function eventAmount(e: StreamEvent): number {
  switch (e.type) {
    case 'resub':
      return e.months;
    case 'giftsub':
      return e.count;
    case 'cheer':
      return e.bits;
    case 'raid':
      return e.viewers;
    case 'donation':
      return e.amountMain ?? e.amount;
    case 'redemption':
      return e.cost;
    default:
      return 0;
  }
}

export function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
