import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RuntimeState, Settings } from '@shared/types';
import { initialRuntimeState, StateHub } from '../src/main/core/state';
import { EventBus } from '../src/main/core/eventBus';
import type { AppContext } from '../src/main/core/context';
import type { SecretsData } from '../src/main/core/secrets';
import { OverlayServer } from '../src/main/overlay/server';
import { CLOSE_KICKED, CLOSE_UNAUTHORIZED, RemoteServer } from '../src/main/remote/server';
import { RemoteAccessService } from '../src/main/remote/service';
import { REMOTE_SHIM } from '../src/main/remote/shim';
import type { RemoteClientInfo, RemoteModerator } from '@shared/remote';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function rendererDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'streamhelper-remote-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="x" /></head><body></body></html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'ok');
  writeFileSync(join(dir, 'secret.txt'), 'outside assets');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

type Mod = RemoteModerator & { key: string };

async function server(opts: { moderators?: Mod[]; overlayPort?: () => number; invoke?: (c: string, a: unknown[]) => Promise<unknown> } = {}) {
  const moderators: Mod[] = opts.moderators ?? [
    { id: 'm1', name: 'Anna', permissions: ['alerts'], createdAt: 0, key: 'key-anna' },
    { id: 'm2', name: 'Boris', permissions: ['chat'], createdAt: 0, key: 'key-boris' },
  ];
  const clients: RemoteClientInfo[][] = [];
  const state = { ...initialRuntimeState(), dockUrl: 'http://127.0.0.1:1/dock?token=t' };
  const s = new RemoteServer({
    port: 0,
    rendererDir: rendererDir(),
    overlayPort: opts.overlayPort ?? (() => 1),
    moderators: () => moderators,
    invoke: opts.invoke ?? (async (channel) => { if (channel === 'alerts:skip') throw new Error('nothing to skip'); if (channel === 'app:init') return { state, settings: {} }; return { echo: channel }; }),
    onClientsChanged: (list) => clients.push(list),
    onAction: () => undefined,
    snapshot: () => ({ state, settings: { language: 'en' } as Settings }),
  });
  cleanups.push(() => s.stop());
  await s.start();
  return { s, url: `http://127.0.0.1:${s.port}`, moderators, clients, state };
}

function socket(url: string, cookie: string, path = '/remote/ws', headers: Record<string, string> = {}) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + path, { headers: { Cookie: cookie, ...headers } });
  const messages: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); waiters.splice(0).forEach((w) => w()); });
  const next = async (pred: (m: Record<string, unknown>) => boolean) => {
    for (;;) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const opened = new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
  opened.catch(() => undefined);
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  let seq = 0;
  const call = async (channel: string, ...args: unknown[]) => {
    await opened;
    const id = ++seq;
    ws.send(JSON.stringify({ t: 'call', id, channel, args }));
    return next((m) => m.t === 'res' && m.id === id);
  };
  ws.on('error', () => undefined);
  cleanups.push(() => { if (ws.readyState === WebSocket.OPEN) ws.terminate(); });
  return { ws, messages, next, call, opened, closed };
}

describe('remote server: http', () => {
  it('rejects other methods, path traversal and unknown paths', async () => {
    const h = await server();
    const cookie = { Cookie: 'sh_remote=key-anna' };
    expect((await fetch(h.url + '/', { method: 'POST' })).status).toBe(405);
    expect((await fetch(h.url + '/assets/..%2Fsecret.txt', { headers: cookie })).status).toBe(400);
    expect((await fetch(h.url + '/assets/..%2F..%2Fsecret.txt', { headers: cookie })).status).toBe(400);
    expect((await fetch(h.url + '/assets/missing.js', { headers: cookie })).status).toBe(404);
    expect((await fetch(h.url + '/nope', { headers: cookie })).status).toBe(404);
    expect((await fetch(h.url + '/nope')).status).toBe(401);
    // POSTs to the overlay server (song player reports) are not exposed.
    expect((await fetch(h.url + '/song/finished', { method: 'POST', headers: cookie, body: '{}' })).status).toBe(405);
  });

  it('signs out and forgets removed moderators', async () => {
    const h = await server();
    const out = await fetch(h.url + '/logout', { redirect: 'manual' });
    expect(out.status).toBe(302);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await (await fetch(h.url + '/', { headers: { Cookie: 'sh_remote=key-anna' } })).text()).toContain('/remote/shim.js');
    h.moderators.splice(0, 1);
    const page = await (await fetch(h.url + '/', { headers: { Cookie: 'sh_remote=key-anna' } })).text();
    expect(page).toContain('<form');
    expect(page).not.toContain('shim.js');
  });

  it('keeps the key out of the address bar and caches only hashed assets', async () => {
    const h = await server();
    const r = await fetch(h.url + '/?key=key-boris', { redirect: 'manual' });
    expect(r.headers.get('location')).toBe('/');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const page = await fetch(h.url + '/', { headers: { Cookie: 'sh_remote=key-boris' } });
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const asset = await fetch(h.url + '/assets/app.js', { headers: { Cookie: 'sh_remote=key-boris' } });
    expect(asset.headers.get('cache-control')).toContain('private');
  });

  it('does not accept a key that only shares a prefix', async () => {
    const h = await server();
    expect((await fetch(h.url + '/?key=key-ann', { redirect: 'manual' })).status).toBe(401);
    expect((await fetch(h.url + '/?key=key-annaa', { redirect: 'manual' })).status).toBe(401);
    expect((await fetch(h.url + '/?key=', { redirect: 'manual' })).status).toBe(401);
  });
});

describe('remote server: sessions', () => {
  it('gives each key its own moderator and permissions', async () => {
    const h = await server();
    const anna = socket(h.url, 'sh_remote=key-anna');
    const boris = socket(h.url, 'sh_remote=key-boris');
    expect(((await anna.call('app:init')).value as { remote: unknown }).remote).toEqual({ name: 'Anna', permissions: ['alerts'] });
    expect(((await boris.call('app:init')).value as { remote: unknown }).remote).toEqual({ name: 'Boris', permissions: ['chat'] });
    expect(await anna.call('chat:send', 'hi')).toMatchObject({ ok: false, denied: true });
    expect(await boris.call('chat:send', 'hi')).toMatchObject({ ok: true });
  });

  it('reports handler errors to the caller and survives garbage', async () => {
    const h = await server();
    const c = socket(h.url, 'sh_remote=key-anna');
    await c.opened;
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ t: 'call', id: 'x', channel: 'alerts:pause' }));
    c.ws.send(JSON.stringify({ t: 'other' }));
    c.ws.send(JSON.stringify({ t: 'call', id: 99, channel: 42 }));
    expect(await c.call('alerts:skip')).toMatchObject({ ok: false, error: 'nothing to skip' });
    expect(await c.call('alerts:pause', true)).toMatchObject({ ok: true, value: { echo: 'alerts:pause' } });
  });

  it('tracks connected moderators with their address', async () => {
    const h = await server();
    const c = socket(h.url, 'sh_remote=key-boris', '/remote/ws', { 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' });
    await c.opened;
    await c.next((m) => m.t === 'push');
    expect(h.clients.at(-1)).toMatchObject([{ moderatorId: 'm2', name: 'Boris', address: '203.0.113.7' }]);
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(h.clients.at(-1)).toEqual([]);
  });

  it('kicks one session, reloads on permission change and forwards pushes filtered', async () => {
    const h = await server();
    const a = socket(h.url, 'sh_remote=key-anna');
    const b = socket(h.url, 'sh_remote=key-boris');
    await Promise.all([a.opened, b.opened]);
    await Promise.all([a.next((m) => m.t === 'push'), b.next((m) => m.t === 'push')]);

    h.s.push('state', { ...h.state, dockUrl: 'secret', remote: { ...h.state.remote, addresses: ['10.0.0.2'] } } as RuntimeState);
    h.s.push('chat:message', { id: 'c1' } as never);
    const state = await a.next((m) => m.t === 'push' && m.channel === 'state' && (m.payload as RuntimeState).remote !== undefined && a.messages.filter((x) => x.channel === 'state').length > 1);
    expect((state.payload as RuntimeState).dockUrl).toBe('');
    expect((state.payload as RuntimeState).remote.addresses).toEqual([]);
    await b.next((m) => m.t === 'push' && m.channel === 'chat:message');

    h.s.reloadModerator('m1');
    await a.next((m) => m.t === 'reload');
    expect(b.messages.some((m) => m.t === 'reload')).toBe(false);

    const id = h.clients.at(-1)!.find((c) => c.moderatorId === 'm2')!.id;
    h.s.kick(id);
    expect(await b.closed).toBe(CLOSE_KICKED);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes sessions of a moderator removed between calls', async () => {
    const h = await server();
    const c = socket(h.url, 'sh_remote=key-anna');
    await c.opened;
    h.moderators.splice(0, 1);
    c.ws.send(JSON.stringify({ t: 'call', id: 1, channel: 'alerts:pause', args: [true] }));
    expect(await c.closed).toBe(CLOSE_UNAUTHORIZED);
  });

  it('refuses websocket paths it does not know', async () => {
    const h = await server();
    const c = socket(h.url, 'sh_remote=key-anna', '/other');
    await expect(c.opened).rejects.toThrow();
  });
});

describe('remote server: overlay previews', () => {
  async function withOverlay() {
    const media = mkdtempSync(join(tmpdir(), 'streamhelper-media-'));
    writeFileSync(join(media, 'pic.png'), 'png');
    cleanups.push(() => rmSync(media, { recursive: true, force: true }));
    const overlay = new OverlayServer({ port: 0, overlaysDir: resolve('resources/overlays'), mediaDir: media, initialMessages: () => [{ type: 'profileVisibility', visible: true }], onClientsChanged: () => undefined });
    await overlay.start();
    cleanups.push(() => overlay.stop());
    return { overlay, ...(await server({ overlayPort: () => overlay.port })) };
  }

  it('proxies overlay pages and media behind the sign-in', async () => {
    const h = await withOverlay();
    expect((await fetch(h.url + '/overlay/chat')).status).toBe(401);
    const page = await fetch(h.url + '/overlay/chat', { headers: { Cookie: 'sh_remote=key-anna' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<');
    const media = await fetch(h.url + '/media/pic.png', { headers: { Cookie: 'sh_remote=key-anna', Range: 'bytes=0-1' } });
    expect(media.status).toBe(206);
    expect(await media.text()).toBe('pn');
    expect((await fetch(h.url + '/overlay/assets/common.js', { headers: { Cookie: 'sh_remote=key-anna' } })).status).toBe(200);
  });

  it('proxies the overlay websocket', async () => {
    const h = await withOverlay();
    const c = socket(h.url, 'sh_remote=key-anna', '/ws?kind=chat&preview=1');
    const msg = await c.next(() => true);
    expect(msg).toEqual({ type: 'profileVisibility', visible: true });
    const anonymous = socket(h.url, '', '/ws?kind=chat');
    await expect(anonymous.opened).rejects.toThrow();
  });

  it('answers 502 when the overlay server is down', async () => {
    const port = await freePort();
    const h = await server({ overlayPort: () => port });
    expect((await fetch(h.url + '/overlay/chat', { headers: { Cookie: 'sh_remote=key-anna' } })).status).toBe(502);
  });
});

// ---------- service ----------

function fakeCtx(overlayPort = 3000) {
  const bus = new EventBus();
  const state = new StateHub(bus);
  const secrets: SecretsData = {};
  const ctx = {
    bus,
    state,
    secrets: { get: (k: keyof SecretsData) => secrets[k], set: (k: keyof SecretsData, v: unknown) => { (secrets as Record<string, unknown>)[k] = v; } },
    settings: { get: (k: string) => (k === 'overlayPort' ? overlayPort : 'en'), all: {} },
    toast: () => undefined,
  } as unknown as AppContext;
  return { ctx, state, secrets };
}

async function service(overlayPort?: number) {
  const f = fakeCtx(overlayPort);
  const svc = new RemoteAccessService(f.ctx, { rendererDir: rendererDir(), overlayPort: () => 1, invoke: async () => null });
  cleanups.push(() => svc.stop());
  await svc.start();
  return { svc, ...f };
}

describe('remote access service', () => {
  it('is off until turned on and validates the port', async () => {
    const h = await service(3000);
    expect(h.state.current.remote.status).toBe('off');
    expect(() => h.svc.configure(true, 80)).toThrow();
    expect(() => h.svc.configure(true, 70000)).toThrow();
    expect(() => h.svc.configure(true, 1.5)).toThrow();
    expect(() => h.svc.configure(true, 3000)).toThrow(/overlay/);
    expect(h.secrets.remoteAccess).toBeUndefined();
  });

  it('runs, serves moderators by their link and stops', async () => {
    const h = await service();
    const port = await freePort();
    await h.svc.configure(true, port);
    expect(h.state.current.remote).toMatchObject({ status: 'running', port, error: null });

    const mod = h.svc.addModerator('  Anna   K  ', ['chat', 'bogus' as never, 'chat']);
    expect(mod).toMatchObject({ name: 'Anna K', permissions: ['chat'] });
    expect(mod).not.toHaveProperty('key');
    expect(h.state.current.remote.moderators).toEqual([mod]);
    expect(JSON.stringify(h.state.current)).not.toContain(h.secrets.remoteAccess!.moderators[0]!.key);

    const link = h.svc.link(mod.id, '127.0.0.1');
    expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?key=`));
    expect((await fetch(link, { redirect: 'manual' })).status).toBe(302);

    h.svc.resetKey(mod.id);
    expect((await fetch(link, { redirect: 'manual' })).status).toBe(401);
    expect((await fetch(h.svc.link(mod.id, '127.0.0.1'), { redirect: 'manual' })).status).toBe(302);

    await h.svc.configure(false, port);
    expect(h.state.current.remote.status).toBe('off');
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('edits and removes moderators', async () => {
    const h = await service();
    const mod = h.svc.addModerator('', []);
    expect(mod.name).toBe('Moderator');
    h.svc.updateModerator(mod.id, { name: 'X'.repeat(80), permissions: ['obs', 'settings'] });
    expect(h.state.current.remote.moderators[0]).toMatchObject({ name: 'X'.repeat(40), permissions: ['obs', 'settings'] });
    expect(() => h.svc.updateModerator('nope', { name: 'a' })).toThrow();
    expect(() => h.svc.link('nope')).toThrow();
    expect(() => h.svc.resetKey('nope')).toThrow();
    h.svc.removeModerator(mod.id);
    expect(h.state.current.remote.moderators).toEqual([]);
    expect(h.secrets.remoteAccess!.moderators).toEqual([]);
  });

  it('reports a busy port and recovers on another one', async () => {
    const h = await service();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, r));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const busy = (blocker.address() as import('node:net').AddressInfo).port;
    await h.svc.configure(true, busy);
    expect(h.state.current.remote.status).toBe('error');
    expect(h.state.current.remote.error).toContain(String(busy));
    const port = await freePort();
    await h.svc.configure(true, port);
    expect(h.state.current.remote).toMatchObject({ status: 'running', port, error: null });
  });

  it('settles on the last setting when toggled quickly', async () => {
    const h = await service();
    const port = await freePort();
    await Promise.all([h.svc.configure(true, port), h.svc.configure(false, port), h.svc.configure(true, port)]);
    expect(h.state.current.remote.status).toBe('running');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it('starts from saved settings', async () => {
    const f = fakeCtx();
    const port = await freePort();
    f.secrets.remoteAccess = { enabled: true, port, moderators: [{ id: 'm', name: 'M', permissions: ['chat'], createdAt: 1, key: 'k' }] };
    const svc = new RemoteAccessService(f.ctx, { rendererDir: rendererDir(), overlayPort: () => 1, invoke: async () => null });
    cleanups.push(() => svc.stop());
    await svc.start();
    expect(f.state.current.remote).toMatchObject({ status: 'running', port, moderators: [{ id: 'm', name: 'M', permissions: ['chat'], createdAt: 1 }] });
    expect((await fetch(`http://127.0.0.1:${port}/?key=k`, { redirect: 'manual' })).status).toBe(302);
  });
});

// ---------- browser shim ----------

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor(public url: string) { FakeSocket.last = this; FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  close(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

function loadShim(opts: { secure?: boolean; protocol?: string } = {}) {
  FakeSocket.all = [];
  const timers: (() => void)[] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const elements: { id?: string; textContent?: string; removed?: boolean }[] = [];
  const location = { protocol: opts.protocol ?? 'http:', host: '10.0.0.5:4848', origin: `${opts.protocol ?? 'http:'}//10.0.0.5:4848`, href: '/', reload: () => { location.href = 'reloaded'; } };
  const element = () => {
    const el = { id: '', textContent: '', style: { cssText: '' }, setAttribute() {}, remove() { el.removed = true; }, removed: false, value: '', select() {} };
    elements.push(el);
    return el;
  };
  const document = {
    getElementById: (id: string) => elements.find((e) => e.id === id && !e.removed) ?? null,
    createElement: element,
    body: { appendChild() {} },
    documentElement: {},
    execCommand: () => true,
  };
  const window: Record<string, unknown> = {
    isSecureContext: !!opts.secure,
    open: (url: string) => opened.push(url),
  };
  runInNewContext(REMOTE_SHIM, {
    window,
    location,
    document,
    navigator: { language: 'ru-RU', clipboard: { writeText: async (v: string) => { copied.push(v); } } },
    WebSocket: FakeSocket,
    setTimeout: (fn: () => void) => timers.push(fn),
    console,
    Promise,
    JSON,
    Map,
    Set,
    Error,
    Math,
    String,
  });
  const api = window.api as { invoke: (c: string, ...a: unknown[]) => Promise<unknown>; on: (c: string, l: (p: unknown) => void) => () => void };
  return { api, location, timers, opened, copied, elements };
}

describe('remote browser shim', () => {
  it('connects to the same host and queues calls until open', async () => {
    const h = loadShim();
    expect(FakeSocket.last.url).toBe('ws://10.0.0.5:4848/remote/ws');
    const result = h.api.invoke('alerts:skip');
    expect(FakeSocket.last.sent).toEqual([]);
    FakeSocket.last.open();
    const sent = JSON.parse(FakeSocket.last.sent[0]!);
    expect(sent).toMatchObject({ t: 'call', channel: 'alerts:skip', args: [] });
    FakeSocket.last.receive({ t: 'res', id: sent.id, ok: true, value: 5 });
    expect(await result).toBe(5);
  });

  it('uses wss on https', () => {
    loadShim({ protocol: 'https:' });
    expect(FakeSocket.last.url).toBe('wss://10.0.0.5:4848/remote/ws');
  });

  it('turns refusals and errors into rejections', async () => {
    const h = loadShim();
    FakeSocket.last.open();
    const denied = h.api.invoke('chat:ban', 'u');
    const failed = h.api.invoke('alerts:skip');
    const [a, b] = FakeSocket.last.sent.map((s) => JSON.parse(s).id);
    FakeSocket.last.receive({ t: 'res', id: a, ok: false, error: 'forbidden', denied: true });
    FakeSocket.last.receive({ t: 'res', id: b, ok: false, error: 'boom' });
    await expect(denied).rejects.toThrow('Нет прав');
    await expect(failed).rejects.toThrow('boom');
  });

  it('points overlay previews at the remote server', async () => {
    const h = loadShim();
    FakeSocket.last.open();
    const states: unknown[] = [];
    const off = h.api.on('state', (s) => states.push(s));
    FakeSocket.last.receive({ t: 'push', channel: 'state', payload: { overlayUrl: 'http://localhost:7000', live: true } });
    expect(states).toEqual([{ overlayUrl: 'http://10.0.0.5:4848', live: true }]);
    off();
    FakeSocket.last.receive({ t: 'push', channel: 'state', payload: { overlayUrl: 'x' } });
    expect(states).toHaveLength(1);

    const init = h.api.invoke('app:init');
    const id = JSON.parse(FakeSocket.last.sent.at(-1)!).id;
    FakeSocket.last.receive({ t: 'res', id, ok: true, value: { state: { overlayUrl: 'http://localhost:7000' }, version: '1' } });
    expect(await init).toEqual({ state: { overlayUrl: 'http://10.0.0.5:4848' }, version: '1' });
  });

  it('copies and opens links in the moderator browser, not on the streamer PC', async () => {
    const h = loadShim({ secure: true });
    FakeSocket.last.open();
    await h.api.invoke('clipboard:write', 'link');
    await h.api.invoke('shell:openExternal', 'https://twitch.tv');
    await h.api.invoke('shell:openExternal', 'file:///C:/Windows');
    expect(h.copied).toEqual(['link']);
    expect(h.opened).toEqual(['https://twitch.tv']);
    expect(FakeSocket.last.sent).toEqual([]);
  });

  it('reconnects after a drop and fails calls in flight', async () => {
    const h = loadShim();
    FakeSocket.last.open();
    const pending = h.api.invoke('alerts:skip');
    FakeSocket.last.close(1006);
    await expect(pending).rejects.toThrow('Нет связи');
    expect(h.elements.some((e) => e.id === 'remote-banner' && !e.removed)).toBe(true);
    expect(h.timers).toHaveLength(1);
    h.timers.shift()!();
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.last.open();
    expect(h.elements.some((e) => e.id === 'remote-banner' && !e.removed)).toBe(false);
  });

  it('goes to sign-in when the key is revoked, stops when kicked, reloads on request', () => {
    const revoked = loadShim();
    FakeSocket.last.open();
    FakeSocket.last.close(4001);
    expect(revoked.location.href).toBe('/');
    expect(revoked.timers).toHaveLength(0);

    const kicked = loadShim();
    FakeSocket.last.open();
    FakeSocket.last.close(4003);
    expect(kicked.timers).toHaveLength(0);
    expect(kicked.elements.find((e) => e.id === 'remote-banner')?.textContent).toContain('отключил');

    const reload = loadShim();
    FakeSocket.last.open();
    FakeSocket.last.receive({ t: 'reload' });
    expect(reload.location.href).toBe('reloaded');
  });
});
