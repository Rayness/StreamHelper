import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultShield } from '@shared/defaults';
import type { ChatMessage, ChatRoles, OverlayMessage } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { CurseService } from '../src/main/features/curses';
import { DuelService } from '../src/main/features/duel';
import { DuckingService } from '../src/main/features/ducking';
import { fillPrice, MarketService, maxAffordable } from '../src/main/features/market';
import { PollService } from '../src/main/features/poll';
import { parsePortalCommand } from '../src/main/features/portal';
import { RaidDetector, ShieldService, spamKey } from '../src/main/features/shield';

let seq = 0;
function msg(text: string, userId = 'u1', at = Date.now(), roles: Partial<ChatRoles> = {}, fragments?: ChatMessage['fragments']): ChatMessage {
  return {
    id: `m${seq++}`,
    platform: 'twitch',
    userId,
    userLogin: `user_${userId}`,
    userName: `User${userId}`,
    badges: [],
    roles: { broadcaster: false, moderator: false, vip: false, subscriber: false, ...roles },
    text,
    fragments: fragments ?? [{ type: 'text', text }],
    timestamp: at,
  };
}

function makeCtx(lang: 'ru' | 'en' = 'en') {
  const bus = new EventBus();
  const dir = mkdtempSync(join(tmpdir(), 'sh-fixes-'));
  const settings = new SettingsStore(join(dir, 'settings.json'), bus, lang);
  const state = new StateHub(bus);
  const ctx = { bus, settings, state, toast: vi.fn(), secrets: {}, openExternal: vi.fn(), mediaDir: '' } as unknown as AppContext;
  const said: string[] = [];
  const deps = { broadcast: vi.fn((_k: unknown, _m: OverlayMessage) => undefined), say: vi.fn(async (t: string) => void said.push(t)) };
  return { ctx, bus, settings, state, deps, said, dir };
}

function shieldDeps() {
  return {
    getChatSettings: vi.fn(async () => ({ followerMode: false, followerMinutes: 0, slowMode: false, slowSec: 0, emoteMode: false })),
    updateChatSettings: vi.fn(async () => undefined),
    setShieldMode: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    timeout: vi.fn(async () => undefined),
    accountAges: vi.fn(async () => new Map<string, number>()),
    say: vi.fn(async () => undefined),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  vi.useRealTimers();
});

describe('market trades fill at the average price', () => {
  it('pays the price between before and after its own impact', () => {
    expect(fillPrice(100, 4, 1.5, 'buy')).toBe(101.5);
    // A balance never buys more than it can pay for, impact included.
    const qty = maxAffordable(100, 1000, 1.5);
    expect(fillPrice(100, qty, 1.5, 'buy') * qty).toBeLessThanOrEqual(1000);
    expect(fillPrice(100, qty + 1, 1.5, 'buy') * (qty + 1)).toBeGreaterThan(1000);
    expect(maxAffordable(100, 50, 1.5)).toBe(0);
  });

  it('buying and selling straight back makes no money', () => {
    const { ctx, bus, settings, deps, dir } = makeCtx('en');
    settings.set('market', { ...settings.get('market'), enabled: true, listMinMessages: 1, earnPerMessage: 0, ipoPrice: 100, startBalance: 1000, announceNews: false, impactPct: 1.5, dividendPct: 0 });
    const market = new MarketService(ctx, deps, join(dir, 'market.json'), () => 0.5);
    let t = Date.now();
    bus.emit('chat:message', msg('hi', 'star', t++));
    bus.emit('chat:message', msg('hi', 'fan', t++));
    for (let round = 0; round < 10; round++) {
      bus.emit('chat:message', msg('!buy @user_star all', 'fan', (t += 4000)));
      bus.emit('chat:message', msg('!sell @user_star all', 'fan', (t += 4000)));
    }
    expect(market.snapshot.wallets.fan.balance).toBeLessThanOrEqual(1000);
    expect(market.snapshot.wallets.fan.balance).toBeGreaterThan(990);
    market.dispose();
  });
});

describe('raid shield fixes', () => {
  const cfg = { ...defaultShield('en'), enabled: true, windowSec: 20, similar: 5, newChatters: 100, young: 0, youngDays: 0, timeoutSec: 60, announce: '' };

  it('treats laughter as laughter', () => {
    expect(spamKey('ахахахахах')).toBe(spamKey('ахахах'));
    expect(spamKey('hahahaha').length).toBeLessThan(5);
  });

  it('ignores regulars spamming the same text, and short reactions from anyone', () => {
    const t = 30_000_000;
    const regulars = new RaidDetector(new Set(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']));
    for (let i = 0; i < 6; i++) regulars.push({ messageId: `m${i}`, userId: `r${i}`, userName: `r${i}`, text: 'what a play', at: t + i });
    expect(regulars.evaluate(t + 10, cfg).reason).toBeNull();
    const newcomers = new RaidDetector(new Set());
    for (let i = 0; i < 6; i++) newcomers.push({ messageId: `m${i}`, userId: `n${i}`, userName: `n${i}`, text: 'LUL', at: t + i });
    expect(newcomers.evaluate(t + 10, cfg).reason).toBeNull();
  });

  it('does not lock the chat over commands or emote spam from new viewers', async () => {
    vi.useFakeTimers();
    const { ctx, bus, settings, state, dir } = makeCtx();
    settings.set('shield', cfg);
    const deps = shieldDeps();
    const shield = new ShieldService(ctx, deps, join(dir, 'known.json'));
    shield.start();
    const t = Date.now();
    for (let i = 0; i < 6; i++) bus.emit('chat:message', msg('!join giveaway', `g${i}`, t + i));
    for (let i = 0; i < 6; i++) bus.emit('chat:message', msg('PogChamp PogChamp', `e${i}`, t + 10 + i, {}, [{ type: 'emote', text: 'PogChamp', url: 'u' }, { type: 'text', text: ' ' }, { type: 'emote', text: 'PogChamp', url: 'u' }]));
    await vi.advanceTimersByTimeAsync(1100);
    expect(state.current.shield.status).toBe('watching');
    shield.dispose();
  });

  it('remembers chatters while off without collecting their messages', async () => {
    vi.useFakeTimers();
    const { ctx, bus, settings, state, dir } = makeCtx();
    settings.set('shield', { ...cfg, enabled: false });
    const shield = new ShieldService(ctx, shieldDeps(), join(dir, 'known.json'));
    shield.start();
    const t = Date.now();
    for (let i = 0; i < 6; i++) bus.emit('chat:message', msg('buy followers at spam dot com', `x${i}`, t + i));
    settings.set('shield', cfg);
    await vi.advanceTimersByTimeAsync(1100);
    // Nothing was queued while off, and those chatters are now known regulars.
    expect(state.current.shield.status).toBe('watching');
    for (let i = 0; i < 6; i++) bus.emit('chat:message', msg('buy followers at spam dot com', `x${i}`, Date.now()));
    await vi.advanceTimersByTimeAsync(1100);
    expect(state.current.shield.status).toBe('watching');
    shield.dispose();
  });

  it('handles every spam message and spammer once, however big the raid', async () => {
    vi.useFakeTimers();
    const { ctx, bus, settings, state, dir } = makeCtx();
    settings.set('shield', cfg);
    const deps = shieldDeps();
    const shield = new ShieldService(ctx, deps, join(dir, 'known.json'));
    shield.start();
    const t = Date.now();
    for (let i = 0; i < 150; i++) bus.emit('chat:message', msg('buy followers at spam dot com', `bot${i}`, t + i));
    await vi.advanceTimersByTimeAsync(5100);
    expect(state.current.shield.status).toBe('active');
    expect(deps.deleteMessage).toHaveBeenCalledTimes(150);
    expect(deps.timeout).toHaveBeenCalledTimes(150);
    shield.dispose();
  });

  it('keeps the lockdown across a restart and unlocks the chat afterwards', async () => {
    const { ctx, settings, state, dir } = makeCtx();
    settings.set('shield', { ...cfg, autoReleaseMin: 0 });
    const deps = shieldDeps();
    const first = new ShieldService(ctx, deps, join(dir, 'known.json'));
    await first.activate('raid');
    expect(existsSync(join(dir, 'shield-lock.json'))).toBe(true);
    first.dispose();

    state.replace('shield', { ...state.current.shield, status: 'watching' });
    const second = new ShieldService(ctx, deps, join(dir, 'known.json'));
    second.start();
    expect(state.current.shield.status).toBe('active');
    expect(second.needsShutdown).toBe(true);
    await second.release();
    expect(deps.updateChatSettings).toHaveBeenLastCalledWith({ followerMode: false, followerMinutes: 0, slowMode: false, slowSec: 0 });
    expect(existsSync(join(dir, 'shield-lock.json'))).toBe(false);
    second.dispose();
  });

  it('stays on and retries when Twitch refuses to unlock', async () => {
    vi.useFakeTimers();
    const { ctx, settings, state, dir } = makeCtx();
    settings.set('shield', { ...cfg, autoReleaseMin: 0 });
    const deps = shieldDeps();
    const shield = new ShieldService(ctx, deps, join(dir, 'known.json'));
    await shield.activate('raid');
    deps.updateChatSettings.mockRejectedValueOnce(new Error('offline'));
    expect(await shield.release()).toBe(false);
    expect(state.current.shield.status).toBe('active');
    expect(existsSync(join(dir, 'shield-lock.json'))).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(state.current.shield.status).toBe('watching');
    expect(existsSync(join(dir, 'shield-lock.json'))).toBe(false);
    shield.dispose();
  });
});

describe('undo before quitting', () => {
  it('a curse is lifted in OBS by shutdown', async () => {
    const { ctx, settings, deps } = makeCtx();
    settings.set('curses', { ...settings.get('curses'), curses: [{ id: 'm', enabled: true, name: 'Mute', description: '', durationSec: 60, steps: [{ type: 'mute', input: 'Game' }] }] });
    const obs = { setFilterEnabled: vi.fn(), setSourceVisible: vi.fn(), setMute: vi.fn(async () => false) };
    const service = new CurseService(ctx, deps, obs);
    expect(service.needsShutdown).toBe(false);
    await service.apply('m');
    expect(service.needsShutdown).toBe(true);
    await service.shutdown();
    expect(obs.setMute).toHaveBeenLastCalledWith('Game', false);
    expect(service.needsShutdown).toBe(false);
    service.dispose();
  });

  it('ducked inputs get their volume back by shutdown', async () => {
    const { ctx, settings } = makeCtx();
    settings.set('ducking', { ...settings.get('ducking'), enabled: true, micInput: 'Mic', targets: ['Music'], duckPercent: 25, attackMs: 0, releaseMs: 10_000, fadeMs: 0 });
    const volumes = new Map([['Music', 0.8]]);
    let listener: ((l: Map<string, number>) => void) | null = null;
    const obs = {
      connected: true,
      onVolumeMeters: (l: (levels: Map<string, number>) => void) => { listener = l; return () => { listener = null; }; },
      getVolume: vi.fn(async (i: string) => volumes.get(i)!),
      setVolume: vi.fn(async (i: string, v: number) => void volumes.set(i, v)),
    };
    const ducking = new DuckingService(ctx, obs, () => 0);
    ducking.start();
    listener!(new Map([['Mic', -10]]));
    await flush();
    expect(volumes.get('Music')).toBeCloseTo(0.2);
    expect(ducking.needsShutdown).toBe(true);
    await ducking.shutdown();
    expect(volumes.get('Music')).toBeCloseTo(0.8);
    expect(listener).toBeNull();
    ducking.dispose();
  });
});

describe('number votes in chat', () => {
  it('a poll, a duel and a curse vote never listen to "1" / "2" at the same time', () => {
    const { ctx, settings, state, deps } = makeCtx();
    settings.set('poll', { ...settings.get('poll'), question: 'Q', options: ['A', 'B'], durationSec: 60 });
    settings.set('curses', { ...settings.get('curses'), curses: [{ id: 'x', enabled: true, name: 'X', description: '', durationSec: 60, steps: [] }] });
    const poll = new PollService(ctx, deps);
    const curses = new CurseService(ctx, deps, { setFilterEnabled: vi.fn(), setSourceVisible: vi.fn(), setMute: vi.fn() });
    const duel = new DuelService(ctx, deps, { upcoming: () => [], hasCurrent: () => false, isPaused: () => false, pause: vi.fn(), move: vi.fn(), play: vi.fn(), remove: vi.fn() });
    poll.start();
    expect(() => curses.startVote()).toThrow(/poll/);
    expect(() => duel.start()).toThrow(/poll/);
    poll.end();
    curses.startVote();
    expect(state.current.curse.status).toBe('voting');
    expect(() => poll.start()).toThrow(/curse/);
    curses.cancel();
    poll.start();
    expect(state.current.poll?.status).toBe('running');
    poll.dispose();
    curses.dispose();
    duel.dispose();
  });
});

describe('portal commands from the partner', () => {
  it('accepts the other language and the default prefix', () => {
    expect(parsePortalCommand('!портал привет', '!', 'portal')).toEqual({ prefix: '!', name: 'портал', args: ['привет'] });
    expect(parsePortalCommand('!portal hi', '?', 'портал')).toEqual({ prefix: '!', name: 'portal', args: ['hi'] });
    expect(parsePortalCommand('?gate hi', '?', 'gate')).toEqual({ prefix: '?', name: 'gate', args: ['hi'] });
    expect(parsePortalCommand('!portal', '!', 'portal')).toBeNull();
    expect(parsePortalCommand('!other hi', '!', 'portal')).toBeNull();
  });
});
