import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { ObsService, overlayIdentity } from '../src/main/obs/obs';

const sha256b64 = (s: string) => createHash('sha256').update(s).digest('base64');

/** Just enough of the obs-websocket v5 JSON protocol to exercise ObsService. */
class FakeObs {
  wss: WebSocketServer;
  socket: WebSocket | null = null;
  requests: { type: string; data: any }[] = [];
  scene = 'Game';
  muted: Record<string, boolean> = { Mic: false, Desktop: true };
  salt = 'salt123';
  challenge = 'challenge456';
  browsers = new Map<string, Record<string, unknown>>();
  items = new Map<string, { sceneItemId: number; sourceName: string; sceneItemEnabled: boolean }[]>();

  constructor(private password?: string) {
    this.wss = new WebSocketServer({ port: 0, handleProtocols: () => 'obswebsocket.json' });
    this.wss.on('connection', (ws) => {
      this.socket = ws;
      ws.send(
        JSON.stringify({
          op: 0,
          d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, ...(password ? { authentication: { challenge: this.challenge, salt: this.salt } } : {}) },
        }),
      );
      ws.on('message', (raw) => this.onMessage(ws, JSON.parse(raw.toString())));
    });
  }

  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }

  private onMessage(ws: WebSocket, msg: any): void {
    if (msg.op === 1) {
      if (this.password) {
        const expected = sha256b64(sha256b64(this.password + this.salt) + this.challenge);
        if (msg.d.authentication !== expected) return ws.close(4009, 'Authentication failed.');
      }
      ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      return;
    }
    if (msg.op !== 6) return;
    const { requestType, requestId, requestData } = msg.d;
    this.requests.push({ type: requestType, data: requestData });
    const ok = (responseData?: unknown) =>
      ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
    const fail = () => ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: false, code: 604, comment: 'no audio' } } }));
    switch (requestType) {
      case 'GetSceneList':
        return ok({ currentProgramSceneName: this.scene, scenes: [{ sceneName: 'BRB' }, { sceneName: 'Game' }, { sceneName: 'Start' }] });
      case 'GetSceneItemList':
        return ok({ sceneItems: this.items.get(requestData.sceneName) ?? [{ sceneItemId: 1, sourceName: 'Camera', sceneItemEnabled: true }, { sceneItemId: 2, sourceName: 'Alerts', sceneItemEnabled: false }] });
      case 'GetInputList':
        return ok({ inputs: [...(requestData?.inputKind ? [] : [{ inputName: 'Mic' }, { inputName: 'Desktop' }, { inputName: 'Image' }]), ...[...this.browsers.keys()].map((inputName) => ({ inputName }))] });
      case 'GetInputSettings': return ok({ inputSettings: this.browsers.get(requestData.inputName) ?? {} });
      case 'SetInputSettings': this.browsers.set(requestData.inputName, { ...this.browsers.get(requestData.inputName), ...requestData.inputSettings }); return ok();
      case 'CreateInput':
        this.browsers.set(requestData.inputName, requestData.inputSettings);
        this.items.set(requestData.sceneName, [...this.items.get(requestData.sceneName) ?? [], { sceneItemId: 40, sourceName: requestData.inputName, sceneItemEnabled: true }]);
        return ok();
      case 'CreateSceneItem':
        this.items.set(requestData.sceneName, [...this.items.get(requestData.sceneName) ?? [], { sceneItemId: 41, sourceName: requestData.sourceName, sceneItemEnabled: true }]);
        return ok();
      case 'SetSceneItemEnabled':
        this.items.set(requestData.sceneName, (this.items.get(requestData.sceneName) ?? []).map((i) => i.sceneItemId === requestData.sceneItemId ? { ...i, sceneItemEnabled: requestData.sceneItemEnabled } : i));
        return ok();
      case 'GetInputMute':
        return requestData.inputName in this.muted ? ok({ inputMuted: this.muted[requestData.inputName] }) : fail();
      case 'GetStreamStatus':
        return ok({ outputActive: true });
      case 'GetRecordStatus':
        return ok({ outputActive: false });
      case 'SetCurrentProgramScene':
        this.scene = requestData.sceneName;
        ok();
        return this.event('CurrentProgramSceneChanged', { sceneName: this.scene });
      case 'ToggleInputMute':
        this.muted[requestData.inputName] = !this.muted[requestData.inputName];
        ok();
        return this.event('InputMuteStateChanged', { inputName: requestData.inputName, inputMuted: this.muted[requestData.inputName] });
      default:
        return ok({});
    }
  }

  event(eventType: string, eventData: unknown): void {
    this.socket?.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } }));
  }

  close(): Promise<void> {
    return new Promise((r) => this.wss.close(() => r()));
  }
}

function makeCtx(port: number, password?: string, songRequests?: { listen: string }) {
  const bus = new EventBus();
  const state = new StateHub(bus);
  const secrets: Record<string, unknown> = { obsPassword: password };
  const toast = vi.fn();
  const ctx = {
    bus,
    state,
    settings: { get: (k: string) => (k === 'obs' ? { host: '127.0.0.1', port, autoConnect: false } : k === 'songRequests' ? songRequests : undefined) },
    secrets: { get: (k: string) => secrets[k], set: (k: string, v: unknown) => (secrets[k] = v) },
    toast,
    openExternal: vi.fn(),
    mediaDir: '',
  } as unknown as AppContext;
  return { ctx, state, toast };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});

describe('ObsService', () => {
  it('serializes concurrent add requests so they cannot duplicate a browser source', async () => {
    const fake = new FakeObs(); fake.items.set('Game', []);
    const { ctx } = makeCtx(fake.port);
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());
    await obs.connect();
    expect(await Promise.all([obs.addBrowserSource('Chat', 'http://127.0.0.1:8145/overlay/chat', 400, 600), obs.addBrowserSource('Chat', 'http://127.0.0.1:8145/overlay/chat', 400, 600)]))
      .toEqual(['created', 'exists']);
    expect(fake.requests.filter((r) => r.type === 'CreateInput')).toHaveLength(1);
    expect(fake.items.get('Game')).toHaveLength(1);
  });
  it('recognizes old local overlay URLs without matching other services or different instances', () => {
    expect(overlayIdentity('http://localhost:9999/overlay/goal?id=a')).toBe(overlayIdentity('http://127.0.0.1:8145/overlay/goal?id=a'));
    expect(overlayIdentity('http://127.0.0.1:8145/overlay/goal?id=a')).not.toBe(overlayIdentity('http://127.0.0.1:8145/overlay/goal?id=b'));
    expect(overlayIdentity('https://example.com/overlay/chat')).toBeNull();
    expect(overlayIdentity('http://localhost:9999/some-other-page')).toBeNull();
  });

  it('repairs a disabled existing source from the live scene, even if the cached list is stale', async () => {
    const fake = new FakeObs();
    fake.browsers.set('StreamHelper alerts', { url: 'http://localhost:1111/overlay/alerts', width: 1280, height: 720 });
    fake.items.set('Game', [{ sceneItemId: 9, sourceName: 'StreamHelper alerts', sceneItemEnabled: false }]);
    const { ctx, state } = makeCtx(fake.port);
    state.patch('overlayUrl', 'http://127.0.0.1:8145');
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());
    await obs.connect();
    state.patch('obs', { sceneItems: [] });
    expect(await obs.addBrowserSource('Alerts', 'http://127.0.0.1:8145/overlay/alerts', 1920, 1080)).toBe('exists');
    expect(fake.browsers.get('StreamHelper alerts')).toMatchObject({ url: 'http://127.0.0.1:8145/overlay/alerts', width: 1280, height: 720, fps: 30, shutdown: false });
    expect(fake.items.get('Game')?.[0].sceneItemEnabled).toBe(true);
    expect(fake.requests.filter((r) => r.type === 'CreateInput')).toHaveLength(0);
    expect(fake.requests.some((r) => r.type === 'PressInputPropertiesButton')).toBe(true);
  });

  it('reuses another scene source and creates a replacement if it was removed from OBS', async () => {
    const fake = new FakeObs();
    fake.browsers.set('Widget', { url: 'http://127.0.0.1:8145/overlay/chat' });
    fake.items.set('Game', []);
    const { ctx } = makeCtx(fake.port);
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());
    await obs.connect();
    expect(await obs.addBrowserSource('Chat', 'http://127.0.0.1:8145/overlay/chat', 400, 600)).toBe('added');
    fake.browsers.delete('Widget'); fake.items.set('Game', []);
    expect(await obs.addBrowserSource('Chat', 'http://127.0.0.1:8145/overlay/chat', 400, 600)).toBe('created');
    expect(fake.browsers.get('Chat')).toMatchObject({ width: 400, height: 600, reroute_audio: true, fps: 30 });
  });

  it('reloads local browser sources again after OBS reconnects', async () => {
    const fake = new FakeObs();
    fake.browsers.set('Chat', { url: 'http://127.0.0.1:8145/overlay/chat' });
    fake.browsers.set('External', { url: 'https://example.com/overlay/chat' });
    const { ctx, state } = makeCtx(fake.port);
    state.patch('overlayUrl', 'http://127.0.0.1:8145');
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());
    await obs.connect();
    fake.socket!.close();
    await until(() => state.current.obs.status === 'disconnected');
    await obs.connect();
    expect(fake.requests.filter((r) => r.type === 'PressInputPropertiesButton' && r.data.inputName === 'Chat')).toHaveLength(2);
    expect(fake.requests.some((r) => r.type === 'SetInputSettings' && r.data.inputName === 'External')).toBe(false);
  });
  it('connects and mirrors scenes, sources, audio and outputs', async () => {
    const fake = new FakeObs('hunter2');
    const { ctx, state, toast } = makeCtx(fake.port, 'hunter2');
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());

    await obs.connect();
    const s = state.current.obs;
    expect(s.status).toBe('connected');
    expect(s.scenes).toEqual(['Start', 'Game', 'BRB']); // reversed to match the OBS UI
    expect(s.currentScene).toBe('Game');
    expect(s.sceneItems.map((i) => i.name)).toEqual(['Alerts', 'Camera']);
    expect(s.inputs).toEqual([
      { name: 'Mic', muted: false },
      { name: 'Desktop', muted: true },
    ]);
    expect(s.streaming).toBe(true);
    expect(s.recording).toBe(false);
    expect(toast).toHaveBeenCalledWith('success', 'toast.obsConnected');
  });

  it('switches scenes and follows OBS events', async () => {
    const fake = new FakeObs();
    const { ctx, state } = makeCtx(fake.port);
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());
    await obs.connect(undefined, true);

    await obs.setScene('BRB');
    await until(() => state.current.obs.currentScene === 'BRB');
    expect(fake.requests.some((r) => r.type === 'SetCurrentProgramScene' && r.data.sceneName === 'BRB')).toBe(true);

    await obs.toggleMute('Mic');
    await until(() => state.current.obs.inputs.find((i) => i.name === 'Mic')?.muted === true);
  });

  it('routes only Song Request sources to stream / headphones as chosen', async () => {
    const fake = new FakeObs(); fake.items.set('Game', []);
    fake.browsers.set('Songs', { url: 'http://127.0.0.1:1234/overlay/song', reroute_audio: false });
    fake.browsers.set('Chat', { url: 'http://127.0.0.1:1234/overlay/chat', reroute_audio: true });
    fake.browsers.set('Other site', { url: 'https://example.com/overlay/song', reroute_audio: false });
    const listen = { listen: 'viewers' };
    const { ctx, state } = makeCtx(fake.port, undefined, listen);
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());
    await obs.connect(undefined, true);
    const monitor = () => fake.requests.filter((r) => r.type === 'SetInputAudioMonitorType').map((r) => r.data);
    expect(monitor()).toEqual([{ inputName: 'Songs', monitorType: 'OBS_MONITORING_TYPE_NONE' }]);
    expect(fake.browsers.get('Songs')!.reroute_audio).toBe(true);
    expect(fake.browsers.get('Other site')!.reroute_audio).toBe(false);
    expect(state.current.songRequests.obsAudio).toEqual({ sources: 1, error: null });
    listen.listen = 'both';
    await obs.applySongAudio();
    expect(monitor().at(-1)).toEqual({ inputName: 'Songs', monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' });
    listen.listen = 'me';
    await obs.applySongAudio();
    expect(monitor().at(-1)).toEqual({ inputName: 'Songs', monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' });
  });

  it('reports a wrong password without retrying', async () => {
    const fake = new FakeObs('right');
    const { ctx, state, toast } = makeCtx(fake.port, 'wrong');
    const obs = new ObsService(ctx);
    cleanup.push(() => obs.disconnect(), () => fake.close());
    await obs.connect();
    expect(state.current.obs.status).toBe('error');
    expect(toast).toHaveBeenCalledWith('error', 'toast.obsAuthFailed');
  });
});
