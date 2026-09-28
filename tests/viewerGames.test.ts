import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultHype } from '@shared/defaults';
import type { ChatMessage, ChatRoles, OverlayMessage, StreamEvent } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { GuessService, parseGuess } from '../src/main/features/guess';
import { HypeService, hypeLevel, hypePoints } from '../src/main/features/hype';
import { insertEntry, ViewerQueueService } from '../src/main/features/viewerQueue';

let seq = 0;
function msg(text: string, roles: Partial<ChatRoles> = {}, userId = 'u1'): ChatMessage {
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
    timestamp: Date.now() + seq * 60_000,
  };
}

function makeCtx(lang: 'ru' | 'en' = 'en') {
  const bus = new EventBus();
  const settings = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'sh-')), 'settings.json'), bus, lang);
  const state = new StateHub(bus);
  const ctx = { bus, settings, state, toast: vi.fn(), secrets: {}, openExternal: vi.fn(), mediaDir: '' } as unknown as AppContext;
  const sent: OverlayMessage[] = [];
  const said: string[] = [];
  const deps = { broadcast: vi.fn((_k: unknown, m: OverlayMessage) => void sent.push(m)), say: vi.fn(async (t: string) => void said.push(t)) };
  return { ctx, bus, settings, state, deps, sent, said };
}

describe('viewer queue', () => {
  it('lets subscribers skip ahead of non-subscribers only when enabled', () => {
    const e = (userId: string, sub: boolean) => ({ userId, userName: userId, platform: 'twitch' as const, sub, joinedAt: 0 });
    const line = [e('s1', true), e('a', false), e('b', false)];
    expect(insertEntry(line, e('s2', true), true).map((x) => x.userId)).toEqual(['s1', 's2', 'a', 'b']);
    expect(insertEntry(line, e('s2', true), false).map((x) => x.userId)).toEqual(['s1', 'a', 'b', 's2']);
  });

  it('joins once per viewer while open, leaves on command and picks in order', () => {
    const { ctx, bus, state, deps, said } = makeCtx();
    const q = new ViewerQueueService(ctx, deps);
    bus.emit('chat:message', msg('!join', {}, 'a'));
    expect(state.current.viewerQueue.entries).toHaveLength(0);
    q.setOpen(true);
    bus.emit('chat:message', msg('!join', {}, 'a'));
    bus.emit('chat:message', msg('!JOIN', {}, 'a'));
    bus.emit('chat:message', msg('!join', {}, 'b'));
    bus.emit('chat:message', msg('!join', {}, 'c'));
    bus.emit('chat:message', msg('!leave', {}, 'b'));
    expect(state.current.viewerQueue.entries.map((e) => e.userId)).toEqual(['a', 'c']);
    expect(q.next()?.userId).toBe('a');
    expect(state.current.viewerQueue.picked[0].userId).toBe('a');
    expect(state.current.viewerQueue.entries.map((e) => e.userId)).toEqual(['c']);
    expect(said.some((s) => s.includes('@Usera'))).toBe(true);
    q.clear();
    expect(() => q.next()).toThrow();
    q.dispose();
  });
});

describe('guess the number', () => {
  it('only takes whole numbers', () => {
    expect(parseGuess(' 42 ')).toBe(42);
    expect(parseGuess('42 please')).toBeNull();
    expect(parseGuess('4.2')).toBeNull();
  });

  it('narrows the range on misses and crowns the exact guess', () => {
    const { ctx, bus, state, deps, settings } = makeCtx();
    settings.set('guess', { ...settings.get('guess'), min: 1, max: 100, cooldownSec: 0 });
    // rand 0.5 → secret 51
    const game = new GuessService(ctx, deps, () => 0.5);
    game.start();
    expect(state.current.guess).toMatchObject({ status: 'running', low: 1, high: 100, answer: null });
    bus.emit('chat:message', msg('30', {}, 'a'));
    expect(state.current.guess).toMatchObject({ low: 31, high: 100, lastGuess: { value: 30, hint: 'higher' } });
    bus.emit('chat:message', msg('70', {}, 'b'));
    expect(state.current.guess).toMatchObject({ low: 31, high: 69, attempts: 2 });
    bus.emit('chat:message', msg('51', { broadcaster: true }, 'me'));
    expect(state.current.guess.status).toBe('running');
    bus.emit('chat:message', msg('51', {}, 'c'));
    expect(state.current.guess).toMatchObject({ status: 'won', winner: 'Userc', answer: 51, attempts: 3 });
    game.dispose();
  });

  it('applies the per-viewer cooldown', () => {
    const { ctx, bus, state, deps, settings } = makeCtx();
    settings.set('guess', { ...settings.get('guess'), min: 1, max: 100, cooldownSec: 5 });
    const game = new GuessService(ctx, deps, () => 0.5);
    game.start();
    const first = msg('10', {}, 'a');
    bus.emit('chat:message', first);
    bus.emit('chat:message', { ...first, id: 'x', text: '20', timestamp: first.timestamp + 1000 });
    expect(state.current.guess.attempts).toBe(1);
    game.stop();
    expect(state.current.guess).toMatchObject({ status: 'ended', answer: 51 });
    game.dispose();
  });
});

describe('hype meter', () => {
  it('turns points into capped levels', () => {
    const cfg = { levelPoints: 100, maxLevel: 3 };
    expect(hypeLevel(0, cfg)).toEqual({ level: 0, progress: 0, points: 0 });
    expect(hypeLevel(50, cfg)).toEqual({ level: 1, progress: 0.5, points: 50 });
    expect(hypeLevel(250, cfg)).toEqual({ level: 3, progress: 0.5, points: 250 });
    expect(hypeLevel(999, cfg)).toEqual({ level: 3, progress: 1, points: 300 });
  });

  it('scores events, ignores tests, cools down and ranks chatters', () => {
    const cfg = defaultHype('en');
    const gift: StreamEvent = { id: 'g', source: 'twitch', timestamp: 0, userName: 'A', type: 'giftsub', tier: '1000', count: 2, anonymous: false };
    expect(hypePoints(gift, cfg, 'USD')).toBe(cfg.points.sub * 2);

    const { ctx, bus, state, deps } = makeCtx();
    const hype = new HypeService(ctx, deps);
    bus.emit('event', { ...gift, source: 'test' });
    expect(state.current.hype.points).toBe(0);
    bus.emit('event', gift);
    const after = state.current.hype.points;
    expect(after).toBe(cfg.points.sub * 2);
    hype.tick(Date.now() + 60_000);
    expect(state.current.hype.points).toBeLessThan(after);

    bus.emit('chat:message', msg('hi', {}, 'a'));
    bus.emit('chat:message', msg('hi again', {}, 'a'));
    bus.emit('chat:message', msg('!cmd', {}, 'b'));
    bus.emit('chat:message', msg('hello', {}, 'c'));
    bus.emit('chat:message', { ...msg('bot here', {}, 'n'), userLogin: 'nightbot' });
    hype.tick();
    expect(state.current.chatLeaders.map((l) => [l.userId, l.messages])).toEqual([['a', 2], ['c', 1]]);
    hype.resetLeaders();
    expect(state.current.chatLeaders).toEqual([]);
  });
});
