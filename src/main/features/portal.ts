import WebSocket from 'ws';
import type { ChatFragment, ChatMessage, OverlayMessage, PortalMessage, PortalSettings } from '@shared/types';
import { renderTemplate } from '@shared/template';
import type { AppContext } from '../core/context';
import { matchesBannedWord } from '../bot/moderation';
import { parseCommand } from '../bot/variables';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const RETRY_MS = [2000, 5000, 10_000, 30_000];
const KEEP = 30;
const LOGIN = /^[a-z0-9_]{3,25}$/;

export interface IrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' } as Record<string, string>)[c] ?? c);
}

/** One raw IRC line → tags, prefix, command, params (the last param may contain spaces). */
export function parseIrcLine(line: string): IrcLine | null {
  let rest = line.replace(/\r?\n$/, '');
  if (!rest) return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    for (const pair of rest.slice(1, end).split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) tags[pair] = '';
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(end + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  const trail = rest.indexOf(' :');
  const head = trail === -1 ? rest : rest.slice(0, trail);
  const params = head.split(' ').filter(Boolean);
  const command = params.shift() ?? '';
  if (trail !== -1) params.push(rest.slice(trail + 2));
  return { tags, prefix, command, params };
}

/** Twitch emote positions ("25:0-4,6-10/1902:12-16") → message fragments. Positions count code points. */
export function ircFragments(text: string, emotesTag: string | undefined): ChatFragment[] {
  const chars = [...text];
  const spans: { start: number; end: number; id: string }[] = [];
  for (const group of (emotesTag ?? '').split('/')) {
    const [id, ranges] = group.split(':');
    if (!id || !ranges) continue;
    for (const r of ranges.split(',')) {
      const [a, b] = r.split('-').map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && a <= b && b < chars.length) spans.push({ start: a, end: b, id });
    }
  }
  spans.sort((x, y) => x.start - y.start);
  const out: ChatFragment[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    if (s.start > pos) out.push({ type: 'text', text: chars.slice(pos, s.start).join('') });
    out.push({ type: 'emote', text: chars.slice(s.start, s.end + 1).join(''), url: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(s.id)}/default/dark/2.0` });
    pos = s.end + 1;
  }
  if (pos < chars.length) out.push({ type: 'text', text: chars.slice(pos).join('') });
  return out;
}

/** Command names a portal message may use: ours, plus both defaults (the partner may run the app in the other language). */
const DEFAULT_COMMANDS = ['портал', 'portal'];

/**
 * "!портал hello" from the partner's chat → the prefix used, the command and its text. The partner's
 * StreamHelper may have another prefix or language, so "!" and both default names are accepted too.
 */
export function parsePortalCommand(text: string, prefix: string, command: string): { prefix: string; name: string; args: string[] } | null {
  const names = new Set([command.trim().toLowerCase().replace(/^[!/]+/, ''), ...DEFAULT_COMMANDS].filter(Boolean));
  for (const p of new Set([prefix, '!'].filter(Boolean))) {
    const parsed = parseCommand(text, p);
    if (parsed && names.has(parsed.name) && parsed.args.length) return { prefix: p, name: parsed.name, args: parsed.args };
  }
  return null;
}

/** Links never travel through the portal. */
export function stripLinks(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '🔗').replace(/\s+/g, ' ').trim();
}

export interface PortalDeps {
  broadcast(message: OverlayMessage): void;
  say(text: string): Promise<void>;
  /** Display name of a channel, or null when it doesn't exist (skipped when Twitch isn't connected). */
  lookup?(login: string): Promise<string | null>;
  socket?: (url: string) => WebSocket;
}

/**
 * A two-way window into a partner's chat. Each side runs its own StreamHelper and reads the other
 * channel anonymously (no login, read-only). Viewers type "!портал text" to send a message through.
 */
export class PortalService {
  private ws: WebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;
  private channel = '';
  private sentAt: number[] = [];
  private relayAt = 0;
  private generation = 0;

  constructor(private ctx: AppContext, private deps: PortalDeps) {
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'portal') this.sync();
      if (key === 'portal' || key === 'language') this.deps.broadcast(this.configMessage());
    });
    ctx.bus.on('chat:message', (m) => this.onOwnChat(m));
  }

  private get cfg(): PortalSettings {
    return this.ctx.settings.get('portal');
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  configMessage(): OverlayMessage {
    return { type: 'portalConfig', config: this.cfg, channel: this.ctx.state.current.portal.channel || this.cfg.partner, lang: this.ctx.settings.get('language') };
  }

  start(): void {
    this.sync();
  }

  private sync(): void {
    const partner = this.cfg.partner.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '').toLowerCase();
    const want = this.cfg.enabled && LOGIN.test(partner) ? partner : '';
    if (want === this.channel && (this.ws || this.retry || !want)) return;
    this.close();
    this.channel = want;
    if (!want) {
      this.ctx.state.patch('portal', { status: 'disconnected', channel: '', error: this.cfg.enabled && partner ? (this.ru ? 'Неверный ник канала' : 'Invalid channel name') : undefined });
      return;
    }
    this.attempts = 0;
    void this.connect(++this.generation);
  }

  private async connect(generation: number): Promise<void> {
    const channel = this.channel;
    this.ctx.state.patch('portal', { status: 'connecting', channel, error: undefined });
    if (this.deps.lookup && this.attempts === 0) {
      const name = await this.deps.lookup(channel).catch(() => undefined);
      if (generation !== this.generation) return;
      if (name === null) {
        this.ctx.state.patch('portal', { status: 'error', error: this.ru ? `Канал ${channel} не найден на Twitch` : `Channel ${channel} not found on Twitch` });
        return;
      }
    }
    const ws = (this.deps.socket ?? ((url) => new WebSocket(url)))(IRC_URL);
    this.ws = ws;
    ws.on('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      ws.send(`JOIN #${channel}`);
    });
    ws.on('message', (raw) => {
      if (generation !== this.generation) return;
      for (const line of raw.toString().split('\r\n')) this.onLine(ws, line);
    });
    ws.on('close', () => {
      if (generation !== this.generation || this.ws !== ws) return;
      this.ws = null;
      this.ctx.state.patch('portal', { status: 'connecting' });
      const delay = RETRY_MS[Math.min(this.attempts++, RETRY_MS.length - 1)];
      this.retry = setTimeout(() => { this.retry = null; void this.connect(generation); }, delay);
    });
    ws.on('error', () => undefined);
  }

  private onLine(ws: WebSocket, raw: string): void {
    const line = parseIrcLine(raw);
    if (!line) return;
    switch (line.command) {
      case 'PING':
        ws.send(`PONG :${line.params[0] ?? 'tmi.twitch.tv'}`);
        return;
      case 'RECONNECT':
        ws.close();
        return;
      case 'ROOMSTATE':
        this.attempts = 0;
        this.ctx.state.patch('portal', { status: 'connected', error: undefined });
        this.deps.broadcast(this.configMessage());
        return;
      case 'CLEARMSG':
        if (line.tags['target-msg-id']) this.remove(`in:${line.tags['target-msg-id']}`);
        return;
      case 'PRIVMSG':
        return this.onPartnerMessage(line);
    }
  }

  private onPartnerMessage(line: IrcLine): void {
    const cfg = this.cfg;
    let text = line.params[1] ?? '';
    const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
    if (action) text = action[1];
    const login = line.prefix.split('!')[0] ?? '';
    const hidden = this.ctx.settings.get('chatOverlay').hideBots.map((b) => b.trim().toLowerCase());
    if (hidden.includes(login.toLowerCase())) return;
    const prefix = this.ctx.settings.get('bot').prefix;
    let body = text;
    let fragments = ircFragments(text, line.tags.emotes);
    if (cfg.mode === 'command') {
      const parsed = parsePortalCommand(text, prefix, cfg.command);
      if (!parsed) return;
      body = parsed.args.join(' ');
      // Emote positions refer to the full text: keep emotes, re-split the rest.
      const skip = [...text].length - [...text.trimStart()].length + parsed.prefix.length + parsed.name.length;
      fragments = trimFragments(fragments, skip);
    } else if (text.trim().startsWith(prefix) || text.trim().startsWith('!')) return;
    if (!this.allow()) return;
    this.emit({
      id: `in:${line.tags.id ?? Date.now().toString(36)}`,
      direction: 'in',
      userName: line.tags['display-name'] || login,
      color: line.tags.color || undefined,
      text: stripLinks(body),
      fragments: fragments.map((f) => (f.type === 'text' ? { ...f, text: stripLinks(f.text) } : f)),
      channel: this.channel,
      at: Date.now(),
    });
  }

  private onOwnChat(m: ChatMessage): void {
    const cfg = this.cfg;
    if (!cfg.enabled || !cfg.showOutgoing || !this.channel || m.fromSelf) return;
    const parsed = parseCommand(m.text, this.ctx.settings.get('bot').prefix);
    if (!parsed || parsed.name !== cfg.command.trim().toLowerCase().replace(/^[!/]+/, '') || !parsed.args.length) return;
    const body = parsed.args.join(' ');
    this.emit({ id: `out:${m.id}`, direction: 'out', userName: m.userName, color: m.color, text: stripLinks(body), fragments: [{ type: 'text', text: stripLinks(body) }], channel: this.channel, at: Date.now() }, false);
  }

  /** Rate limit for incoming messages (per minute). */
  private allow(): boolean {
    const now = Date.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= Math.max(1, this.cfg.maxPerMinute)) return false;
    this.sentAt.push(now);
    return true;
  }

  private emit(message: PortalMessage, relay = true): void {
    if (!message.text.trim() || matchesBannedWord(message.text, this.ctx.settings.get('bot').moderation.words.list)) return;
    this.deps.broadcast({ type: 'portal', message });
    this.ctx.state.patch('portal', { messages: [message, ...this.ctx.state.current.portal.messages].slice(0, KEEP) });
    if (relay && message.direction === 'in' && this.cfg.relayToChat && Date.now() - this.relayAt > 3000) {
      this.relayAt = Date.now();
      void this.deps.say(renderTemplate('🌀 [{channel}] {user}: {text}', { channel: message.channel, user: message.userName, text: message.text.slice(0, 300) })).catch(() => undefined);
    }
  }

  private remove(id: string): void {
    this.deps.broadcast({ type: 'portalDelete', id });
    this.ctx.state.patch('portal', { messages: this.ctx.state.current.portal.messages.filter((m) => m.id !== id) });
  }

  /** A sample message from the other side, to set up the overlay. */
  test(): void {
    const ru = this.ru;
    this.emit({ id: `test:${Date.now()}`, direction: 'in', userName: ru ? 'Гость_портала' : 'Portal_guest', color: '#3fa7ff', text: ru ? 'Привет из соседнего чата! 👋' : 'Hello from the other chat! 👋', fragments: [{ type: 'text', text: ru ? 'Привет из соседнего чата! 👋' : 'Hello from the other chat! 👋' }], channel: this.channel || this.cfg.partner || 'partner', at: Date.now() }, false);
  }

  private close(): void {
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.close();
    }
  }

  stop(): void {
    this.close();
  }
}

/** Drop the first `count` code points from fragments (the "!портал " part). */
export function trimFragments(fragments: ChatFragment[], count: number): ChatFragment[] {
  let left = count;
  const out: ChatFragment[] = [];
  for (const f of fragments) {
    if (left <= 0) { out.push(f); continue; }
    const chars = [...f.text];
    if (f.type !== 'text') { left -= chars.length; continue; }
    if (chars.length <= left) { left -= chars.length; continue; }
    out.push({ ...f, text: chars.slice(left).join('').trimStart() });
    left = 0;
  }
  return out.filter((f) => f.text);
}
