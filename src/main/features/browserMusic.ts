import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MusicSourceKind } from '@shared/types';

interface MediaMetadata {
  title?: string;
  artist?: string;
  album?: string;
  subtitle?: string;
}

export interface BrowserMusicTab {
  host: string;
  title: string;
}

export interface MediaSource {
  kind: MusicSourceKind;
  browser: boolean;
  site?: string;
}

const YANDEX = /^music\.yandex\.(?:ru|com|by|kz|uz|com\.tr)$/;
const BROWSER = /chrome|chromium|msedge|firefox|browser|opera|vivaldi|brave|waterfox|librewolf|yandex(?:\.exe|$)/i;

/** Accept a public-looking host, or a browser-provided HTTP origin. Keep paths and query strings private. */
export function mediaHost(value: string): string | undefined {
  const match = /^(?:https?:\/\/)?((?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*)(?::\d{1,5})?\/?$/i.exec(value.trim());
  if (!match || match[1].length > 120 || /\.(?:local|localhost|internal|lan|home|test|invalid)$/i.test(match[1])) return undefined;
  return match[1].toLowerCase();
}

function sourceFromHost(host: string): MediaSource {
  const domain = host.replace(/^(?:www|next)\./, '');
  if (YANDEX.test(domain)) return { kind: 'yandex', browser: true };
  if (domain === 'music.youtube.com') return { kind: 'youtubeMusic', browser: true };
  if (['youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(domain)) return { kind: 'youtube', browser: true };
  if (domain === 'spotify.com' || domain === 'open.spotify.com') return { kind: 'spotify', browser: true };
  return { kind: 'browser', browser: true, site: domain };
}

function namedSource(text: string): MusicSourceKind | undefined {
  const value = text.toLowerCase().replace(/[\s_.-]+/g, '');
  if (/^spotify(?:exe)?$/.test(value)) return 'spotify';
  if (/^(?:yandexmusic|яндексмузыка)(?:exe)?$/.test(value)) return 'yandex';
  if (/^youtubemusic(?:exe)?$/.test(value)) return 'youtubeMusic';
  if (/^youtube(?:exe)?$/.test(value)) return 'youtube';
  return undefined;
}

export function classifyMusicSession(appId: string, metadata: MediaMetadata = {}, host?: string): MediaSource {
  if (/spotify/i.test(appId)) return { kind: 'spotify', browser: false };
  if (/yandex[\s_.-]*music|music[\s_.-]*yandex/i.test(appId)) return { kind: 'yandex', browser: false };
  if (/youtube[\s_.-]*music/i.test(appId)) return { kind: 'youtubeMusic', browser: false };
  const browser = BROWSER.test(appId);
  if (!browser) return { kind: namedSource(appId) ?? 'other', browser: false };
  if (host) return sourceFromHost(host);

  // Chromium may place the origin in Artist when the page supplies no artist.
  for (const field of [metadata.subtitle, metadata.artist]) {
    const origin = field && mediaHost(field);
    if (origin) return sourceFromHost(origin);
  }
  const suffix = metadata.title?.match(/\s[–—|·-]\s([^–—|·]+)$/)?.[1];
  for (const marker of [metadata.subtitle, metadata.artist, metadata.album, suffix]) {
    const kind = marker && namedSource(marker);
    if (kind) return { kind, browser: true };
  }
  return { kind: 'browser', browser: true };
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Use a title match for multiple browsers and only fall back to a single unambiguous audible tab. */
export function browserHostForSession(title: string, tabs: readonly BrowserMusicTab[], singleSession: boolean): string | undefined {
  const name = normalizedTitle(title);
  const matches = new Set(tabs.filter((tab) => {
    const page = normalizedTitle(tab.title);
    return !!name && (page === name || (name.length >= 6 && ` ${page} `.includes(` ${name} `)));
  }).map((tab) => tab.host));
  if (matches.size === 1) return matches.values().next().value;
  if (matches.size > 1 || !singleSession) return undefined;
  const hosts = new Set(tabs.map((tab) => tab.host));
  return hosts.size === 1 ? hosts.values().next().value : undefined;
}

const ROUTE = '/music/browser';
const CLIENT_TTL = 75_000;
const MAX_BODY = 8192;

/** The extension reports ephemeral hints to the loopback overlay server. */
export class BrowserMusicBridge {
  private clients = new Map<string, { tabs: BrowserMusicTab[]; at: number }>();

  constructor(private token: () => string | undefined, private onUpdate: () => void) {}

  snapshot(now = Date.now()): { connected: boolean; tabs: BrowserMusicTab[] } {
    for (const [id, entry] of this.clients) {
      if (now - entry.at > CLIENT_TTL) this.clients.delete(id);
    }
    return { connected: this.clients.size > 0, tabs: [...this.clients.values()].flatMap((entry) => entry.tabs) };
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== ROUTE) return false;
    const token = this.token();
    const auth = req.headers.authorization?.match(/^Bearer ([a-f\d]{64})$/i)?.[1];
    let status = 403;
    if (req.method === 'POST' && token && auth && token.length === auth.length && timingSafeEqual(Buffer.from(token), Buffer.from(auth))) {
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > MAX_BODY) { res.writeHead(413); res.end(); return true; }
        }
        const data = JSON.parse(body) as { client?: unknown; tabs?: unknown };
        if (typeof data.client !== 'string' || !/^[\da-f-]{36}$/i.test(data.client)) throw new Error('Invalid client');
        if (data.tabs === null) {
          this.clients.delete(data.client);
        } else {
          if (!Array.isArray(data.tabs) || data.tabs.length > 12) throw new Error('Invalid tabs');
          const tabs: BrowserMusicTab[] = data.tabs.flatMap((tab) => {
            const host = typeof tab?.host === 'string' ? mediaHost(tab.host) : undefined;
            return host && typeof tab.title === 'string' ? [{ host, title: tab.title.slice(0, 250) }] : [];
          });
          this.snapshot();
          if (this.clients.size >= 16 && !this.clients.has(data.client)) this.clients.delete(this.clients.keys().next().value!);
          this.clients.set(data.client, { tabs, at: Date.now() });
        }
        this.onUpdate();
        status = 204;
      } catch { status = 400; }
    }
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  static pairing(port: number, token: string): string {
    return `http://127.0.0.1:${port}${ROUTE}#${token}`;
  }
}
