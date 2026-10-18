import { request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultEventStudio, newEventScene, type EventScene, type SceneEventData } from '@shared/eventStudio';
import { SceneMcpServer, SCENE_MCP_MAX_BODY, SCENE_MCP_MAX_CONCURRENT } from '../src/main/sceneStudio/mcp';

const TOKEN = 'scene-mcp-local-secret-0123456789';
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' };
const cleanups: (() => Promise<void>)[] = [];
// Wire data stays deliberately untrusted; each test asserts the fields it consumes.
type RpcEnvelope = { id: string | number | null; result: any; error: { code: number; message: string } };
const json = async (response: Response): Promise<RpcEnvelope> => await response.json() as RpcEnvelope;
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const studio = defaultEventStudio();
  const live: EventScene = { ...newEventScene(), id: 'live-scene', name: 'Live', published: true };
  studio.scenes.push(live);
  const saveDraft = vi.fn((scene: EventScene) => {
    const index = studio.scenes.findIndex((s) => s.id === scene.id);
    if (index >= 0) studio.scenes[index] = scene; else studio.scenes.push(scene);
  });
  const preview = vi.fn();
  const context = { brand: 'StreamHelper', style: 'anime', palette: ['#9b6bff'], language: 'ru', instructions: 'Use a transparent background.' };
  const server = new SceneMcpServer({ token: TOKEN, port: 0, getStudio: () => studio, getContext: () => context, saveDraft, preview });
  await server.start(); cleanups.push(() => server.stop());
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const send = (body: unknown, overrides: RequestInit = {}) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body), ...overrides });
  const rpc = async (method: string, params?: unknown, id: string | number = 1) => {
    const res = await send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toContain('application/json');
    return json(res);
  };
  return { server, studio, live, preview, saveDraft, context, url, send, rpc };
}

describe('scene MCP transport and authentication', () => {
  it('binds a loopback endpoint and requires a bearer token, never a query parameter', async () => {
    const { url, send } = await setup();
    for (const authorization of ['', 'Bearer wrong', 'Basic ' + TOKEN]) {
      const res = await send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { ...headers, Authorization: authorization } });
      expect(res.status).toBe(401); expect(res.headers.get('www-authenticate')).toContain('Bearer');
      expect(await res.text()).not.toContain(TOKEN);
    }
    expect((await fetch(url + '?token=' + TOKEN, { headers })).status).toBe(404);
    expect((await fetch(url, { headers: { Accept: 'text/event-stream' } })).status).toBe(401);
  });

  it('rejects foreign Host and Origin even when a correct bearer token is present', async () => {
    const { url, send, server } = await setup();
    for (const patch of [
      { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `http://localhost:${server.port}/path` },
      { Origin: `http://localhost:${server.port + 1}` }, { Origin: `https://localhost:${server.port}` },
    ]) {
      expect((await send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { ...headers, ...patch } })).status).toBe(403);
    }
    // undici controls Host itself; use raw HTTP to test DNS-rebinding host rejection.
    for (const host of ['evil.example', `127.0.0.1:${server.port + 1}`]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(url, { method: 'POST', headers: { ...headers, Host: host } }, (res) => { res.resume(); resolve(res.statusCode!); });
        req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
      });
      expect(status).toBe(403);
    }
    const allowed = await fetch(url, { method: 'POST', headers: { ...headers, Origin: `http://localhost:${server.port}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(allowed.status).toBe(200);
  });

  it('implements stateless GET/DELETE 405, JSON content type and Accept negotiation', async () => {
    const { url, send } = await setup();
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      const res = await fetch(url, { method, headers });
      expect(res.status).toBe(405); expect(res.headers.get('allow')).toBe('POST');
    }
    const message = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await send(message, { headers: { ...headers, 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await send(message, { headers: { ...headers, Accept: 'text/html' } })).status).toBe(406);
    expect((await send(message, { headers: { ...headers, 'MCP-Protocol-Version': 'future-invalid' } })).status).toBe(400);
    const result = await send(message);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('mcp-session-id')).toBeNull();
  });

  it('negotiates supported versions and offers the current version for unknown clients', async () => {
    const { rpc, send } = await setup();
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2099-01-01']) {
      const result = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } });
      expect(result.result.protocolVersion).toBe(version === '2099-01-01' ? '2025-11-25' : version);
      expect(result.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
      expect(result.result.serverInfo.name).toBe('streamhelper-scene-studio');
    }
    expect((await rpc('initialize', { protocolVersion: '2025-11-25' })).error.code).toBe(-32602);
    const { 'MCP-Protocol-Version': _unused, ...legacyHeaders } = headers;
    const legacy = await send({ jsonrpc: '2.0', id: 7, method: 'ping' }, { headers: legacyHeaders });
    expect(legacy.status).toBe(200);
  });

  it('accepts initialized/cancel notifications and client responses with 202 and no body', async () => {
    const { send } = await setup();
    for (const message of [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', id: 7, result: {} },
    ]) {
      const res = await send(message); expect(res.status).toBe(202); expect(await res.text()).toBe('');
    }
  });

  it('reports JSON-RPC parse/validation/method errors without dispatching invalid messages', async () => {
    const { send, rpc, saveDraft, preview } = await setup();
    const parse = await send(null, { body: '{broken JSON' });
    expect(parse.status).toBe(400); expect((await json(parse)).error.code).toBe(-32700);
    for (const body of [null, [], [{ jsonrpc: '2.0', id: 1, method: 'ping' }], { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: 1 }]) {
      const res = await send(body); expect(res.status).toBe(400); expect((await json(res)).error.code).toBe(-32600);
    }
    const invalidParams = await send({ jsonrpc: '2.0', id: 'keep-id', method: 'tools/call', params: [] });
    expect(await json(invalidParams)).toMatchObject({ id: 'keep-id', error: { code: -32602 } });
    for (const method of ['constructor', '__proto__', 'publish_scene', 'scene:publish', 'app:init']) expect((await rpc(method)).error.code).toBe(-32601);
    expect(saveDraft).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
  });

  it('caps request bodies before parsing them', async () => {
    const { send } = await setup();
    const res = await send(null, { body: 'x'.repeat(SCENE_MCP_MAX_BODY + 1) });
    expect(res.status).toBe(413);
  });

  it('caps concurrent unfinished uploads and recovers after they close', async () => {
    const { server, url, send } = await setup();
    const held: ClientRequest[] = [];
    try {
      for (let n = 0; n < SCENE_MCP_MAX_CONCURRENT; n++) {
        const req = httpRequest(url, { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' } });
        req.on('error', () => undefined); req.write('{'); held.push(req);
      }
      // Wait for all incomplete request bodies to enter the reader.
      await vi.waitFor(async () => {
        const res = await send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(res.status).toBe(429);
      });
    } finally { for (const req of held) req.destroy(); }
    await vi.waitFor(async () => expect((await send({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200));
    await server.stop(); await server.stop();
  });
});

describe('scene MCP tools, resources and prompts', () => {
  it('advertises only studio draft/preview tools and exposes configurable runtime context', async () => {
    const { rpc } = await setup();
    const tools = (await rpc('tools/list')).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['scene_context', 'list_scenes', 'get_scene', 'save_scene_draft', 'preview_scene']);
    expect(tools.every((tool: { inputSchema: { type: string }; annotations: { destructiveHint: boolean } }) => tool.inputSchema.type === 'object' && !tool.annotations.destructiveHint)).toBe(true);
    const context = (await rpc('tools/call', { name: 'scene_context', arguments: {} })).result;
    expect(context.structuredContent.context).toMatchObject({ brand: 'StreamHelper', language: 'ru', palette: ['#9b6bff'] });
    expect(context.structuredContent.runtime).toContain('scene.onUpdate');
    expect(context.structuredContent.runtime).toContain('scene.finish');
    expect(JSON.stringify(context)).not.toContain(TOKEN);
    expect((await rpc('tools/call', { name: 'get_scene', arguments: { id: 'live-scene' } })).result.structuredContent.scene.id).toBe('live-scene');
    const scenes = (await rpc('tools/call', { name: 'list_scenes' })).result.structuredContent.scenes;
    expect(scenes).toMatchObject([{ id: 'live-scene', published: true }]); expect(scenes[0]).not.toHaveProperty('js');
    expect((await rpc('tools/call', { name: 'get_scene', arguments: { id: 'missing' } })).error.code).toBe(-32602);
  });

  it('keeps a published scene intact and saves a separate linked draft', async () => {
    const { rpc, live, studio, saveDraft } = await setup();
    const changed = { ...live, html: '<p>Edited</p>', name: 'Changed', published: true };
    const res = await rpc('tools/call', { name: 'save_scene_draft', arguments: { scene: changed } });
    const saved = res.result.structuredContent.scene;
    expect(saved).toMatchObject({ html: changed.html, published: false, draftOf: live.id });
    expect(saved.id).not.toBe(live.id); expect(saved.id).toMatch(/^draft-/);
    expect(studio.scenes[0]).toBe(live); expect(live.html).not.toBe(changed.html);
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(JSON.parse(res.result.content[0].text)).toEqual(res.result.structuredContent);
    const next = await rpc('tools/call', { name: 'save_scene_draft', arguments: { scene: { ...saved, css: 'p{color:blue}' } } });
    expect(next.result.structuredContent.scene.id).toBe(saved.id);
    expect(studio.scenes).toHaveLength(2);
  });

  it('validates previews and never saves or publishes from preview', async () => {
    const { rpc, live, preview, saveDraft } = await setup();
    const event: SceneEventData = { id: 'preview-1', type: 'giftsub', user: '<script>viewer</script>', amount: 0, currency: '', message: 'hello', count: 5, viewers: 0, months: 0, tier: '1000', anonymous: false, source: 'twitch' };
    const res = await rpc('tools/call', { name: 'preview_scene', arguments: { scene: live, event } });
    expect(res.result.structuredContent).toMatchObject({ previewed: true, published: false });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ id: live.id, published: false }), event);
    expect(saveDraft).not.toHaveBeenCalled(); expect(live.published).toBe(true);
    expect((await rpc('tools/call', { name: 'preview_scene', arguments: { scene: live, event: { ...event, count: -1 } } })).error.code).toBe(-32602);
    expect((await rpc('tools/call', { name: 'save_scene_draft', arguments: { scene: { ...live, html: [] } } })).error.code).toBe(-32602);
    expect(preview).toHaveBeenCalledOnce(); expect(saveDraft).not.toHaveBeenCalled();
  });

  it('distinguishes execution errors from protocol errors without exposing secrets', async () => {
    const { rpc, saveDraft, live } = await setup();
    saveDraft.mockImplementationOnce(() => { throw new Error(TOKEN + ' internal details'); });
    const res = await rpc('tools/call', { name: 'save_scene_draft', arguments: { scene: live } });
    expect(res.result.isError).toBe(true); expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect((await rpc('tools/call', { name: 'publish_scene', arguments: {} })).error.code).toBe(-32602);
  });

  it('serves resource and prompt shapes understood by MCP clients', async () => {
    const { rpc } = await setup();
    const resources = (await rpc('resources/list')).result.resources;
    expect(resources[0]).toMatchObject({ uri: 'studio://context', mimeType: 'application/json' });
    const resource = (await rpc('resources/read', { uri: resources[0].uri })).result.contents[0];
    expect(JSON.parse(resource.text).context.brand).toBe('StreamHelper');
    expect((await rpc('resources/read', { uri: 'file:///secrets' })).error.code).toBe(-32002);
    expect((await rpc('prompts/list')).result.prompts[0].name).toBe('create_event_scene');
    const prompt = (await rpc('prompts/get', { name: 'create_event_scene', arguments: { request: 'Create a purple donation alert', sceneId: 'live-scene' } })).result;
    expect(prompt.messages).toMatchObject([{ role: 'user', content: { type: 'text' } }]);
    for (const text of ['purple donation', 'scene.params', 'scene.durationMs', 'StreamHelper', 'live-scene']) expect(prompt.messages[0].content.text).toContain(text);
    expect(JSON.stringify(prompt)).not.toContain(TOKEN);
    expect((await rpc('prompts/get', { name: 'create_event_scene', arguments: { request: 123 } })).error.code).toBe(-32602);
  });
});
