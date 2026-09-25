import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { OverlayKind, OverlayMessage } from '@shared/types';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

export const OVERLAY_KINDS: OverlayKind[] = ['chat', 'alerts', 'goal', 'timer', 'events'];

interface Client {
  ws: WebSocket;
  kind: OverlayKind;
  id: string | null;
}

export interface OverlayServerOptions {
  port: number;
  overlaysDir: string;
  mediaDir: string;
  /** Messages a freshly connected overlay needs to render its current state. */
  initialMessages: (kind: OverlayKind, id: string | null) => OverlayMessage[];
  onClientsChanged: (count: number) => void;
  /** Extra routes (OAuth callbacks). Return true if handled. */
  extraRoute?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
}

/** Resolve `rel` inside `root`, refusing path traversal. */
export function safeJoin(root: string, rel: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(rel);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes('\0')) return null;
  const full = normalize(join(root, decoded));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return full.startsWith(base) ? full : null;
}

export class OverlayServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();

  constructor(private opts: OverlayServerOptions) {}

  get port(): number {
    return this.opts.port;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/ws') return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, url));
      });
      server.once('error', reject);
      server.listen(this.opts.port, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (err) => console.error('[overlay] server error', err));
        this.server = server;
        this.wss = wss;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.ws.close();
    this.clients.clear();
    this.wss?.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  async restart(port: number): Promise<void> {
    await this.stop();
    this.opts.port = port;
    await this.start();
  }

  /** Send to every overlay of a kind (optionally only the one bound to `id`, e.g. a specific goal). */
  broadcast(kind: OverlayKind | OverlayKind[], msg: OverlayMessage, id?: string): void {
    const kinds = Array.isArray(kind) ? kind : [kind];
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (!kinds.includes(c.kind)) continue;
      if (id !== undefined && c.id !== id) continue;
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  /** Send a per-client message (e.g. each goal overlay gets its own goal). */
  forEachClient(kind: OverlayKind, fn: (id: string | null) => OverlayMessage | null): void {
    for (const c of this.clients) {
      if (c.kind !== kind || c.ws.readyState !== c.ws.OPEN) continue;
      const msg = fn(c.id);
      if (msg) c.ws.send(JSON.stringify(msg));
    }
  }

  private onConnection(ws: WebSocket, url: URL): void {
    const kind = url.searchParams.get('kind') as OverlayKind;
    if (!OVERLAY_KINDS.includes(kind)) return ws.close(1008, 'unknown overlay kind');
    const client: Client = { ws, kind, id: url.searchParams.get('id') };
    this.clients.add(client);
    this.opts.onClientsChanged(this.clients.size);
    for (const m of this.opts.initialMessages(kind, client.id)) ws.send(JSON.stringify(m));
    // Keep NAT-less localhost connections alive and detect dead browser sources.
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 30_000);
    ws.on('close', () => {
      clearInterval(ping);
      this.clients.delete(client);
      this.opts.onClientsChanged(this.clients.size);
    });
    ws.on('error', () => undefined);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (this.opts.extraRoute && (await this.opts.extraRoute(req, res, url))) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.send(res, 405, 'Method not allowed');

      if (url.pathname === '/' || url.pathname === '/overlay' || url.pathname === '/overlay/') {
        return this.send(res, 200, this.indexPage(), 'text/html; charset=utf-8');
      }
      const overlay = /^\/overlay\/([a-z]+)\/?$/.exec(url.pathname);
      if (overlay && OVERLAY_KINDS.includes(overlay[1] as OverlayKind)) {
        return this.sendFile(res, join(this.opts.overlaysDir, `${overlay[1]}.html`));
      }
      if (url.pathname.startsWith('/overlay/assets/')) {
        const file = safeJoin(join(this.opts.overlaysDir, 'assets'), url.pathname.slice('/overlay/assets/'.length));
        return file ? this.sendFile(res, file) : this.send(res, 400, 'Bad path');
      }
      if (url.pathname.startsWith('/media/')) {
        const file = safeJoin(this.opts.mediaDir, url.pathname.slice('/media/'.length));
        return file ? this.sendFile(res, file, req) : this.send(res, 400, 'Bad path');
      }
      this.send(res, 404, 'Not found');
    } catch (err) {
      console.error('[overlay] request failed', err);
      if (!res.headersSent) this.send(res, 500, 'Internal error');
    }
  }

  private send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  /** Serves files with Range support so OBS/Chromium can seek audio/video. */
  private sendFile(res: ServerResponse, file: string, req?: IncomingMessage): void {
    if (!existsSync(file) || !statSync(file).isFile()) return this.send(res, 404, 'Not found');
    const size = statSync(file).size;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = req?.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return void res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  }

  private indexPage(): string {
    const links = OVERLAY_KINDS.map((k) => `<li><a href="/overlay/${k}">/overlay/${k}</a></li>`).join('');
    return `<!doctype html><meta charset="utf-8"><title>StreamHelper overlays</title>
<body style="font-family:system-ui;background:#111;color:#eee;padding:24px">
<h1>StreamHelper</h1><p>Добавьте эти адреса в OBS как «Браузер» / Add these URLs to OBS as Browser Sources:</p><ul>${links}</ul></body>`;
  }
}
