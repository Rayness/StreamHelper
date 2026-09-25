import type { ChatMessage, ModAction, ModerationSettings } from '@shared/types';
import { hasPermission } from './permissions';

export type FilterName = 'links' | 'caps' | 'words' | 'spam';

export interface Violation {
  filter: FilterName;
  action: ModAction;
  timeoutSec: number;
  warning: string;
}

const URL_RE = /(https?:\/\/)?((?:[a-z0-9-]+\.)+([a-z]{2,}))(?:[/?#]\S*)?/gi;
/** Without a scheme, only well-known TLDs count as links, so "ok.so" or "wait.what" don't trigger. */
const COMMON_TLDS = new Set(
  'com net org ru io tv gg me co uk de fr info biz xyz su app dev link ly be to cc us online site shop store ua by kz fm am live stream pro club top vip ws website space ink'.split(
    ' ',
  ),
);

export function extractDomains(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const host = m[2].toLowerCase();
    if (!m[1] && !host.startsWith('www.') && !COMMON_TLDS.has(m[3].toLowerCase())) continue;
    out.push(host.replace(/^www\./, ''));
  }
  return out;
}

export function isAllowedDomain(host: string, allowed: string[]): boolean {
  return allowed.some((a) => {
    const d = a.trim().toLowerCase().replace(/^www\./, '');
    return d && (host === d || host.endsWith('.' + d));
  });
}

export function capsRatio(text: string): { letters: number; ratio: number } {
  const letters = [...text].filter((c) => c.toLowerCase() !== c.toUpperCase());
  if (letters.length === 0) return { letters: 0, ratio: 0 };
  const upper = letters.filter((c) => c === c.toUpperCase()).length;
  return { letters: letters.length, ratio: (upper / letters.length) * 100 };
}

/** Banned-word entries are case-insensitive substrings; "/regex/" entries are regular expressions. */
export function matchesBannedWord(text: string, list: string[]): boolean {
  const lower = text.toLowerCase();
  return list.some((raw) => {
    const w = raw.trim();
    if (!w) return false;
    if (w.length > 2 && w.startsWith('/') && w.endsWith('/')) {
      try {
        return new RegExp(w.slice(1, -1), 'i').test(text);
      } catch {
        return false;
      }
    }
    return lower.includes(w.toLowerCase());
  });
}

/**
 * Stateful checker: remembers recent messages per user (for repeat-spam) and link permits.
 * Clock injectable for tests.
 */
export class Moderator {
  private recent = new Map<string, { text: string; count: number; at: number }>();
  private permits = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  permit(userLogin: string, seconds: number): void {
    this.permits.set(userLogin.toLowerCase().replace(/^@/, ''), this.now() + seconds * 1000);
  }

  private hasPermit(login: string): boolean {
    const until = this.permits.get(login.toLowerCase());
    if (!until) return false;
    if (until < this.now()) {
      this.permits.delete(login.toLowerCase());
      return false;
    }
    return true;
  }

  check(msg: ChatMessage, s: ModerationSettings): Violation | null {
    if (msg.fromSelf || hasPermission(msg.roles, s.exempt)) return null;
    const v = (filter: FilterName): Violation => ({ filter, action: s[filter].action, timeoutSec: s[filter].timeoutSec, warning: s[filter].warning });

    if (s.words.enabled && matchesBannedWord(msg.text, s.words.list)) return v('words');

    if (s.links.enabled) {
      const bad = extractDomains(msg.text).filter((d) => !isAllowedDomain(d, s.links.allowed));
      if (bad.length) {
        if (this.hasPermit(msg.userLogin)) this.permits.delete(msg.userLogin.toLowerCase());
        else return v('links');
      }
    }

    if (s.caps.enabled) {
      const { letters, ratio } = capsRatio(msg.fragments.filter((f) => f.type !== 'emote').map((f) => f.text).join(''));
      if (letters >= s.caps.minLength && ratio >= s.caps.percent) return v('caps');
    }

    if (s.spam.enabled) {
      if (s.spam.maxLength > 0 && msg.text.length > s.spam.maxLength) return v('spam');
      const emotes = msg.fragments.filter((f) => f.type === 'emote').length;
      if (s.spam.maxEmotes > 0 && emotes > s.spam.maxEmotes) return v('spam');
      if (s.spam.maxRepeats > 0 && this.isRepeat(msg, s.spam.maxRepeats)) return v('spam');
    }
    return null;
  }

  private isRepeat(msg: ChatMessage, maxRepeats: number): boolean {
    const t = this.now();
    const norm = msg.text.trim().toLowerCase();
    const prev = this.recent.get(msg.userId);
    const count = prev && prev.text === norm && t - prev.at < 60_000 ? prev.count + 1 : 1;
    this.recent.set(msg.userId, { text: norm, count, at: t });
    if (this.recent.size > 5000) this.recent.delete(this.recent.keys().next().value!);
    return count > maxRepeats;
  }
}
