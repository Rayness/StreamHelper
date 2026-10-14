import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { defaultSettings } from '@shared/defaults';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import type { AppContext } from '../src/main/core/context';
import type { MusicService } from '../src/main/features/music';
import { SongRequestService, musicLinkInText, searchHits, yandexTrackId, youtubePlaylist, youtubeUrlInText, youtubeVideoId, type RemotePlayer, type RemotePlayerEvent, type SearchHit, type VideoCheck, type VideoDetails, type YandexTrack } from '../src/main/features/songRequests';

const first = 'M7lc1UVf-VE';
const second = 'dQw4w9WgXcQ';

function setup(extra: { remote?: RemotePlayer } = {}) {
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
  const search = vi.fn(async (_query: string): Promise<SearchHit[] | null> => []);
  const yandex = vi.fn(async (_trackId: string): Promise<YandexTrack | null> => null);
  const yandexFind = vi.fn(async (_query: string): Promise<YandexTrack[] | null> => []);
  const details = vi.fn(async (_id: string): Promise<VideoDetails | null> => null);
  const service = new SongRequestService(ctx, music, broadcast, reply, { lookup, rewards: { settle }, search, yandexTrack: yandex, yandexSearch: yandexFind, details, ...extra });
  return { ctx, service, music, broadcast, reply, lookup, settle, search, yandex, yandexFind, details };
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
    expect(ctx.state.current.songRequests.lastError).toContain('Empty request');
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

  it('refuses banned viewers and banned videos, refunds them and clears their queued requests', async () => {
    const { ctx, service, reply, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    const redeem = (id: string, userName: string, video: string, userLogin?: string) => ctx.bus.emit('event', { id, source: 'twitch', timestamp: 1, userName, userLogin, type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: `https://youtu.be/${video}` });
    redeem('r1', 'Ann', first);
    redeem('r2', 'Bob', second);
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(2));
    service.banUser('@Ann');
    expect(ctx.settings.get('songRequests').bannedUsers).toEqual(['ann']);
    expect(ctx.settings.get('songQueue').map((item) => item.id)).toEqual(['r2']);
    expect(settle).toHaveBeenCalledWith('song-reward', 'r1', 'CANCELED');
    redeem('r3', 'Ann', 'aaaaaaaaaaa');
    redeem('r4', 'Энн', 'bbbbbbbbbbb', 'ann');
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('song-reward', 'r4', 'CANCELED'));
    expect(settle).toHaveBeenCalledWith('song-reward', 'r3', 'CANCELED');
    await vi.waitFor(() => expect(reply.mock.calls.some(([text]) => /^@Ann, you are banned/.test(text))).toBe(true));
    await service.banVideo(`https://youtu.be/${second}`);
    expect(ctx.settings.get('songRequests').bannedVideos).toEqual([{ videoId: second, title: 'Song title' }]);
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
    expect(settle).toHaveBeenCalledWith('song-reward', 'r2', 'CANCELED');
    redeem('r5', 'Cid', second);
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('song-reward', 'r5', 'CANCELED'));
    await expect(service.addManual(`https://youtu.be/${second}`)).rejects.toThrow('banned');
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
  });

  it('skips the playing track for channel points and refunds a skip when nothing plays', async () => {
    const { ctx, service, reply, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), skipRewardId: 'skip-reward', bannedUsers: ['troll'] });
    const skip = (id: string, userName: string) => ctx.bus.emit('event', { id, source: 'twitch', timestamp: 1, userName, type: 'redemption', rewardId: 'skip-reward', rewardTitle: 'Skip', cost: 2000, input: '' });
    skip('s0', 'Bob');
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('skip-reward', 's0', 'CANCELED'));
    service.setPlayerConnected(true);
    service.add(`https://youtu.be/${first}`, 'Ann', 'manual', 'a', { title: 'First' });
    service.add(`https://youtu.be/${second}`, 'Ann', 'manual', 'b');
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('a'));
    skip('s1', 'Troll');
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('skip-reward', 's1', 'CANCELED'));
    expect(ctx.state.current.songRequests.current?.id).toBe('a');
    skip('s2', 'Bob');
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('b'));
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('skip-reward', 's2', 'FULFILLED'));
    expect(reply).toHaveBeenCalledWith('@Bob skipped the track «First».', undefined);
    expect(ctx.settings.get('songQueue').map((item) => item.id)).toEqual(['b']);
  });

  it('plays the background playlist between requests and gives way to a request', async () => {
    const { ctx, service, music } = setup();
    type Song = Extract<typeof service.overlayMessage, { type: 'song' }>;
    const message = () => service.overlayMessage as Song;
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), backgroundEnabled: true, backgroundShuffle: false,
      backgroundTracks: [{ videoId: 'aaaaaaaaaaa', title: 'Lofi' }, { videoId: 'bbbbbbbbbbb' }] });
    expect(ctx.state.current.songRequests.background ?? null).toBeNull();
    service.setPlayerConnected(true);
    await vi.waitFor(() => expect(ctx.state.current.songRequests.background).toEqual({ videoId: 'aaaaaaaaaaa', title: 'Lofi' }));
    expect(message()).toMatchObject({ background: true, request: { videoId: 'aaaaaaaaaaa' }, config: { backgroundTracks: [], bannedUsers: [] } });
    expect(music.pauseCurrent).not.toHaveBeenCalled();
    // A finished background track moves on to the next entry.
    expect(await service.playerFinished(message().request!.id, message().nonce!)).toBe(true);
    expect(ctx.state.current.songRequests.background?.videoId).toBe('bbbbbbbbbbb');
    const stale = message();
    // A request takes the player over.
    service.add(`https://youtu.be/${first}`, 'Ann', 'manual', 'a');
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('a'));
    expect(ctx.state.current.songRequests.background).toBeNull();
    expect(message()).toMatchObject({ background: false, request: { id: 'a' } });
    expect(await service.playerFinished(stale.request!.id, stale.nonce!)).toBe(false);
    // After the queue the playlist comes back with the following track.
    expect(await service.playerFinished('a', message().nonce!)).toBe(true);
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect(ctx.state.current.songRequests.background?.videoId).toBe('aaaaaaaaaaa');
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
    // Skip and pause work on the background track too.
    service.pause(true);
    expect(message()).toMatchObject({ background: true, paused: true });
    await service.skip();
    expect(ctx.state.current.songRequests.background?.videoId).toBe('bbbbbbbbbbb');
    expect(ctx.state.current.songRequests.paused).toBe(false);
    // An entry YouTube refuses is left out; removing the playing one or switching off stops it.
    expect(await service.playerFinished(message().request!.id, message().nonce!, 'blocked (150)', 'video')).toBe(true);
    expect(ctx.state.current.songRequests.background?.videoId).toBe('aaaaaaaaaaa');
    expect(await service.playerFinished(message().request!.id, message().nonce!)).toBe(true);
    expect(ctx.state.current.songRequests.background?.videoId).toBe('aaaaaaaaaaa');
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), backgroundEnabled: false });
    expect(ctx.state.current.songRequests.background).toBeNull();
    expect(message().request).toBeNull();
  });

  it('adds checked links to the background playlist', async () => {
    const { ctx, service, lookup } = setup();
    await service.addBackground(`https://youtu.be/${first}`);
    expect(ctx.settings.get('songRequests').backgroundTracks).toEqual([{ videoId: first, title: 'Song title' }]);
    await expect(service.addBackground(`https://youtu.be/${first}`)).rejects.toThrow('already');
    lookup.mockResolvedValueOnce({ ok: false, reason: 'embedBlocked' });
    await expect(service.addBackground(`https://youtu.be/${second}`)).rejects.toThrow('outside YouTube');
    await expect(service.addBackground('https://example.com/')).rejects.toThrow('YouTube');
  });

  it('adds jams from mix and playlist links and plays the chosen one as background music', async () => {
    const { ctx, service } = setup();
    type Song = Extract<typeof service.overlayMessage, { type: 'song' }>;
    const message = () => service.overlayMessage as Song;
    const playlistLookup = vi.fn(async (_id: string): Promise<VideoCheck | null> => ({ ok: true, title: 'Chill playlist' }));
    (service as unknown as { options: { playlistLookup: typeof playlistLookup } }).options.playlistLookup = playlistLookup;
    expect(youtubePlaylist(`https://www.youtube.com/watch?v=${first}&list=RD${first}&start_radio=1`)).toEqual({ listId: `RD${first}`, videoId: first });
    expect(youtubePlaylist(`https://youtu.be/${first}`)).toBeNull();
    expect(youtubePlaylist('https://evil.example/playlist?list=PLabc')).toBeNull();
    await service.addJam(`https://www.youtube.com/watch?v=${first}&list=RD${first}`, ' Rock ');
    await service.addJam('https://www.youtube.com/playlist?list=PLchill123');
    expect(playlistLookup).toHaveBeenCalledTimes(1);
    const jams = ctx.settings.get('songRequests').jams;
    expect(jams).toMatchObject([{ name: 'Rock', listId: `RD${first}`, videoId: first }, { name: 'Chill playlist', listId: 'PLchill123' }]);
    await expect(service.addJam('https://www.youtube.com/playlist?list=PLchill123')).rejects.toThrow('already');
    await expect(service.addJam('https://www.youtube.com/playlist?list=WL')).rejects.toThrow('account');
    await expect(service.addJam(`https://youtu.be/${first}`)).rejects.toThrow('list=');
    playlistLookup.mockResolvedValueOnce({ ok: false, reason: 'notFound' });
    await expect(service.addJam('https://www.youtube.com/playlist?list=PLprivate')).rejects.toThrow('private');

    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), backgroundEnabled: true, backgroundJamId: jams[0].id, backgroundTracks: [{ videoId: 'aaaaaaaaaaa' }] });
    service.setPlayerConnected(true);
    await vi.waitFor(() => expect(message()).toMatchObject({ background: true, request: { playlistId: `RD${first}`, videoId: first, title: 'Rock' }, config: { jams: [] } }));
    // Choosing another jam switches the player at once.
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), backgroundJamId: jams[1].id });
    await vi.waitFor(() => expect(message().request).toMatchObject({ playlistId: 'PLchill123', videoId: '', title: 'Chill playlist' }));
    // A request interrupts the jam and it returns afterwards.
    service.add(`https://youtu.be/${second}`, 'Ann', 'manual', 'a');
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.id).toBe('a'));
    expect(await service.playerFinished('a', message().nonce!)).toBe(true);
    expect(message().request).toMatchObject({ playlistId: 'PLchill123' });
    // A jam YouTube refuses to play is not retried in a loop.
    expect(await service.playerFinished(message().request!.id, message().nonce!, 'blocked (150)', 'video')).toBe(true);
    expect(message().request).toBeNull();
    // Back to the streamer's own playlist.
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), backgroundJamId: '' });
    await vi.waitFor(() => expect(message().request).toMatchObject({ videoId: 'aaaaaaaaaaa' }));
    expect(message().request!.playlistId).toBeUndefined();
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
  it('recognises YouTube Music and Yandex Music track links', () => {
    expect(youtubeVideoId(`https://music.youtube.com/watch?v=${first}&si=abc`)).toBe(first);
    expect(yandexTrackId('https://music.yandex.ru/album/123/track/456789?utm_source=share')).toBe('456789');
    expect(yandexTrackId('https://music.yandex.com/track/42')).toBe('42');
    expect(yandexTrackId('https://music.yandex.ru/album/123')).toBeNull();
    expect(yandexTrackId('https://music.yandex.ru.evil.example/track/42')).toBeNull();
    expect(musicLinkInText(`play this https://music.yandex.ru/album/1/track/2.`)).toEqual({ kind: 'yandex', url: 'https://music.yandex.ru/album/1/track/2', trackId: '2' });
    expect(musicLinkInText(`https://music.youtube.com/watch?v=${first}`)).toMatchObject({ kind: 'youtube', videoId: first });
  });

  it('reads videos from a YouTube search response, without live streams and long videos', () => {
    const video = (videoId: string, length?: string) => ({ videoRenderer: { videoId, title: { runs: [{ text: 'Artist - ' }, { text: videoId }] }, ...(length ? { lengthText: { simpleText: length } } : {}) } });
    const data = { contents: { sections: [{ items: [{ channelRenderer: { channelId: 'x' } }, video(first, '3:45'), video('aaaaaaaaaaa'), video('bbbbbbbbbbb', '1:02:00'), video(second, '4:01'), video(first, '3:45')] }] } };
    expect(searchHits(data)).toEqual([{ videoId: first, title: `Artist - ${first}` }, { videoId: second, title: `Artist - ${second}` }]);
  });

  it('finds a song by artist and title, skipping uploads YouTube will not embed', async () => {
    const { ctx, reply, lookup, search, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    search.mockResolvedValueOnce([{ videoId: first, title: 'Official' }, { videoId: second, title: 'Lyrics' }]);
    lookup.mockResolvedValueOnce({ ok: false, reason: 'embedBlocked' }).mockResolvedValueOnce({ ok: true, title: 'Artist - Song (lyrics)' });
    ctx.bus.emit('event', { id: 'r1', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: '  Artist   - Song ' });
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(1));
    expect(search).toHaveBeenCalledWith('Artist - Song');
    expect(ctx.settings.get('songQueue')[0]).toMatchObject({ videoId: second, title: 'Artist - Song (lyrics)', url: `https://www.youtube.com/watch?v=${second}` });
    expect(reply).toHaveBeenCalledWith('@Ann, «Artist - Song (lyrics)» is queued at #1.', undefined);
    // Nothing found, or search is off: the viewer is told and refunded.
    ctx.bus.emit('event', { id: 'r2', source: 'twitch', timestamp: 2, userName: 'Bob', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: 'zzzz' });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('song-reward', 'r2', 'CANCELED'));
    expect(reply.mock.calls.at(-1)![0]).toMatch(/nothing found/);
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), allowSearch: false });
    ctx.bus.emit('event', { id: 'r3', source: 'twitch', timestamp: 3, userName: 'Cid', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: 'Artist - Other' });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('song-reward', 'r3', 'CANCELED'));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('does not swap a banned or queued song for another upload', async () => {
    const { ctx, service, search } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), bannedVideos: [{ videoId: first }] });
    search.mockResolvedValue([{ videoId: first, title: 'Banned' }, { videoId: second, title: 'Other upload' }]);
    await expect(service.addManual('Banned song')).rejects.toThrow('banned');
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
  });

  it('plays Yandex Music tracks by finding them on YouTube and queues from the streamer search', async () => {
    const { ctx, service, search, yandex } = setup();
    yandex.mockResolvedValueOnce({ trackId: '2', albumId: '1', title: 'Artist - Track', available: true });
    search.mockResolvedValueOnce([{ videoId: first, title: 'Artist - Track' }]);
    await service.addManual('https://music.yandex.ru/album/1/track/2');
    expect(yandex).toHaveBeenCalledWith('2');
    expect(search).toHaveBeenCalledWith('Artist - Track');
    expect(ctx.settings.get('songQueue')[0]).toMatchObject({ videoId: first, source: 'manual' });
    await expect(service.addManual('https://music.yandex.ru/album/1/track/3')).rejects.toThrow('Yandex Music');
    await expect(service.addManual('https://open.spotify.com/track/abc')).rejects.toThrow('cannot be played');
    search.mockResolvedValueOnce(null);
    await expect(service.addManual('Some song')).rejects.toThrow('unavailable');
  });

  it('accepts chat requests by song name and ignores donations without a link', async () => {
    const { ctx, service, search } = setup();
    search.mockResolvedValue([{ videoId: first, title: 'Found' }]);
    const message = { id: 'm1', platform: 'twitch', userId: 'u1', userName: 'Ann', text: '!sr Artist - Song', roles: { broadcaster: false, moderator: false, vip: false, subscriber: false } } as ChatMessage;
    expect(await service.handleChat(message)).toBe(true);
    expect(ctx.settings.get('songQueue')).toMatchObject([{ source: 'chat', videoId: first }]);
    ctx.bus.emit('event', { id: 'tip', source: 'donationalerts', timestamp: 1, userName: 'Bob', type: 'donation', amount: 500, currency: 'RUB', message: 'Artist - Song' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(search).toHaveBeenCalledTimes(1);
  });
  it('limits requests per viewer, track length, views and banned words for viewers only', async () => {
    const { ctx, service, reply, details, search, settle } = setup();
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward', maxPerUser: 2, maxDurationMin: 5, minViews: 1000, bannedWords: ['Bad'] });
    let n = 0;
    const redeem = (input: string, userName = 'Ann', userLogin?: string) => {
      const id = `r${++n}`;
      ctx.bus.emit('event', { id, source: 'twitch', timestamp: n, userName, userLogin, type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input });
      return id;
    };
    const refunded = async (id: string) => vi.waitFor(() => expect(settle).toHaveBeenCalledWith('song-reward', id, 'CANCELED'));
    // Too long, live, few views, banned word in the title or in the viewer's text.
    details.mockResolvedValueOnce({ seconds: 6 * 60, views: 5000, live: false });
    await refunded(redeem(`https://youtu.be/${first}`));
    expect(reply.mock.calls.at(-1)![0]).toMatch(/longer than 5 min/);
    details.mockResolvedValueOnce({ seconds: 0, views: 5000, live: true });
    await refunded(redeem(`https://youtu.be/${first}`));
    expect(reply.mock.calls.at(-1)![0]).toMatch(/live streams/);
    details.mockResolvedValueOnce({ seconds: 200, views: 10, live: false });
    await refunded(redeem(`https://youtu.be/${first}`));
    expect(reply.mock.calls.at(-1)![0]).toMatch(/fewer than 1,000 views/);
    details.mockResolvedValueOnce({ seconds: 200, views: 5000, live: false, title: 'A BAD song' });
    await refunded(redeem(`https://youtu.be/${first}`));
    await refunded(redeem('bad words please'));
    expect(search).not.toHaveBeenCalled();
    expect(ctx.settings.get('songQueue')).toHaveLength(0);
    // Name search moves past a result that breaks the limits.
    search.mockResolvedValueOnce([{ videoId: first, title: 'Extended' }, { videoId: second, title: 'Radio edit' }]);
    details.mockResolvedValueOnce({ seconds: 600, views: 5000, live: false }).mockResolvedValueOnce({ seconds: 200, views: 5000, live: false });
    redeem('Artist - Song');
    await vi.waitFor(() => expect(ctx.settings.get('songQueue').map((item) => item.videoId)).toEqual([second]));
    // Unknown length/views: accepted. Then the per-viewer limit, also across a display name / login pair.
    redeem('https://youtu.be/aaaaaaaaaaa', 'Ann');
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(2));
    const third = redeem('https://youtu.be/bbbbbbbbbbb', 'Энн', 'ann');
    await refunded(third);
    expect(reply.mock.calls.at(-1)![0]).toMatch(/already have 2 tracks/);
    redeem('https://youtu.be/bbbbbbbbbbb', 'Bob');
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(3));
    // The streamer is not limited.
    details.mockResolvedValueOnce({ seconds: 3600, views: 1, live: false, title: 'bad' });
    await service.addManual('https://youtu.be/ccccccccccc');
    expect(ctx.settings.get('songQueue')).toHaveLength(4);
    expect(service.overlayMessage).toMatchObject({ config: { maxDurationMin: 5, bannedWords: [] } });
  });
  it('plays Yandex Music requests in the Yandex Music app and gives the player back after the queue', async () => {
    let listener: (event: RemotePlayerEvent) => void = () => undefined;
    const remote = { ready: true, play: vi.fn(async () => undefined), pause: vi.fn(), release: vi.fn(), hold: vi.fn(), setVolume: vi.fn(), onEvent: vi.fn((fn: (event: RemotePlayerEvent) => void) => { listener = fn; return () => undefined; }) };
    const { ctx, service, yandex, yandexFind, search, settle, broadcast } = setup({ remote });
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), rewardId: 'song-reward' });
    yandex.mockResolvedValueOnce({ trackId: '42', albumId: '7', title: 'Artist - Track', durationMs: 200_000, cover: 'https://avatars.yandex.net/x/200x200', available: true });
    // No OBS source is needed for a Yandex track.
    ctx.bus.emit('event', { id: 'r1', source: 'twitch', timestamp: 1, userName: 'Ann', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: 'https://music.yandex.ru/album/7/track/42' });
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe('ym:42'));
    expect(ctx.state.current.songRequests.current).toMatchObject({ provider: 'yandex', yandexTrackId: '42', url: 'https://music.yandex.ru/album/7/track/42', title: 'Artist - Track' });
    expect(remote.play).toHaveBeenCalledWith({ trackId: '42', albumId: '7', title: 'Artist - Track', cover: 'avatars.yandex.net/x/%%', durationMs: 200_000 });
    expect(search).not.toHaveBeenCalled();
    expect(broadcast.mock.calls.at(-1)![0]).toMatchObject({ type: 'song', request: { provider: 'yandex' } });
    service.pause(true);
    expect(remote.pause).toHaveBeenCalledWith(true);
    service.pause(false);
    // A name search goes to Yandex Music first, skipping a result over the length limit.
    ctx.settings.set('songRequests', { ...ctx.settings.get('songRequests'), maxDurationMin: 5 });
    yandexFind.mockResolvedValueOnce([{ trackId: '50', title: 'Long', durationMs: 600_000, available: true }, { trackId: '51', title: 'Short', durationMs: 180_000, available: true }]);
    ctx.bus.emit('event', { id: 'r2', source: 'twitch', timestamp: 2, userName: 'Bob', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: 'Artist - Song' });
    await vi.waitFor(() => expect(ctx.settings.get('songQueue').map((item) => item.videoId)).toEqual(['ym:42', 'ym:51']));
    // Nothing on Yandex: YouTube takes it.
    search.mockResolvedValueOnce([{ videoId: first, title: 'On YouTube' }]);
    ctx.bus.emit('event', { id: 'r3', source: 'twitch', timestamp: 3, userName: 'Cid', type: 'redemption', rewardId: 'song-reward', rewardTitle: 'Song', cost: 500, input: 'Rare song' });
    await vi.waitFor(() => expect(ctx.settings.get('songQueue')).toHaveLength(3));
    // Events for another track are ignored; the end of ours moves on to the next Yandex track.
    listener({ type: 'ended', trackId: '999' });
    expect(ctx.state.current.songRequests.current?.id).toBe('r1');
    listener({ type: 'ended', trackId: '42' });
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe('ym:51'));
    expect(settle).toHaveBeenCalledWith('song-reward', 'r1', 'FULFILLED');
    // Next is a YouTube video: it needs the OBS source; the Yandex app is put on hold.
    service.setPlayerConnected(true);
    listener({ type: 'ended', trackId: '51' });
    await vi.waitFor(() => expect(ctx.state.current.songRequests.current?.videoId).toBe(first));
    expect(remote.hold).toHaveBeenCalled();
    expect(remote.release).not.toHaveBeenCalled();
    const message = service.overlayMessage as Extract<typeof service.overlayMessage, { type: 'song' }>;
    expect(await service.playerFinished('r3', message.nonce!)).toBe(true);
    expect(remote.release).toHaveBeenCalledWith(true);
  });

  it('keeps a Yandex request when the Yandex Music app cannot play it', async () => {
    const remote = { ready: true, play: vi.fn(async () => { throw new Error('Open the Yandex Music app'); }), pause: vi.fn(), release: vi.fn(), hold: vi.fn(), setVolume: vi.fn(), onEvent: vi.fn(() => () => undefined) };
    const { ctx, service, yandex } = setup({ remote });
    yandex.mockResolvedValue({ trackId: '42', title: 'Artist - Track', available: true });
    await service.addManual('https://music.yandex.ru/track/42');
    await vi.waitFor(() => expect(ctx.state.current.songRequests.lastError).toContain('Open the Yandex Music app'));
    expect(ctx.state.current.songRequests.current).toBeNull();
    expect(ctx.settings.get('songQueue')).toHaveLength(1);
    // Not connected: Yandex links go through YouTube instead, and queued Yandex tracks can't be started.
    (remote as { ready: boolean }).ready = false;
    await expect(service.play()).rejects.toThrow('Yandex Music is not connected');
  });
});
