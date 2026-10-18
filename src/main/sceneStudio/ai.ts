import type { AppContext } from '../core/context';
import { normalizeEventScene, type EventScene } from '@shared/eventStudio';
import { defaultSceneAiConfig, isSceneAiLocalUrl, normalizeSceneAiConfig, SCENE_AI_MAX_PROMPT, SCENE_AI_MAX_RESPONSE_BYTES, SCENE_RUNTIME_CONTEXT, type SceneAiConfig, type SceneAiStatus } from '@shared/sceneAi';
export { SCENE_RUNTIME_CONTEXT } from '@shared/sceneAi';

export type SceneAiErrorCode = 'configuration' | 'busy' | 'timeout' | 'network' | 'provider' | 'output';
export class SceneAiError extends Error {
  constructor(readonly code: SceneAiErrorCode, message: string) { super(message); this.name = 'SceneAiError'; }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function endpoint(config: SceneAiConfig): string {
  const suffix = config.provider === 'responses' ? '/responses' : config.provider === 'anthropic' ? '/messages' : '/chat/completions';
  return config.baseUrl.endsWith(suffix) ? config.baseUrl : config.baseUrl + suffix;
}

async function responseJson(response: Response): Promise<unknown> {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > SCENE_AI_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new SceneAiError('output', 'AI response exceeds the size limit.');
  }
  if (!response.body) throw new SceneAiError('output', 'The AI provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > SCENE_AI_MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SceneAiError('output', 'AI response exceeds the size limit.'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new SceneAiError('output', 'The AI provider returned invalid JSON.'); }
}

/** Extract generated text only, never reasoning, refusals or raw provider error details. */
function generatedText(provider: SceneAiConfig['provider'], data: unknown): string {
  if (!record(data)) throw new SceneAiError('output', 'The AI provider returned an invalid result.');
  let text = '';
  if (provider === 'responses') {
    if (data.error || (data.status !== undefined && data.status !== 'completed')) throw new SceneAiError('output', 'AI generation was incomplete or refused.');
    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (!record(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (record(part) && part.type === 'refusal') throw new SceneAiError('output', 'AI generation was refused.');
          if (record(part) && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        }
      }
    } else if (typeof data.output_text === 'string') text = data.output_text;
  } else if (provider === 'compatible') {
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (record(choice) && record(choice.message) && (!choice.finish_reason || choice.finish_reason === 'stop')) {
      if (choice.message.refusal) throw new SceneAiError('output', 'AI generation was refused.');
      const content = choice.message.content;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) text = content.filter((p) => record(p) && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
    }
  } else if (Array.isArray(data.content) && (!data.stop_reason || data.stop_reason === 'end_turn')) {
    text = data.content.filter((p) => record(p) && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
  }
  if (!text.trim()) throw new SceneAiError('output', 'AI generation returned no complete scene.');
  return text;
}

export class SceneAiService {
  private busy = false;
  constructor(private ctx: AppContext, private fetcher: typeof fetch = fetch) {}

  getConfig(): SceneAiStatus {
    const saved = this.ctx.secrets.get('sceneStudio');
    let config = defaultSceneAiConfig();
    try { if (saved?.config) config = normalizeSceneAiConfig(saved.config); } catch { /* an old or invalid config must remain editable */ }
    const hasApiKey = !!saved?.apiKey;
    return { config, hasApiKey, configured: !!config.model && (hasApiKey || (config.provider === 'compatible' && isSceneAiLocalUrl(new URL(config.baseUrl)))) };
  }

  configure(value: SceneAiConfig, apiKey?: string): SceneAiStatus {
    const config = normalizeSceneAiConfig(value);
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(apiKey))) throw new SceneAiError('configuration', 'Invalid AI API key.');
    const saved = this.ctx.secrets.get('sceneStudio');
    this.ctx.secrets.set('sceneStudio', { ...saved, config, apiKey: apiKey === undefined ? saved?.apiKey : apiKey || undefined });
    return this.getConfig();
  }

  /** Generates a draft only; saving and publishing remain explicit caller actions. */
  async generate(request: { prompt: string; scene: EventScene }): Promise<EventScene> {
    if (!request || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > SCENE_AI_MAX_PROMPT) throw new SceneAiError('configuration', `Enter scene instructions up to ${SCENE_AI_MAX_PROMPT} characters.`);
    let scene: EventScene;
    try { scene = normalizeEventScene(request.scene); } catch { throw new SceneAiError('configuration', 'The source scene is invalid.'); }
    const status = this.getConfig();
    if (!status.configured) throw new SceneAiError('configuration', 'Choose a model and configure the provider API key first.');
    if (this.busy) throw new SceneAiError('busy', 'Scene generation is already running.');
    const config = status.config;
    const apiKey = this.ctx.secrets.get('sceneStudio')?.apiKey;
    const instructions = `${SCENE_RUNTIME_CONTEXT}\n\nAdditional studio instructions:\n${config.systemPrompt}`;
    const input = JSON.stringify({ request: request.prompt, language: this.ctx.settings.get('language'), scene: { ...scene, published: false } });
    const sampling = config.temperature === null ? {} : { temperature: config.temperature };
    const body = config.provider === 'responses'
      ? { model: config.model, instructions, input, max_output_tokens: config.maxTokens, store: false, text: { format: { type: 'json_object' } }, ...sampling }
      : config.provider === 'compatible'
        ? { model: config.model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], max_tokens: config.maxTokens, ...sampling }
        : { model: config.model, system: instructions, messages: [{ role: 'user', content: input }], max_tokens: config.maxTokens, ...sampling };
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (config.provider === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (apiKey) headers['x-api-key'] = apiKey; }
    else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.busy = true;
    try {
      const operation = async () => {
        const response = await this.fetcher(endpoint(config), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new SceneAiError('provider', `AI provider rejected the request (HTTP ${response.status}). Check the model, API key and output settings.`);
        }
        const text = generatedText(config.provider, await responseJson(response));
        let result: unknown;
        try { result = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')); }
        catch { throw new SceneAiError('output', 'AI output is not a valid scene JSON object.'); }
        if (!record(result) || !['html', 'css', 'js'].every((key) => typeof result[key] === 'string')) throw new SceneAiError('output', 'AI output must contain HTML, CSS and JavaScript strings.');
        for (const [key, min, max] of [['width', 320, 3840], ['height', 180, 2160], ['durationSec', 1, 120], ['volume', 0, 1]] as const) {
          if (result[key] !== undefined && (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max)) throw new SceneAiError('output', 'AI output contains invalid scene dimensions, duration or volume.');
        }
        if (result.parameters !== undefined && !record(result.parameters) || result.name !== undefined && (typeof result.name !== 'string' || result.name.length > 100) || result.instructions !== undefined && (typeof result.instructions !== 'string' || result.instructions.length > 12_000)) throw new SceneAiError('output', 'AI output contains invalid scene metadata.');
        try {
          return normalizeEventScene({ ...scene, ...result, id: scene.id, draftOf: scene.draftOf, published: false, updatedAt: Date.now() });
        } catch { throw new SceneAiError('output', 'AI output contains invalid scene fields or exceeds a scene limit.'); }
      };
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SceneAiError('timeout', 'Scene generation timed out. Try a smaller scene or a longer timeout.')); }, config.timeoutSec * 1000);
      })]);
    } catch (error) {
      if (error instanceof SceneAiError) throw error;
      // Never expose a fetch error/cause, URL credentials, API key or provider response text.
      throw new SceneAiError(controller.signal.aborted ? 'timeout' : 'network', controller.signal.aborted ? 'Scene generation timed out.' : 'Could not reach the AI provider. Check its API address and connection.');
    } finally { if (timer) clearTimeout(timer); this.busy = false; }
  }
}
