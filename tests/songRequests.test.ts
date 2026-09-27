import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import type { AppContext } from '../src/main/core/context';
import type { MusicService } from '../src/main/features/music';
import { SongRequestService, youtubeUrlInText, youtubeVideoId } from '../src/main/features/songRequests';

const first = 'M7lc1UVf-VE';
const second = 'dQw4w9WgXcQ';

function setup() {
  const bus = new EventBus();
  const state = new StateHub(bus);
  let settings = defaultSettings('en');
  settings.currency = 'RUB';
  settings.songRequests = { ...settings.songRequests, enabled: true, rewardTitle: 'Song', minDonation: 100 };
  const ctx = {
    bus,
    state,
    settings: {
      get: (key: keyof typeof settings) => settings[key],
      set: (key: keyof typeof settings, value: never) => { settings = { ...settings, [key]: value }; bus.emit('settings:changed', key); },
    },
  } as unknown as AppContext;
  const music = { pauseCurrent: vi.fn(async () => 'Spotify.exe'), resumeSource: vi.fn(async () => undefined) } as unknown as MusicService;
  const broadcast = vi.fn();
  const service = new SongRequestService(ctx, music, broadcast);
  return { ctx, service, music, broadcast };
}

describe('song requests', () => {
  it('accepts individual YouTube videos and rejects lookalike hosts', () => {
    expect(youtubeVideoId(`https://youtu.be/${first}?t=5`)).toBe(first);
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${first}`)).toBe(first);
    expect(youtubeVideoId(`https://youtube.com.evil.example/watch?v=${first}`)).toBeNull();
    expect(youtubeVideoId('https://youtube.com/playlist?list=abc')).toBeNull();
    expect(youtubeUrlInText(`Please play https://youtu.be/${first}!`)).toContain(first);
  });

  it('moves through redemptions and donations, then resumes the previous player', async () => {
    const { ctx, service, music } = setup();
    service.setPlayerConnected(true);
    ctx.bus.emit('event', { id: 'reward1', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardTitle: 'Song', cost: 1000, input: `https://youtu.be/${first}` });
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe(first));
    ctx.bus.emit('event', { id: 'donation1', source: 'donationalerts', timestamp: 2, userName: 'Bob', type: 'donation', amount: 150, currency: 'RUB', message: `https://youtu.be/${second}` });
    expect(ctx.state.current.songRequests.queue[0]?.videoId).toBe(second);
    const nonce1 = (service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>).nonce;
    expect(await service.playerFinished('reward1', nonce1 ?? '')).toBe(true);
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe(second));
    const nonce2 = (service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>).nonce;
    expect(await service.playerFinished('donation1', nonce2 ?? '')).toBe(true);
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect((music.pauseCurrent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((music.resumeSource as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Spotify.exe');
  });

  it('ignores duplicate donation events and donations below the configured amount', () => {
    const { ctx } = setup();
    const event = { id: 'tip1', source: 'streamlabs' as const, timestamp: 1, userName: 'Bob', type: 'donation' as const, amount: 50, currency: 'RUB', message: `https://youtu.be/${first}` };
    ctx.bus.emit('event', event);
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
    ctx.bus.emit('event', { ...event, amount: 150 });
    ctx.bus.emit('event', { ...event, amount: 150 });
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
  });
});
