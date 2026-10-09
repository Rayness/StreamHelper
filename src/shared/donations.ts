import { donationAmount, formatAmount } from './events';
import type { DonationRecord, DonationsBoard, DonationsOverlaySettings, Settings, StreamEvent } from './types';

/** Donations kept for the board; older ones are dropped. */
export const DONATION_LOG_LIMIT = 500;

export function donationRecord(e: Extract<StreamEvent, { type: 'donation' }>, mainCurrency: string): DonationRecord {
  return {
    id: e.id,
    name: e.userName,
    amount: e.amount,
    currency: e.currency,
    amountMain: donationAmount(e, mainCurrency),
    message: e.message,
    source: e.source as DonationRecord['source'],
    at: e.timestamp,
  };
}

/** Newest first, without duplicates (providers may resend a donation after a reconnect). */
export function appendDonation(log: DonationRecord[], record: DonationRecord): DonationRecord[] {
  if (log.some((d) => d.id === record.id)) return log;
  return [record, ...log].slice(0, DONATION_LOG_LIMIT);
}

/** Lists for the donation board from the log, in the streamer's main currency. */
export function donationBoard(
  log: DonationRecord[],
  cfg: Pick<DonationsOverlaySettings, 'period' | 'count'>,
  since: number,
  currency: string,
): DonationsBoard {
  const records = cfg.period === 'session' ? log.filter((d) => d.at >= since) : log;
  const donors = new Map<string, { name: string; amount: number; count: number }>();
  let total = 0;
  for (const d of records) {
    const amount = d.amountMain ?? 0;
    total += amount;
    const key = d.name.trim().toLowerCase();
    const donor = donors.get(key) ?? { name: d.name, amount: 0, count: 0 };
    donor.amount = Math.round((donor.amount + amount) * 100) / 100;
    donor.count++;
    donors.set(key, donor);
  }
  const count = Math.max(1, Math.min(50, Math.round(cfg.count) || 5));
  return {
    latest: records.slice(0, count),
    top: [...donors.values()].filter((d) => d.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, count),
    all: records.slice(0, 100),
    total: Math.round(total * 100) / 100,
    count: records.length,
    currency,
  };
}

/** "Name — 100 RUB, Other — 50 RUB" for template variables. */
export function donationList(entries: { name: string; amount: number; currency?: string }[], currency: string): string {
  return entries.map((d) => `${d.name} — ${formatAmount(d.amount)} ${d.currency ?? currency}`).join(', ');
}

export function boardFor(s: Pick<Settings, 'donationLog' | 'stats' | 'currency'>, cfg: Pick<DonationsOverlaySettings, 'period' | 'count'>): DonationsBoard {
  return donationBoard(s.donationLog ?? [], cfg, s.stats.since, s.currency);
}
