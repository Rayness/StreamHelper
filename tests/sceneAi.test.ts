import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/main/core/context';
import type { SecretsData } from '../src/main/core/secrets';
import { SceneAiService } from '../src/main/sceneStudio/ai';
import { newEventScene, SCENE_MAX_CODE_LENGTH } from '@shared/eventStudio';
import { defaultSceneAiConfig, normalizeSceneAiConfig, SCENE_AI_MAX_RESPONSE_BYTES, SCENE_RUNTIME_CONTEXT, type SceneAiConfig } from '@shared/sceneAi';

const KEY = 'sk-test-provider-secret';
const config = (patch: Partial<SceneAiConfig> = {}): SceneAiConfig => ({ ...defaultSceneAiConfig(), model: 'configured-model', ...patch });
const source = () => ({ ...newEventScene(), id: 'source-scene', parameters: { brand: 'Studio', palette: '#9b6bff', style: 'anime', sparkle: true }, instructions: 'Keep the logo area clear.' });
const generated = () => ({ ...source(), id: 'provider-changed-id', name: 'AI scene', html: '<p data-field="user"></p>', css: 'p{color:red}', js: 'scene.onUpdate(event=>console.log(event.count));', published: true });
function setup(fetcher?: typeof fetch) {
  let saved: SecretsData['sceneStudio'];
  const setSettings = vi.fn();
  const ctx = {
    secrets: { get: () => saved, set: (_key: string, value: SecretsData['sceneStudio']) => { saved = value; } },
    settings: { get: () => 'ru', set: setSettings },
  } as unknown as AppContext;
  const ai = new SceneAiService(ctx, fetcher);
  return { ai, saved: () => saved, setSettings };
}
const response = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const envelope = (text: string) => ({ status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'not scene output' }] }, { type: 'message', content: [{ type: 'output_text', text }] }] });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('scene AI configuration', () => {
  it('requires an explicit model and never returns provider keys', () => {
    const { ai, saved } = setup();
    expect(ai.getConfig()).toEqual({ config: defaultSceneAiConfig(), hasApiKey: false, configured: false });
    const status = ai.configure(config(), KEY);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(saved()?.apiKey).toBe(KEY);
    ai.configure(config({ model: '' }));
    expect(ai.getConfig().configured).toBe(false);
    expect(saved()?.apiKey).toBe(KEY);
    ai.configure(config(), '');
    expect(saved()?.apiKey).toBeUndefined();
    expect(ai.getConfig().hasApiKey).toBe(false);
  });

  it.each(['http://api.example/v1', 'https://user:password@api.example/v1', 'https://api.example/v1?key=secret', 'file:///models', 'http://localhost.evil/v1'])('rejects unsafe API root %s', (baseUrl) => {
    expect(() => normalizeSceneAiConfig(config({ baseUrl }))).toThrow();
  });

  it.each(['http://localhost:1234/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1'])('only allows keyless compatible inference at explicit loopback root %s', (baseUrl) => {
    const { ai } = setup();
    expect(ai.configure(config({ provider: 'compatible', baseUrl })).configured).toBe(true);
    expect(() => ai.configure(config({ provider: 'responses', baseUrl }))).toThrow();
  });

  it('validates finite limits and does not accept credentials in key fields', () => {
    const { ai } = setup();
    for (const patch of [{ maxTokens: 0 }, { maxTokens: 100_000 }, { timeoutSec: Infinity }, { timeoutSec: 0 }, { temperature: NaN }, { temperature: 3 }, { provider: 'anthropic' as const, temperature: 1.5 }]) {
      expect(() => ai.configure(config(patch))).toThrow();
    }
    expect(() => ai.configure(config(), 'key\r\ninjected: header')).toThrow();
    expect(() => ai.configure(config({ systemPrompt: 'x'.repeat(24_001) }))).toThrow();
  });
});

describe('scene AI generation', () => {
  it('uses Responses instructions/input and nested output text; returns an unpublished same-id draft without saving', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(envelope(JSON.stringify(generated()))));
    const { ai, saved, setSettings } = setup(fetcher);
    ai.configure(config({ systemPrompt: 'Brand: StreamHelper; style: cel shaded; palette: purple.', temperature: null }), KEY);
    const original = { ...source(), published: true };
    const draft = await ai.generate({ prompt: 'Сделай красивый донат', scene: original });
    expect(draft).toMatchObject({ id: original.id, published: false, name: 'AI scene', html: generated().html });
    expect(original.published).toBe(true);
    expect(setSettings).not.toHaveBeenCalled();
    expect(saved()?.apiKey).toBe(KEY);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model: 'configured-model', max_output_tokens: 8192, store: false, text: { format: { type: 'json_object' } } });
    expect(body).not.toHaveProperty('temperature');
    expect(body.instructions).toContain(SCENE_RUNTIME_CONTEXT);
    expect(body.instructions).toContain('Brand: StreamHelper');
    expect(JSON.parse(body.input)).toMatchObject({ language: 'ru', scene: { parameters: original.parameters, instructions: original.instructions, published: false } });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('uses compatible chat completions and accepts fenced JSON text', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(generated()) + '\n```' } }] }));
    const { ai } = setup(fetcher);
    ai.configure(config({ provider: 'compatible', baseUrl: 'https://compatible.example/v1/chat/completions', temperature: 0.4 }), KEY);
    expect((await ai.generate({ prompt: 'Edit', scene: source() })).published).toBe(false);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://compatible.example/v1/chat/completions');
    expect(JSON.parse(init?.body as string)).toMatchObject({ temperature: 0.4, max_tokens: 8192, messages: [{ role: 'system' }, { role: 'user' }] });
  });

  it('uses Anthropic messages, version header and text blocks', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'ignore this' }, { type: 'text', text: JSON.stringify(generated()) }] }));
    const { ai } = setup(fetcher);
    ai.configure(config({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', temperature: 0.2 }), KEY);
    expect((await ai.generate({ prompt: 'Edit', scene: source() })).id).toBe('source-scene');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
    expect(JSON.parse(init?.body as string)).toMatchObject({ system: expect.stringContaining('scene.onUpdate'), max_tokens: 8192, messages: [{ role: 'user' }] });
  });

  it('calls a real local fake compatible HTTP provider without a key', async () => {
    let received: unknown;
    const server: Server = createServer(async (req, res) => {
      expect(req.url).toBe('/v1/chat/completions'); expect(req.headers.authorization).toBeUndefined();
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(generated()) }, finish_reason: 'stop' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const port = (server.address() as { port: number }).port;
    const { ai } = setup();
    ai.configure(config({ provider: 'compatible', baseUrl: `http://127.0.0.1:${port}/v1` }));
    expect((await ai.generate({ prompt: 'Local generation', scene: source() })).name).toBe('AI scene');
    expect(received).toMatchObject({ model: 'configured-model' });
  });

  it.each([
    ['responses', { status: 'incomplete', output: [] }],
    ['responses', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: KEY }] }] }],
    ['compatible', { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(generated()) } }] }],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: JSON.stringify(generated()) }] }],
  ] as const)('rejects incomplete/refused %s output', async (provider, value) => {
    const { ai } = setup(async () => response(value));
    ai.configure(config({ provider }), KEY);
    await expect(ai.generate({ prompt: 'Edit', scene: source() })).rejects.toMatchObject({ code: 'output' });
  });

  it.each([KEY, '[]', '{"html":1,"css":"","js":""}', JSON.stringify({ ...generated(), width: -1 }), JSON.stringify({ ...generated(), js: 'a'.repeat(SCENE_MAX_CODE_LENGTH + 1) })])('rejects malformed or oversized generated scene without echoing raw output', async (output) => {
    const { ai } = setup(async () => response(envelope(output)));
    ai.configure(config(), KEY);
    await expect(ai.generate({ prompt: 'Edit', scene: source() })).rejects.toMatchObject({ code: 'output', message: expect.not.stringContaining(KEY) });
  });

  it('caps response bytes and sanitizes HTTP and network errors', async () => {
    for (const fetcher of [
      async () => new Response(KEY + ' raw provider error', { status: 401, statusText: KEY }),
      async () => { throw new Error('Connection failed ' + KEY); },
      async () => new Response('a'.repeat(SCENE_AI_MAX_RESPONSE_BYTES + 1)),
    ]) {
      const { ai } = setup(fetcher); ai.configure(config(), KEY);
      await expect(ai.generate({ prompt: 'Edit', scene: source() })).rejects.toMatchObject({ message: expect.not.stringContaining(KEY) });
    }
  });

  it('rejects missing config/invalid input before calling a provider', async () => {
    const fetcher = vi.fn<typeof fetch>(); const { ai } = setup(fetcher);
    await expect(ai.generate({ prompt: 'Edit', scene: source() })).rejects.toMatchObject({ code: 'configuration' });
    ai.configure(config(), KEY);
    await expect(ai.generate({ prompt: ' ', scene: source() })).rejects.toMatchObject({ code: 'configuration' });
    await expect(ai.generate({ prompt: 'x'.repeat(16_001), scene: source() })).rejects.toMatchObject({ code: 'configuration' });
    await expect(ai.generate({ prompt: 'Edit', scene: { ...source(), html: null } as never })).rejects.toMatchObject({ code: 'configuration' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('limits concurrency and times out even an injected provider that ignores abort', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const { ai } = setup(fetcher); ai.configure(config({ timeoutSec: 5 }), KEY);
    const pending = ai.generate({ prompt: 'Edit', scene: source() });
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await expect(ai.generate({ prompt: 'Edit again', scene: source() })).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(5001); await timedOut;
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
});
