import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBanner, defaultBuiltins, defaultSettings, emptyStats, mergeDefaults, migrateSettings } from '@shared/defaults';
import type { ChatMessage, ChatRoles, OverlayMessage, RuntimeState, StreamEvent } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { bannerShown } from '../src/main/features/banners';
import { AdsService } from '../src/main/features/ads';
import { BossService } from '../src/main/features/boss';
import { emoteUrls } from '../src/main/features/emotes';
import { GiveawayService, isEntry, ROLL_MS } from '../src/main/features/giveaway';
import { leadersOf, parseVote, PollService } from '../src/main/features/poll';
import { answerVariants, isCorrectAnswer, levenshtein, maskTitle } from '../src/main/features/quiz';
import { normalizeText, pickWeighted } from '../src/main/features/stage';
import { applyEventToStats, resolveStreamVar } from '../src/main/features/vars';
import { segmentAtPointer, wheelRotation, WheelService } from '../src/main/features/wheel';

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
    timestamp: Date.now(),
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

describe('shared helpers', () => {
  it('adds new advertising and boss defaults without changing saved text banners', () => {
    const old = defaultSettings('ru') as Partial<ReturnType<typeof defaultSettings>>;
    const originalBanners = old.banners;
    delete old.ads;
    delete old.boss;
    const upgraded = mergeDefaults(defaultSettings('ru'), old);
    expect(upgraded.banners).toEqual(originalBanners);
    expect(upgraded.ads).toHaveLength(1);
    expect(upgraded.boss.maxHp).toBeGreaterThan(0);
  });

  it('keeps existing ad campaigns and gives them the original entrance effect', () => {
    const old = defaultSettings('ru');
    const campaign = { ...old.ads[0], headline: 'Старый партнёр' } as Record<string, unknown>;
    delete campaign.entrance;
    delete campaign.entranceMs;
    old.ads = [campaign as unknown as typeof old.ads[number]];
    const upgraded = migrateSettings(mergeDefaults(defaultSettings('ru'), old));
    expect(upgraded.ads[0]).toMatchObject({ headline: 'Старый партнёр', entrance: 'slideUp', entranceMs: 550 });
  });

  it('adds chat appearance options without replacing an existing chat theme', () => {
    const old = defaultSettings('ru');
    const chat = old.chatOverlay as unknown as Record<string, unknown>;
    chat.background = 'rgba(12,24,48,.8)';
    delete chat.backgroundStyle;
    delete chat.enterAnimation;
    delete chat.showTimestamp;
    const upgraded = mergeDefaults(defaultSettings('ru'), old);
    expect(upgraded.chatOverlay).toMatchObject({
      background: 'rgba(12,24,48,.8)', backgroundStyle: 'card', enterAnimation: 'slideUp', showTimestamp: false,
    });
  });

  it('picks by weight and never picks zero-weight items', () => {
    const items = [{ w: 0 }, { w: 1 }, { w: 3 }];
    expect(pickWeighted(items, (i) => i.w, () => 0)).toBe(1);
    expect(pickWeighted(items, (i) => i.w, () => 0.3)).toBe(2);
    expect(pickWeighted(items, (i) => i.w, () => 0.999999)).toBe(2);
    expect(pickWeighted([{ w: 0 }], (i) => i.w)).toBe(-1);
  });

  it('normalizes text for comparisons', () => {
    expect(normalizeText('  Ёжик, в ТУМАНЕ!! ')).toBe('ежик в тумане');
  });
});

describe('new interactive and advertising services', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('applies a personal chat cooldown and ends the boss fight exactly at zero HP', () => {
    const { ctx, bus, settings, state, deps } = makeCtx();
    settings.set('boss', { ...settings.get('boss'), maxHp: 30, damage: 10, cooldownSec: 30, command: 'hit', redemptionTitle: 'Strike', announce: false });
    const boss = new BossService(ctx, deps);
    boss.start();
    bus.emit('chat:message', msg('!hit', {}, 'a'));
    bus.emit('chat:message', msg('!hit', {}, 'a'));
    expect(state.current.boss).toMatchObject({ status: 'running', hp: 20, hits: 1 });
    bus.emit('chat:message', msg('!hit', {}, 'b'));
    bus.emit('event', { id: 'reward1', source: 'twitch', timestamp: Date.now(), userName: 'Alice', type: 'redemption', rewardTitle: 'Strike', cost: 100, input: '' });
    expect(state.current.boss).toMatchObject({ status: 'defeated', hp: 0, hits: 3 });
    expect(state.current.boss.top).toHaveLength(3);
    boss.dispose();
  });

  it('schedules a graphic ad only while live and lets a manual showing override that schedule', () => {
    const { ctx, settings, state, deps } = makeCtx();
    const campaign = { ...settings.get('ads')[0], media: 'sponsor.png', enabled: true, everyMin: 1, durationSec: 5, onlyWhenLive: true };
    settings.set('ads', [campaign]);
    const ads = new AdsService(ctx, deps);
    ads.tick();
    vi.advanceTimersByTime(60_000);
    ads.tick();
    expect(state.current.ad.activeId).toBeNull();
    ads.show(campaign.id);
    expect(state.current.ad.activeId).toBe(campaign.id);
    expect(ads.overlayMessage()).toMatchObject({ type: 'ad', campaign: { media: '/media/sponsor.png' } });
    vi.advanceTimersByTime(5000);
    ads.tick();
    expect(state.current.ad.activeId).toBeNull();
    ads.stop();
  });
});

describe('wheel geometry', () => {
  it('stops the chosen segment under the pointer', () => {
    for (const n of [2, 3, 6, 11]) {
      for (let winner = 0; winner < n; winner++) {
        for (const r of [0, 0.25, 0.5, 0.99]) {
          const rot = wheelRotation(n, winner, () => r);
          expect(segmentAtPointer(n, rot)).toBe(winner);
          expect(rot).toBeGreaterThanOrEqual(6 * 360);
        }
      }
    }
  });
});

describe('WheelService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spins, announces, removes the winner and queues spins', () => {
    const { ctx, settings, state, deps, sent, said } = makeCtx();
    const wheel = settings.get('wheels')[0];
    settings.set('wheels', [{ ...wheel, removeWinner: true, spinSec: 3, announce: 'Got {result}' }]);
    const svc = new WheelService(ctx, deps, () => 0);
    svc.spin(wheel.id, 'Ann');
    svc.spin(wheel.id, 'Bob');
    const spins = sent.filter((m) => m.type === 'wheelSpin');
    expect(spins).toHaveLength(1);
    expect(state.current.wheel.spinning).toBe(true);
    vi.advanceTimersByTime(3300);
    expect(said).toEqual([`Got ${wheel.segments[0].label}`]);
    expect(settings.get('wheels')[0].segments).toHaveLength(wheel.segments.length - 1);
    vi.advanceTimersByTime(2600);
    // The queued spin starts after the gap, on the updated wheel.
    expect(sent.filter((m) => m.type === 'wheelSpin')).toHaveLength(2);
  });

  it('spins from a chat command and from a channel-points reward', () => {
    const { ctx, bus, settings, sent } = makeCtx();
    const wheel = settings.get('wheels')[0];
    settings.set('wheels', [{ ...wheel, command: 'wheel', commandPermission: 'everyone', commandCooldownSec: 0, redemptionTitle: 'Spin it' }]);
    new WheelService(ctx, { broadcast: (_k, m) => void sent.push(m), say: async () => undefined });
    bus.emit('chat:message', msg('!wheel'));
    const ev: StreamEvent = { id: 'r', source: 'twitch', timestamp: 0, userName: 'Ann', type: 'redemption', rewardTitle: 'spin IT ', cost: 100, input: '' };
    bus.emit('event', ev);
    expect(sent.filter((m) => m.type === 'wheelSpin').length).toBe(1);
  });

  it('refuses a wheel with nothing that can win', () => {
    const { ctx, settings, deps } = makeCtx();
    const wheel = settings.get('wheels')[0];
    settings.set('wheels', [{ ...wheel, segments: wheel.segments.map((s) => ({ ...s, weight: 0 })) }]);
    expect(() => new WheelService(ctx, deps).spin(wheel.id)).toThrow();
  });
});

describe('poll', () => {
  it('parses votes by number or by option text', () => {
    const opts = ['Хоррор', 'Инди'];
    expect(parseVote('2', opts)).toBe(1);
    expect(parseVote('#1', opts)).toBe(0);
    expect(parseVote('3', opts)).toBe(-1);
    expect(parseVote('хоррор!', opts)).toBe(0);
    expect(parseVote('хоррор лучше', opts)).toBe(-1);
    expect(leadersOf([{ votes: 2 }, { votes: 2 }, { votes: 1 }])).toEqual([0, 1]);
    expect(leadersOf([{ votes: 0 }])).toEqual([]);
  });

  it('counts one vote per viewer, allows changing, ends with a result', () => {
    const { ctx, bus, settings, state, deps, said } = makeCtx();
    settings.set('poll', { ...settings.get('poll'), options: ['A', 'B'], durationSec: 0, allowChange: true, announce: true });
    const poll = new PollService(ctx, deps);
    poll.start();
    bus.emit('chat:message', msg('1', {}, 'a'));
    bus.emit('chat:message', msg('1', {}, 'b'));
    bus.emit('chat:message', msg('2', {}, 'b'));
    bus.emit('chat:message', msg('2', {}, 'c'));
    bus.emit('chat:message', msg('2', {}, 'c'));
    expect(state.current.poll!.options.map((o) => o.votes)).toEqual([1, 2]);
    expect(state.current.poll!.total).toBe(3);
    poll.end();
    expect(state.current.poll!.status).toBe('ended');
    expect(state.current.poll!.leaders).toEqual([1]);
    expect(said.at(-1)).toContain('B');
    poll.dispose();
  });

  it('needs two options', () => {
    const { ctx, settings, deps } = makeCtx();
    settings.set('poll', { ...settings.get('poll'), options: ['only'] });
    expect(() => new PollService(ctx, deps).start()).toThrow();
  });
});

describe('giveaway', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('matches the keyword loosely but not partial words', () => {
    expect(isEntry('!участвую', '!участвую')).toBe(true);
    expect(isEntry('Участвую плз', '!участвую')).toBe(true);
    expect(isEntry('неучаствую', '!участвую')).toBe(false);
    expect(isEntry('hi', '')).toBe(false);
  });

  it('collects entrants once, weights subs, picks and re-rolls', () => {
    const { ctx, bus, settings, state, deps, said } = makeCtx();
    settings.set('giveaway', { ...settings.get('giveaway'), keyword: '!join', subLuck: 3 });
    const g = new GiveawayService(ctx, deps, () => 0.99);
    g.open();
    bus.emit('chat:message', msg('!join', {}, 'a'));
    bus.emit('chat:message', msg('!join', {}, 'a'));
    bus.emit('chat:message', msg('!join', { subscriber: true }, 'b'));
    bus.emit('chat:message', msg('!join', { broadcaster: true }, 'me'));
    bus.emit('chat:message', msg('hello', {}, 'c'));
    expect(state.current.giveaway.entrants.map((e) => [e.userId, e.tickets])).toEqual([
      ['a', 1],
      ['b', 3],
    ]);
    g.roll();
    expect(state.current.giveaway.status).toBe('rolling');
    vi.advanceTimersByTime(ROLL_MS);
    expect(state.current.giveaway.status).toBe('done');
    expect(state.current.giveaway.winner!.userId).toBe('b');
    expect(said.at(-1)).toContain('Userb');
    bus.emit('chat:message', msg('I won!', {}, 'b'));
    expect(state.current.giveaway.winnerMessages.map((m) => m.text)).toEqual(['I won!']);
    g.roll();
    vi.advanceTimersByTime(ROLL_MS);
    expect(state.current.giveaway.winner!.userId).toBe('a');
    g.dispose();
  });
});

describe('quiz answers', () => {
  it('accepts short forms, other languages and small typos', () => {
    const answers = ['Провожающая в последний путь Фрирен', "Frieren: Beyond Journey's End", 'Sousou no Frieren'].flatMap(answerVariants);
    expect(isCorrectAnswer('frieren', answers)).toBe(true);
    expect(isCorrectAnswer('Sousou no Frieren', answers)).toBe(true);
    expect(isCorrectAnswer('провожающая в последний путь фририн', answers)).toBe(true);
    expect(isCorrectAnswer('frier', answers)).toBe(false);
    expect(isCorrectAnswer('naruto', answers)).toBe(false);
  });

  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'ab')).toBe(2);
  });

  it('masks letters but keeps spaces and punctuation', () => {
    expect(maskTitle('Re:Zero 2', 0)).toBe('__:____ _');
    const half = maskTitle('Naruto', 0.5, () => 0);
    expect(half.replace(/_/g, '').length).toBe(3);
    expect(maskTitle('Naruto', 1)).toBe('Naruto');
  });
});

describe('stats and variables', () => {
  const base = { id: 'e', source: 'twitch' as const, timestamp: 0, userName: 'Ann' };

  it('tracks last and top values in the main currency', () => {
    let s = emptyStats();
    s = applyEventToStats(s, { ...base, type: 'follow' }, 'RUB')!;
    s = applyEventToStats(s, { ...base, userName: 'Bob', type: 'donation', amount: 500, currency: 'RUB', message: '' }, 'RUB')!;
    s = applyEventToStats(s, { ...base, userName: 'Cid', type: 'donation', amount: 10, currency: 'USD', message: '' }, 'RUB')!;
    s = applyEventToStats(s, { ...base, userName: 'Dan', type: 'donation', amount: 20, currency: 'USD', amountMain: 1800, message: '' }, 'RUB')!;
    expect(s.lastFollower).toBe('Ann');
    expect(s.follows).toBe(1);
    expect(s.lastDonation).toEqual({ name: 'Dan', amount: 20, currency: 'USD' });
    expect(s.topDonation).toEqual({ name: 'Dan', amount: 1800, currency: 'RUB' });
    expect(s.donations).toBe(2300);
    expect(applyEventToStats(s, { ...base, type: 'redemption', rewardTitle: 'x', cost: 1, input: '' }, 'RUB')).toBeNull();
  });

  it('resolves stream, stats and Kawaki variables', () => {
    const settings = defaultSettings('en');
    settings.stats = { ...emptyStats(), lastFollower: 'Ann', topDonation: { name: 'Bob', amount: 5, currency: 'USD' } };
    const { state } = makeCtx();
    const st: RuntimeState = {
      ...state.current,
      kawaki: {
        ...state.current.kawaki,
        nowWatching: { animeId: 'a', externalId: 7, title: 'Frieren', titleEn: null, posterUrl: null, episode: 12, episodesTotal: 28, progressSec: null, durationSec: null, url: 'https://kawaki.ru/anime/7', source: 'live' },
      },
    };
    const r = (n: string) => resolveStreamVar(n, undefined, settings, st);
    expect(r('lastfollower')).toBe('Ann');
    expect(r('topdonation')).toBe('5 USD');
    expect(r('lastsub')).toBe('—');
    expect(r('anime')).toBe('Frieren');
    expect(r('episode')).toBe(12);
    expect(r('animeurl')).toBe('https://kawaki.ru/anime/7');
    expect(r('kawaki')).toBe('https://kawaki.ru');
    expect(r('nope')).toBeUndefined();
  });
});

describe('banners', () => {
  it('shows manual, scheduled and pop-up banners correctly', () => {
    const b = { ...defaultBanner('en'), visible: true, scheduleEveryMin: 0 };
    expect(bannerShown(b, undefined, 1000)).toBe(true);
    expect(bannerShown({ ...b, visible: false }, undefined, 1000)).toBe(false);
    expect(bannerShown({ ...b, scheduleEveryMin: 10 }, undefined, 1000)).toBe(false);
    expect(bannerShown({ ...b, scheduleEveryMin: 10 }, 2000, 1000)).toBe(true);
    expect(bannerShown({ ...b, visible: false }, 2000, 1000)).toBe(true);
  });
});

describe('emotes', () => {
  it('takes emote urls from fragments, capped', () => {
    const m = msg('Kappa Kappa hi');
    m.fragments = [
      { type: 'emote', text: 'Kappa', url: 'k1' },
      { type: 'text', text: ' ' },
      { type: 'emote', text: 'Kappa', url: 'k2' },
      { type: 'text', text: ' hi' },
    ];
    expect(emoteUrls(m, 1)).toEqual(['k1']);
    expect(emoteUrls(m, 5)).toEqual(['k1', 'k2']);
  });
});

describe('settings migration', () => {
  it('adds new built-in commands to old settings files', () => {
    const old = defaultSettings('ru');
    old.bot.builtins = defaultBuiltins('ru').filter((b) => b.id !== 'anime');
    const merged = migrateSettings(mergeDefaults(defaultSettings('ru'), JSON.parse(JSON.stringify(old))));
    expect(merged.bot.builtins.map((b) => b.id)).toContain('anime');
    expect(merged.wheels.length).toBeGreaterThan(0);
  });
});
