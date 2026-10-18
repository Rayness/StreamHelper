import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { defaultEventStudio, newEventScene, SCENE_MAX_COUNT, type EventScene, type SceneEventData } from '@shared/eventStudio';
import { defaultSceneAiConfig } from '@shared/sceneAi';
import type { Settings, SettingsKey } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import type { SecretsData } from '../src/main/core/secrets';
import type { AlertQueue } from '../src/main/features/alerts';
import { SceneStudioService } from '../src/main/sceneStudio/service';

const API_KEY = 'private-scene-ai-key';
const INITIAL_TOKEN = 'private-scene-mcp-token-0123456789';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function setup() {
  const settings = defaultSettings('ru');
  const live = { ...newEventScene(), id: 'published-scene', published: true, name: 'Published scene' };
  settings.alerts.studio = { ...defaultEventStudio(), enabled: true, scenes: [live], bindings: { donation: live.id }, donationLevels: [{ id: 'level', name: 'Large', minAmount: 100, sceneId: live.id }] };
  let secrets: SecretsData['sceneStudio'] = { config: { ...defaultSceneAiConfig(), model: 'owner-model', systemPrompt: 'Brand: StreamHelper; style: anime; palette: purple.' }, apiKey: API_KEY, mcpToken: INITIAL_TOKEN, mcpEnabled: false };
  const setSettings = vi.fn(<K extends SettingsKey>(key: K, value: Settings[K]) => { settings[key] = value; });
  const enqueueScene = vi.fn();
  const localPreview = vi.fn();
  const ctx = {
    settings: { get: <K extends SettingsKey>(key: K): Settings[K] => settings[key], set: setSettings },
    secrets: { get: () => secrets, set: (_key: string, value: SecretsData['sceneStudio']) => { secrets = value; } },
  } as unknown as AppContext;
  const service = new SceneStudioService(ctx, { enqueueScene } as unknown as AlertQueue, localPreview);
  cleanups.push(() => service.stop());
  return { service, settings, live, secrets: () => secrets, setSettings, enqueueScene, localPreview };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  expect(port).toBeGreaterThanOrEqual(1024);
  return port;
}

async function call(service: SceneStudioService, method: string, params?: unknown, token = service.status().token) {
  const res = await fetch(service.status().url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: res.status, body: await res.json() as { result?: { structuredContent?: { scene?: EventScene; previewed?: boolean }; contents?: { text: string }[] }; error?: unknown } };
}

describe('scene studio authoring boundary', () => {
  it('copies a published target to a separate linked draft without changing live bindings or other alert configuration', () => {
    const { service, settings, live, setSettings } = setup();
    const before = structuredClone(settings.alerts);
    service.saveDraft({ ...live, html: '<p>Changed draft</p>', published: true });
    const studio = settings.alerts.studio!;
    expect(studio.scenes).toHaveLength(2);
    expect(studio.scenes.find((scene) => scene.id === live.id)).toEqual(live);
    const draft = studio.scenes.find((scene) => scene.id !== live.id)!;
    expect(draft).toMatchObject({ draftOf: live.id, published: false, html: '<p>Changed draft</p>' });
    expect(draft.id).not.toBe(live.id);
    expect(studio.bindings).toEqual(before.studio!.bindings);
    expect(studio.donationLevels).toEqual(before.studio!.donationLevels);
    expect({ ...settings.alerts, studio: undefined }).toEqual({ ...before, studio: undefined });
    expect(setSettings).toHaveBeenCalledOnce();
    service.saveDraft({ ...draft, css: 'p{color:purple}' });
    expect(settings.alerts.studio!.scenes).toHaveLength(2);
    expect(settings.alerts.studio!.scenes.find((scene) => scene.id === draft.id)?.css).toBe('p{color:purple}');
  });

  it('enforces capacity for new/copied drafts while permitting edits of an existing draft at capacity', () => {
    const { service, settings, live, setSettings } = setup();
    settings.alerts.studio!.scenes = [live, ...Array.from({ length: SCENE_MAX_COUNT - 1 }, (_, index) => ({ ...newEventScene(), id: `draft-${index}` }))];
    const before = structuredClone(settings.alerts);
    expect(() => service.saveDraft({ ...newEventScene(), id: 'new-draft' })).toThrow('Maximum');
    expect(() => service.saveDraft({ ...live, html: '<p>Cannot overwrite published</p>' })).toThrow('Maximum');
    expect(settings.alerts).toEqual(before);
    expect(setSettings).not.toHaveBeenCalled();
    service.saveDraft({ ...settings.alerts.studio!.scenes[1], name: 'Edited at capacity' });
    expect(settings.alerts.studio!.scenes).toHaveLength(SCENE_MAX_COUNT);
    expect(settings.alerts.studio!.scenes.find((scene) => scene.id === 'draft-0')?.name).toBe('Edited at capacity');
  });

  it('rejects invalid authored source before changing saved scenes', () => {
    const { service, settings, live, setSettings } = setup();
    expect(() => service.saveDraft({ ...live, html: null } as never)).toThrow();
    expect(setSettings).not.toHaveBeenCalled();
    expect(settings.alerts.studio!.scenes).toEqual([live]);
  });

  it('keeps studio context free of API/MCP credentials and supplies configured design/runtime context', () => {
    const { service, settings } = setup();
    const text = JSON.stringify(service.context());
    for (const secret of [API_KEY, INITIAL_TOKEN, 'apiKey', 'mcpToken']) expect(text).not.toContain(secret);
    for (const value of ['StreamHelper', 'anime', 'purple', 'scene.onUpdate', 'scene.finish', 'ru', settings.currency]) expect(text).toContain(value);
    expect(service.ai.getConfig()).toMatchObject({ configured: true, hasApiKey: true });
    expect(JSON.stringify(service.ai.getConfig())).not.toContain(API_KEY);
  });

  it('routes explicit editor live tests through AlertQueue without using the MCP local-preview callback', () => {
    const { service, live, enqueueScene, localPreview, setSettings } = setup();
    const event: SceneEventData = { id: 'editor-test', type: 'donation', user: 'Demo', amount: 100, currency: 'RUB', message: 'Local test', count: 1, viewers: 0, months: 0, tier: '', anonymous: false, source: 'test' };
    service.preview(live, event);
    expect(enqueueScene).toHaveBeenCalledExactlyOnceWith(live, event);
    expect(localPreview).not.toHaveBeenCalled();
    expect(setSettings).not.toHaveBeenCalled();
  });
});

describe('scene studio MCP controller integration', () => {
  it('previews through actual loopback MCP using only localPreview, and saves drafts without touching AlertQueue', async () => {
    const { service, live, localPreview, enqueueScene, settings } = setup();
    const status = await service.configure(true, await freePort());
    expect(status).toMatchObject({ enabled: true, running: true });
    expect(status.url).toBe(`http://127.0.0.1:${status.port}/mcp`);
    const event: SceneEventData = { id: 'mcp-preview', type: 'raid', user: 'Demo', amount: 0, currency: '', message: '', count: 1, viewers: 42, months: 0, tier: '', anonymous: false, source: 'test' };
    const preview = await call(service, 'tools/call', { name: 'preview_scene', arguments: { scene: live, event } });
    expect(preview.body.result?.structuredContent?.previewed).toBe(true);
    expect(localPreview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: live.id, published: false }), event);
    expect(enqueueScene).not.toHaveBeenCalled();
    const save = await call(service, 'tools/call', { name: 'save_scene_draft', arguments: { scene: { ...live, js: '// Edited by external assistant' } } });
    const draft = save.body.result?.structuredContent?.scene;
    expect(draft).toMatchObject({ published: false, draftOf: live.id });
    expect(settings.alerts.studio!.scenes).toHaveLength(2);
    expect(settings.alerts.studio!.scenes.find((scene) => scene.id === live.id)).toEqual(live);
    expect(settings.alerts.studio!.bindings.donation).toBe(live.id);
    expect(enqueueScene).not.toHaveBeenCalled();
    const resource = await call(service, 'resources/read', { uri: 'studio://context' });
    const context = resource.body.result?.contents?.[0].text ?? '';
    expect(context).toContain('Brand: StreamHelper');
    expect(context).not.toContain(API_KEY); expect(context).not.toContain(status.token);
  });

  it('rotates authentication immediately while preserving AI config/key, then disables, restarts and stops the server', async () => {
    const { service, secrets } = setup();
    const aiBefore = structuredClone(service.ai.getConfig());
    const port = await freePort();
    const initial = await service.configure(true, port);
    const first = await call(service, 'ping'); expect(first.status).toBe(200);
    await service.start(); expect((await call(service, 'ping')).status).toBe(200);
    const rotated = await service.rotate();
    expect(rotated).toMatchObject({ enabled: true, running: true, port });
    expect(rotated.token).not.toBe(initial.token);
    expect((await call(service, 'ping', undefined, initial.token)).status).toBe(401);
    expect((await call(service, 'ping')).status).toBe(200);
    expect(service.ai.getConfig()).toEqual(aiBefore); expect(secrets()?.apiKey).toBe(API_KEY);
    const changedAi = { ...aiBefore.config, model: 'second-model', systemPrompt: 'Brand: updated' };
    service.ai.configure(changedAi);
    expect(secrets()).toMatchObject({ mcpToken: rotated.token, mcpEnabled: true, mcpPort: port, apiKey: API_KEY });
    const disabled = await service.configure(false, port);
    expect(disabled).toMatchObject({ enabled: false, running: false, token: rotated.token });
    await expect(fetch(disabled.url)).rejects.toThrow();
    const restarted = await service.configure(true, port);
    expect(restarted.running).toBe(true); expect((await call(service, 'ping')).status).toBe(200);
    expect(service.ai.getConfig().config).toEqual(changedAi);
    await service.stop(); await service.stop();
    expect(service.status()).toMatchObject({ enabled: true, running: false });
    await expect(fetch(restarted.url)).rejects.toThrow();
  });

  it('moves a running server to the new configured loopback port and rejects invalid ports without losing config', async () => {
    const { service, secrets } = setup();
    const initial = await service.configure(true, await freePort());
    let nextPort = await freePort();
    while (nextPort === initial.port) nextPort = await freePort();
    const moved = await service.configure(true, nextPort);
    expect(moved).toMatchObject({ running: true, port: nextPort, token: initial.token });
    expect((await call(service, 'ping')).status).toBe(200);
    await expect(fetch(initial.url)).rejects.toThrow();
    const saved = structuredClone(secrets());
    for (const port of [0, 80, 1023, 65536, 4851.5, NaN]) await expect(service.configure(true, port)).rejects.toThrow('Invalid MCP port');
    expect(secrets()).toEqual(saved); expect((await call(service, 'ping')).status).toBe(200);
  });

  it('starts from persisted enablement and generates a token without overwriting API configuration', async () => {
    const { service, secrets } = setup();
    const saved = secrets()!; saved.mcpEnabled = true; saved.mcpPort = await freePort(); delete saved.mcpToken;
    const config = structuredClone(saved.config);
    await service.start();
    expect(service.status()).toMatchObject({ enabled: true, running: true });
    expect(service.status().token.length).toBeGreaterThanOrEqual(32);
    expect((await call(service, 'ping')).status).toBe(200);
    expect(secrets()?.apiKey).toBe(API_KEY); expect(secrets()?.config).toEqual(config);
  });

  it('reports a bind failure safely and recovers when the port becomes available', async () => {
    const { service, secrets } = setup();
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
    cleanups.push(() => new Promise<void>((resolve) => occupied.listening ? occupied.close(() => resolve()) : resolve()));
    const port = (occupied.address() as { port: number }).port;
    const failed = await service.configure(true, port);
    expect(failed).toMatchObject({ enabled: true, running: false, error: expect.stringContaining('Could not start') });
    expect(failed.error).not.toContain(API_KEY); expect(failed.error).not.toContain(INITIAL_TOKEN);
    expect(secrets()?.apiKey).toBe(API_KEY);
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    await service.start();
    expect(service.status()).toMatchObject({ running: true }); expect(service.status().error).toBeUndefined();
    expect((await call(service, 'ping')).status).toBe(200);
  });
});
