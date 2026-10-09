import { EventSubscription, OBSWebSocket } from 'obs-websocket-js/json';
import { errorMessage, type AppContext } from '../core/context';
import { ALL_OVERLAY_KINDS } from '@shared/profiles';

const RETRY_MS = 10_000;

/** OBS "Audio Monitoring" per listener choice: what goes to the stream vs. the streamer's headphones. */
const MONITOR_TYPE = {
  viewers: 'OBS_MONITORING_TYPE_NONE',
  both: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
  me: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
} as const;

/** Only local StreamHelper overlay URLs may be repaired automatically. */
export function overlayIdentity(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    const match = /^\/overlay\/([a-z]+)\/?$/.exec(url.pathname);
    if (!match || !ALL_OVERLAY_KINDS.includes(match[1] as import('@shared/types').OverlayKind)) return null;
    return `${url.pathname.replace(/\/$/, '')}?id=${url.searchParams.get('id') ?? ''}`;
  } catch { return null; }
}

/** Overlays that play YouTube audio follow the song requests' "who hears the music" choice. */
export function isMusicOverlay(url: string): boolean {
  const id = overlayIdentity(url);
  return !!id && ['/overlay/song?', '/overlay/duel?', '/overlay/melody?'].some((prefix) => id.startsWith(prefix));
}

export class ObsService {
  private obs = new OBSWebSocket();
  private retryTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private connecting = false;
  private generation = 0;
  private sourceWrites: Promise<unknown> = Promise.resolve();

  constructor(private ctx: AppContext) {
    this.obs.on('ConnectionClosed', (err) => {
      // Our own disconnect before a reconnect: connect() reports the outcome itself.
      if (this.connecting && this.ctx.state.current.obs.status === 'connecting') return;
      const wasConnected = this.ctx.state.current.obs.status === 'connected';
      this.ctx.state.patch('obs', { status: 'disconnected', error: wasConnected ? undefined : err?.message, sceneItems: [], inputs: [] });
      if (wasConnected && !this.manualDisconnect) this.ctx.toast('info', 'toast.obsDisconnected');
      this.scheduleRetry();
    });
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.ctx.state.patch('obs', { currentScene: sceneName });
      void this.refreshSceneItems();
    });
    this.obs.on('SceneListChanged', () => void this.refreshScenes().catch((err) => console.warn('[obs] scenes', errorMessage(err))));
    this.obs.on('CurrentSceneCollectionChanged', () => void this.refreshScenes().then(() => this.repairBrowserSources()).catch((err) => console.warn('[obs] collection', errorMessage(err))));
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
    const refreshInputs = () => void this.refreshInputs().catch((err) => console.warn('[obs] inputs', errorMessage(err)));
    this.obs.on('InputCreated', (input) => {
      refreshInputs();
      // A Song Request source added by hand in OBS gets the chosen listening mode too.
      if ((input as { inputKind?: string }).inputKind === 'browser_source') this.scheduleSongAudio();
    });
    this.obs.on('InputRemoved', refreshInputs);
    this.obs.on('InputNameChanged', refreshInputs);
    this.obs.on('InputVolumeMeters', ({ inputs }) => {
      if (!this.meterListeners.size) return;
      const levels = new Map<string, number>();
      for (const input of inputs as { inputName?: string; inputLevelsMul?: number[][] }[]) {
        if (!input.inputName) continue;
        // [magnitude, peak, input peak] per channel; the loudest channel peak wins.
        const peak = Math.max(0, ...(input.inputLevelsMul ?? []).map((ch) => Number(ch?.[1]) || 0));
        levels.set(input.inputName, peak > 0 ? 20 * Math.log10(peak) : -100);
      }
      for (const listener of this.meterListeners) listener(levels);
    });
    this.obs.on('StreamStateChanged', ({ outputActive }) => this.ctx.state.patch('obs', { streaming: outputActive }));
    this.obs.on('RecordStateChanged', ({ outputActive }) => this.ctx.state.patch('obs', { recording: outputActive }));
  }

  private subscriptions(): number {
    const base = EventSubscription.General | EventSubscription.Scenes | EventSubscription.SceneItems | EventSubscription.Inputs | EventSubscription.Outputs;
    // Audio levels arrive ~20 times a second: only ask for them while someone listens.
    return this.meterListeners.size ? base | EventSubscription.InputVolumeMeters : base;
  }

  private meterListeners = new Set<(levels: Map<string, number>) => void>();

  /**
   * Peak level of every audio input in dBFS, about 20 times a second while subscribed.
   * Returns an unsubscribe function.
   */
  onVolumeMeters(listener: (levels: Map<string, number>) => void): () => void {
    const first = this.meterListeners.size === 0;
    this.meterListeners.add(listener);
    if (first) void this.reidentify();
    return () => {
      if (!this.meterListeners.delete(listener)) return;
      if (this.meterListeners.size === 0) void this.reidentify();
    };
  }

  private async reidentify(): Promise<void> {
    if (!this.connected) return;
    try { await this.obs.reidentify({ eventSubscriptions: this.subscriptions() }); }
    catch (err) { console.warn('[obs] reidentify', errorMessage(err)); }
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
    const generation = ++this.generation;
    const wasConnected = this.connected;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const { host, port } = this.ctx.settings.get('obs');
    this.ctx.state.patch('obs', { status: 'connecting', error: undefined });
    try {
      if (wasConnected) await this.obs.disconnect();
      await this.obs.connect(`ws://${host}:${port}`, this.ctx.secrets.get('obsPassword'), {
        eventSubscriptions: this.subscriptions(),
      });
      if (generation !== this.generation || this.manualDisconnect) { await this.obs.disconnect(); return; }
      this.ctx.state.patch('obs', { status: 'connected', error: undefined });
      // A retry scheduled by a close during this attempt would reconnect a healthy session.
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      await Promise.all([this.refreshScenes(), this.refreshInputs(), this.refreshOutputs()]);
      if (generation !== this.generation || !this.connected) return;
      await this.repairBrowserSources().catch((err) => console.warn('[obs] repair sources', errorMessage(err)));
      if (generation !== this.generation || !this.connected) return;
      await this.applySongAudio();
      if (generation !== this.generation || !this.connected) return;
      if (!silent) this.ctx.toast('success', 'toast.obsConnected');
    } catch (err) {
      if (generation !== this.generation || this.manualDisconnect) return;
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
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.obs.disconnect().catch(() => undefined);
    this.ctx.state.patch('obs', { status: 'disconnected', error: undefined, sceneItems: [], inputs: [] });
  }

  private songAudioTimer: NodeJS.Timeout | null = null;
  private scheduleSongAudio(): void {
    if (this.songAudioTimer) clearTimeout(this.songAudioTimer);
    // OBS fills a new source's settings right after InputCreated.
    this.songAudioTimer = setTimeout(() => { this.songAudioTimer = null; void this.applySongAudio(); }, 500);
  }

  /**
   * Applies the "who hears the music" choice to every Song Request browser source:
   * the source stays routed through OBS and its monitoring decides stream vs. headphones.
   */
  async applySongAudio(): Promise<void> {
    if (!this.connected) { this.ctx.state.patch('songRequests', { obsAudio: null }); return; }
    const monitorType = MONITOR_TYPE[this.ctx.settings.get('songRequests')?.listen as keyof typeof MONITOR_TYPE] ?? MONITOR_TYPE.viewers;
    const generation = this.generation;
    let sources = 0;
    try {
      const { inputs } = await this.obs.call('GetInputList', { inputKind: 'browser_source' });
      for (const input of inputs as { inputName: string }[]) {
        const { inputSettings } = await this.obs.call('GetInputSettings', { inputName: input.inputName });
        const settings = inputSettings as { url?: string; reroute_audio?: boolean };
        if (!isMusicOverlay(settings.url ?? '')) continue;
        // Without "Control audio via OBS" the browser plays straight to the speakers and OBS cannot route it.
        if (!settings.reroute_audio) await this.obs.call('SetInputSettings', { inputName: input.inputName, inputSettings: { reroute_audio: true }, overlay: true });
        await this.obs.call('SetInputAudioMonitorType', { inputName: input.inputName, monitorType });
        sources++;
      }
      if (generation === this.generation) this.ctx.state.patch('songRequests', { obsAudio: { sources, error: null } });
    } catch (err) {
      if (generation === this.generation) this.ctx.state.patch('songRequests', { obsAudio: { sources, error: errorMessage(err) } });
    }
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
    const generation = this.generation;
    const list = await this.obs.call('GetSceneList');
    if (generation !== this.generation || !this.connected) return;
    // OBS returns scenes bottom-to-top; reverse to match the OBS UI.
    const scenes = (list.scenes as { sceneName: string }[]).map((s) => s.sceneName).reverse();
    this.ctx.state.patch('obs', { scenes, currentScene: list.currentProgramSceneName });
    await this.refreshSceneItems();
  }

  private async refreshSceneItems(): Promise<void> {
    const generation = this.generation;
    const scene = this.ctx.state.current.obs.currentScene;
    if (!this.connected || !scene) return;
    try {
      const res = await this.obs.call('GetSceneItemList', { sceneName: scene });
      const sceneItems = (res.sceneItems as any[])
        .map((i) => ({ id: i.sceneItemId as number, name: i.sourceName as string, enabled: i.sceneItemEnabled as boolean }))
        .reverse();
      if (generation === this.generation && this.connected && this.ctx.state.current.obs.currentScene === scene) this.ctx.state.patch('obs', { sceneItems });
    } catch (err) {
      console.warn('[obs] scene items', errorMessage(err));
    }
  }

  private async refreshInputs(): Promise<void> {
    if (!this.connected) return;
    const generation = this.generation;
    const { inputs } = await this.obs.call('GetInputList');
    const names = (inputs as { inputName: string }[]).map((i) => i.inputName);
    // Only inputs with audio answer GetInputMute; that's how we find mixer channels.
    const checks = await Promise.allSettled(names.map((inputName) => this.obs.call('GetInputMute', { inputName })));
    const audio = names
      .map((name, i) => (checks[i].status === 'fulfilled' ? { name, muted: (checks[i] as PromiseFulfilledResult<any>).value.inputMuted } : null))
      .filter(Boolean) as { name: string; muted: boolean }[];
    if (generation === this.generation && this.connected) this.ctx.state.patch('obs', { inputs: audio });
  }

  private async refreshOutputs(): Promise<void> {
    if (!this.connected) return;
    const generation = this.generation;
    const [stream, record] = await Promise.all([this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus')]);
    if (generation === this.generation && this.connected) this.ctx.state.patch('obs', { streaming: stream.outputActive, recording: record.outputActive });
  }

  // ---------- commands ----------

  private ensure(): void {
    if (!this.connected) throw new Error('OBS is not connected');
  }

  private async repairInput(inputName: string, url: string): Promise<void> {
    await this.obs.call('SetInputSettings', { inputName, inputSettings: {
      url, reroute_audio: true, shutdown: false, restart_when_active: false, fps_custom: true, fps: 30,
    }, overlay: true });
    // A browser source that loaded while the server was unavailable needs an explicit reload.
    await this.obs.call('PressInputPropertiesButton', { inputName, propertyName: 'refreshnocache' });
  }

  async repairBrowserSources(): Promise<void> {
    const base = this.ctx.state.current.overlayUrl;
    if (!this.connected || !base) return;
    const generation = this.generation;
    const { inputs } = await this.obs.call('GetInputList', { inputKind: 'browser_source' });
    for (const input of inputs as { inputName: string }[]) {
      if (generation !== this.generation || !this.connected) return;
      try {
        const { inputSettings } = await this.obs.call('GetInputSettings', { inputName: input.inputName });
        const raw = (inputSettings as { url?: string }).url;
        if (generation !== this.generation || !this.connected) return;
        if (!raw || !overlayIdentity(raw)) continue;
        const old = new URL(raw);
        await this.repairInput(input.inputName, `${base}${old.pathname}${old.search}`);
      } catch (err) { console.warn('[obs] repair source', input.inputName, errorMessage(err)); }
    }
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
    const operation = this.sourceWrites.then(() => this.addBrowserSourceNow(name, url, width, height));
    this.sourceWrites = operation.catch(() => undefined);
    return operation;
  }

  private async addBrowserSourceNow(name: string, url: string, width: number, height: number): Promise<'created' | 'added' | 'exists'> {
    this.ensure();
    const sceneName = this.ctx.state.current.obs.currentScene;
    if (!sceneName) throw new Error('no current scene');
    const { inputs } = await this.obs.call('GetInputList', { inputKind: 'browser_source' });
    for (const input of inputs as { inputName: string }[]) {
      const { inputSettings } = await this.obs.call('GetInputSettings', { inputName: input.inputName });
      const existingUrl = (inputSettings as { url?: string }).url ?? '';
      if (existingUrl !== url && (!overlayIdentity(url) || overlayIdentity(existingUrl) !== overlayIdentity(url))) continue;
      await this.repairInput(input.inputName, url);
      if (isMusicOverlay(url)) await this.applySongAudio();
      const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName });
      const existing = (sceneItems as { sourceName: string; sceneItemId: number }[]).find((i) => i.sourceName === input.inputName);
      if (existing) {
        await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: existing.sceneItemId, sceneItemEnabled: true });
        await this.refreshSceneItems();
        return 'exists';
      }
      await this.obs.call('CreateSceneItem', { sceneName, sourceName: input.inputName, sceneItemEnabled: true });
      await this.refreshSceneItems();
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
      inputSettings: { url, width, height, reroute_audio: true, shutdown: false, restart_when_active: false, fps_custom: true, fps: 30 },
      sceneItemEnabled: true,
    });
    await this.refreshSceneItems();
    if (isMusicOverlay(url)) await this.applySongAudio();
    return 'created';
  }

  // ---------- precise controls (curses, ducking) ----------

  /** Every input and scene: filters can be attached to both. */
  async listSources(): Promise<string[]> {
    this.ensure();
    const [{ inputs }, { scenes }] = await Promise.all([this.obs.call('GetInputList'), this.obs.call('GetSceneList')]);
    const names = [...(inputs as { inputName: string }[]).map((i) => i.inputName), ...(scenes as { sceneName: string }[]).map((s) => s.sceneName)];
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }

  async listFilters(sourceName: string): Promise<string[]> {
    this.ensure();
    const { filters } = await this.obs.call('GetSourceFilterList', { sourceName });
    return (filters as { filterName: string }[]).map((f) => f.filterName);
  }

  /** Returns the previous state, so the caller can undo exactly what it changed. */
  async setFilterEnabled(sourceName: string, filterName: string, enabled: boolean): Promise<boolean> {
    this.ensure();
    const { filterEnabled } = await this.obs.call('GetSourceFilter', { sourceName, filterName });
    if (filterEnabled !== enabled) await this.obs.call('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled: enabled });
    return filterEnabled as boolean;
  }

  async setSourceVisible(sceneName: string, sourceName: string, visible: boolean): Promise<boolean> {
    this.ensure();
    const scene = sceneName || this.ctx.state.current.obs.currentScene;
    const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName: scene, sourceName });
    const { sceneItemEnabled } = await this.obs.call('GetSceneItemEnabled', { sceneName: scene, sceneItemId });
    if (sceneItemEnabled !== visible) await this.obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled: visible });
    return sceneItemEnabled as boolean;
  }

  async setMute(inputName: string, muted: boolean): Promise<boolean> {
    this.ensure();
    const { inputMuted } = await this.obs.call('GetInputMute', { inputName });
    if (inputMuted !== muted) await this.obs.call('SetInputMute', { inputName, inputMuted: muted });
    return inputMuted as boolean;
  }

  async getVolume(inputName: string): Promise<number> {
    this.ensure();
    const { inputVolumeMul } = await this.obs.call('GetInputVolume', { inputName });
    return inputVolumeMul as number;
  }

  async setVolume(inputName: string, multiplier: number): Promise<void> {
    this.ensure();
    await this.obs.call('SetInputVolume', { inputName, inputVolumeMul: Math.max(0, Math.min(20, multiplier)) });
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
