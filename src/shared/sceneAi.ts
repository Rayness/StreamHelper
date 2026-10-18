export type SceneAiProvider = 'responses' | 'compatible' | 'anthropic';

export interface SceneAiConfig {
  provider: SceneAiProvider;
  /** API root, normally ending in /v1; an explicit endpoint is also accepted. */
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** null omits sampling configuration for models that do not support it. */
  temperature: number | null;
  maxTokens: number;
  timeoutSec: number;
}

/** Deliberately excludes API keys and MCP tokens. */
export interface SceneAiStatus {
  config: SceneAiConfig;
  hasApiKey: boolean;
  configured: boolean;
}

/** Local owner-only connection details; never sent to a model or MCP resources. */
export interface SceneMcpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string;
  token: string;
  error?: string;
}

export const SCENE_AI_MAX_PROMPT = 16_000;
export const SCENE_AI_MAX_RESPONSE_BYTES = 2_000_000;

export function defaultSceneAiConfig(): SceneAiConfig {
  return { provider: 'responses', baseUrl: 'https://api.openai.com/v1', model: '', systemPrompt: '', temperature: null, maxTokens: 8192, timeoutSec: 90 };
}

export function isSceneAiLocalUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
}

/** Reject rather than silently truncate a user's API configuration. */
export function normalizeSceneAiConfig(value: unknown): SceneAiConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scene AI configuration.');
  const v = value as Record<string, unknown>;
  if (!['responses', 'compatible', 'anthropic'].includes(String(v.provider))) throw new Error('Choose a supported AI provider.');
  if (typeof v.baseUrl !== 'string' || v.baseUrl.length > 2048) throw new Error('Invalid AI API address.');
  let url: URL;
  try { url = new URL(v.baseUrl.trim()); } catch { throw new Error('Invalid AI API address.'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Use an API address without credentials, query or fragment.');
  if (url.protocol !== 'https:' && !(v.provider === 'compatible' && isSceneAiLocalUrl(url))) throw new Error('Use HTTPS for remote AI providers.');
  if (typeof v.model !== 'string' || v.model.length > 200 || /[\x00-\x1f\x7f]/.test(v.model)) throw new Error('Invalid AI model name.');
  if (typeof v.systemPrompt !== 'string' || v.systemPrompt.length > 24_000) throw new Error('AI system instructions are too long.');
  if (v.temperature !== null && (typeof v.temperature !== 'number' || !Number.isFinite(v.temperature) || v.temperature < 0 || v.temperature > (v.provider === 'anthropic' ? 1 : 2))) throw new Error('Invalid AI temperature.');
  if (!Number.isInteger(v.maxTokens) || (v.maxTokens as number) < 256 || (v.maxTokens as number) > 32_768) throw new Error('AI output limit must be between 256 and 32768 tokens.');
  if (typeof v.timeoutSec !== 'number' || !Number.isFinite(v.timeoutSec) || v.timeoutSec < 5 || v.timeoutSec > 180) throw new Error('AI timeout must be between 5 and 180 seconds.');
  return {
    provider: v.provider as SceneAiProvider, baseUrl: url.toString().replace(/\/+$/, ''), model: v.model.trim(),
    systemPrompt: v.systemPrompt, temperature: v.temperature as number | null, maxTokens: v.maxTokens as number, timeoutSec: v.timeoutSec,
  };
}

/** Shared with external MCP assistants, so generated scenes use the same runtime. */
export const SCENE_RUNTIME_CONTEXT = `You create event scenes for StreamHelper Scene Studio: isolated HTML, CSS and JavaScript in an OBS browser source.
Return one JSON object describing an EventScene, never Markdown or a complete HTML document. Its fields are:
id (keep the supplied id), name, eventType (follow|sub|resub|giftsub|cheer|raid|donation|redemption|any), html (body fragment), css, js,
width and height in pixels, durationSec, volume (0..1), parameters (named string/number/boolean values), instructions (human editing notes), published:false, updatedAt (epoch ms).
The host provides window.scene (also available as scene):
- scene.event: {id,type,user,amount,currency,message,count,viewers,months,tier,anonymous,source}. Use user, never userName.
- scene.params: the scene's configurable parameters. Preserve supplied brand/style/palette settings and expose useful visual choices through them.
- scene.mediaUrl(filename): resolve an imported media filename or /media/ reference to an absolute local media URL. Use it for scene.params.image and scene.params.sound. Color parameters are also available as CSS variables such as var(--accent).
- scene.preview: boolean, true only for local preview. Do not play audio in preview.
- scene.durationMs: the planned duration in milliseconds.
- scene.finish(): end the visual and its audio early; the alert queue keeps the configured duration. Set durationSec to the full animation length.
- scene.onUpdate(callback): receive an explicit parent event update without restarting animation. Current gift batches are merged before playback begins, so read scene.event.count at startup.
HTML elements with data-field="user", data-field="message", data-field="amount", etc. receive event values as text automatically.
Treat viewer event values as untrusted text: use textContent, never innerHTML, eval, document.write or string-built code for them.
Keep the background transparent, composition inside width/height, text readable and responsive to long names/messages. Use CSS/Web Animations or canvas for motion; clean up timers/listeners when finished.
No Electron, Node, filesystem, app controls, API keys, network requests, external scripts, remote imports or new windows. Prefer self-contained CSS/SVG; use only supplied local media references.
Code is saved as a draft for explicit review; never publish, change bindings, or trigger a live event. Follow the user's language and the provided brand, style, palette, parameters and instructions.`;
