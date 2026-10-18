import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import type { AppContext } from '../src/main/core/context';
import type { SecretsData } from '../src/main/core/secrets';
import { YnisonClient, type YnisonSocket, type YnisonState } from '../src/main/integrations/ynison';
import { tokenFromRedirect, YandexMusicService } from '../src/main/integrations/yandexMusic';
import type { RemotePlayerEvent } from '../src/main/features/songRequests';

class FakeSocket implements YnisonSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  private handlers: Record<string, ((...args: any[]) => void)[]> = {};
  constructor(readonly url: string, readonly protocols: string[]) {}
  on(event: string, listener: (...args: any[]) => void): this { (this.handlers[event] ??= []).push(listener); return this; }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; for (const fn of this.handlers.open ?? []) fn(); }
  message(data: unknown): void { for (const fn of this.handlers.message ?? []) fn(Buffer.from(JSON.stringify(data))); }
  get headers(): Record<string, string> { return JSON.parse(decodeURIComponent(this.protocols[2])); }
}

function fakeNetwork() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string, protocols: string[]) => { const socket = new FakeSocket(url, protocols); sockets.push(socket); return socket; };
  return { sockets, factory };
}

const version = { device_id: 'app', version: 1, timestamp_ms: 0 };
function state(trackId: string | null, status: { paused?: boolean; progress_ms?: number; duration_ms?: number } = {}, from = 'user'): YnisonState {
  return {
    player_state: {
      player_queue: {
        current_playable_index: trackId ? 0 : -1, entity_id: '', entity_type: 'VARIOUS', options: { repeat_mode: 'NONE' }, entity_context: 'BASED_ON_ENTITY_BY_DEFAULT', version, from_optional: '',
        playable_list: trackId ? [{ playable_id: trackId, playable_type: 'TRACK', album_id_optional: null, from, title: '', cover_url_optional: null }] : [],
      },
      status: { duration_ms: 200_000, paused: false, playback_speed: 1, progress_ms: 0, version, ...status },
    },
    devices: [
      { info: { device_id: 'app', title: 'Music Desktop App', type: 'WEB_DESKTOP' }, capabilities: { can_be_player: true } },
      { info: { device_id: 'me', title: 'StreamHelper' }, is_shadow: true, capabilities: { can_be_player: false } },
    ],
    active_device_id_optional: 'app',
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('Ynison', () => {
  it('reads the token Yandex puts into the redirect', () => {
    expect(tokenFromRedirect('https://music.yandex.ru/#access_token=y0_AgAAAAABCDEFGHIJKLMNOPQRSTUV&token_type=bearer&expires_in=31536000')).toBe('y0_AgAAAAABCDEFGHIJKLMNOPQRSTUV');
    expect(tokenFromRedirect('https://music.yandex.ru/home')).toBeNull();
    expect(tokenFromRedirect('not a url')).toBeNull();
  });

  it('connects through the redirector as a shadow remote and replaces the queue to play a track', () => {
    const { sockets, factory } = fakeNetwork();
    const onState = vi.fn();
    const client = new YnisonClient('token123', 'me', { onState }, factory);
    client.start();
    expect(sockets[0].url).toBe('wss://ynison.music.yandex.ru/redirector.YnisonRedirectService/GetRedirectToYnison');
    expect(sockets[0].protocols.slice(0, 2)).toEqual(['Bearer', 'v2']);
    expect(sockets[0].headers).toMatchObject({ 'Ynison-Device-Id': 'me', authorization: 'OAuth token123' });
    sockets[0].message({ host: 'hub.example', redirect_ticket: 'ticket', session_id: 'sess' });
    expect(sockets[1].url).toBe('wss://hub.example/ynison_state.YnisonStateService/PutYnisonState');
    expect(sockets[1].headers).toMatchObject({ 'Ynison-Redirect-Ticket': 'ticket', 'Ynison-Session-Id': 'sess', authorization: 'OAuth token123' });
    sockets[1].open();
    const hello = sockets[1].sent[0];
    expect(hello.update_full_state.device).toMatchObject({ is_shadow: true, capabilities: { can_be_player: false, can_be_remote_controller: true }, info: { device_id: 'me' } });
    expect(hello.activity_interception_type).toBe('DO_NOT_INTERCEPT_BY_DEFAULT');
    sockets[1].message(state('1'));
    expect(client.connected).toBe(true);
    expect(onState).toHaveBeenCalled();
    expect(client.playTracks([{ trackId: '42', albumId: '7', title: 'Song', durationMs: 1000 }])).toBe(true);
    const play = sockets[1].sent[1].update_player_state.player_state;
    expect(play.player_queue).toMatchObject({ current_playable_index: 0, playable_list: [{ playable_id: '42', playable_type: 'TRACK', album_id_optional: '7', title: 'Song' }] });
    expect(play.status).toMatchObject({ paused: false, progress_ms: 0, duration_ms: 1000 });
    expect(play.status.version.device_id).toBe('me');
    client.setPaused(true);
    expect(sockets[1].sent[2].update_playing_status.playing_status.paused).toBe(true);
    client.setVolume(0.4);
    expect(sockets[1].sent[3].update_volume_info).toMatchObject({ device_id: 'app', volume_info: { volume: 0.4 } });
    client.stop();
  });
});

describe('Ynison resilience', () => {
  it('reconnects after a silent drop, a bad hub address or a hung redirector, and survives a throwing listener', () => {
    vi.useFakeTimers();
    const { sockets, factory } = fakeNetwork();
    const pinged: FakeSocket[] = [];
    const withPing = (url: string, protocols: string[]) => { const socket = factory(url, protocols) as FakeSocket & { ping?: () => void }; socket.ping = () => { pinged.push(socket); }; return socket; };
    const onState = vi.fn(() => { throw new Error('listener bug'); });
    const client = new YnisonClient('token123', 'me', { onState }, withPing);
    client.start();
    // A host that can't be a host is refused without throwing.
    expect(() => sockets[0].message({ host: 'bad host/ x', redirect_ticket: 't' })).not.toThrow();
    vi.advanceTimersByTime(2_000);
    // The next redirector never answers.
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(15_000 + 5_000);
    expect(sockets).toHaveLength(3);
    sockets[2].message({ host: 'hub.example', redirect_ticket: 't', session_id: 's' });
    const hub = sockets[3];
    hub.open();
    expect(() => hub.message(state('1'))).not.toThrow();
    expect(onState).toHaveBeenCalled();
    // Partial / unknown messages are ignored.
    expect(() => hub.message({ player_state: { status: {} } })).not.toThrow();
    // No pong for a whole heartbeat: the socket is given up and a new connection starts.
    vi.advanceTimersByTime(25_000);
    expect(pinged).toHaveLength(1);
    vi.advanceTimersByTime(25_000);
    expect(client.connected).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(sockets.length).toBeGreaterThan(4);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops for good after the login is refused', () => {
    vi.useFakeTimers();
    const { sockets, factory } = fakeNetwork();
    let client!: YnisonClient;
    client = new YnisonClient('token123', 'me', { onStatus: (_status, error) => { if (error === 'unauthorized') client.stop(); } }, factory);
    client.start();
    sockets[0].message({ error: { grpc_code: 16, http_code: 401, message: 'UNAUTHENTICATED' } });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('Yandex Music remote', () => {
  function setup() {
    vi.useFakeTimers();
    const bus = new EventBus();
    const hub = new StateHub(bus);
    let settings = defaultSettings('en');
    const secrets: SecretsData = { yandexMusic: { accessToken: 'token123456789012345678901', deviceId: 'me', login: 'streamer' } };
    const ctx = {
      bus, state: hub,
      settings: { get: (key: keyof typeof settings) => settings[key], set: (key: keyof typeof settings, value: never) => { settings = { ...settings, [key]: value }; bus.emit('settings:changed', key); } },
      secrets: { get: (key: keyof SecretsData) => secrets[key], set: (key: keyof SecretsData, value: never) => { secrets[key] = value; } },
    } as unknown as AppContext;
    const { sockets, factory } = fakeNetwork();
    const service = new YandexMusicService(ctx, factory);
    const events: RemotePlayerEvent[] = [];
    service.onEvent((event) => events.push(event));
    service.start();
    sockets[0].message({ host: 'hub', redirect_ticket: 't', session_id: 's' });
    const hub1 = sockets[1];
    hub1.open();
    return { ctx, service, hub: hub1, events };
  }

  it('starts the request on the playing device, notices the end and gives the streamer\'s music back', async () => {
    const { ctx, service, hub, events } = setup();
    hub.message(state('own', { progress_ms: 50_000 }));
    expect(service.ready).toBe(true);
    expect(ctx.state.current.yandexMusic).toMatchObject({ status: 'connected', device: 'Music Desktop App' });
    await service.play({ trackId: '42', durationMs: 200_000 });
    expect(hub.sent.at(-2)!.update_player_state.player_state.player_queue.playable_list[0].playable_id).toBe('42');
    // The app picked it up, then the track runs out with no further news.
    hub.message(state('42', { progress_ms: 0 }, 'streamhelper-song-request'));
    vi.advanceTimersByTime(200_000 + 5_000);
    expect(events).toEqual([{ type: 'ended', trackId: '42' }]);
    service.release(true);
    const restored = hub.sent.at(-1)!.update_player_state.player_state;
    expect(restored.player_queue.playable_list[0].playable_id).toBe('own');
    expect(restored.status.paused).toBe(false);
    expect(restored.status.progress_ms).toBeGreaterThanOrEqual(50_000);
    service.stop();
  });

  it('treats a queue change after the start as the end and reports a device that never started', async () => {
    const { service, hub, events } = setup();
    hub.message(state(null));
    await service.play({ trackId: '42' });
    hub.message(state('42', {}, 'streamhelper-song-request'));
    hub.message(state('777'));
    expect(events).toEqual([{ type: 'ended', trackId: '42' }]);
    // Nobody plays it: paused queue, no confirmation within the start timeout.
    await service.play({ trackId: '43' });
    hub.message(state('43', { paused: true }, 'streamhelper-song-request'));
    vi.advanceTimersByTime(13_000);
    expect(events.at(-1)).toMatchObject({ type: 'failed', trackId: '43' });
    // Nothing saved to restore: release just pauses ours.
    service.release(true);
    expect(hub.sent.at(-1)!.update_playing_status.playing_status.paused).toBe(true);
    service.stop();
  });

  it('refuses to play when no Yandex Music app or site is open', async () => {
    const { service, hub } = setup();
    hub.message({ ...state(null), devices: [{ info: { device_id: 'me' }, is_shadow: true }], active_device_id_optional: null });
    await expect(service.play({ trackId: '42' })).rejects.toThrow('Open the Yandex Music app or site');
    service.stop();
  });

  it.each(['disable', 'logout'] as const)('restores the previous queue before disconnecting on %s', async (action) => {
    const { ctx, service, hub } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), resumeWindowsMusic: true });
    hub.message(state('own', { progress_ms: 50_000 }));
    await service.play({ trackId: '42' });
    hub.message(state('42', {}, 'streamhelper-song-request'));
    const sentBeforeDisconnect = hub.sent.length;
    const close = vi.spyOn(hub, 'close');
    close.mockImplementation(() => {
      expect(hub.sent.length).toBeGreaterThan(sentBeforeDisconnect);
      expect(hub.sent.at(-1)!.update_player_state.player_state).toMatchObject({
        player_queue: { playable_list: [{ playable_id: 'own' }] },
        status: { paused: false, progress_ms: 50_000 },
      });
      hub.readyState = 3;
    });
    if (action === 'disable') ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), yandexPlayback: false });
    else service.logout();
    expect(close).toHaveBeenCalledOnce();
    expect(service.ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses the request before logout when restoring music is disabled', async () => {
    const { ctx, service, hub } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), resumeWindowsMusic: false });
    hub.message(state('own'));
    await service.play({ trackId: '42' });
    hub.message(state('42', {}, 'streamhelper-song-request'));
    const close = vi.spyOn(hub, 'close');
    close.mockImplementation(() => {
      expect(hub.sent.at(-1)!.update_playing_status.playing_status.paused).toBe(true);
      hub.readyState = 3;
    });
    service.logout();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
