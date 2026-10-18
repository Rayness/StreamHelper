import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { normalizeEventScene, SCENE_EVENT_TYPES, type EventScene, type EventStudioSettings, type SceneEventData } from '@shared/eventStudio';
import { SCENE_RUNTIME_CONTEXT } from '@shared/sceneAi';

export const SCENE_MCP_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const SCENE_MCP_MAX_BODY = 2_000_000;
export const SCENE_MCP_MAX_CONCURRENT = 8;

export interface SceneMcpDeps {
  getStudio: () => EventStudioSettings;
  saveDraft: (scene: EventScene) => void;
  preview: (scene: EventScene, event?: SceneEventData) => void;
  /** Only non-secret studio design context, such as brand/style/palette/language. */
  getContext: () => unknown;
  token: string;
  port: number;
}

type RpcId = string | number;
type JsonRecord = Record<string, unknown>;
const record = (v: unknown): v is JsonRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const idSchema = { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['id'], additionalProperties: false };
const sceneSchema = {
  type: 'object', description: 'An EventScene JSON document; obtain a complete example using scene_context.',
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, eventType: { type: 'string', enum: [...SCENE_EVENT_TYPES, 'any'] },
    html: { type: 'string' }, css: { type: 'string' }, js: { type: 'string' },
    width: { type: 'number' }, height: { type: 'number' }, durationSec: { type: 'number' }, volume: { type: 'number' },
    parameters: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    instructions: { type: 'string' }, published: { type: 'boolean' }, updatedAt: { type: 'number' }, draftOf: { type: 'string' },
  }, required: ['id', 'name', 'eventType', 'html', 'css', 'js', 'width', 'height', 'durationSec', 'volume', 'parameters', 'instructions', 'published', 'updatedAt'], additionalProperties: false,
};
const tool = (name: string, description: string, inputSchema: unknown, readOnlyHint: boolean) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false },
});
export const SCENE_MCP_TOOLS = [
  tool('scene_context', 'Read the scene runtime API and configurable studio design context. No credentials or app controls.', emptySchema, true),
  tool('list_scenes', 'List saved scenes and publication state without their source code.', emptySchema, true),
  tool('get_scene', 'Read one saved EventScene including HTML, CSS, JavaScript and parameters.', idSchema, true),
  tool('save_scene_draft', 'Save an unpublished scene draft. A published target is copied to a new draft id; live scenes and event bindings are never changed.', {
    type: 'object', properties: { scene: sceneSchema }, required: ['scene'], additionalProperties: false,
  }, false),
  tool('preview_scene', 'Preview a validated scene locally in the studio. Does not trigger a live event or publish anything.', {
    type: 'object', properties: { scene: sceneSchema, event: { type: 'object', description: 'Optional complete SceneEventData sample.' } }, required: ['scene'], additionalProperties: false,
  }, false),
];

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function rpcError(id: RpcId | null, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function result(value: unknown) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: record(value) ? value : { value }, isError: false }; }

function sampleEvent(value: unknown): SceneEventData | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !SCENE_EVENT_TYPES.includes(value.type as SceneEventData['type'])) throw new RpcError(-32602, 'Invalid preview event.');
  const text = (key: string, max: number) => {
    const v = value[key];
    if (typeof v !== 'string' || v.length > max) throw new RpcError(-32602, 'Invalid preview event.');
    return v;
  };
  const number = (key: string) => {
    const v = value[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000_000) throw new RpcError(-32602, 'Invalid preview event.');
    return v;
  };
  if (typeof value.anonymous !== 'boolean') throw new RpcError(-32602, 'Invalid preview event.');
  return { id: text('id', 200), type: value.type as SceneEventData['type'], user: text('user', 300), amount: number('amount'), currency: text('currency', 20), message: text('message', 10_000), count: number('count'), viewers: number('viewers'), months: number('months'), tier: text('tier', 100), anonymous: value.anonymous, source: text('source', 100) };
}

/** Streamable HTTP MCP: stateless JSON responses, no SSE sessions or live publishing tools. */
export class SceneMcpServer {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private active = 0;
  private actualPort: number;
  private tokenHash: Buffer;

  constructor(private deps: SceneMcpDeps) {
    if (typeof deps.token !== 'string' || deps.token.length < 24 || deps.token.length > 4096 || /[\x00-\x20\x7f]/.test(deps.token)) throw new Error('Use a strong scene MCP token.');
    if (!Number.isInteger(deps.port) || deps.port < 0 || deps.port > 65535) throw new Error('Invalid scene MCP port.');
    this.actualPort = deps.port;
    this.tokenHash = createHash('sha256').update(deps.token).digest();
  }

  get port(): number { return this.actualPort; }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.server?.listening) return;
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    server.maxConnections = 32;
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 2500;
    this.starting = new Promise<void>((resolve, reject) => {
      const failed = () => { this.server = null; reject(new Error('Could not start the local scene MCP server. Check its port.')); };
      server.once('error', failed);
      server.listen(this.deps.port, '127.0.0.1', () => {
        server.off('error', failed);
        // Keep runtime socket errors from surfacing credentials or crashing the app.
        server.on('error', () => undefined);
        const address = server.address();
        if (address && typeof address !== 'string') this.actualPort = address.port;
        resolve();
      });
    });
    try { await this.starting; } finally { this.starting = null; }
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private allowedHost(host: string): boolean {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, ...(this.port === 80 ? ['127.0.0.1', 'localhost'] : [])].includes(host.toLowerCase());
  }

  private allowedOrigin(origin: string): boolean {
    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && !url.username && !url.password && url.origin === origin && this.allowedHost(url.host);
    } catch { return false; }
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (body !== undefined) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(status);
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > SCENE_MCP_MAX_BODY) { req.resume(); throw new HttpError(413, 'MCP request is too large.'); }
    const chunks: Buffer[] = [];
    let length = 0;
    // Bound slow uploads separately from the HTTP server's complete-request timeout.
    const timer = setTimeout(() => req.destroy(), 10_000);
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += Buffer.byteLength(chunk);
        if (length > SCENE_MCP_MAX_BODY) { req.resume(); throw new HttpError(413, 'MCP request is too large.'); }
        chunks.push(Buffer.from(chunk));
      }
    } finally { clearTimeout(timer); }
    try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { throw new RpcError(-32700, 'Invalid JSON.'); }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let counted = false;
    try {
      if (!req.headers.host || !this.allowedHost(req.headers.host)) throw new HttpError(403, 'Host is not allowed.');
      if (req.headers.origin !== undefined && !this.allowedOrigin(req.headers.origin)) throw new HttpError(403, 'Origin is not allowed.');
      const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!bearer || bearer.length > 4096 || !timingSafeEqual(createHash('sha256').update(bearer).digest(), this.tokenHash)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="StreamHelper Scene Studio"');
        throw new HttpError(401, 'A valid scene MCP bearer token is required.');
      }
      if (req.url !== '/mcp') throw new HttpError(404, 'MCP endpoint not found.');
      const protocol = req.headers['mcp-protocol-version'];
      if (protocol !== undefined && (typeof protocol !== 'string' || !SCENE_MCP_PROTOCOLS.includes(protocol as typeof SCENE_MCP_PROTOCOLS[number]))) throw new HttpError(400, 'Unsupported MCP protocol version.');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new HttpError(405, 'This stateless endpoint does not offer an SSE stream.'); }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send application/json.');
      const accept = req.headers.accept ?? '';
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) throw new HttpError(406, 'Accept application/json and text/event-stream.');
      if (this.active >= SCENE_MCP_MAX_CONCURRENT) throw new HttpError(429, 'Too many concurrent MCP requests.');
      this.active++; counted = true;
      const message = await this.readBody(req);
      if (!record(message) || message.jsonrpc !== '2.0') throw new RpcError(-32600, 'Invalid JSON-RPC request.');
      const hasId = Object.hasOwn(message, 'id');
      if (hasId && !((typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 200) || (typeof message.id === 'number' && Number.isSafeInteger(message.id)))) throw new RpcError(-32600, 'Invalid JSON-RPC request id.');
      const id = hasId ? message.id as RpcId : null;
      if (typeof message.method !== 'string') {
        // Clients may send JSON-RPC responses; this server does not issue its own requests.
        if (hasId && (Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error'))) { this.send(res, 202); return; }
        throw new RpcError(-32600, 'Invalid JSON-RPC method.');
      }
      if (message.method.length > 200 || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw new RpcError(-32600, 'Invalid JSON-RPC request.');
      if (message.params !== undefined && !record(message.params)) { this.send(res, 400, rpcError(id, -32602, 'Parameters must be an object.')); return; }
      if (!hasId) { this.send(res, 202); return; }
      try {
        const value = this.dispatch(message.method, message.params as JsonRecord | undefined ?? {});
        this.send(res, 200, { jsonrpc: '2.0', id, result: value });
      } catch (error) {
        this.send(res, 200, rpcError(id, error instanceof RpcError ? error.code : -32603, error instanceof RpcError ? error.message : 'The scene operation could not be completed.'));
      }
    } catch (error) {
      if (error instanceof HttpError) this.send(res, error.status, { error: error.message });
      else this.send(res, 400, rpcError(null, error instanceof RpcError ? error.code : -32603, error instanceof RpcError ? error.message : 'Invalid MCP request.'));
    } finally { if (counted) this.active--; }
  }

  private context(): unknown { return { runtime: SCENE_RUNTIME_CONTEXT, context: this.deps.getContext(), eventTypes: SCENE_EVENT_TYPES }; }

  private scene(value: unknown): EventScene {
    try { return normalizeEventScene(value); } catch { throw new RpcError(-32602, 'Invalid scene document or scene limit exceeded.'); }
  }

  private savedScene(id: unknown): EventScene {
    if (typeof id !== 'string' || !id || id.length > 120) throw new RpcError(-32602, 'Provide a scene id.');
    const scene = this.deps.getStudio().scenes.find((item) => item.id === id);
    if (!scene) throw new RpcError(-32602, 'Scene not found.');
    return scene;
  }

  private dispatch(method: string, params: JsonRecord): unknown {
    switch (method) {
      case 'initialize': {
        if (typeof params.protocolVersion !== 'string' || !record(params.capabilities) || !record(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') throw new RpcError(-32602, 'Invalid MCP initialization parameters.');
        const requested = params.protocolVersion as typeof SCENE_MCP_PROTOCOLS[number];
        return { protocolVersion: SCENE_MCP_PROTOCOLS.includes(requested) ? requested : SCENE_MCP_PROTOCOLS[0], serverInfo: { name: 'streamhelper-scene-studio', version: '1.0.0' }, capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: 'Create scene drafts and preview them locally. Publishing and live event controls require the streamer in StreamHelper.' };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: SCENE_MCP_TOOLS };
      case 'tools/call': {
        if (typeof params.name !== 'string' || !SCENE_MCP_TOOLS.some((tool) => tool.name === params.name)) throw new RpcError(-32602, 'Unknown scene tool.');
        if (params.arguments !== undefined && !record(params.arguments)) throw new RpcError(-32602, 'Tool arguments must be an object.');
        try { return result(this.callTool(params.name, params.arguments as JsonRecord | undefined ?? {})); }
        catch (error) {
          if (error instanceof RpcError) throw error;
          // Tool execution errors are content, distinct from protocol validation errors.
          return { content: [{ type: 'text', text: 'The scene operation failed. Check the scene and available studio capacity.' }], isError: true };
        }
      }
      case 'resources/list': return { resources: [{ uri: 'studio://context', name: 'Scene studio context', description: 'Runtime API and configured design context, without credentials.', mimeType: 'application/json' }] };
      case 'resources/read': {
        if (params.uri !== 'studio://context') throw new RpcError(-32002, 'Resource not found.');
        return { contents: [{ uri: 'studio://context', mimeType: 'application/json', text: JSON.stringify(this.context()) }] };
      }
      case 'prompts/list': return { prompts: [{ name: 'create_event_scene', description: 'Design a StreamHelper event scene as an unpublished draft.', arguments: [{ name: 'request', description: 'Desired event animation and visual style.', required: false }, { name: 'sceneId', description: 'Optional saved scene to edit.', required: false }] }] };
      case 'prompts/get': {
        if (params.name !== 'create_event_scene' || (params.arguments !== undefined && !record(params.arguments))) throw new RpcError(-32602, 'Unknown prompt or invalid prompt arguments.');
        const args = params.arguments as JsonRecord | undefined ?? {};
        if (Object.values(args).some((value) => typeof value !== 'string' || value.length > 16_000)) throw new RpcError(-32602, 'Prompt arguments must be strings within the size limit.');
        const base = args.sceneId === undefined ? undefined : this.savedScene(args.sceneId);
        return { description: 'Create an unpublished event scene draft.', messages: [{ role: 'user', content: { type: 'text', text: `${SCENE_RUNTIME_CONTEXT}\n\nStudio context:\n${JSON.stringify(this.deps.getContext())}\n\n${base ? `Source scene:\n${JSON.stringify(base)}\n\n` : ''}User request:\n${args.request ?? 'Create a readable, animated event scene using the configured studio style.'}\nUse save_scene_draft and preview_scene; leave publishing to the streamer.` } }] };
      }
      default: throw new RpcError(-32601, 'Method not found.');
    }
  }

  private callTool(name: string, args: JsonRecord): unknown {
    switch (name) {
      case 'scene_context': return this.context();
      case 'list_scenes': return { scenes: this.deps.getStudio().scenes.map(({ id, name, eventType, published, updatedAt, draftOf }) => ({ id, name, eventType, published, updatedAt, ...(draftOf ? { draftOf } : {}) })) };
      case 'get_scene': return { scene: this.savedScene(args.id) };
      case 'save_scene_draft': {
        const incoming = this.scene(args.scene);
        const existing = this.deps.getStudio().scenes.find((scene) => scene.id === incoming.id);
        const scene = this.scene({ ...incoming, ...(existing?.published ? { id: `draft-${randomUUID()}`, draftOf: existing.id } : {}), published: false, updatedAt: Date.now() });
        this.deps.saveDraft(scene);
        return { scene, saved: true, published: false };
      }
      case 'preview_scene': {
        const scene = this.scene({ ...this.scene(args.scene), published: false });
        this.deps.preview(scene, sampleEvent(args.event));
        return { previewed: true, id: scene.id, published: false };
      }
      default: throw new RpcError(-32602, 'Unknown scene tool.');
    }
  }
}
