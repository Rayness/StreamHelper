import { describe, expect, it } from 'vitest';
import { defaultSettings, mergeDefaults } from '@shared/defaults';
import { eventAmount, eventVars } from '@shared/events';
import { formatClock, formatDuration, renderTemplate, renderTemplateAsync } from '@shared/template';
import { timerAdd, timerPause, timerReset, timerStart, timerValue } from '@shared/timer';
import type { OverlayTimer, StreamEvent } from '@shared/types';

describe('renderTemplate', () => {
  it('substitutes variables and keeps unknown ones visible', () => {
    expect(renderTemplate('{user} donated {amount} {currency}', { user: 'Bob', amount: 5, currency: 'USD' })).toBe('Bob donated 5 USD');
    expect(renderTemplate('hi {nope}', { user: 'x' })).toBe('hi {nope}');
  });

  it('passes arguments to resolvers', () => {
    expect(renderTemplate('{count:deaths}/{count+:wins}', (n, a) => `${n}=${a}`)).toBe('count=deaths/count+=wins');
  });

  it('async variant resolves in order', async () => {
    let n = 0;
    expect(await renderTemplateAsync('{a} {a} {b}', async (name) => (name === 'a' ? ++n : undefined))).toBe('1 2 {b}');
  });
});

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0мин');
    expect(formatDuration(90 * 60_000, 'en')).toBe('1h 30m');
    expect(formatDuration((26 * 60 + 5) * 60_000, 'ru')).toBe('1д 2ч 5мин');
  });
  it('formats clocks', () => {
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('00:00');
  });
});

describe('mergeDefaults', () => {
  it('fills new keys but keeps user values, including null-default fields', () => {
    const defaults = defaultSettings('ru');
    const stored = JSON.parse(JSON.stringify(defaults));
    delete stored.currency;
    stored.overlayPort = 5000;
    stored.alerts.types.follow.sound = 'ding.mp3';
    delete stored.alerts.types.follow.tts;
    const merged = mergeDefaults(defaults, stored);
    expect(merged.currency).toBe('RUB');
    expect(merged.overlayPort).toBe(5000);
    expect(merged.alerts.types.follow.sound).toBe('ding.mp3');
    expect(merged.alerts.types.follow.tts).toBe(false);
  });

  it('replaces values of the wrong type', () => {
    const merged = mergeDefaults({ a: 1, b: [1] }, { a: 'x', b: 'y' });
    expect(merged).toEqual({ a: 1, b: [1] });
  });
});

describe('event vars', () => {
  const base = { id: '1', source: 'twitch' as const, timestamp: 0, userName: 'Ann' };
  it('exposes amount for thresholds', () => {
    const donation: StreamEvent = { ...base, type: 'donation', amount: 100, currency: 'RUB', amountMain: 1.1, message: 'hi' };
    expect(eventAmount(donation)).toBe(1.1);
    expect(eventVars(donation)).toMatchObject({ user: 'Ann', amount: '100', currency: 'RUB', message: 'hi' });
    expect(eventVars({ ...base, type: 'donation', amount: 2.5, currency: 'USD', message: '' }).amount).toBe('2.50');
  });
  it('maps resub months and gift counts', () => {
    expect(eventVars({ ...base, type: 'resub', tier: '2000', months: 7, message: 'yo' })).toMatchObject({ months: 7, tier: '2' });
    expect(eventAmount({ ...base, type: 'giftsub', tier: '1000', count: 10, anonymous: false })).toBe(10);
  });
});

describe('overlay timer math', () => {
  const t0: OverlayTimer = {
    id: 't',
    title: '',
    mode: 'countdown',
    durationSec: 60,
    running: false,
    anchorAt: null,
    pausedMs: 60_000,
    addSec: { sub: 0, giftsubPerSub: 0, bitsPer100: 0, donationPerUnit: 0, follow: 0 },
    fontFamily: '',
    fontSize: 10,
    textColor: '',
  };

  it('counts down, pauses and resumes', () => {
    let t = timerStart(t0, 1000);
    expect(timerValue(t, 11_000)).toBe(50_000);
    t = timerPause(t, 11_000);
    expect(timerValue(t, 99_000)).toBe(50_000);
    t = timerStart(t, 100_000);
    expect(timerValue(t, 110_000)).toBe(40_000);
    expect(timerValue(t, 999_999)).toBe(0);
  });

  it('adds time while running, even after it expired', () => {
    let t = timerStart(t0, 0);
    t = timerAdd(t, 30, 10_000);
    expect(timerValue(t, 10_000)).toBe(80_000);
    t = timerAdd(t, 10, 200_000); // already at zero -> restarts from now
    expect(timerValue(t, 200_000)).toBe(10_000);
  });

  it('stopwatch counts up and reset restores duration', () => {
    const sw = timerStart({ ...t0, mode: 'stopwatch', pausedMs: 0 }, 0);
    expect(timerValue(sw, 5000)).toBe(5000);
    expect(timerValue(timerAdd(sw, 10, 5000), 5000)).toBe(15_000);
    expect(timerReset(timerStart(t0, 0)).pausedMs).toBe(60_000);
  });
});
