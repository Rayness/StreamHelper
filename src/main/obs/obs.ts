import { EventSubscription, OBSWebSocket } from 'obs-websocket-js/json';
import { errorMessage, type AppContext } from '../core/context';

const RETRY_MS = 10_000;

export class ObsService {
  private obs = new OBSWebSocket();
  private retryTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private connecting = false;

  constructor(private ctx: AppContext) {
    this.obs.on('ConnectionClosed', (err) => {
      // Our own disconnect before a reconnect: connect() reports the outcome itself.
      if (this.connecting && this.ctx.state.current.obs.status === 'connecting') return;
      const wasConnected = this.ctx.state.current.obs.status === 'connected';
      this.ctx.state.patch('obs', { status: 'disconnected', error: wasConnected ? undefined : err?.message });
      if (wasConnected && !this.manualDisconnect) this.ctx.toast('info', 'toast.obsDisconnected');
      this.scheduleRetry();
    });
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.ctx.state.patch('obs', { currentScene: sceneName });
      void this.refreshSceneItems();
    });
    this.obs.on('SceneListChanged', () => void this.refreshScenes());
    this.obs.on('SceneItemEnableStateChanged', ({ sceneName, sceneItemId, sceneItemEnabled }) => {
      if (sceneName !== this.ctx.state.current.obs.currentScene) return;
      const sceneItems = this.ctx.state.current.obs.sceneItems.map((i) => (i.id === sceneItemId ? { ...i, enabled: sceneItemEnabled } : i));
      this.ctx.state.patch('obs', { sceneItems });
    });
    this.obs.on('SceneItemCreated', () => void this.refreshSceneItems());
    this.obs.on('SceneItemRemoved', () => void this.refreshSceneItems());
    this.obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
      const inputs = this.ctx.state.current.obs.inputs.map((i) => (i.name === inputName ? { ...i, muted: inputMuted } : i));
      this.ctx.state.patch('obs', { inputs });
    });
    this.obs.on('InputCreated', () => void this.refreshInputs());
    this.obs.on('InputRemoved', () => void this.refreshInputs());
    this.obs.on('InputNameChanged', () => void this.refreshInputs());
    this.obs.on('StreamStateChanged', ({ outputActive }) => this.ctx.state.patch('obs', { streaming: outputActive }));
    this.obs.on('RecordStateChanged', ({ outputActive }) => this.ctx.state.patch('obs', { recording: outputActive }));
  }

  get connected(): boolean {
    return this.ctx.state.current.obs.status === 'connected';
  }

  start(): void {
    if (this.ctx.settings.get('obs').autoConnect) void this.connect(undefined, true);
  }

  async connect(password?: string, silent = false): Promise<void> {
    if (password !== undefined) this.ctx.secrets.set('obsPassword', password || undefined);
    if (this.connecting) return;
    this.connecting = true;
    this.manualDisconnect = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const { host, port } = this.ctx.settings.get('obs');
    this.ctx.state.patch('obs', { status: 'connecting', error: undefined });
    try {
      if (this.connected) await this.obs.disconnect();
      await this.obs.connect(`ws://${host}:${port}`, this.ctx.secrets.get('obsPassword'), {
        eventSubscriptions: EventSubscription.General | EventSubscription.Scenes | EventSubscription.SceneItems | EventSubscription.Inputs | EventSubscription.Outputs,
      });
      this.ctx.state.patch('obs', { status: 'connected', error: undefined });
      // A retry scheduled by a close during this attempt would reconnect a healthy session.
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      await Promise.all([this.refreshScenes(), this.refreshInputs(), this.refreshOutputs()]);
      if (!silent) this.ctx.toast('success', 'toast.obsConnected');
    } catch (err) {
      const msg = errorMessage(err);
      const authFailed = /auth/i.test(msg);
      this.ctx.state.patch('obs', { status: authFailed ? 'error' : 'disconnected', error: msg });
      if (!silent) this.ctx.toast('error', authFailed ? 'toast.obsAuthFailed' : 'toast.obsConnectFailed');
      // A wrong password won't fix itself; anything else (OBS not started yet) is worth retrying.
      if (!authFailed) this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.obs.disconnect().catch(() => undefined);
    this.ctx.state.patch('obs', { status: 'disconnected', error: undefined });
  }

  private scheduleRetry(): void {
    if (this.manualDisconnect || this.retryTimer || !this.ctx.settings.get('obs').autoConnect) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(undefined, true);
    }, RETRY_MS);
  }

  // ---------- state refresh ----------

  private async refreshScenes(): Promise<void> {
    if (!this.connected) return;
    const list = await this.obs.call('GetSceneList');
    // OBS returns scenes bottom-to-top; reverse to match the OBS UI.
    const scenes = (list.scenes as { sceneName: string }[]).map((s) => s.sceneName).reverse();
    this.ctx.state.patch('obs', { scenes, currentScene: list.currentProgramSceneName });
    await this.refreshSceneItems();
  }

  private async refreshSceneItems(): Promise<void> {
    const scene = this.ctx.state.current.obs.currentScene;
    if (!this.connected || !scene) return;
    try {
      const res = await this.obs.call('GetSceneItemList', { sceneName: scene });
      const sceneItems = (res.sceneItems as any[])
        .map((i) => ({ id: i.sceneItemId as number, name: i.sourceName as string, enabled: i.sceneItemEnabled as boolean }))
        .reverse();
      this.ctx.state.patch('obs', { sceneItems });
    } catch (err) {
      console.warn('[obs] scene items', errorMessage(err));
    }
  }

  private async refreshInputs(): Promise<void> {
    if (!this.connected) return;
    const { inputs } = await this.obs.call('GetInputList');
    const names = (inputs as { inputName: string }[]).map((i) => i.inputName);
    // Only inputs with audio answer GetInputMute; that's how we find mixer channels.
    const checks = await Promise.allSettled(names.map((inputName) => this.obs.call('GetInputMute', { inputName })));
    const audio = names
      .map((name, i) => (checks[i].status === 'fulfilled' ? { name, muted: (checks[i] as PromiseFulfilledResult<any>).value.inputMuted } : null))
      .filter(Boolean) as { name: string; muted: boolean }[];
    this.ctx.state.patch('obs', { inputs: audio });
  }

  private async refreshOutputs(): Promise<void> {
    if (!this.connected) return;
    const [stream, record] = await Promise.all([this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus')]);
    this.ctx.state.patch('obs', { streaming: stream.outputActive, recording: record.outputActive });
  }

  // ---------- commands ----------

  private ensure(): void {
    if (!this.connected) throw new Error('OBS is not connected');
  }

  async setScene(sceneName: string): Promise<void> {
    this.ensure();
    await this.obs.call('SetCurrentProgramScene', { sceneName });
  }

  async toggleSceneItem(sceneName: string, sceneItemId: number): Promise<void> {
    this.ensure();
    const { sceneItemEnabled } = await this.obs.call('GetSceneItemEnabled', { sceneName, sceneItemId });
    await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !sceneItemEnabled });
  }

  async toggleSourceByName(sceneName: string, sourceName: string): Promise<void> {
    this.ensure();
    const scene = sceneName || this.ctx.state.current.obs.currentScene;
    const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName: scene, sourceName });
    await this.toggleSceneItem(scene, sceneItemId);
  }

  /**
   * One-click "Add to OBS": a browser source in the current scene with the right size and audio
   * routed through OBS (alert sounds, TTS). If a browser source with this URL already exists,
   * it's reused so the overlay isn't duplicated across scenes.
   */
  async addBrowserSource(name: string, url: string, width: number, height: number): Promise<'created' | 'added' | 'exists'> {
    this.ensure();
    const sceneName = this.ctx.state.current.obs.currentScene;
    if (!sceneName) throw new Error('no current scene');
    const { inputs } = await this.obs.call('GetInputList', { inputKind: 'browser_source' });
    for (const input of inputs as { inputName: string }[]) {
      const { inputSettings } = await this.obs.call('GetInputSettings', { inputName: input.inputName });
      if ((inputSettings as { url?: string }).url !== url) continue;
      const inScene = this.ctx.state.current.obs.sceneItems.some((i) => i.name === input.inputName);
      if (inScene) return 'exists';
      await this.obs.call('CreateSceneItem', { sceneName, sourceName: input.inputName, sceneItemEnabled: true });
      return 'added';
    }
    const { inputs: all } = await this.obs.call('GetInputList');
    const taken = new Set((all as { inputName: string }[]).map((i) => i.inputName));
    let inputName = name;
    for (let n = 2; taken.has(inputName); n++) inputName = `${name} ${n}`;
    await this.obs.call('CreateInput', {
      sceneName,
      inputName,
      inputKind: 'browser_source',
      inputSettings: { url, width, height, reroute_audio: true, fps_custom: false },
      sceneItemEnabled: true,
    });
    return 'created';
  }

  async toggleMute(inputName: string): Promise<void> {
    this.ensure();
    await this.obs.call('ToggleInputMute', { inputName });
  }

  async stream(mode: 'start' | 'stop' | 'toggle'): Promise<void> {
    this.ensure();
    await this.obs.call(mode === 'start' ? 'StartStream' : mode === 'stop' ? 'StopStream' : 'ToggleStream');
  }

  async record(mode: 'start' | 'stop' | 'toggle'): Promise<void> {
    this.ensure();
    await this.obs.call(mode === 'start' ? 'StartRecord' : mode === 'stop' ? 'StopRecord' : 'ToggleRecord');
  }
}
