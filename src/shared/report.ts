import { donationAmount } from './events';
import type { ChatMessage, ClipMoment, ReportSummary, StreamEvent } from './types';

/** Common words that never become "the word of the stream". */
const STOP_WORDS = new Set(
  (
    'это как что так все уже был была было были есть нет ещё еще тоже только когда если чтобы потому очень может можно надо будет буду будем ' +
    'просто вообще короче типа щас сейчас тебя тебе меня мне него неё нее они она оно этот эта эти того тому этого этом там тут здесь вот ' +
    'кто где куда зачем почему какой какая какие всем всех свой свою себя себе даже нибудь либо разве пока потом сразу снова опять ' +
    'that this with have what just like your from they them then than there their about would could should will were been when which ' +
    'into some more very really yeah okay what\'s dont don\'t cant can\'t its it\'s youre you\'re lets let\'s gonna wanna'
  ).split(/\s+/),
);

export function emptyReportSummary(startedAt: number, currency = ''): ReportSummary {
  return {
    startedAt, endedAt: null, title: '', category: '', peakViewers: 0, avgViewers: 0, messages: 0, chatters: 0, mvp: [],
    topWord: null, topEmote: null, follows: 0, subs: 0, gifts: 0, bits: 0, donations: 0, currency, topDonation: null,
    raids: [], drama: null, bestClip: null, clips: 0,
  };
}

/** Words of a chat message worth counting: plain text, no links, mentions, commands or short words. */
export function reportWords(message: Pick<ChatMessage, 'fragments' | 'text'>, extraStop: readonly string[] = []): string[] {
  if (/^\s*[!/]/.test(message.text)) return [];
  const stop = new Set(extraStop.map((w) => w.trim().toLowerCase().replace(/ё/g, 'е')).filter(Boolean));
  const out: string[] = [];
  for (const f of message.fragments) {
    if (f.type !== 'text') continue;
    for (const raw of f.text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}'-]+/u)) {
      const word = raw.replace(/^['-]+|['-]+$/g, '');
      if (word.length < 4 || /^\d+$/.test(word) || STOP_WORDS.has(word) || stop.has(word)) continue;
      out.push(word);
    }
  }
  return [...new Set(out)];
}

interface ChatterStat { name: string; count: number; color?: string }

export interface ReportSessionData {
  startedAt: number;
  endedAt: number | null;
  title: string;
  category: string;
  peakViewers: number;
  viewerSum: number;
  viewerSamples: number;
  messages: number;
  chatters: Record<string, ChatterStat>;
  words: Record<string, number>;
  emotes: Record<string, { url: string; count: number }>;
  /** Messages per minute (key: minute epoch). */
  minutes: Record<string, number>;
  /** One quotable message per minute (the longest). */
  quotes: Record<string, { user: string; text: string }>;
  follows: number;
  subs: number;
  gifts: number;
  bits: number;
  donations: number;
  currency: string;
  topDonation: { name: string; amount: number; currency: string } | null;
  raids: { name: string; viewers: number }[];
  clips: Pick<ClipMoment, 'clipUrl' | 'reason' | 'at' | 'score'>[];
}

const MAX_WORDS = 20_000;

/**
 * Everything the end-of-stream card needs, gathered while live. Plain data, so it can be saved to
 * disk every minute and survive an app restart in the middle of a stream.
 */
export class ReportCollector {
  data: ReportSessionData;

  constructor(startedAt: number, currency: string, data?: ReportSessionData) {
    this.data = data ?? {
      startedAt, endedAt: null, title: '', category: '', peakViewers: 0, viewerSum: 0, viewerSamples: 0, messages: 0,
      chatters: {}, words: {}, emotes: {}, minutes: {}, quotes: {}, follows: 0, subs: 0, gifts: 0, bits: 0, donations: 0,
      currency, topDonation: null, raids: [], clips: [],
    };
  }

  static restore(raw: unknown): ReportCollector | null {
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Partial<ReportSessionData>;
    if (typeof d.startedAt !== 'number' || typeof d.chatters !== 'object' || !d.chatters) return null;
    const base = new ReportCollector(d.startedAt, d.currency ?? '');
    return new ReportCollector(d.startedAt, d.currency ?? '', { ...base.data, ...d } as ReportSessionData);
  }

  setStream(title: string, category: string): void {
    if (title) this.data.title = title;
    if (category) this.data.category = category;
  }

  sampleViewers(viewers: number): void {
    if (!Number.isFinite(viewers) || viewers < 0) return;
    this.data.peakViewers = Math.max(this.data.peakViewers, viewers);
    this.data.viewerSum += viewers;
    this.data.viewerSamples++;
  }

  addChat(m: ChatMessage, exclude: ReadonlySet<string>, stopWords: readonly string[] = []): void {
    if (m.fromSelf || exclude.has(m.userLogin.toLowerCase())) return;
    const d = this.data;
    d.messages++;
    const c = d.chatters[m.userId] ?? (d.chatters[m.userId] = { name: m.userName, count: 0, color: m.color });
    c.count++;
    c.name = m.userName;
    for (const w of reportWords(m, stopWords)) d.words[w] = (d.words[w] ?? 0) + 1;
    if (Object.keys(d.words).length > MAX_WORDS) {
      for (const [w, n] of Object.entries(d.words)) if (n < 2) delete d.words[w];
    }
    for (const f of m.fragments) {
      if (f.type !== 'emote') continue;
      const e = d.emotes[f.text] ?? (d.emotes[f.text] = { url: f.url, count: 0 });
      e.count++;
    }
    const minute = String(Math.floor((m.timestamp || Date.now()) / 60_000) * 60_000);
    d.minutes[minute] = (d.minutes[minute] ?? 0) + 1;
    const text = m.text.trim();
    if (text.length >= 6 && text.length <= 140 && !/^[!/]/.test(text) && !/https?:\/\//i.test(text)) {
      const q = d.quotes[minute];
      if (!q || text.length > q.text.length) d.quotes[minute] = { user: m.userName, text };
    }
  }

  addEvent(e: StreamEvent, mainCurrency: string): void {
    if (e.source === 'test') return;
    const d = this.data;
    switch (e.type) {
      case 'follow': d.follows++; break;
      case 'sub': case 'resub': d.subs++; break;
      case 'giftsub': d.gifts += e.count; break;
      case 'cheer': d.bits += e.bits; break;
      case 'raid': d.raids.push({ name: e.userName, viewers: e.viewers }); break;
      case 'donation': {
        const amount = donationAmount(e, mainCurrency);
        if (amount !== null && Number.isFinite(amount)) {
          d.donations += amount;
          d.currency = mainCurrency;
          if (!d.topDonation || amount > d.topDonation.amount) d.topDonation = { name: e.userName, amount, currency: mainCurrency };
        }
        break;
      }
    }
  }

  addClip(moment: ClipMoment): void {
    this.data.clips.push({ clipUrl: moment.clipUrl, reason: moment.reason, at: moment.at, score: moment.score });
    if (this.data.clips.length > 200) this.data.clips.shift();
  }

  summary(): ReportSummary {
    const d = this.data;
    const mvp = Object.values(d.chatters).sort((a, b) => b.count - a.count).slice(0, 3).map((c) => ({ name: c.name, messages: c.count, color: c.color }));
    const topWord = Object.entries(d.words).sort((a, b) => b[1] - a[1])[0];
    const topEmote = Object.entries(d.emotes).sort((a, b) => b[1].count - a[1].count)[0];
    const busiest = Object.entries(d.minutes).sort((a, b) => b[1] - a[1])[0];
    const withUrl = d.clips.filter((c) => c.clipUrl);
    const best = [...withUrl].sort((a, b) => b.score - a.score)[0];
    return {
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      title: d.title,
      category: d.category,
      peakViewers: d.peakViewers,
      avgViewers: d.viewerSamples ? Math.round(d.viewerSum / d.viewerSamples) : 0,
      messages: d.messages,
      chatters: Object.keys(d.chatters).length,
      mvp,
      topWord: topWord && topWord[1] > 1 ? { word: topWord[0], count: topWord[1] } : null,
      topEmote: topEmote ? { name: topEmote[0], url: topEmote[1].url, count: topEmote[1].count } : null,
      follows: d.follows,
      subs: d.subs,
      gifts: d.gifts,
      bits: d.bits,
      donations: Math.round(d.donations * 100) / 100,
      currency: d.currency,
      topDonation: d.topDonation,
      raids: d.raids.slice(0, 10),
      drama: busiest && busiest[1] >= 5 ? { at: Number(busiest[0]), messages: busiest[1], quote: d.quotes[busiest[0]] ?? null } : null,
      bestClip: best?.clipUrl ? { url: best.clipUrl, reason: best.reason, at: best.at } : null,
      clips: d.clips.length,
    };
  }
}
