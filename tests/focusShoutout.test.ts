import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFocus, defaultShoutout } from '@shared/defaults';
import { ALL_OVERLAY_KINDS } from '@shared/profiles';
import type { ChatMessage, OverlayMessage, ShoutoutCard, ShoutoutClip, StreamEvent } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { allowedExtension, FocusService, formatLeft, nextPhase, phaseMs } from '../src/main/features/focus';
import { cardDurationMs, pickClip, ShoutoutService, shoutoutLogin, type ChannelInfo } from '../src/main/features/shoutout';

const MIN = 60_000;

function makeCtx(lang: 'ru' | 'en' = 'en') {
  const bus = new EventBus();
  const dir = mkdtempSync(join(tmpdir(), 'sh-focus-'));
  const settings = new SettingsStore(join(dir, 'settings.json'), bus, lang);
  const state = new StateHub(bus);
  const ctx = { bus, settings, state, toast: vi.fn(), secrets: {}, openExternal: vi.fn(), mediaDir: '' } as unknown as AppContext;
  return { ctx, bus, settings, state };
}

let seq = 0;
function chat(text: string): ChatMessage {
  return {
    id: `m${seq++}`, platform: 'twitch', userId: 'u1', userLogin: 'viewer', userName: 'Viewer', badges: [],
    roles: { broadcaster: false, moderator: false, vip: false, subscriber: false }, text, fragments: [{ type: 'text', text }], timestamp: Date.now(),
  };
}

function redemption(title: string, user = 'Fan'): StreamEvent {
  return { id: `r${seq++}`, source: 'twitch', type: 'redemption', userName: user, timestamp: Date.now(), rewardTitle: title, cost: 100, input: '' };
}

function raid(login: string, viewers: number): StreamEvent {
  return { id: `raid${seq++}`, source: 'twitch', type: 'raid', userName: login, userLogin: login, viewers, timestamp: Date.now() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('focus timer helpers', () => {
  it('orders phases with a long break every N sessions', () => {
    expect(nextPhase('focus', 1, 4)).toBe('break');
    expect(nextPhase('focus', 4, 4)).toBe('long');
    expect(nextPhase('focus', 8, 4)).toBe('long');
    expect(nextPhase('focus', 4, 0)).toBe('break');
    expect(nextPhase('break', 3, 4)).toBe('focus');
    expect(nextPhase('long', 4, 4)).toBe('focus');
  });

  it('formats time and caps what chat may add', () => {
    expect(formatLeft(25 * MIN)).toBe('25:00');
    expect(formatLeft(3_725_000)).toBe('1:02:05');
    expect(formatLeft(-5)).toBe('0:00');
    expect(phaseMs({ ...defaultFocus('en'), breakMin: 0 }, 'break')).toBe(MIN);
    expect(allowedExtension(5, 0, 30)).toBe(5);
    expect(allowedExtension(5, 28, 30)).toBe(2);
    expect(allowedExtension(5, 30, 30)).toBe(0);
  });
});

describe('focus timer', () => {
  function setup(patch: Partial<ReturnType<typeof defaultFocus>> = {}, scene = 'Game') {
    vi.useFakeTimers();
    const env = makeCtx();
    env.settings.set('focus', { ...defaultFocus('en'), focusMin: 25, breakMin: 5, longBreakMin: 15, longEvery: 2, ...patch });
    const sent: OverlayMessage[] = [];
    const said: string[] = [];
    let current = scene;
    const setScene = vi.fn(async (s: string) => { current = s; });
    const focus = new FocusService(env.ctx, {
      broadcast: (_k, m) => void sent.push(m),
      say: async (t) => void said.push(t),
      currentScene: () => current,
      setScene,
    });
    return { ...env, focus, sent, said, setScene, scene: () => current, moveTo: (s: string) => { current = s; } };
  }

  it('runs focus, break and a long break after the set number of sessions', async () => {
    const { focus, state, said, sent } = setup();
    focus.toggle();
    expect(state.current.focus).toMatchObject({ status: 'running', phase: 'focus', durationMs: 25 * MIN });
    expect(sent.some((m) => m.type === 'focusChime')).toBe(true);
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(state.current.focus).toMatchObject({ phase: 'break', done: 1, focusMs: 25 * MIN });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(state.current.focus.phase).toBe('focus');
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(state.current.focus).toMatchObject({ phase: 'long', done: 2, durationMs: 15 * MIN });
    expect(said.some((t) => t.includes('Long break: 15 min'))).toBe(true);
    focus.dispose();
  });

  it('keeps the time left over a pause', async () => {
    const { focus, state } = setup();
    focus.toggle();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    focus.toggle();
    expect(state.current.focus).toMatchObject({ status: 'paused', leftMs: 15 * MIN, endsAt: null });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(state.current.focus.phase).toBe('focus');
    focus.toggle();
    expect(focus.left()).toBe(15 * MIN);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(state.current.focus.phase).toBe('break');
    focus.dispose();
  });

  it('lets chat extend the phase with a reward, up to the limit', async () => {
    const { focus, state, bus, said } = setup({ rewardTitle: 'More focus', rewardMinutes: 5, maxExtendMin: 8 });
    bus.emit('event', redemption('More focus'));
    expect(state.current.focus.extendedMin).toBe(0); // not running: nothing to extend
    focus.toggle();
    bus.emit('event', redemption('more focus ', 'Anna'));
    expect(focus.left()).toBe(30 * MIN);
    expect(state.current.focus.lastExtend).toMatchObject({ user: 'Anna', minutes: 5 });
    bus.emit('event', redemption('More focus', 'Bob'));
    expect(state.current.focus.extendedMin).toBe(8);
    expect(focus.left()).toBe(33 * MIN);
    bus.emit('event', redemption('More focus', 'Cid'));
    expect(focus.left()).toBe(33 * MIN);
    expect(said.at(-1)).toContain("can't be extended");
    // The next phase starts from zero again.
    await vi.advanceTimersByTimeAsync(33 * MIN);
    expect(state.current.focus).toMatchObject({ phase: 'break', extendedMin: 0 });
    focus.dispose();
  });

  it('answers the chat command with the time left, not more than once per 10 s', async () => {
    const { focus, bus, said } = setup({ command: 'focus' });
    bus.emit('chat:message', chat('!focus'));
    expect(said.at(-1)).toBe('The focus timer is not running');
    focus.toggle();
    bus.emit('chat:message', chat('!focus'));
    expect(said.filter((t) => t.includes('left')).length).toBe(0);
    await vi.advanceTimersByTimeAsync(11_000);
    bus.emit('chat:message', chat('!FOCUS'));
    expect(said.at(-1)).toMatch(/^Focus: 24:49 left\. Sessions this stream: 1$/);
    focus.dispose();
  });

  it('shows the break scene and brings the previous one back', async () => {
    const { focus, setScene, scene } = setup({ breakScene: 'BRB' });
    focus.toggle();
    expect(setScene).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(scene()).toBe('BRB');
    expect(focus.needsShutdown).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(scene()).toBe('Game');
    expect(focus.needsShutdown).toBe(false);
    focus.dispose();
  });

  it('leaves the scene alone when the streamer changed it during the break', async () => {
    const { focus, scene, moveTo } = setup({ breakScene: 'BRB' });
    focus.toggle();
    await vi.advanceTimersByTimeAsync(25 * MIN);
    moveTo('Just Chatting');
    focus.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(scene()).toBe('Just Chatting');
    focus.dispose();
  });

  it('waits for the streamer between phases when auto-continue is off', async () => {
    const { focus, state, scene, said } = setup({ autoContinue: false, breakScene: 'BRB' });
    focus.toggle();
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(state.current.focus).toMatchObject({ status: 'paused', phase: 'break', leftMs: 5 * MIN });
    expect(scene()).toBe('Game');
    const before = said.length;
    focus.add(2);
    focus.toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(scene()).toBe('BRB');
    expect(said.length).toBe(before + 1);
    expect(focus.left()).toBe(7 * MIN);
    focus.dispose();
  });

  it('counts a skipped focus session only when half of it was done', async () => {
    const { focus, state } = setup();
    focus.toggle();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    focus.skip();
    expect(state.current.focus).toMatchObject({ phase: 'break', status: 'running', done: 0, focusMs: 5 * MIN });
    focus.skip();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    focus.skip();
    expect(state.current.focus).toMatchObject({ phase: 'break', done: 1, focusMs: 25 * MIN });
    focus.dispose();
  });
});

describe('shoutout helpers', () => {
  const clips: ShoutoutClip[] = [
    { id: 'a', title: 'best', durationSec: 28, views: 900, thumbnailUrl: '' },
    { id: 'b', title: 'second', durationSec: 55, views: 400, thumbnailUrl: '' },
  ];

  it('reads channel names from links and mentions', () => {
    expect(shoutoutLogin('@Friend_1')).toBe('friend_1');
    expect(shoutoutLogin('https://www.twitch.tv/Friend/videos')).toBe('friend');
  });

  it('picks the most viewed clip or a random one of the best', () => {
    expect(pickClip(clips, 'top')?.id).toBe('a');
    expect(pickClip(clips, 'random', () => 0.99)?.id).toBe('b');
    expect(pickClip([], 'top')).toBeNull();
  });

  it('keeps a card on screen for its clip, cut to the limit', () => {
    const cfg = { ...defaultShoutout('en'), clipMaxSec: 30, cardSec: 12 };
    const card = { clip: clips[1] } as ShoutoutCard;
    expect(cardDurationMs(card, cfg)).toBe(32_000);
    expect(cardDurationMs({ ...card, clip: clips[0] }, cfg)).toBe(30_000);
    expect(cardDurationMs({ ...card, clip: null }, cfg)).toBe(12_000);
    expect(cardDurationMs(card, { ...cfg, playClip: false })).toBe(12_000);
  });
});

describe('shoutout card', () => {
  const channels: Record<string, ChannelInfo> = {
    raider: { id: '11', login: 'raider', displayName: 'Raider', avatarUrl: 'https://static-cdn.jtvnw.net/a.png', game: 'Celeste', title: 'Speedrun' },
    pal: { id: '22', login: 'pal', displayName: 'Pal', avatarUrl: '', game: '', title: 'Chill' },
  };

  function setup(patch: Partial<ReturnType<typeof defaultShoutout>> = {}) {
    vi.useFakeTimers();
    const env = makeCtx();
    env.settings.set('shoutout', { ...defaultShoutout('en'), delaySec: 8, clipMaxSec: 30, cardSec: 10, ...patch });
    const sent: OverlayMessage[] = [];
    const said: string[] = [];
    const deps = {
      broadcast: (m: OverlayMessage) => void sent.push(m),
      say: async (t: string) => void said.push(t),
      channel: vi.fn(async (login: string) => channels[login] ?? null),
      clips: vi.fn(async (id: string, days?: number) => (id === '11' && !days ? [{ id: 'clipA', title: 'GG', durationSec: 20, views: 5, thumbnailUrl: '' }] : [])),
      native: vi.fn(async (_id: string): Promise<void> => undefined),
      followers: vi.fn(async (id: string) => ({ '11': 120, '22': 51, '33': 7 } as Record<string, number>)[id] ?? 0),
      now: () => Date.now(),
    };
    const so = new ShoutoutService(env.ctx, deps);
    return { ...env, so, sent, said, deps };
  }

  it('shouts out a raider after the raid alert, with a clip, then hides the card', async () => {
    const { bus, so, state, said, deps } = setup({ clipPick: 'recent' });
    bus.emit('event', raid('raider', 25));
    await vi.advanceTimersByTimeAsync(7000);
    expect(state.current.shoutout.current).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(said).toEqual(['Thanks for the raid, Raider! Go check them out at twitch.tv/raider — last seen in Celeste']);
    expect(deps.native).toHaveBeenCalledWith('11');
    // "recent" found nothing in the last month and fell back to all-time clips.
    expect(deps.clips).toHaveBeenCalledWith('11', 30);
    expect(state.current.shoutout.current).toMatchObject({ login: 'raider', viewers: 25, reason: 'raid', clip: { id: 'clipA' } });
    await vi.advanceTimersByTimeAsync(22_000);
    expect(state.current.shoutout.current).toBeNull();
    expect(state.current.shoutout.history[0].login).toBe('raider');
    so.dispose();
  });

  it('queues raids one after another and ignores small or repeated ones', async () => {
    const { bus, so, state } = setup({ minViewers: 5, delaySec: 0, playClip: false });
    bus.emit('event', raid('raider', 30));
    bus.emit('event', raid('pal', 6));
    bus.emit('event', raid('pal', 9));
    bus.emit('event', raid('tiny', 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.current.shoutout.current?.login).toBe('raider');
    expect(state.current.shoutout.queue).toEqual(['pal']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.current.shoutout.current?.login).toBe('pal');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.current.shoutout.current).toBeNull();
    expect(state.current.shoutout.history.map((c) => c.login)).toEqual(['pal', 'raider']);
    so.dispose();
  });

  it("shows the card for the bot's !so without a second chat message; Twitch's shoutout goes through the queue", async () => {
    const { bus, so, state, said, deps } = setup();
    bus.emit('shoutout:command', { login: 'pal', userId: '22' });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.current.shoutout.current).toMatchObject({ login: 'pal', reason: 'command', clip: null });
    expect(said).toEqual([]);
    expect(deps.native).toHaveBeenCalledWith('22');
    so.dispose();
  });

  function chatter(login: string, userId: string, roles: Partial<ChatMessage['roles']> = {}): ChatMessage {
    return { ...chat('hi'), userId, userLogin: login, userName: login, roles: { broadcaster: false, moderator: false, vip: false, subscriber: false, ...roles } };
  }

  function live(env: ReturnType<typeof setup>, on = true) {
    env.state.patch('stream', { ...env.state.current.stream, live: on });
    env.bus.emit('stream:update', env.state.current.stream);
  }

  it('shouts out a streamer with enough followers once per stream when they write in chat', async () => {
    const env = setup({ onChatter: true, minFollowers: 50, playClip: false });
    const { bus, so, state, said, deps } = env;
    bus.emit('chat:message', chatter('raider', '11'));
    await vi.advanceTimersByTimeAsync(0);
    // Offline: nothing.
    expect(deps.followers).not.toHaveBeenCalled();
    live(env);
    bus.emit('chat:message', chatter('raider', '11'));
    bus.emit('chat:message', chatter('raider', '11'));
    bus.emit('chat:message', chatter('smol', '33'));
    bus.emit('chat:message', chatter('nightbot', '44'));
    bus.emit('chat:message', chatter('pal', '22', { broadcaster: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.followers.mock.calls.map((c) => c[0])).toEqual(['11', '33']);
    expect(state.current.shoutout.current).toMatchObject({ login: 'raider', reason: 'chatter', followers: 120 });
    expect(said).toEqual(['Streamer Raider is in chat! Go check them out at twitch.tv/raider — last seen in Celeste']);
    expect(deps.native).toHaveBeenCalledWith('11');
    await vi.advanceTimersByTimeAsync(20_000);
    bus.emit('chat:message', chatter('raider', '11'));
    await vi.advanceTimersByTimeAsync(0);
    expect(said).toHaveLength(1);
    // A new stream: shouted out again.
    live(env, false);
    live(env);
    bus.emit('chat:message', chatter('raider', '11'));
    await vi.advanceTimersByTimeAsync(0);
    expect(said).toHaveLength(2);
    so.dispose();
  });

  it('does not shout out a raider again for chatting after the raid', async () => {
    const env = setup({ onChatter: true, delaySec: 0, playClip: false });
    live(env);
    env.bus.emit('event', raid('raider', 10));
    await vi.advanceTimersByTimeAsync(0);
    env.bus.emit('chat:message', chatter('raider', '11'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(env.said).toHaveLength(1);
    expect(env.deps.followers).not.toHaveBeenCalled();
    env.so.dispose();
  });

  it("queues Twitch's own shoutout when one went out recently, and retries after a cooldown refusal", async () => {
    const env = setup({ onChatter: true, showCard: false });
    const { bus, so, state, deps } = env;
    live(env);
    deps.native.mockRejectedValueOnce(Object.assign(new Error('cooldown'), { status: 429 }));
    bus.emit('chat:message', chatter('raider', '11'));
    bus.emit('chat:message', chatter('pal', '22'));
    await vi.advanceTimersByTimeAsync(1000);
    // The first try was refused: both wait.
    expect(deps.native.mock.calls.map((c) => c[0])).toEqual(['11']);
    expect(state.current.shoutout.nativeQueue).toEqual(['Raider', 'Pal']);
    expect(state.current.shoutout.nativeNextAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(124_000);
    expect(deps.native.mock.calls.map((c) => c[0])).toEqual(['11', '11']);
    expect(state.current.shoutout.nativeQueue).toEqual(['Pal']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.native).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(deps.native.mock.calls.map((c) => c[0])).toEqual(['11', '11', '22']);
    expect(state.current.shoutout.nativeQueue).toEqual([]);
    expect(state.current.shoutout.nativeNextAt).toBeNull();
    // The same channel within the hour: Twitch would refuse, so it is not queued.
    await so.show('raider');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(deps.native).toHaveBeenCalledTimes(3);
    so.dispose();
  });

  it('posts without a card when the card is off, and reports unknown channels right away', async () => {
    const { so, state, said, sent } = setup({ showCard: false });
    await expect(so.show('nobody_here')).rejects.toThrow('not found');
    await so.show('twitch.tv/pal');
    await vi.advanceTimersByTimeAsync(0);
    expect(said[0]).toContain('last seen in none yet');
    expect(state.current.shoutout.current).toBeNull();
    expect(sent.filter((m) => m.type === 'shoutout' && m.card)).toHaveLength(0);
    so.dispose();
  });

  it('does nothing on raids when raid shoutouts are off; the test card works without Twitch', async () => {
    const { bus, so, state, deps } = setup({ onRaid: false });
    bus.emit('event', raid('raider', 50));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.channel).not.toHaveBeenCalled();
    so.test();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.current.shoutout.current?.reason).toBe('test');
    so.skip();
    expect(state.current.shoutout.current).toBeNull();
    so.dispose();
  });
});

describe('focus and shoutout overlays in existing profiles', () => {
  it('switches them on once in profiles saved before they existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-profiles-'));
    const file = join(dir, 'settings.json');
    const before = ALL_OVERLAY_KINDS.filter((k) => k !== 'focus' && k !== 'shoutout');
    writeFileSync(file, JSON.stringify({ language: 'en', overlayKindsSeen: before, activeProfileId: 'p', profiles: [{ id: 'p', name: 'Main', config: {}, overlays: before.filter((k) => k !== 'wheel') }] }));
    const store = new SettingsStore(file, new EventBus(), 'en');
    const overlays = store.get('profiles')[0].overlays;
    expect(overlays).toContain('focus');
    expect(overlays).toContain('shoutout');
    expect(overlays).not.toContain('wheel');
    expect(store.get('profiles')[0].config.focus).toMatchObject({ focusMin: 25 });
  });
});
