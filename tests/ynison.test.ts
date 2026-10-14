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
});
