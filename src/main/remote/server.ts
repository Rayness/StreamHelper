import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { extname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IpcPush, RuntimeState, Settings } from '@shared/types';
import { remoteAllowed, remoteReadOnly, type RemoteClientInfo, type RemoteLogEntry, type RemoteModerator, type RemoteSession } from '@shared/remote';
import { safeJoin } from '../overlay/server';
import { REMOTE_SHIM } from './shim';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export const REMOTE_COOKIE = 'sh_remote';
/** Close codes the browser shim understands. */
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_KICKED = 4003;

/** Paths of the local overlay server a moderator's browser may load (overlay previews, media). */
const PROXIED = /^\/(overlay|media|tts|reports)\//;

export interface RemoteServerOptions {
  port: number;
  /** Built renderer (index.html + assets). */
  rendererDir: string;
  /** Local overlay server port, for previews. */
  overlayPort: () => number;
  /** Current moderators; looked up on every call so edits apply at once. */
  moderators: () => (RemoteModerator & { key: string })[];
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
  onClientsChanged: (clients: RemoteClientInfo[]) => void;
  onAction: (entry: RemoteLogEntry) => void;
  /** Current state and settings, sent on every (re)connect so a browser that was offline catches up. */
  snapshot: () => { state: RuntimeState; settings: Settings };
}

interface Client {
  info: RemoteClientInfo;
  ws: WebSocket;
}

const hash = (value: string) => createHash('sha256').update(value).digest();

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** What a moderator's browser may see of the runtime state: no dock key, no remote access details. */
export function remoteView(state: RuntimeState): RuntimeState {
  return { ...state, dockUrl: '', remote: { ...state.remote, moderators: [], clients: [], log: [], addresses: [] } };
}

/**
 * Remote access for moderators: serves the app UI to a browser on another computer and runs its
 * calls through the same handlers as the app window, after checking the moderator's permissions.
 */
export class RemoteServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout | null = null;
  private alive = new WeakSet<WebSocket>();
  private indexHtml: string | null = null;

  constructor(private opts: RemoteServerOptions) {}

  get port(): number {
    return this.opts.port;
  }

  get running(): boolean {
    return !!this.server;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
      server.on('upgrade', (req, socket, head) => this.upgrade(wss, req, socket, head));
      server.once('error', reject);
      // Every interface: moderators connect from other computers.
      server.listen(this.opts.port, () => {
        if (this.opts.port === 0) this.opts.port = (server.address() as import('node:net').AddressInfo).port;
        server.off('error', reject);
        server.on('error', (err) => console.error('[remote] server error', err));
        this.server = server;
        this.wss = wss;
        this.heartbeat = setInterval(() => {
          for (const c of this.clients) {
            if (!this.alive.has(c.ws)) { c.ws.terminate(); continue; }
            this.alive.delete(c.ws);
            if (c.ws.readyState === c.ws.OPEN) c.ws.ping();
          }
        }, 30_000);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.notify();
    this.wss?.close();
    const server = this.server;
    this.server = null;
    this.wss = null;
    await new Promise<void>((r) => {
      if (!server) return r();
      server.close(() => r());
      server.closeAllConnections();
    });
  }

  /** Forward an app push to every connected moderator. */
  push<K extends keyof IpcPush>(channel: K, payload: IpcPush[K]): void {
    if (!this.clients.size) return;
    const data = JSON.stringify({ t: 'push', channel, payload: channel === 'state' ? remoteView(payload as RuntimeState) : payload });
    for (const c of this.clients) this.send(c, data);
  }

  /** Close every session of a moderator (removed, or the key was reset). */
  disconnectModerator(moderatorId: string, code = CLOSE_UNAUTHORIZED): void {
    for (const c of [...this.clients]) if (c.info.moderatorId === moderatorId) c.ws.close(code, 'signed out');
  }

  /** Permissions changed: the moderator's UI reloads to show the new set. */
  reloadModerator(moderatorId: string): void {
    for (const c of this.clients) if (c.info.moderatorId === moderatorId) this.send(c, JSON.stringify({ t: 'reload' }));
  }

  kick(clientId: string): void {
    for (const c of [...this.clients]) if (c.info.id === clientId) c.ws.close(CLOSE_KICKED, 'kicked');
  }

  private send(c: Client, data: string): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    // A stalled browser must not pile up state pushes in memory.
    if (c.ws.bufferedAmount > 8 * 1024 * 1024) { c.ws.terminate(); return; }
    c.ws.send(data);
  }

  private moderator(key: string | null): (RemoteModerator & { key: string }) | null {
    if (!key) return null;
    const given = hash(key);
    let found: (RemoteModerator & { key: string }) | null = null;
    // Compare against every key in constant time, so timing tells nothing about which one matched.
    for (const m of this.opts.moderators()) if (timingSafeEqual(given, hash(m.key))) found = m;
    return found;
  }

  private notify(): void {
    this.opts.onClientsChanged([...this.clients].map((c) => c.info));
  }

  private upgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://remote');
    const moderator = this.moderator(readCookie(req.headers.cookie, REMOTE_COOKIE));
    if (!moderator) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (url.pathname === '/ws') { this.proxyUpgrade(req, socket, head); return; }
    if (url.pathname !== '/remote/ws') { socket.destroy(); return; }
    // Another site's page can't drive the app with the moderator's cookie.
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* invalid origin */ }
      if (host !== req.headers.host) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req, moderator));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage, moderator: RemoteModerator): void {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    const client: Client = {
      ws,
      info: { id: randomBytes(8).toString('hex'), moderatorId: moderator.id, name: moderator.name, address: forwarded || (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), since: Date.now() },
    };
    this.clients.add(client);
    this.alive.add(ws);
    this.notify();
    ws.on('pong', () => this.alive.add(ws));
    ws.on('close', () => {
      this.clients.delete(client);
      this.notify();
    });
    ws.on('error', () => undefined);
    ws.on('message', (raw) => void this.onMessage(client, raw.toString()));
    const { state, settings } = this.opts.snapshot();
    this.send(client, JSON.stringify({ t: 'push', channel: 'state', payload: remoteView(state) }));
    this.send(client, JSON.stringify({ t: 'push', channel: 'settings', payload: settings }));
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let msg: { t?: unknown; id?: unknown; channel?: unknown; args?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.channel !== 'string') return;
    const { id, channel } = msg;
    const args = Array.isArray(msg.args) ? msg.args : [];
    const reply = (body: object) => this.send(client, JSON.stringify({ t: 'res', id, ...body }));
    // Fresh lookup: a removed moderator or a revoked permission stops working immediately.
    const moderator = this.opts.moderators().find((m) => m.id === client.info.moderatorId);
    if (!moderator) { client.ws.close(CLOSE_UNAUTHORIZED, 'signed out'); return; }
    if (!remoteAllowed(moderator.permissions, channel, args)) return reply({ ok: false, error: 'forbidden', denied: true });
    try {
      let value = await this.opts.invoke(channel, args);
      if (channel === 'app:init' && value && typeof value === 'object') {
        const init = value as { state: RuntimeState };
        const session: RemoteSession = { name: moderator.name, permissions: moderator.permissions };
        value = { ...init, state: remoteView(init.state), remote: session };
      }
      if (!remoteReadOnly(channel)) {
        this.opts.onAction({ at: Date.now(), name: moderator.name, action: channel, detail: channel.startsWith('settings:') ? String(args[0]) : undefined });
      }
      reply({ ok: true, value: value ?? null });
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://remote');
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.text(res, 405, 'Method not allowed');
      const key = url.searchParams.get('key');
      if (url.pathname === '/' && key !== null) {
        // Sign in from the invite link: keep the key in a cookie and drop it from the address bar.
        if (!this.moderator(key)) return this.html(res, 401, loginPage(true));
        res.writeHead(302, {
          'Set-Cookie': `${REMOTE_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
          Location: '/',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        return void res.end();
      }
      if (url.pathname === '/logout') {
        res.writeHead(302, { 'Set-Cookie': `${REMOTE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, Location: '/' });
        return void res.end();
      }
      if (url.pathname === '/favicon.ico') return this.text(res, 404, 'Not found');
      if (!this.moderator(readCookie(req.headers.cookie, REMOTE_COOKIE))) {
        return url.pathname === '/' ? this.html(res, 200, loginPage(false)) : this.text(res, 401, 'Unauthorized');
      }
      if (url.pathname === '/' || url.pathname === '/index.html') return this.html(res, 200, this.index(), this.csp(req));
      if (url.pathname === '/remote/shim.js') return this.text(res, 200, REMOTE_SHIM, 'text/javascript; charset=utf-8');
      if (url.pathname.startsWith('/assets/')) {
        const file = safeJoin(join(this.opts.rendererDir, 'assets'), url.pathname.slice('/assets/'.length));
        return file ? this.file(res, file, req) : this.text(res, 400, 'Bad path');
      }
      if (PROXIED.test(url.pathname)) return this.proxy(req, res);
      this.text(res, 404, 'Not found');
    } catch (err) {
      console.error('[remote] request failed', err);
      if (!res.headersSent) this.text(res, 500, 'Internal error');
    }
  }

  /** The app page with the shim that replaces Electron IPC by the websocket. */
  private index(): string {
    if (this.indexHtml === null) {
      const html = readFileSync(join(this.opts.rendererDir, 'index.html'), 'utf8');
      this.indexHtml = html
        .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '')
        .replace(/<head>/i, '<head>\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <script src="/remote/shim.js"></script>');
    }
    return this.indexHtml;
  }

  private csp(req: IncomingMessage): string {
    const host = String(req.headers.host ?? '').replace(/[^\w.:[\]-]/g, '');
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      "frame-src 'self'",
      `connect-src 'self' ws://${host} wss://${host}`,
      "font-src 'self' data:",
    ].join('; ');
  }

  /** Overlay previews and media come from the local overlay server, behind the moderator's sign-in. */
  private proxy(req: IncomingMessage, res: ServerResponse): void {
    const headers = { ...req.headers, host: `127.0.0.1:${this.opts.overlayPort()}` };
    delete headers.cookie;
    const upstream = request({ host: '127.0.0.1', port: this.opts.overlayPort(), method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) this.text(res, 502, 'Overlay server unavailable'); else res.destroy(); });
    res.on('close', () => upstream.destroy());
    upstream.end();
  }

  private proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = this.opts.overlayPort();
    const upstream: Socket = connect(port, '127.0.0.1', () => {
      const lines = [`GET ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === 'cookie' || value === undefined) continue;
        if (name === 'host') { lines.push(`Host: 127.0.0.1:${port}`); continue; }
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
  }

  private file(res: ServerResponse, file: string, req: IncomingMessage): void {
    if (!existsSync(file) || !statSync(file).isFile()) return this.text(res, 404, 'Not found');
    const body = readFileSync(file);
    // Built assets have content hashes in their names.
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  private html(res: ServerResponse, status: number, body: string, csp?: string): void {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      ...(csp ? { 'Content-Security-Policy': csp } : {}),
    });
    res.end(body);
  }

  private text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }
}

function loginPage(wrongKey: boolean): string {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>StreamHelper</title>
<style>
:root{color-scheme:dark;--bg:#0e0e13;--panel:#1b1b25;--line:#3a3a4c;--text:#eee;--muted:#9a9aae;--accent:#9b6bff;--err:#ff6b7a}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f4f8;--panel:#fff;--line:#c8c8d4;--text:#16161d;--muted:#5d5d70;--err:#c4283a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;max-width:380px;width:100%;box-sizing:border-box}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px;font-size:14px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:14px ui-monospace,monospace}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:15px;cursor:pointer}
.err{color:var(--err)}
</style>
<form method="get" action="/">
<h1>StreamHelper</h1>
<p>Удалённый доступ для модераторов. Откройте ссылку-приглашение от стримера или вставьте ключ.<br>Remote access for moderators. Open the invite link from the streamer or paste your key.</p>
${wrongKey ? '<p class="err">Ключ не подошёл: возможно, стример его сменил. / The key did not work: the streamer may have changed it.</p>' : ''}
<input name="key" autocomplete="off" spellcheck="false" placeholder="Ключ / Key" aria-label="Ключ / Key" required>
<button type="submit">Войти / Sign in</button>
</form></html>`;
}
