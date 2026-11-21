import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { BrowserMusicBridge, browserHostForSession, classifyMusicSession } from '../src/main/features/browserMusic';
import { MusicService, chooseMusicCandidate } from '../src/main/features/music';

describe('Windows music session selection', () => {
  it('recognizes Spotify, Yandex Music and browser sessions', () => {
    expect(classifyMusicSession('Spotify.exe').kind).toBe('spotify');
    expect(classifyMusicSession('YandexMusic.exe').kind).toBe('yandex');
    expect(classifyMusicSession('Chrome').kind).toBe('browser');
    expect(classifyMusicSession('SomePlayer.exe').kind).toBe('other');
  });

  it('prefers active playback before the service priority', () => {
    const sessions = [
      { kind: 'spotify' as const, playing: false },
      { kind: 'browser' as const, playing: true },
    ];
    expect(chooseMusicCandidate(sessions, 'auto')).toBe(sessions[1]);
  });

  it('prefers Spotify then Yandex among active sessions', () => {
    const sessions = [
      { kind: 'browser' as const, playing: true },
      { kind: 'yandex' as const, playing: true },
      { kind: 'spotify' as const, playing: true },
    ];
    expect(chooseMusicCandidate(sessions, 'auto')).toBe(sessions[2]);
    expect(chooseMusicCandidate(sessions, 'yandex')).toBe(sessions[1]);
    expect(chooseMusicCandidate(sessions, 'other')).toBeNull();
  });

  it('distinguishes YouTube Music from YouTube and identifies Yandex Music in the browser', () => {
    expect(classifyMusicSession('Chrome', { title: 'Track — YouTube Music', artist: 'Artist' })).toEqual({ kind: 'youtubeMusic', browser: true });
    expect(classifyMusicSession('Firefox', { artist: 'www.youtube.com' })).toEqual({ kind: 'youtube', browser: true });
    expect(classifyMusicSession('MSEdge', { subtitle: 'https://music.yandex.ru/' })).toEqual({ kind: 'yandex', browser: true });
    expect(classifyMusicSession('Chrome', { album: 'Artist', artist: 'open.spotify.com' })).toEqual({ kind: 'spotify', browser: true });
    expect(classifyMusicSession('Brave', {}, 'soundcloud.com')).toEqual({ kind: 'browser', browser: true, site: 'soundcloud.com' });
    expect(classifyMusicSession('Chrome', { title: 'Artist mentions Spotify in the song' })).toEqual({ kind: 'browser', browser: true });
    expect(chooseMusicCandidate([{ kind: 'youtubeMusic', playing: true, browser: true }], 'browser')?.kind).toBe('youtubeMusic');
    expect(chooseMusicCandidate([{ kind: 'youtubeMusic', playing: true, browser: false }], 'browser')).toBeNull();
  });

  it('uses the title to distinguish audible tabs and leaves ambiguous sessions unmatched', () => {
    const tabs = [
      { host: 'music.yandex.ru', title: 'Песня о доме — Артист' },
      { host: 'music.youtube.com', title: 'Some Song - YouTube Music' },
    ];
    expect(browserHostForSession('Песня о доме', tabs, false)).toBe('music.yandex.ru');
    expect(browserHostForSession('Some Song', tabs, false)).toBe('music.youtube.com');
    expect(browserHostForSession('Other Title', tabs, true)).toBeUndefined();
    expect(browserHostForSession('Other Title', tabs.slice(0, 1), true)).toBe('music.yandex.ru');
    expect(browserHostForSession('Some Song', [...tabs, { host: 'youtube.com', title: 'Some Song - YouTube' }], true)).toBeUndefined();
  });

  it('pauses and resumes the same browser session while leaving the selected external provider playing', async () => {
    const bus = new EventBus();
    const settings = defaultSettings('en');
    const ctx = { bus, state: new StateHub(bus), settings: { get: (key: keyof typeof settings) => settings[key] } } as unknown as AppContext;
    function session(title: string, subtitle: string) {
      let playing = true;
      return {
        sourceAppUserModelId: 'Chrome',
        tryGetMediaPropertiesAsync: async () => ({ title, subtitle, artist: 'Test Artist' }),
        getPlaybackInfo: () => ({ playbackStatus: playing ? 4 : 5 }),
        tryPauseAsync: vi.fn(async () => { playing = false; return true; }),
        tryPlayAsync: vi.fn(async () => { playing = true; return true; }),
      };
    }
    const yandex = session('Yandex song', 'music.yandex.ru');
    const youtube = session('YouTube Music song', 'music.youtube.com');
    const music = new MusicService(ctx, '');
    Object.assign(music, {
      manager: { getSessions: () => [yandex, youtube] },
      bindings: { createProjectedLifetimeScope: () => ({ dispose() {} }), GlobalSystemMediaTransportControlsSessionPlaybackStatus: { Playing: 4 } },
    });
    const token = await music.pauseCurrent('yandex');
    expect(token).toBeTruthy();
    expect(yandex.tryPauseAsync).not.toHaveBeenCalled();
    expect(youtube.tryPauseAsync).toHaveBeenCalledTimes(1);
    await music.resumeSource(token!);
    expect(youtube.tryPlayAsync).toHaveBeenCalledTimes(1);
    expect(yandex.tryPlayAsync).not.toHaveBeenCalled();
  });

  it('accepts authenticated loopback reports, bounds and expires the data, and removes disconnected clients', async () => {
    const token = 'a'.repeat(64);
    const onUpdate = vi.fn();
    const bridge = new BrowserMusicBridge(() => token, onUpdate);
    const server = createServer(async (req, res) => {
      if (!await bridge.route(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const pairing = new URL(BrowserMusicBridge.pairing((server.address() as AddressInfo).port, token));
      expect(pairing.hash).toBe(`#${token}`);
      pairing.hash = '';
      const post = (tabs: unknown, authorization = `Bearer ${token}`) =>
        fetch(pairing, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: '86bf289d-0cbc-427c-a392-6ec02bc20684', tabs }) });
      expect((await post([], '')).status).toBe(403);
      expect(bridge.snapshot().connected).toBe(false);
      expect((await post(new Array(13).fill(null))).status).toBe(400);
      expect((await post([{ host: 'music.youtube.com', title: 'Song' }, { host: '127.0.0.1', title: 'Private' }])).status).toBe(204);
      expect(bridge.snapshot()).toEqual({ connected: true, tabs: [{ host: 'music.youtube.com', title: 'Song' }] });
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(bridge.snapshot(Date.now() + 76_000)).toEqual({ connected: false, tabs: [] });
      expect((await post([])).status).toBe(204);
      expect((await post(null)).status).toBe(204);
      expect(bridge.snapshot()).toEqual({ connected: false, tabs: [] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
