import { describe, expect, it } from 'vitest';
import { defaultAlerts, defaultChatOverlay, defaultGoal, defaultTimer } from '@shared/defaults';
import type { ChatMessage, StreamEvent } from '@shared/types';
import { normalizeDonation } from '../src/main/donations/donationalerts';
import { normalizeStreamlabs } from '../src/main/donations/streamlabs';
import { renderAlert, sampleEvent } from '../src/main/features/alerts';
import { goalIncrement, subathonSeconds } from '../src/main/features/progress';
import { showInChatOverlay } from '../src/main/overlay/hub';
import { safeJoin } from '../src/main/overlay/server';

const base = { id: 'e', source: 'twitch' as const, timestamp: 0, userName: 'Ann' };

describe('renderAlert', () => {
  it('renders templates and media urls', () => {
    const s = defaultAlerts('en');
    s.types.donation.sound = 'coin drop.mp3';
    const a = renderAlert({ ...base, type: 'donation', amount: 5, currency: 'USD', message: 'gg' }, s)!;
    expect(a.title).toBe('Ann donated 5 USD');
    expect(a.message).toBe('gg');
    expect(a.sound).toBe('/media/coin%20drop.mp3');
    expect(a.image).toBeNull();
    expect(a.style).toMatchObject({ x: 50, y: 50, width: 90, anchor: 'center' });
  });

  it('respects enabled flag and minimum amount', () => {
    const s = defaultAlerts('en');
    s.types.cheer.minAmount = 100;
    expect(renderAlert({ ...base, type: 'cheer', bits: 50, message: '', anonymous: false }, s)).toBeNull();
    expect(renderAlert({ ...base, type: 'cheer', bits: 100, message: '', anonymous: false }, s)).not.toBeNull();
    s.types.follow.enabled = false;
    expect(renderAlert({ ...base, type: 'follow' }, s)).toBeNull();
  });

  it('has a sample for every alert type', () => {
    for (const t of Object.keys(defaultAlerts('ru').types) as StreamEvent['type'][]) {
      expect(sampleEvent(t, 'ru', 'RUB').type).toBe(t);
    }
  });
});

describe('goals and subathon', () => {
  it('increments matching goals only', () => {
    const g = { ...defaultGoal('en'), kind: 'subs' as const };
    expect(goalIncrement(g, { ...base, type: 'giftsub', tier: '1000', count: 5, anonymous: false })).toBe(5);
    expect(goalIncrement(g, { ...base, type: 'follow' })).toBe(0);
  });

  it('counts donations in the goal currency or converted amount', () => {
    const g = { ...defaultGoal('en'), kind: 'donations' as const, currency: 'RUB' };
    expect(goalIncrement(g, { ...base, type: 'donation', amount: 100, currency: 'RUB', message: '' })).toBe(100);
    expect(goalIncrement(g, { ...base, type: 'donation', amount: 5, currency: 'USD', message: '' })).toBe(0);
    expect(goalIncrement(g, { ...base, type: 'donation', amount: 5, currency: 'USD', amountMain: 450, message: '' })).toBe(450);
  });

  it('uses the highest matching donation tier', () => {
    const s = defaultAlerts('en');
    s.donationTiers = [
      { id: 'low', minAmount: 100, variant: { ...s.types.donation, title: 'Thanks {user}' } },
      { id: 'high', minAmount: 500, variant: { ...s.types.donation, title: 'Big thanks {user}' }, style: { ...s.style, accentColor: '#ff0000' } },
    ];
    const donation = { ...base, type: 'donation' as const, amount: 600, currency: 'USD', message: '' };
    expect(renderAlert(donation, s)?.title).toBe('Big thanks Ann');
    expect(renderAlert(donation, s)?.style.accentColor).toBe('#ff0000');
    expect(renderAlert({ ...donation, amount: 200 }, s)?.title).toBe('Thanks Ann');
    expect(renderAlert({ ...donation, amount: 20 }, s)?.title).toBe('Ann donated 20 USD');
    expect(renderAlert(donation, s, 'RUB')?.title).toBe('Ann donated 600 USD');
    expect(renderAlert({ ...donation, amountMain: 600 }, s, 'RUB')?.title).toBe('Big thanks Ann');
  });

  it('filters donation goals by source and amount, then caps one contribution', () => {
    const g = { ...defaultGoal('en'), kind: 'donations' as const, donationMinAmount: 100, donationMaxAmount: 500, donationSources: ['donationalerts' as const] };
    const donation = { ...base, source: 'donationalerts' as const, type: 'donation' as const, amount: 600, currency: 'RUB', message: '' };
    expect(goalIncrement(g, donation)).toBe(500);
    expect(goalIncrement(g, { ...donation, amount: 50 })).toBe(0);
    expect(goalIncrement(g, { ...donation, source: 'streamlabs' })).toBe(0);
  });

  it('computes subathon seconds', () => {
    const t = defaultTimer('en');
    t.addSec = { sub: 60, giftsubPerSub: 30, bitsPer100: 10, donationPerUnit: 1, follow: 0 };
    expect(subathonSeconds(t, { ...base, type: 'giftsub', tier: '1000', count: 3, anonymous: false }, 'RUB')).toBe(90);
    expect(subathonSeconds(t, { ...base, type: 'cheer', bits: 250, message: '', anonymous: false }, 'RUB')).toBe(25);
    expect(subathonSeconds(t, { ...base, type: 'donation', amount: 300, currency: 'RUB', message: '' }, 'RUB')).toBe(300);
    expect(subathonSeconds(t, { ...base, type: 'follow' }, 'RUB')).toBe(0);
  });
});

describe('donation providers', () => {
  it('parses DonationAlerts payloads', () => {
    const e = normalizeDonation(
      { id: 77, name: 'Donations', username: '', message: 'привет', message_type: 'text', amount: 150, currency: 'RUB', amount_in_user_currency: 150 },
      'Аноним',
    );
    expect(e).toMatchObject({ id: 'da_77', type: 'donation', userName: 'Аноним', amount: 150, currency: 'RUB', message: 'привет' });
    expect(normalizeDonation({ id: 1 }, 'x')).toBeNull();
  });

  it('parses Streamlabs socket events', () => {
    const events = normalizeStreamlabs(
      { type: 'donation', message: [{ _id: 'a1', name: 'Bob', amount: '4.20', currency: 'USD', message: 'nice' }] },
      'Anonymous',
    );
    expect(events).toEqual([expect.objectContaining({ id: 'sl_a1', userName: 'Bob', amount: 4.2, currency: 'USD' })]);
    expect(normalizeStreamlabs({ type: 'follow', message: [] }, 'x')).toEqual([]);
  });
});

describe('chat overlay filter', () => {
  const m = (text: string, login = 'viewer') => ({ text, userLogin: login }) as ChatMessage;
  it('hides commands and bots', () => {
    const cfg = defaultChatOverlay();
    expect(showInChatOverlay(m('hello'), cfg, '!')).toBe(true);
    expect(showInChatOverlay(m('!discord'), cfg, '!')).toBe(false);
    expect(showInChatOverlay(m('hi', 'Nightbot'), cfg, '!')).toBe(false);
    expect(showInChatOverlay(m('!discord'), { ...cfg, hideCommands: false }, '!')).toBe(true);
  });
});

describe('safeJoin', () => {
  it('blocks path traversal', () => {
    expect(safeJoin('/srv/media', 'a.png')).toMatch(/a\.png$/);
    expect(safeJoin('/srv/media', '../secrets.bin')).toBeNull();
    expect(safeJoin('/srv/media', '..%2Fsecrets.bin')).toBeNull();
    expect(safeJoin('/srv/media', '%E0%A4%A')).toBeNull();
  });
});
