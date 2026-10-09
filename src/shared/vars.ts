import { boardFor, donationList } from './donations';
import { donationAmount, formatAmount } from './events';
import { formatDuration } from './template';
import type { RuntimeState, Settings, StatEntry, StreamEvent, StreamStats } from './types';

const EMPTY = '—';

const amount = (e: StatEntry | null) => (e ? `${formatAmount(e.amount)}${e.currency ? ` ${e.currency}` : ''}` : EMPTY);

/** A custom variable by name (case-insensitive); undefined when there is none. */
export function customVar(s: Pick<Settings, 'variables'>, name: string): string | undefined {
  const key = name.trim().toLowerCase();
  return (s.variables ?? []).find((v) => v.name.trim().toLowerCase() === key)?.value;
}

/** Valid custom variable name: letters, digits and underscores, not starting with a digit. */
export const VARIABLE_NAME = /^[a-zA-Z_][\w]{0,39}$/;

/** "+5" / "-1" change a numeric variable; anything else replaces the value. */
export function nextVariableValue(current: string, input: string): string {
  const delta = /^\s*([+-])\s*(\d+(?:[.,]\d+)?)\s*$/.exec(input);
  const base = Number(current.replace(',', '.'));
  if (!delta || (current.trim() !== '' && !Number.isFinite(base))) return input;
  const value = (Number.isFinite(base) ? base : 0) + (delta[1] === '-' ? -1 : 1) * Number(delta[2].replace(',', '.'));
  return String(Math.round(value * 100) / 100);
}

const listCount = (arg: string | undefined, fallback: number) => Math.max(1, Math.min(20, Math.round(Number(arg)) || fallback));

/**
 * Variables shared by banners, labels, custom overlays and bot commands: stream info, "last
 * follower"-style stats, donations, counters, Kawaki and the streamer's own variables.
 * Returns undefined for unknown names (left as typed).
 */
export function resolveStreamVar(name: string, arg: string | undefined, s: Settings, st: RuntimeState, now = Date.now()): string | number | undefined {
  const builtin = resolveBuiltinVar(name, arg, s, st, now);
  if (builtin !== undefined) return builtin;
  return name.toLowerCase() === 'var' ? (arg ? customVar(s, arg) ?? '' : undefined) : customVar(s, name);
}

function resolveBuiltinVar(name: string, arg: string | undefined, s: Settings, st: RuntimeState, now: number): string | number | undefined {
  const stats = s.stats;
  const lang = s.language;
  const kw = st.kawaki.nowWatching;
  switch (name.toLowerCase()) {
    case 'title':
      return st.stream.title;
    case 'game':
      return st.stream.categoryName;
    case 'viewers':
      return st.stream.viewers;
    case 'uptime':
      return st.stream.live && st.stream.startedAt ? formatDuration(now - st.stream.startedAt, lang) : EMPTY;
    case 'time':
      return new Date(now).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    case 'date':
      return new Date(now).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US');
    case 'channel':
      return st.twitch.account?.displayName ?? '';
    case 'count':
      return arg ? (s.bot.counters[arg] ?? 0) : undefined;
    case 'lastfollower':
      return stats.lastFollower || EMPTY;
    case 'lastsub':
    case 'lastsubscriber':
      return stats.lastSubscriber || EMPTY;
    case 'lastdonor':
      return stats.lastDonation?.name ?? EMPTY;
    case 'lastdonation':
      return amount(stats.lastDonation);
    case 'topdonor':
      return stats.topDonation?.name ?? EMPTY;
    case 'topdonation':
      return amount(stats.topDonation);
    case 'lastcheerer':
      return stats.lastCheer?.name ?? EMPTY;
    case 'lastcheer':
      return stats.lastCheer ? stats.lastCheer.amount : EMPTY;
    case 'topcheerer':
      return stats.topCheer?.name ?? EMPTY;
    case 'topcheer':
      return stats.topCheer ? stats.topCheer.amount : EMPTY;
    case 'lastraider':
      return stats.lastRaid?.name ?? EMPTY;
    case 'lastraid':
      return stats.lastRaid ? stats.lastRaid.amount : EMPTY;
    case 'follows':
      return stats.follows;
    case 'subs':
      return stats.subs;
    case 'bits':
      return stats.bits;
    case 'donations':
      return `${formatAmount(stats.donations)} ${s.currency}`;
    case 'donationcount':
      return boardFor(s, { period: 'session', count: 1 }).count;
    case 'lastdonations': {
      const board = boardFor(s, { period: 'session', count: listCount(arg, 3) });
      return board.latest.length ? donationList(board.latest, s.currency) : EMPTY;
    }
    case 'topdonors': {
      const board = boardFor(s, { period: 'session', count: listCount(arg, 3) });
      return board.top.length ? donationList(board.top, s.currency) : EMPTY;
    }
    case 'alltimetop': {
      const board = boardFor(s, { period: 'all', count: listCount(arg, 3) });
      return board.top.length ? donationList(board.top, s.currency) : EMPTY;
    }
    case 'anime':
      return kw?.title ?? EMPTY;
    case 'episode':
      return kw?.episode ?? EMPTY;
    case 'animeurl':
      return kw?.url ?? s.kawaki.baseUrl;
    case 'kawaki':
      return st.kawaki.partner?.liveUrl ?? s.kawaki.baseUrl;
    default:
      return undefined;
  }
}

/** Fold a real event into the running stats. Returns null when the event doesn't touch them. */
export function applyEventToStats(stats: StreamStats, e: StreamEvent, mainCurrency: string): StreamStats | null {
  switch (e.type) {
    case 'follow':
      return { ...stats, lastFollower: e.userName, follows: stats.follows + 1 };
    case 'sub':
    case 'resub':
      return { ...stats, lastSubscriber: e.userName, subs: stats.subs + 1 };
    case 'giftsub':
      return { ...stats, lastSubscriber: e.userName, subs: stats.subs + e.count };
    case 'cheer': {
      const entry = { name: e.userName, amount: e.bits };
      const top = !stats.topCheer || e.bits > stats.topCheer.amount ? entry : stats.topCheer;
      return { ...stats, lastCheer: entry, topCheer: top, bits: stats.bits + e.bits };
    }
    case 'raid':
      return { ...stats, lastRaid: { name: e.userName, amount: e.viewers } };
    case 'donation': {
      const main = donationAmount(e, mainCurrency);
      const entry: StatEntry = { name: e.userName, amount: e.amount, currency: e.currency };
      // Top donation is compared in the main currency; foreign amounts without conversion can't compete.
      const topMain = stats.topDonation ? (stats.topDonation.currency?.toUpperCase() === mainCurrency.toUpperCase() ? stats.topDonation.amount : 0) : -1;
      const top = main !== null && main > topMain ? { name: e.userName, amount: main, currency: mainCurrency } : stats.topDonation;
      return { ...stats, lastDonation: entry, topDonation: top, donations: Math.round((stats.donations + (main ?? 0)) * 100) / 100 };
    }
    default:
      return null;
  }
}
