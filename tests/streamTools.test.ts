import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultClipper, defaultShield } from '@shared/defaults';
import { emptyReportSummary, ReportCollector, reportWords } from '@shared/report';
import type { ChatMessage, ChatRoles, Curse, OverlayMessage, SongRequest, StreamEvent } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { ClipperService, clipErrorText, hasKeyword, MomentDetector } from '../src/main/features/clipper';
import { CurseService, parseVote } from '../src/main/features/curses';
import { DuelService, parseDuelVote } from '../src/main/features/duel';
import { Ducker, DuckingService } from '../src/main/features/ducking';
import { MarketService, nextPrice, parseQty, priceAfterTrade } from '../src/main/features/market';
import { levenshtein, maskAnswer, melodyMatch, MelodyService, splitTitle } from '../src/main/features/melody';
import { ircFragments, parseIrcLine, PortalService, stripLinks, trimFragments } from '../src/main/features/portal';
import { ReportService } from '../src/main/features/report';
import { reportHtml } from '../src/main/features/reportCard';
import { RaidDetector, ShieldService, spamKey } from '../src/main/features/shield';
import { isMusicOverlay } from '../src/main/obs/obs';

let seq = 0;
function msg(text: string, userId = 'u1', at = Date.now(), roles: Partial<ChatRoles> = {}): ChatMessage {
  return {
    id: `m${seq++}`,
    platform: 'twitch',
    userId,
    userLogin: `user_${userId}`,
    userName: `User${userId}`,
    badges: [],
    roles: { broadcaster: false, moderator: false, vip: false, subscriber: false, ...roles },
    text,
    fragments: [{ type: 'text', text }],
    timestamp: at,
  };
}

function makeCtx(lang: 'ru' | 'en' = 'en') {
  const bus = new EventBus();
  const dir = mkdtempSync(join(tmpdir(), 'sh-tools-'));
  const settings = new SettingsStore(join(dir, 'settings.json'), bus, lang);
  const state = new StateHub(bus);
  const ctx = { bus, settings, state, toast: vi.fn(), secrets: {}, openExternal: vi.fn(), mediaDir: '' } as unknown as AppContext;
  const sent: OverlayMessage[] = [];
  const said: string[] = [];
  const deps = { broadcast: vi.fn((_k: unknown, m: OverlayMessage) => void sent.push(m)), say: vi.fn(async (t: string) => void said.push(t)) };
  return { ctx, bus, settings, state, deps, sent, said, dir };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  vi.useRealTimers();
});

describe('auto clipper', () => {
  const cfg = { ...defaultClipper('en'), enabled: true, windowSec: 15, sensitivity: 3, minMessages: 10, keywordHits: 5, voteThreshold: 3 };

  it('matches reaction words case-insensitively', () => {
    expect(hasKeyword('lmao KEKW', cfg.keywords)).toBe(true);
    expect(hasKeyword('ахахахах', ['ахах'])).toBe(true);
    expect(hasKeyword('nice play', cfg.keywords)).toBe(false);
  });

  it('notices a burst against the usual chat speed, not a steady busy chat', () => {
    const d = new MomentDetector();
    const start = 1_000_000;
    // Three minutes of calm chat: one message every 10 s.
    for (let i = 0; i < 18; i++) d.push({ at: start + i * 10_000, userId: `c${i}`, user: 'calm', text: 'hello there' }, cfg, '!');
    expect(d.check(start + 180_000, cfg)).toBeNull();
    // Then 20 messages in 5 seconds.
    const t = start + 181_000;
    for (let i = 0; i < 20; i++) d.push({ at: t + i * 250, userId: `b${i}`, user: 'b', text: 'what was that' }, cfg, '!');
    const hit = d.check(t + 5000, cfg);
    expect(hit?.reason).toBe('burst');
    expect(hit!.score).toBeGreaterThan(3);
  });

  it('counts different viewers voting with the command', () => {
    const d = new MomentDetector();
    const t = 5_000_000;
    d.push({ at: t, userId: 'a', user: 'a', text: '!clip' }, cfg, '!');
    d.push({ at: t + 1, userId: 'a', user: 'a', text: '!clip' }, cfg, '!');
    d.push({ at: t + 2, userId: 'b', user: 'b', text: '!clip' }, cfg, '!');
    expect(d.check(t + 3, cfg)).toBeNull();
    d.push({ at: t + 3, userId: 'c', user: 'c', text: '!CLIP' }, cfg, '!');
    expect(d.check(t + 4, cfg)?.reason).toBe('vote');
  });

  it('clips and marks a moment, then respects the cooldown', async () => {
    const { ctx, bus, settings, state } = makeCtx();
    settings.set('clipper', { ...cfg, keywordHits: 3, cooldownSec: 60, announce: 'clip {url}' });
    state.patch('stream', { live: true });
    const createClip = vi.fn(async () => ({ id: 'Abc', url: 'https://clips.twitch.tv/Abc', editUrl: 'https://edit' }));
    const createMarker = vi.fn(async () => 754);
    const say = vi.fn(async () => undefined);
    const moments: unknown[] = [];
    bus.on('clip:moment', (m) => moments.push(m));
    const clipper = new ClipperService(ctx, { createClip, createMarker, say });
    const t = Date.now();
    for (let i = 0; i < 3; i++) bus.emit('chat:message', msg('KEKW', `k${i}`, t + i));
    await flush();
    expect(createClip).toHaveBeenCalledTimes(1);
    expect(createMarker).toHaveBeenCalledTimes(1);
    expect(state.current.clipper.moments[0]).toMatchObject({ reason: 'keywords', clipUrl: 'https://clips.twitch.tv/Abc', markerSec: 754 });
    expect(say).toHaveBeenCalledWith('clip https://clips.twitch.tv/Abc');
    expect(moments).toHaveLength(1);
    for (let i = 0; i < 5; i++) bus.emit('chat:message', msg('LUL', `l${i}`, t + 100 + i));
    await flush();
    expect(createClip).toHaveBeenCalledTimes(1);
    clipper.dispose();
  });

  it('explains missing permissions and offline clips', () => {
    expect(clipErrorText(Object.assign(new Error('Missing scope: clips:edit'), { status: 401 }), false)).toMatch(/Reconnect Twitch/);
    expect(clipErrorText(Object.assign(new Error('Clipping is not possible for an offline channel.'), { status: 404 }), true)).toMatch(/эфира/);
  });
});

describe('curses', () => {
  it('reads small vote numbers only', () => {
    expect(parseVote('2', 3)).toBe(2);
    expect(parseVote(' #3 ', 3)).toBe(3);
    expect(parseVote('4', 3)).toBeNull();
    expect(parseVote('2 please', 3)).toBeNull();
  });

  it('runs a vote, applies the winner in OBS and undoes it exactly', async () => {
    const { ctx, bus, settings, state, deps, said } = makeCtx();
    const curses: Curse[] = [
      { id: 'mute', enabled: true, name: 'Mute', description: '', durationSec: 60, steps: [{ type: 'mute', input: 'Game' }] },
      { id: 'gray', enabled: true, name: 'Gray', description: '', durationSec: 60, steps: [{ type: 'filter', source: 'Game', filter: 'BW' }, { type: 'source', scene: '', source: 'Cam', show: false }] },
    ];
    settings.set('curses', { ...settings.get('curses'), curses, choices: 2 });
    const calls: string[] = [];
    const obs = {
      setFilterEnabled: vi.fn(async (s: string, f: string, on: boolean) => { calls.push(`filter ${s}/${f} ${on}`); return false; }),
      setSourceVisible: vi.fn(async (_sc: string, s: string, v: boolean) => { calls.push(`source ${s} ${v}`); return true; }),
      setMute: vi.fn(async (i: string, m: boolean) => { calls.push(`mute ${i} ${m}`); return false; }),
    };
    const service = new CurseService(ctx, deps, obs, () => 0);
    service.startVote();
    expect(state.current.curse.status).toBe('voting');
    const gray = state.current.curse.options.findIndex((o) => o.id === 'gray') + 1;
    bus.emit('chat:message', msg(String(gray), 'a'));
    bus.emit('chat:message', msg(String(gray), 'b'));
    bus.emit('chat:message', msg(String(3 - gray), 'c'));
    expect(state.current.curse.total).toBe(3);
    await service.finishVote();
    expect(state.current.curse.status).toBe('active');
    expect(state.current.curse.active?.name).toBe('Gray');
    expect(calls).toEqual(['filter Game/BW true', 'source Cam false']);
    await service.lift();
    expect(calls.slice(2)).toEqual(['source Cam true', 'filter Game/BW false']);
    expect(state.current.curse.status).toBe('idle');
    expect(said.some((s) => s.includes('Gray'))).toBe(true);
    service.dispose();
  });

  it('refuses a second curse while one is active', async () => {
    const { ctx, settings, deps } = makeCtx();
    settings.set('curses', { ...settings.get('curses'), curses: [{ id: 'x', enabled: true, name: 'X', description: '', durationSec: 60, steps: [] }] });
    const service = new CurseService(ctx, deps, { setFilterEnabled: vi.fn(), setSourceVisible: vi.fn(), setMute: vi.fn() });
    await service.apply('x');
    expect(() => service.startVote()).toThrow();
    await expect(service.apply('x')).rejects.toThrow();
    await service.lift();
    service.dispose();
  });
});

describe('music duel', () => {
  const req = (id: string, videoId: string): SongRequest => ({ id, videoId, url: `https://youtu.be/${videoId}`, userName: `user_${id}`, source: 'chat', requestedAt: 0, title: `Song ${id}` });

  it('reads 1/2 and a/b in both alphabets', () => {
    expect(parseDuelVote('1')).toBe('a');
    expect(parseDuelVote('Б')).toBe('b');
    expect(parseDuelVote('b')).toBe('b');
    expect(parseDuelVote('12')).toBeNull();
  });

  it('plays both snippets, counts votes after both started and promotes the winner', async () => {
    vi.useFakeTimers();
    const { ctx, bus, settings, state, deps } = makeCtx();
    settings.set('duel', { ...settings.get('duel'), snippetSec: 10, voteSec: 10, winnerAction: 'playNext', loserAction: 'remove' });
    state.replace('overlayKinds', { duel: 1 });
    const songs = { upcoming: () => [req('a', 'aaaaaaaaaaa'), req('b', 'bbbbbbbbbbb')], hasCurrent: () => true, isPaused: () => false, pause: vi.fn(), move: vi.fn(), play: vi.fn(async () => undefined), remove: vi.fn() };
    const duel = new DuelService(ctx, deps, songs);
    duel.start();
    expect(songs.pause).toHaveBeenCalledWith(true);
    expect(state.current.duel.status).toBe('playingA');
    bus.emit('chat:message', msg('1', 'early'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.current.duel.status).toBe('playingB');
    bus.emit('chat:message', msg('2', 'x'));
    bus.emit('chat:message', msg('2', 'y'));
    bus.emit('chat:message', msg('1', 'z'));
    bus.emit('chat:message', msg('1', 'x'));
    bus.emit('chat:message', msg('2', 'x'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.current.duel.status).toBe('voting');
    expect(state.current.duel.a?.votes).toBe(1);
    expect(state.current.duel.b?.votes).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.current.duel.winner).toBe('b');
    expect(songs.remove).toHaveBeenCalledWith('a');
    expect(songs.move).toHaveBeenCalledWith('b', 0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.current.duel.status).toBe('idle');
    expect(songs.pause).toHaveBeenLastCalledWith(false);
    duel.dispose();
  });

  it('reports a track YouTube refuses and skips its silent snippet', () => {
    vi.useFakeTimers();
    const { ctx, settings, state, deps } = makeCtx('ru');
    settings.set('duel', { ...settings.get('duel'), snippetSec: 20 });
    state.replace('overlayKinds', { duel: 1 });
    const songs = { upcoming: () => [req('a', 'aaaaaaaaaaa'), req('b', 'bbbbbbbbbbb')], hasCurrent: () => false, isPaused: () => false, pause: vi.fn(), move: vi.fn(), play: vi.fn(async () => undefined), remove: vi.fn() };
    const duel = new DuelService(ctx, deps, songs);
    duel.start();
    duel.playerError('zzzzzzzzzzz', 150);
    expect(state.current.duel.error).toBeNull();
    duel.playerError('aaaaaaaaaaa', 150);
    expect(state.current.duel.error).toMatch(/Song a.*150/);
    expect(state.current.duel.status).toBe('playingB');
    duel.stop();
    expect(state.current.duel.error).toBeNull();
    duel.dispose();
  });

  it('needs the overlay and two requests', () => {
    const { ctx, state, deps } = makeCtx();
    const songs = { upcoming: () => [req('a', 'aaaaaaaaaaa')], hasCurrent: () => false, isPaused: () => false, pause: vi.fn(), move: vi.fn(), play: vi.fn(), remove: vi.fn() };
    const duel = new DuelService(ctx, deps, songs);
    expect(() => duel.start()).toThrow(/overlay/i);
    state.replace('overlayKinds', { duel: 1 });
    expect(() => duel.start()).toThrow(/two requests/);
  });
});

describe('guess the melody', () => {
  it('splits YouTube titles into artist and song', () => {
    expect(splitTitle('Queen – Bohemian Rhapsody (Official Video Remastered)')).toEqual({ artist: 'Queen', song: 'Bohemian Rhapsody' });
    expect(splitTitle('Земфира - Хочешь? [Official Video] 4K')).toEqual({ artist: 'Земфира', song: 'Хочешь?' });
    expect(splitTitle('Lana Del Rey - Video Games')).toEqual({ artist: 'Lana Del Rey', song: 'Video Games' });
    expect(splitTitle('Daft Punk "Get Lucky" ft. Pharrell').song).toBe('Get Lucky');
  });

  it('accepts exact, contained and slightly misspelled answers', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(melodyMatch('bohemian rhapsody', ['Bohemian Rhapsody'])).toBe(true);
    expect(melodyMatch('это же Bohemian Rhapsody!!!', ['Bohemian Rhapsody'])).toBe(true);
    expect(melodyMatch('bohemain rhapsody', ['Bohemian Rhapsody'])).toBe(true);
    expect(melodyMatch('Ёлка', ['елка'])).toBe(true);
    expect(melodyMatch('rhapsody', ['Bohemian Rhapsody'])).toBe(false);
    expect(melodyMatch('ok', ['Ok Computer'])).toBe(false);
  });

  it('masks answers letter by letter', () => {
    expect(maskAnswer('Get Lucky!', 0)).toBe('___ _____!');
    expect(maskAnswer('Get Lucky!', 1)).toBe('G__ L____!');
  });

  it('gives the round to the first right answer', async () => {
    vi.useFakeTimers();
    const { ctx, bus, settings, state, deps } = makeCtx();
    settings.set('melody', { ...settings.get('melody'), rounds: 1, playlist: [{ id: 't', videoId: 'ccccccccccc', title: 'Queen - Bohemian Rhapsody', answers: ['Bohemian Rhapsody'], artist: 'Queen' }] });
    const melody = new MelodyService(ctx, deps, async () => null, () => 0.5);
    await expect(melody.start()).rejects.toThrow(/overlay/i);
    state.replace('overlayKinds', { melody: 1 });
    await melody.start();
    expect(state.current.melody).toMatchObject({ status: 'playing', round: 1, videoId: 'ccccccccccc', hint: '________ ________' });
    bus.emit('chat:message', msg('queen', 'a'));
    expect(state.current.melody.status).toBe('playing');
    bus.emit('chat:message', msg('bohemian rhapsody', 'b'));
    expect(state.current.melody).toMatchObject({ status: 'reveal', winner: 'Userb' });
    await vi.advanceTimersByTimeAsync(settings.get('melody').revealSec * 1000);
    expect(state.current.melody.status).toBe('finished');
    expect(state.current.melody.leaderboard).toEqual([{ userName: 'Userb', points: 1 }]);
    melody.dispose();
  });

  it('skips a round YouTube cannot play', async () => {
    vi.useFakeTimers();
    const { ctx, settings, state, deps } = makeCtx();
    settings.set('melody', { ...settings.get('melody'), rounds: 1, playlist: [{ id: 't', videoId: 'eeeeeeeeeee', title: 'Blocked - Song', answers: ['Song'], artist: 'Blocked' }] });
    state.replace('overlayKinds', { melody: 1 });
    const melody = new MelodyService(ctx, deps, async () => null);
    await melody.start();
    melody.playerError('eeeeeeeeeee', 0);
    expect(state.current.melody.status).toBe('playing');
    expect(state.current.melody.error).toMatch(/OBS/);
    melody.playerError('eeeeeeeeeee', 150);
    expect(state.current.melody).toMatchObject({ status: 'reveal', winner: null });
    expect(state.current.melody.error).toMatch(/150/);
    melody.dispose();
  });

  it('builds a playlist from song requests without duplicates', async () => {
    const { ctx, settings, deps } = makeCtx();
    const melody = new MelodyService(ctx, deps, async () => null);
    const r = { id: '1', videoId: 'ddddddddddd', url: '', userName: 'a', source: 'chat' as const, requestedAt: 0, title: 'Muse - Uprising' };
    expect(await melody.addFromSongs([r, { ...r, id: '2' }])).toBe(1);
    expect(settings.get('melody').playlist[0]).toMatchObject({ videoId: 'ddddddddddd', answers: ['Uprising'], artist: 'Muse' });
    expect(await melody.addFromSongs([r])).toBe(0);
  });

  it('names tracks saved without a title and refuses to play unguessable ones', async () => {
    const { ctx, settings, state, deps } = makeCtx('ru');
    settings.set('melody', { ...settings.get('melody'), playlist: [{ id: 'keep', videoId: 'jHZndXhMPXg', title: 'jHZndXhMPXg', answers: ['jHZndXhMPXg'], artist: '' }] });
    state.replace('overlayKinds', { melody: 1 });
    let online = false;
    const melody = new MelodyService(ctx, deps, async () => (online ? { ok: true, title: 'Norma Tale - Кисточка (мультклип)' } : null));
    await expect(melody.start()).rejects.toThrow(/нет названия/);
    online = true;
    expect(await melody.nameTracks()).toBe(1);
    expect(settings.get('melody').playlist[0]).toMatchObject({ id: 'keep', answers: ['Кисточка'], artist: 'Norma Tale' });
    await melody.start();
    expect(state.current.melody.status).toBe('playing');
    melody.dispose();
  });
});

describe('ducking', () => {
  it('needs the voice to last (attack) and waits for silence (release)', () => {
    const d = new Ducker();
    const cfg = { thresholdDb: -30, attackMs: 100, releaseMs: 500 };
    expect(d.update(-10, 0, cfg)).toBe(false);
    expect(d.update(-10, 50, cfg)).toBe(false);
    expect(d.update(-10, 120, cfg)).toBe(true);
    // Release counts from the last moment the voice was heard (120 ms).
    expect(d.update(-50, 300, cfg)).toBe(true);
    expect(d.update(-50, 600, cfg)).toBe(true);
    expect(d.update(-50, 650, cfg)).toBe(false);
    // A click shorter than the attack never ducks.
    expect(d.update(-5, 800, cfg)).toBe(false);
    expect(d.update(-50, 850, cfg)).toBe(false);
  });

  it('turns targets down and restores their own volume', async () => {
    const { ctx, settings, state } = makeCtx();
    settings.set('ducking', { ...settings.get('ducking'), enabled: true, micInput: 'Mic', targets: ['Music', 'Songs'], duckPercent: 25, attackMs: 0, releaseMs: 200, fadeMs: 0 });
    const volumes = new Map([['Music', 0.8], ['Songs', 0.4]]);
    let listener: ((l: Map<string, number>) => void) | null = null;
    const obs = {
      connected: true,
      onVolumeMeters: (l: (levels: Map<string, number>) => void) => { listener = l; return () => { listener = null; }; },
      getVolume: vi.fn(async (i: string) => volumes.get(i)!),
      setVolume: vi.fn(async (i: string, v: number) => void volumes.set(i, v)),
    };
    let now = 0;
    const ducking = new DuckingService(ctx, obs, () => now);
    ducking.start();
    expect(state.current.ducking.listening).toBe(true);
    listener!(new Map([['Mic', -10]]));
    await flush();
    expect(state.current.ducking.ducked).toBe(true);
    expect(volumes.get('Music')).toBeCloseTo(0.2);
    expect(volumes.get('Songs')).toBeCloseTo(0.1);
    now = 100;
    listener!(new Map([['Mic', -60]]));
    now = 400;
    listener!(new Map([['Mic', -60]]));
    await flush();
    expect(state.current.ducking.ducked).toBe(false);
    expect(volumes.get('Music')).toBeCloseTo(0.8);
    expect(volumes.get('Songs')).toBeCloseTo(0.4);
    settings.set('ducking', { ...settings.get('ducking'), enabled: false });
    expect(listener).toBeNull();
    ducking.dispose();
  });
});

describe('viewer stock exchange', () => {
  it('moves prices with activity and never below 1', () => {
    const cfg = { volatility: 8, decayPct: 3 };
    const mid = () => 0.5;
    expect(nextPrice({ price: 100, tickMessages: 20, avgActivity: 5 }, cfg, true, mid).price).toBeGreaterThan(100);
    expect(nextPrice({ price: 100, tickMessages: 0, avgActivity: 5 }, cfg, true, mid).price).toBeLessThan(100);
    expect(nextPrice({ price: 1, tickMessages: 0, avgActivity: 50 }, cfg, true, mid).price).toBe(1);
    expect(priceAfterTrade(100, 4, 1.5, 'buy')).toBe(103);
    expect(priceAfterTrade(103, 4, 1.5, 'sell')).toBeCloseTo(100, 0);
    expect(parseQty('все', 7.9)).toBe(7);
    expect(parseQty(undefined, 5)).toBe(1);
    expect(parseQty('abc', 5)).toBeNull();
  });

  it('lists chatty viewers, trades by command and remembers everything', async () => {
    const { ctx, bus, settings, deps, said, dir } = makeCtx('ru');
    settings.set('market', { ...settings.get('market'), enabled: true, listMinMessages: 3, earnCooldownSec: 0, ipoPrice: 100, startBalance: 1000, announceNews: false, impactPct: 0 });
    const file = join(dir, 'market.json');
    const market = new MarketService(ctx, deps, file, () => 0.5);
    let t = Date.now();
    for (let i = 0; i < 3; i++) bus.emit('chat:message', msg('привет', 'star', t++));
    bus.emit('chat:message', msg('хай', 'fan', t++));
    expect(market.quotes().map((q) => q.name)).toEqual(['Userstar']);
    bus.emit('chat:message', msg('!купить @user_star 3', 'fan', t += 4000));
    expect(said.at(-1)).toMatch(/куплено 3/);
    const fan = market.snapshot.wallets.fan;
    expect(fan.holdings.star.qty).toBe(3);
    expect(fan.balance).toBeCloseTo(1000 + 2 - 300);
    bus.emit('chat:message', msg('!купить @user_star', 'star', t += 4000));
    expect(said.at(-1)).toMatch(/инсайдер/);
    bus.emit('chat:message', msg('!продать @user_star все', 'fan', t += 4000));
    expect(said.at(-1)).toMatch(/продано 3/);
    expect(market.snapshot.wallets.fan.holdings.star).toBeUndefined();
    market.dispose();
    expect(existsSync(file)).toBe(true);
    const again = new MarketService(ctx, deps, file);
    expect(again.snapshot.stocks.star.listed).toBe(true);
    again.dispose();
  });
});

describe('portal', () => {
  it('parses Twitch IRC lines with tags and trailing text', () => {
    const line = parseIrcLine('@badge-info=;color=#FF0000;display-name=Foo\\sBar;emotes=25:6-10;id=abc :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hello Kappa hi');
    expect(line).toMatchObject({ command: 'PRIVMSG', params: ['#chan', 'hello Kappa hi'], tags: { 'display-name': 'Foo Bar', color: '#FF0000', id: 'abc' } });
    expect(parseIrcLine('PING :tmi.twitch.tv')).toMatchObject({ command: 'PING', params: ['tmi.twitch.tv'] });
  });

  it('turns emote positions into fragments, by code points', () => {
    const f = ircFragments('😀 hi Kappa', '25:5-9');
    expect(f).toEqual([{ type: 'text', text: '😀 hi ' }, { type: 'emote', text: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' }]);
    expect(trimFragments([{ type: 'text', text: '!portal hi ' }, { type: 'emote', text: 'Kappa', url: 'u' }], 7)).toEqual([{ type: 'text', text: 'hi ' }, { type: 'emote', text: 'Kappa', url: 'u' }]);
    expect(stripLinks('see https://evil.example/x now')).toBe('see 🔗 now');
  });

  it('shows partner messages sent with the command and drops the rest', async () => {
    const { ctx, settings, state } = makeCtx();
    const sent: OverlayMessage[] = [];
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() });
    const portal = new PortalService(ctx, { broadcast: (m) => void sent.push(m), say: vi.fn(async () => undefined), socket: () => socket as never });
    settings.set('portal', { ...settings.get('portal'), enabled: true, partner: 'https://twitch.tv/Friend', command: 'portal', maxPerMinute: 2 });
    await flush();
    socket.emit('open');
    expect(socket.send).toHaveBeenCalledWith('JOIN #friend');
    socket.emit('message', Buffer.from('@room-id=1 :tmi.twitch.tv ROOMSTATE #friend\r\n'));
    expect(state.current.portal.status).toBe('connected');
    const privmsg = (id: string, text: string) => Buffer.from(`@display-name=Pal;id=${id} :pal!pal@pal.tmi.twitch.tv PRIVMSG #friend :${text}\r\n`);
    socket.emit('message', privmsg('1', 'just chatting'));
    socket.emit('message', privmsg('2', '!portal hello neighbours'));
    socket.emit('message', privmsg('3', '!portal two'));
    socket.emit('message', privmsg('4', '!portal three is over the limit'));
    const shown = sent.filter((m) => m.type === 'portal');
    expect(shown.map((m) => m.type === 'portal' && m.message.text)).toEqual(['hello neighbours', 'two']);
    socket.emit('message', Buffer.from('@target-msg-id=2 :tmi.twitch.tv CLEARMSG #friend :hello neighbours\r\n'));
    expect(sent.at(-1)).toEqual({ type: 'portalDelete', id: 'in:2' });
    portal.stop();
  });
});

describe('stream report', () => {
  it('collects MVPs, the word and emote of the stream and the busiest minute', () => {
    const c = new ReportCollector(0, 'RUB');
    const at = 60_000 * 100;
    for (let i = 0; i < 6; i++) c.addChat({ ...msg('какой красивый закат', 'a', at + i), fragments: [{ type: 'text', text: 'какой красивый закат ' }, { type: 'emote', text: 'Kappa', url: 'k' }] }, new Set());
    c.addChat(msg('закат закат закат', 'b', at + 10), new Set());
    c.addChat(msg('!команды', 'b', at + 20), new Set());
    c.addChat(msg('bot spam', 'nightbot', at + 30), new Set(['user_nightbot']));
    c.addEvent({ id: 'e', source: 'twitch', timestamp: 0, userName: 'Don', type: 'donation', amount: 500, currency: 'RUB', message: '' } as StreamEvent, 'RUB');
    c.sampleViewers(10);
    c.sampleViewers(30);
    const s = c.summary();
    expect(s.messages).toBe(8);
    expect(s.chatters).toBe(2);
    expect(s.mvp[0]).toMatchObject({ name: 'Usera', messages: 6 });
    expect(s.topWord?.word).toBe('закат');
    expect(s.topEmote).toMatchObject({ name: 'Kappa', count: 6 });
    expect(s.drama?.messages).toBe(8);
    expect(s.peakViewers).toBe(30);
    expect(s.avgViewers).toBe(20);
    expect(s.topDonation).toMatchObject({ name: 'Don', amount: 500 });
    expect(reportWords(msg('!so @someone'))).toEqual([]);
  });

  it('escapes chat text in the card', () => {
    const s = { ...emptyReportSummary(0), title: '<script>x</script>', mvp: [{ name: '<b>', messages: 1 }] };
    const html = reportHtml(s, { accentColor: 'red;}' }, 'en', 'chan');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('#9b6bff');
  });

  it('saves a card with its data and lists it', async () => {
    const { ctx, bus, dir } = makeCtx();
    const render = vi.fn(async () => Buffer.from('png'));
    const report = new ReportService(ctx, { dir: join(dir, 'reports'), sessionFile: join(dir, 'session.json'), render, imageUrl: (id) => `/reports/${id}.png`, say: vi.fn(async () => undefined) });
    bus.emit('chat:message', msg('hello stream', 'a'));
    const saved = await report.generate();
    expect(render).toHaveBeenCalled();
    expect(existsSync(report.pngPath(saved.id))).toBe(true);
    expect(report.list().map((r) => r.id)).toEqual([saved.id]);
    expect(() => report.pngPath('../evil')).toThrow();
    report.remove(saved.id);
    expect(report.list()).toEqual([]);
    report.dispose();
  });
});

describe('raid shield', () => {
  const cfg = { ...defaultShield('en'), enabled: true, windowSec: 20, similar: 5, newChatters: 10, young: 4, youngDays: 7 };

  it('reduces spam to a skeleton', () => {
    expect(spamKey('FOLLOW ME @victim 123!!!')).toBe(spamKey('follow   me @other 9'));
    expect(spamKey('heeeeeey')).toBe('heey');
  });

  it('flags copy-paste spam from many accounts and ignores it during a raid grace', () => {
    const d = new RaidDetector(new Set());
    const t = 10_000_000;
    for (let i = 0; i < 5; i++) d.push({ messageId: `m${i}`, userId: `r${i}`, userName: `r${i}`, text: `you suck ${i}`, at: t + i });
    expect(d.evaluate(t + 10, cfg).reason).toBe('similar');
    expect(d.evaluate(t + 10, cfg).suspects).toHaveLength(5);
    expect(d.evaluate(t + 10, cfg, t + 60_000).reason).toBeNull();
  });

  it('only trusts "new chatters" once regulars are known', () => {
    const d = new RaidDetector(new Set());
    const t = 20_000_000;
    for (let i = 0; i < 12; i++) d.push({ messageId: `m${i}`, userId: `n${i}`, userName: `n${i}`, text: `hello ${String.fromCharCode(97 + i)}${String.fromCharCode(110 + i)}`, at: t + i });
    expect(d.evaluate(t + 20, cfg, 0, false).reason).toBeNull();
    expect(d.evaluate(t + 20, cfg, 0, true).reason).toBe('newChatters');
  });

  it('locks the chat and puts back exactly what it changed', async () => {
    const { ctx, settings, state, dir } = makeCtx();
    settings.set('shield', { ...cfg, followersOnly: true, followersMinutes: 10, slowMode: true, slowSec: 10, announce: '' });
    const deps = {
      getChatSettings: vi.fn(async () => ({ followerMode: false, followerMinutes: 0, slowMode: true, slowSec: 30, emoteMode: false })),
      updateChatSettings: vi.fn(async () => undefined),
      setShieldMode: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      timeout: vi.fn(async () => undefined),
      accountAges: vi.fn(async () => new Map()),
      say: vi.fn(async () => undefined),
    };
    const shield = new ShieldService(ctx, deps, join(dir, 'known.json'));
    await shield.activate('test');
    // Slow mode was already stricter: left alone.
    expect(deps.updateChatSettings).toHaveBeenCalledWith({ followerMode: true, followerMinutes: 10 });
    expect(state.current.shield.status).toBe('active');
    await shield.release();
    expect(deps.updateChatSettings).toHaveBeenLastCalledWith({ followerMode: false, followerMinutes: 0 });
    expect(state.current.shield.status).toBe('watching');
    shield.dispose();
  });

  it('triggers on its own and deletes the spam', async () => {
    vi.useFakeTimers();
    const { ctx, bus, settings, state, dir } = makeCtx();
    settings.set('shield', { ...cfg, announce: '' });
    const deps = {
      getChatSettings: vi.fn(async () => ({ followerMode: false, followerMinutes: 0, slowMode: false, slowSec: 0, emoteMode: false })),
      updateChatSettings: vi.fn(async () => undefined),
      setShieldMode: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      timeout: vi.fn(async () => undefined),
      accountAges: vi.fn(async () => new Map()),
      say: vi.fn(async () => undefined),
    };
    const shield = new ShieldService(ctx, deps, join(dir, 'known.json'));
    shield.start();
    const t = Date.now();
    for (let i = 0; i < 5; i++) bus.emit('chat:message', msg('buy followers at spam dot com', `bot${i}`, t + i));
    bus.emit('chat:message', msg('buy followers at spam dot com', 'mod', t + 6, { moderator: true }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(state.current.shield.status).toBe('active');
    expect(deps.deleteMessage).toHaveBeenCalledTimes(5);
    expect(state.current.shield.suspects.map((s) => s.userId)).not.toContain('mod');
    shield.dispose();
  });
});

describe('song overlays in OBS', () => {
  it('routes duel and melody audio like song requests', () => {
    expect(isMusicOverlay('http://127.0.0.1:4848/overlay/duel')).toBe(true);
    expect(isMusicOverlay('http://127.0.0.1:4848/overlay/melody?id=x')).toBe(true);
    expect(isMusicOverlay('http://127.0.0.1:4848/overlay/chat')).toBe(false);
  });
});
