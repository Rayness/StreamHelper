import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { ObsService } from '../src/main/obs/obs';

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
        return ok({ sceneItems: [{ sceneItemId: 1, sourceName: 'Camera', sceneItemEnabled: true }, { sceneItemId: 2, sourceName: 'Alerts', sceneItemEnabled: false }] });
      case 'GetInputList':
        return ok({ inputs: [{ inputName: 'Mic' }, { inputName: 'Desktop' }, { inputName: 'Image' }] });
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

function makeCtx(port: number, password?: string) {
  const bus = new EventBus();
  const state = new StateHub(bus);
  const secrets: Record<string, unknown> = { obsPassword: password };
  const toast = vi.fn();
  const ctx = {
    bus,
    state,
    settings: { get: (k: string) => (k === 'obs' ? { host: '127.0.0.1', port, autoConnect: false } : undefined) },
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
