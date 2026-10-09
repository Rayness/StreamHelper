import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { defaultSettings } from '@shared/defaults';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import type { AppContext } from '../src/main/core/context';
import type { MusicService } from '../src/main/features/music';
import { SongRequestService, youtubeUrlInText, youtubeVideoId, type VideoCheck } from '../src/main/features/songRequests';

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
  const reply = vi.fn(async (_text: string, _replyTo?: string) => undefined);
  const lookup = vi.fn(async (_id: string): Promise<VideoCheck | null> => ({ ok: true, title: 'Song title' }));
  const settle = vi.fn(async (_reward: string, _id: string, _status: 'FULFILLED' | 'CANCELED') => undefined);
  const service = new SongRequestService(ctx, music, broadcast, reply, { lookup, rewards: { settle } });
  return { ctx, service, music, broadcast, reply, lookup, settle };
}

describe('song requests', () => {
  it('does not play a request removed while Windows music is pausing', async () => {
    const { ctx, service, music } = setup();
    let resolve!: (id: string) => void;
    vi.mocked(music.pauseCurrent).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    service.setPlayerConnected(true);
    service.add(`https://youtu.be/${first}`, 'Ann', 'manual', 'removed');
    service.remove('removed');
    resolve('Spotify.exe');
    await vi.waitFor(() => expect(music.resumeSource).toHaveBeenCalled());
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect(ctx.settings.get('songQueue')).toEqual([]);
  });
  it('retains paid requests on player errors and pauses autoplay until a manual retry', async () => {
    const { ctx, service, music } = setup();
    service.setPlayerConnected(true); service.add(`https://youtu.be/${first}`);
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current).not.toBeNull());
    const old = service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>;
    expect(await service.playerFinished(old.request!.id, old.nonce!, 'Embed blocked')).toBe(true);
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect(music.resumeSource).toHaveBeenCalled();
    service.add(`https://youtu.be/${second}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.state.current.songRequests.current).toBeNull();
    await service.play();
    expect(ctx.state.current.songRequests.current?.videoId).toBe(first);
  });
  it('accepts chat commands and applies permissions, aliases and per-viewer cooldowns', async () => {
    const { ctx, service } = setup();
    const message = { id: 'm1', platform: 'twitch', userId: 'u1', userName: 'Ann', text: `!sr https://youtu.be/${first}`, roles: { broadcaster: false, moderator: false, vip: false, subscriber: false } } as ChatMessage;
    expect(await service.handleChat(message)).toBe(true);
    expect(ctx.settings.get('songQueue')).toMatchObject([{ source: 'chat', userName: 'Ann', videoId: first }]);
    await service.handleChat({ ...message, id: 'm2', text: `!songrequest https://youtu.be/${second}` });
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
    await service.handleChat({ ...message, id: 'm3', userId: 'u2', text: `!songrequest https://youtu.be/${second}` });
    expect(ctx.settings.get('songQueue')).toHaveLength(2);
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), chatPermission: 'subscriber' });
    await service.handleChat({ ...message, id: 'm4', userId: 'u3' });
    expect(ctx.settings.get('songQueue')).toHaveLength(2);
    expect(await service.handleChat({ ...message, fromSelf: true })).toBe(false);
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), chatEnabled: false });
    expect(await service.handleChat(message)).toBe(false);
  });

  it('matches a selected reward by ID even after its title changes', async () => {
    const { ctx } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'selected' });
    ctx.bus.emit('event', { id: 'reward-id', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'selected', rewardTitle: 'Renamed', cost: 1, input: `https://youtu.be/${first}` });
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(1));
    expect(ctx.settings.get('songQueue')[0]).toMatchObject({ title: 'Song title', redemption: { id: 'reward-id', rewardId: 'selected' } });
    ctx.bus.emit('event', { id: 'wrong-id', source: 'twitch', timestamp: 2, userName: 'Ann', type: 'redemption', rewardId: 'other', rewardTitle: 'Song', cost: 1, input: `https://youtu.be/${second}` });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
  });

  it('reports missing reward input instead of silently losing a request', () => {
    const { ctx } = setup();
    ctx.bus.emit('event', { id: 'empty', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardTitle: 'Song', cost: 1, input: '' });
    expect(ctx.state.current.songRequests.lastError).toContain('no YouTube link');
  });

  it('keeps a track in the queue on player loss, resumes Windows music and invalidates the old completion', async () => {
    const { ctx, service, music } = setup();
    service.setPlayerConnected(true);
    service.add(`https://youtu.be/${first}`);
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current).not.toBeNull());
    const old = service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>;
    service.setPlayerConnected(false);
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
    expect(music.resumeSource).toHaveBeenCalledWith('Spotify.exe');
    service.setPlayerConnected(true);
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current).not.toBeNull());
    expect(await service.playerFinished(old.request!.id, old.nonce!)).toBe(false);
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
  });

  it('handles player loss while an asynchronous pause is in progress', async () => {
    const { ctx, service, music } = setup();
    let resolve!: (id: string) => void;
    vi.mocked(music.pauseCurrent).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    service.setPlayerConnected(true);
    service.add(`https://youtu.be/${first}`);
    service.setPlayerConnected(false);
    resolve('Spotify.exe');
    await vi.waitFor(() => expect(music.resumeSource).toHaveBeenCalled());
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
  });
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
    await vi.waitFor(() => expect(ctx.state.current.songRequests.queue[0]?.videoId).toBe(second));
    const nonce1 = (service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>).nonce;
    expect(await service.playerFinished('reward1', nonce1 ?? '')).toBe(true);
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe(second));
    const nonce2 = (service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>).nonce;
    expect(await service.playerFinished('donation1', nonce2 ?? '')).toBe(true);
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect((music.pauseCurrent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((music.resumeSource as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Spotify.exe');
  });

  it('ignores duplicate donation events and donations below the configured amount', async () => {
    const { ctx } = setup();
    const event = { id: 'tip1', source: 'streamlabs' as const, timestamp: 1, userName: 'Bob', type: 'donation' as const, amount: 50, currency: 'RUB', message: `https://youtu.be/${first}` };
    ctx.bus.emit('event', event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
    ctx.bus.emit('event', { ...event, amount: 150 });
    ctx.bus.emit('event', { ...event, amount: 150 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
  });

  it('rejects videos YouTube will not embed, tells the viewer and refunds the points', async () => {
    const { ctx, reply, lookup, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    lookup.mockResolvedValueOnce({ ok: false, reason: 'embedBlocked' });
    ctx.bus.emit('event', { id: 'r1', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `play https://youtu.be/${first} pls` });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('song-reward', 'r1', 'CANCELED'));
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
    expect(reply.mock.calls[0][0]).toMatch(/^@Ann, .*outside YouTube.*Points refunded\.$/s);
    expect(ctx.state.current.songRequests.lastRejected).toMatchObject({ userName: 'Ann' });
  });

  it('does not promise a refund Twitch refused (reward created outside the app)', async () => {
    const { ctx, reply, lookup, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    settle.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    lookup.mockResolvedValueOnce({ ok: false, reason: 'embedBlocked' });
    ctx.bus.emit('event', { id: 'r1', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `https://youtu.be/${first}` });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply.mock.calls[0][0]).toMatch(/^@Ann, .*outside YouTube/s);
    expect(reply.mock.calls[0][0]).not.toMatch(/refunded/i);
  });

  it('refunds a redemption without a link and confirms a queued one with its position', async () => {
    const { ctx, reply, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    ctx.bus.emit('event', { id: 'r0', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: 'some song please' });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('song-reward', 'r0', 'CANCELED'));
    ctx.bus.emit('event', { id: 'r1', source: 'twitch', timestamp: 2, userName: 'Bob', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `https://youtu.be/${first}` });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('@Bob, «Song title» is queued at #1.', undefined));
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), replyInChat: false, refundRejected: false });
    ctx.bus.emit('event', { id: 'r2', source: 'twitch', timestamp: 3, userName: 'Cid', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `https://youtu.be/${first}` });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reply).toHaveBeenCalledTimes(2);
    expect(settle).not.toHaveBeenCalledWith('song-reward', 'r2', 'CANCELED');
  });

  it('skips an unplayable video, refunds it and keeps the stream going with the next request', async () => {
    const { ctx, service, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    service.setPlayerConnected(true);
    ctx.bus.emit('event', { id: 'r1', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `https://youtu.be/${first}` });
    ctx.bus.emit('event', { id: 'r2', source: 'twitch', timestamp: 2, userName: 'Bob', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `https://youtu.be/${second}` });
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('r1'));
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(2));
    const nonce1 = (service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>).nonce!;
    expect(await service.playerFinished('r1', nonce1, 'blocked (150)', 'video')).toBe(true);
    expect(settle).toHaveBeenCalledWith('song-reward', 'r1', 'CANCELED');
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('r2'));
    const nonce2 = (service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>).nonce!;
    expect(await service.playerFinished('r2', nonce2)).toBe(true);
    expect(settle).toHaveBeenCalledWith('song-reward', 'r2', 'FULFILLED');
  });

  it('reorders upcoming tracks without touching the playing one and pauses it in OBS', async () => {
    const { ctx, service, broadcast } = setup();
    service.setPlayerConnected(true);
    service.add(`https://youtu.be/${first}`, 'Ann', 'manual', 'a');
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('a'));
    service.add(`https://youtu.be/${second}`, 'Bob', 'manual', 'b');
    service.add('https://youtu.be/aaaaaaaaaaa', 'Cid', 'manual', 'c');
    service.move('c', 0);
    expect(ctx.settings.get('songQueue').map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(ctx.state.current.songRequests.queue.map((item) => item.id)).toEqual(['c', 'b']);
    service.move('a', 5);
    expect(ctx.settings.get('songQueue').map((item) => item.id)).toEqual(['a', 'c', 'b']);
    service.pause(true);
    expect(ctx.state.current.songRequests.paused).toBe(true);
    expect(broadcast.mock.calls.at(-1)![0]).toMatchObject({ type: 'song', paused: true, request: { id: 'a' } });
    await service.skip();
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('c'));
    expect(ctx.state.current.songRequests.paused).toBe(false);
  });

  it('refunds a queued request the streamer removes', async () => {
    const { ctx, service, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    ctx.bus.emit('event', { id: 'r1', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `https://youtu.be/${first}` });
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(1));
    service.remove('r1');
    expect(settle).toHaveBeenCalledWith('song-reward', 'r1', 'CANCELED');
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
  });

  it('checks the streamer\'s own links too and reports the reason', async () => {
    const { ctx, service, lookup } = setup();
    lookup.mockResolvedValueOnce({ ok: false, reason: 'notFound' });
    await expect(service.addManual(`https://youtu.be/${first}`)).rejects.toThrow('not found');
    lookup.mockResolvedValueOnce(null);
    await service.addManual(`https://youtu.be/${first}`);
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
  });

  it('keeps requests queued when video is turned off and resumes playback when it is turned on', async () => {
    const { ctx, service, music } = setup();
    service.setPlayerConnected(true);
    service.add(`https://youtu.be/${first}`);
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe(first));
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), videoLayout: 'queue' });
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current).toBeNull());
    expect(ctx.settings.get('songQueue')[0]?.videoId).toBe(first);
    expect((music.resumeSource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await expect(service.play()).rejects.toThrow('Queue-only mode');
    expect(service.overlayMessage).toMatchObject({ type: 'song', request: null, config: { videoLayout: 'queue' }, queue: [{ videoId: first }] });
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), videoLayout: 'compact' });
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe(first));
  });
});
