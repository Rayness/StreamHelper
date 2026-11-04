import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CaptionLine, CaptionsSettings, OverlayMessage } from '@shared/types';
import { maskProfanity } from '@shared/tts';
import type { AppContext } from '../core/context';
import { authorized } from '../overlay/dock';

/** Finished phrases kept for the overlay and the app. */
const KEEP = 6;
const MAX_TEXT = 400;
/** Chrome slows timers of background tabs to once a minute, so the page may be quiet for that long. */
const STALE_MS = 90_000;

export interface CaptionsDeps {
  broadcast(message: OverlayMessage): void;
  now?: () => number;
}

/** What the microphone page sends: the phrase being spoken, or a finished one. */
export interface HeardText {
  text: string;
  final: boolean;
  translation?: string;
}

function clean(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
}

/** The page's report, checked: anything else from the network is dropped. */
export function parseHeard(body: unknown): HeardText | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string' || typeof b.final !== 'boolean') return null;
  const translation = clean(b.translation);
  return { text: clean(b.text), final: b.final, ...(translation ? { translation } : {}) };
}

/**
 * Live captions of the streamer's speech. Recognition runs in a page opened in Chrome or Edge
 * (their speech recognition is free and good at Russian; Electron has none), which sends the text
 * here; the overlay shows the last phrases and fades out in silence.
 */
export class CaptionsService {
  private lines: CaptionLine[] = [];
  private interim = '';
  private lastAt: number | null = null;
  private lastPing = 0;
  private seq = 0;
  private watch: NodeJS.Timeout;

  constructor(private ctx: AppContext, private deps: CaptionsDeps) {
    ctx.bus.on('settings:changed', (key) => {
      if (key !== 'captions') return;
      if (!this.cfg.enabled) this.reset();
      this.push();
    });
    this.watch = setInterval(() => this.check(), 5000);
  }

  private get cfg(): CaptionsSettings {
    return this.ctx.settings.get('captions');
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  overlayMessage(): OverlayMessage {
    const cfg = this.cfg;
    return { type: 'captions', lines: this.lines.slice(-Math.max(1, Math.min(KEEP, cfg.maxLines))), interim: this.interim, style: cfg, lastAt: this.lastAt, now: this.now(), lang: this.ctx.settings.get('language') };
  }

  /** Text from the microphone page. */
  hear(heard: HeardText): void {
    const cfg = this.cfg;
    this.alive(null);
    if (!cfg.enabled) return;
    const mask = (s: string) => (cfg.profanityFilter ? maskProfanity(s) : s);
    const text = mask(heard.text);
    if (heard.final) {
      this.interim = '';
      if (text) {
        this.lines = [...this.lines, { id: `c${++this.seq}`, text, ...(heard.translation ? { translation: mask(heard.translation) } : {}), at: this.now() }].slice(-KEEP);
      }
    } else {
      if (text === this.interim) return;
      this.interim = text;
    }
    this.lastAt = this.now();
    this.ctx.state.patch('captions', { lines: this.lines, interim: this.interim, lastAt: this.lastAt });
    this.push();
  }

  /** The page is open; `error` is its own trouble (microphone blocked, no translation...). */
  alive(error: string | null): void {
    this.lastPing = this.now();
    const s = this.ctx.state.current.captions;
    if (!s.listening || s.error !== error) this.ctx.state.patch('captions', { listening: true, error });
  }

  /** Sample phrases to set the overlay up without speaking. */
  test(): void {
    const ru = this.ctx.settings.get('language') === 'ru';
    const at = this.now();
    this.lines = [
      { id: `c${++this.seq}`, text: ru ? 'Всем привет, сегодня проходим финального босса' : 'Hi everyone, today we beat the final boss', translation: ru ? 'Hi everyone, today we beat the final boss' : 'Всем привет, сегодня проходим финального босса', at },
    ];
    this.interim = ru ? 'и посмотрим, что будет дальше' : "and we'll see what happens next";
    this.lastAt = at;
    this.ctx.state.patch('captions', { lines: this.lines, interim: this.interim, lastAt: at });
    this.push();
  }

  clear(): void {
    this.reset();
    this.push();
  }

  private reset(): void {
    this.lines = [];
    this.interim = '';
    this.lastAt = null;
    this.ctx.state.patch('captions', { lines: [], interim: '', lastAt: null });
  }

  private check(): void {
    if (this.ctx.state.current.captions.listening && this.now() - this.lastPing > STALE_MS) this.ctx.state.patch('captions', { listening: false });
  }

  private push(): void {
    this.deps.broadcast(this.overlayMessage());
  }

  dispose(): void {
    clearInterval(this.watch);
  }
}

export interface CaptionsRouteOptions {
  token: string;
  htmlPath: string;
  service: CaptionsService;
  settings: () => { captions: CaptionsSettings; language: 'ru' | 'en' };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 4096) throw new Error('Request too large');
  }
  return body ? JSON.parse(body) : {};
}

/** The microphone page and what it calls, behind its own token (the link is the streamer's only). */
export function createCaptionsRoutes(opts: CaptionsRouteOptions) {
  const html = readFileSync(opts.htmlPath, 'utf8');
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/captions/')) return false;
    if (!authorized(url.searchParams.get('token'), opts.token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return true;
    }
    try {
      if (url.pathname === '/captions/mic' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(html);
        return true;
      }
      if (url.pathname === '/captions/config' && req.method === 'GET') {
        const { captions, language } = opts.settings();
        json(res, 200, { enabled: captions.enabled, language: captions.language, translateTo: captions.translateTo, lang: language });
        return true;
      }
      if (url.pathname === '/captions/push' && req.method === 'POST') {
        const heard = parseHeard(await readJson(req));
        if (heard) opts.service.hear(heard);
        json(res, heard ? 200 : 400, heard ? { ok: true } : { error: 'bad request' });
        return true;
      }
      if (url.pathname === '/captions/ping' && req.method === 'POST') {
        const body = (await readJson(req)) as { error?: unknown };
        opts.service.alive(typeof body?.error === 'string' && body.error ? body.error.slice(0, 300) : null);
        json(res, 200, { ok: true });
        return true;
      }
      res.writeHead(404);
      res.end();
    } catch {
      if (!res.headersSent) json(res, 400, { error: 'bad request' });
    }
    return true;
  };
}
