import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeEventScene, normalizeEventStudio, SCENE_MAX_COUNT, type EventScene, type SceneEventData } from '@shared/eventStudio';
import { defaultSceneAiConfig, SCENE_RUNTIME_CONTEXT, type SceneMcpStatus } from '@shared/sceneAi';
import type { AppContext } from '../core/context';
import type { AlertQueue } from '../features/alerts';
import { SceneAiService } from './ai';
import { SceneMcpServer } from './mcp';

/** AI and MCP share authoring context; only explicit editor publication changes live bindings. */
export class SceneStudioService {
  readonly ai: SceneAiService;
  private server: SceneMcpServer | null = null;
  private changes: Promise<void> = Promise.resolve();
  private error: string | undefined;

  constructor(private ctx: AppContext, private alerts: AlertQueue, private localPreview: (scene: EventScene, event?: SceneEventData) => void, fetcher?: typeof fetch) { this.ai = new SceneAiService(ctx, fetcher); }

  private config() { return this.ctx.secrets.get('sceneStudio') ?? { config: defaultSceneAiConfig() }; }

  status(): SceneMcpStatus {
    const config = this.config();
    const port = config.mcpPort ?? 4851;
    return { enabled: config.mcpEnabled === true, running: !!this.server, port, url: `http://127.0.0.1:${port}/mcp`, token: config.mcpToken ?? '', ...(this.error ? { error: this.error } : {}) };
  }

  context(): unknown {
    return { application: 'StreamHelper Event Studio', language: this.ctx.settings.get('language'), currency: this.ctx.settings.get('currency'),
      profile: this.ctx.settings.get('activeProfileId'), instructions: this.ai.getConfig().config.systemPrompt, runtime: SCENE_RUNTIME_CONTEXT,
      studio: normalizeEventStudio(this.ctx.settings.get('alerts').studio),
      workflow: 'Read context, author HTML/CSS/JS, save a draft, preview it, then let the streamer publish in Event Studio. Never embed credentials or execute account/OBS commands.' };
  }

  saveDraft(value: EventScene): void {
    let scene = normalizeEventScene(value);
    const alerts = this.ctx.settings.get('alerts');
    const studio = normalizeEventStudio(alerts.studio);
    const original = studio.scenes.find((s) => s.id === scene.id);
    if (original?.published) scene = { ...scene, id: `scene-${randomUUID()}`, draftOf: original.id };
    if (!studio.scenes.some((s) => s.id === scene.id) && studio.scenes.length >= SCENE_MAX_COUNT) throw new Error('Maximum number of scenes reached');
    scene = { ...scene, published: false, updatedAt: Date.now() };
    this.ctx.settings.set('alerts', { ...alerts, studio: { ...studio, scenes: [...studio.scenes.filter((s) => s.id !== scene.id), scene] } });
  }

  preview(scene: EventScene, event?: SceneEventData): void { this.alerts.enqueueScene(scene, event); }

  async configure(enabled: boolean, port: number): Promise<SceneMcpStatus> {
    if (typeof enabled !== 'boolean' || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MCP port (1024–65535)');
    const config = this.config();
    this.ctx.secrets.set('sceneStudio', { ...config, mcpEnabled: enabled, mcpPort: port, mcpToken: config.mcpToken || randomBytes(32).toString('hex') });
    await this.apply();
    return this.status();
  }

  async rotate(): Promise<SceneMcpStatus> {
    this.ctx.secrets.set('sceneStudio', { ...this.config(), mcpToken: randomBytes(32).toString('hex') });
    await this.apply(true);
    return this.status();
  }

  async start(): Promise<void> { await this.apply(); }

  private apply(restart = false): Promise<void> {
    const run = this.changes.then(async () => {
      const config = this.config();
      const port = config.mcpPort ?? 4851;
      if (this.server && (!config.mcpEnabled || this.server.port !== port || restart)) { await this.server.stop(); this.server = null; }
      if (!config.mcpEnabled || this.server) return;
      if (!config.mcpToken) { this.ctx.secrets.set('sceneStudio', { ...config, mcpToken: randomBytes(32).toString('hex') }); }
      const server = new SceneMcpServer({ port, token: this.config().mcpToken!, getStudio: () => normalizeEventStudio(this.ctx.settings.get('alerts').studio),
        saveDraft: (scene) => this.saveDraft(scene), preview: (scene, event) => this.localPreview(scene, event), getContext: () => this.context() });
      try { await server.start(); this.server = server; this.error = undefined; }
      catch (err) { this.error = err instanceof Error ? err.message : String(err); await server.stop(); }
    });
    this.changes = run.catch(() => undefined);
    return run;
  }

  async stop(): Promise<void> { await this.changes; await this.server?.stop(); this.server = null; }
}
