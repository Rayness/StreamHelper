import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultSettings } from '@shared/defaults';
import { defaultEventStudio, newEventScene } from '@shared/eventStudio';
import { remoteAllowed } from '@shared/remote';
import { initialRuntimeState } from '../src/main/core/state';
import { RemoteServer } from '../src/main/remote/server';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('keeps executable scenes owner-only for moderator settings writes and resets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamhelper-scene-remote-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets')); writeFileSync(join(dir, 'index.html'), '<html><head></head></html>');
  const settings = defaultSettings('en');
  const scene = { ...newEventScene(), id: 'live', published: true };
  settings.alerts.studio = { ...defaultEventStudio(), enabled: true, scenes: [scene], bindings: { donation: scene.id } };
  const calls: { channel: string; args: unknown[] }[] = [];
  const server = new RemoteServer({ port: 0, rendererDir: dir, overlayPort: () => 1,
    moderators: () => [{ id: 'mod', name: 'Mod', key: 'key-mod', permissions: ['settings'], createdAt: 0 }],
    invoke: async (channel, args) => { calls.push({ channel, args }); return true; },
    snapshot: () => ({ state: initialRuntimeState(), settings }), onClientsChanged: () => undefined, onAction: () => undefined });
  cleanup.push(() => server.stop()); await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/remote/ws`, { headers: { Cookie: 'sh_remote=key-mod' } });
  cleanup.push(() => ws.terminate());
  const replies = new Map<number, (value: Record<string, unknown>) => void>();
  ws.on('message', (raw) => { const data = JSON.parse(String(raw)); if (data.t === 'res') replies.get(data.id)?.(data); });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const call = (channel: string, ...args: unknown[]) => new Promise<Record<string, unknown>>((resolve) => { const seq = ++id; replies.set(seq, resolve); ws.send(JSON.stringify({ t: 'call', id: seq, channel, args })); });
  const malicious = { ...settings.alerts, studio: { ...settings.alerts.studio, scenes: [{ ...scene, js: 'bad()' }] } };
  expect(await call('settings:set', ['alerts'], malicious)).toMatchObject({ denied: true });
  expect(calls).toEqual([]);
  expect(await call('settings:set', 'alerts', malicious, undefined, malicious)).toMatchObject({ ok: true });
  expect(calls[0].args[1]).toMatchObject({ studio: settings.alerts.studio });
  expect(calls[0].args[3]).toMatchObject({ studio: settings.alerts.studio });
  expect(await call('settings:reset', 'alerts')).toMatchObject({ ok: true });
  expect(calls[1]).toMatchObject({ channel: 'settings:set', args: ['alerts', expect.objectContaining({ studio: settings.alerts.studio })] });
  for (const channel of ['scene:ai:get', 'scene:ai:configure', 'scene:ai:generate', 'scene:mcp:status', 'scene:mcp:configure', 'scene:test']) {
    expect(await call(channel)).toMatchObject({ denied: true });
  }
});

it('does not coerce array/object setting keys into privileged sections', () => {
  expect(remoteAllowed(['settings'], 'settings:set', [['alerts'], {}])).toBe(false);
  expect(remoteAllowed(['settings'], 'settings:reset', [['alerts']])).toBe(false);
  expect(remoteAllowed(['settings'], 'settings:set', [{ toString: () => 'alerts' }, {}])).toBe(false);
});
