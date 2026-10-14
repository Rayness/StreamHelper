import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RuntimeState, Settings } from '@shared/types';
import { remoteAllowed, settingsPermission, type RemoteLogEntry, type RemoteModerator } from '@shared/remote';
import { CLOSE_UNAUTHORIZED, RemoteServer, readCookie } from '../src/main/remote/server';
import { linkBase } from '../src/main/remote/service';

describe('remote permissions', () => {
  it('maps calls to the permission they need', () => {
    expect(remoteAllowed([], 'app:init', [])).toBe(true);
    expect(remoteAllowed([], 'alerts:skip', [])).toBe(false);
    expect(remoteAllowed(['alerts'], 'alerts:skip', [])).toBe(true);
    expect(remoteAllowed(['alerts'], 'chat:ban', ['1'])).toBe(false);
    expect(remoteAllowed(['chat'], 'chat:ban', ['1'])).toBe(true);
    expect(remoteAllowed(['songs'], 'song:skip', [])).toBe(true);
  });

  it('never allows logins, files, updates or remote access itself', () => {
    const all = ['stream', 'obs', 'chat', 'alerts', 'songs', 'tts', 'interactive', 'settings'] as const;
    for (const channel of ['twitch:login', 'da:login', 'yandex:setToken', 'obs:connect', 'media:import', 'song:importLocal', 'update:install', 'report:open',
      'shell:openExternal', 'clipboard:write', 'profiles:delete', 'remote:addModerator', 'remote:link', 'remote:configure', 'constructor', '__proto__']) {
      expect(remoteAllowed(all, channel, [])).toBe(false);
    }
  });

  it('checks settings writes per section', () => {
    expect(settingsPermission('overlayPort')).toBeNull();
    expect(settingsPermission('obs')).toBeNull();
    expect(settingsPermission('appearance')).toBeNull();
    expect(settingsPermission('songRequests')).toBe('songs');
    expect(settingsPermission('poll')).toBe('settings');
    expect(remoteAllowed(['settings'], 'settings:set', ['overlayPort', 1])).toBe(false);
    expect(remoteAllowed(['settings'], 'settings:set', ['poll', {}])).toBe(true);
    expect(remoteAllowed(['settings'], 'settings:set', ['songRequests', {}])).toBe(false);
    expect(remoteAllowed(['songs'], 'settings:set', ['songRequests', {}])).toBe(true);
    expect(remoteAllowed(['songs'], 'settings:reset', ['poll'])).toBe(false);
  });

  it('builds invite link bases', () => {
    expect(linkBase('192.168.1.5', 4848)).toBe('http://192.168.1.5:4848');
    expect(linkBase('100.64.0.2:9000', 4848)).toBe('http://100.64.0.2:9000');
    expect(linkBase('https://abc.trycloudflare.com/', 4848)).toBe('https://abc.trycloudflare.com');
    expect(linkBase('fe80::1', 4848)).toBe('http://[fe80::1]:4848');
  });

  it('reads cookies', () => {
    expect(readCookie('a=1; sh_remote=abc%2B; b=2', 'sh_remote')).toBe('abc+');
    expect(readCookie('xsh_remote=1', 'sh_remote')).toBeNull();
    expect(readCookie(undefined, 'sh_remote')).toBeNull();
  });
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

const KEY = 'good-key-0123456789';

async function setup(permissions: RemoteModerator['permissions'] = ['alerts', 'settings']) {
  const dir = mkdtempSync(join(tmpdir(), 'streamhelper-remote-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'" /><script type="module" src="./assets/app.js"></script></head><body></body></html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  const moderators = [{ id: 'm1', name: 'Mod', permissions, createdAt: 0, key: KEY }];
  const calls: { channel: string; args: unknown[] }[] = [];
  const log: RemoteLogEntry[] = [];
  const state = { dockUrl: 'http://127.0.0.1:1/dock?token=secret', overlayUrl: 'http://localhost:1', remote: { status: 'running', port: 0, addresses: ['10.0.0.1'], moderators: [{ id: 'm1' }], clients: [], log: [], error: null } } as unknown as RuntimeState;
  const server = new RemoteServer({
    port: 0,
    rendererDir: dir,
    overlayPort: () => 1,
    moderators: () => moderators,
    invoke: async (channel, args) => {
      calls.push({ channel, args });
      if (channel === 'app:init') return { state, settings: {} };
      return null;
    },
    onClientsChanged: () => undefined,
    onAction: (entry) => log.push(entry),
    snapshot: () => ({ state, settings: { language: 'ru' } as Settings }),
  });
  cleanups.push(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
  await server.start();
  const url = `http://127.0.0.1:${server.port}`;
  return { server, url, calls, log, moderators };
}

function open(url: string, cookie?: string, origin?: string) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/remote/ws', { headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) } });
  const messages: { t: string; [k: string]: unknown }[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); waiters.splice(0).forEach((w) => w()); });
  const next = async (pred: (m: (typeof messages)[number]) => boolean) => {
    for (;;) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  let seq = 0;
  const call = async (channel: string, ...args: unknown[]) => {
    const id = ++seq;
    ws.send(JSON.stringify({ t: 'call', id, channel, args }));
    return next((m) => m.t === 'res' && m.id === id);
  };
  return { ws, messages, next, call };
}

describe('remote server', () => {
  it('signs in with the invite link and serves the app with the shim', async () => {
    const h = await setup();
    const login = await fetch(h.url + '/');
    expect(await login.text()).toContain('<form');
    expect((await fetch(h.url + '/?key=wrong')).status).toBe(401);
    expect((await fetch(h.url + '/assets/app.js')).status).toBe(401);

    const signIn = await fetch(h.url + `/?key=${KEY}`, { redirect: 'manual' });
    expect(signIn.status).toBe(302);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    expect(signIn.headers.get('set-cookie')).toContain('HttpOnly');

    const page = await fetch(h.url + '/', { headers: { Cookie: cookie } });
    const html = await page.text();
    expect(html).toContain('/remote/shim.js');
    expect(html).not.toContain('http-equiv="Content-Security-Policy"');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await fetch(h.url + '/assets/app.js', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(h.url + '/remote/shim.js', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('refuses sockets without a valid key or from another site', async () => {
    const h = await setup();
    const anonymous = open(h.url);
    await expect(new Promise((resolve, reject) => { anonymous.ws.on('open', resolve); anonymous.ws.on('error', reject); })).rejects.toThrow();
    const foreign = open(h.url, `sh_remote=${KEY}`, 'http://evil.example');
    await expect(new Promise((resolve, reject) => { foreign.ws.on('open', resolve); foreign.ws.on('error', reject); })).rejects.toThrow();
  });

  it('runs allowed calls, refuses the rest and hides local secrets', async () => {
    const h = await setup();
    const c = open(h.url, `sh_remote=${KEY}`, h.url);
    const pushed = await c.next((m) => m.t === 'push' && m.channel === 'state');
    expect((pushed.payload as RuntimeState).dockUrl).toBe('');
    expect((pushed.payload as RuntimeState).remote.moderators).toEqual([]);

    const init = await c.call('app:init');
    expect(init.ok).toBe(true);
    const value = init.value as { remote: unknown; state: RuntimeState };
    expect(value.remote).toEqual({ name: 'Mod', permissions: ['alerts', 'settings'] });
    expect(value.state.dockUrl).toBe('');
    expect(value.state.remote.addresses).toEqual([]);

    expect(await c.call('alerts:skip')).toMatchObject({ ok: true });
    expect(await c.call('chat:ban', 'u1')).toMatchObject({ ok: false, denied: true });
    expect(await c.call('settings:set', 'overlayPort', 1)).toMatchObject({ ok: false, denied: true });
    expect(await c.call('settings:set', 'poll', {})).toMatchObject({ ok: true });
    expect(await c.call('twitch:login', 'broadcaster')).toMatchObject({ ok: false, denied: true });

    expect(h.calls.map((x) => x.channel)).toEqual(['app:init', 'alerts:skip', 'settings:set']);
    expect(h.log.map((e) => [e.name, e.action, e.detail])).toEqual([['Mod', 'alerts:skip', undefined], ['Mod', 'settings:set', 'poll']]);
  });

  it('applies permission changes at once and signs removed moderators out', async () => {
    const h = await setup();
    const c = open(h.url, `sh_remote=${KEY}`);
    await c.next((m) => m.t === 'push');
    h.moderators[0]!.permissions = [];
    expect(await c.call('alerts:skip')).toMatchObject({ ok: false, denied: true });
    const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
    h.server.disconnectModerator('m1');
    expect(await closed).toBe(CLOSE_UNAUTHORIZED);
  });
});
