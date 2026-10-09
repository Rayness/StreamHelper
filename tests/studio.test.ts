import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultBanner, defaultCustomOverlay, defaultSettings, migrateLists } from '@shared/defaults';
import { appendDonation, donationBoard, donationRecord } from '@shared/donations';
import { BUNDLED_FONTS } from '@shared/fonts';
import { ALL_OVERLAY_KINDS, PROFILE_KEYS } from '@shared/profiles';
import { applyVariant, variantDiff, withVariant } from '@shared/variants';
import { nextVariableValue, resolveStreamVar } from '@shared/vars';
import type { DonationRecord, OverlayMessage, Settings, StreamEvent } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { initialRuntimeState } from '../src/main/core/state';
import { registryFontNames, uniqueSorted } from '../src/main/core/systemFonts';
import { TextOverlays } from '../src/main/features/banners';
import { ProgressTracker } from '../src/main/features/progress';
import { containerName, isContainerName, overlayIdentity, parseOverlayUrl } from '../src/main/obs/obs';
import { OverlayServer } from '../src/main/overlay/server';

const donation = (id: string, userName: string, amount: number, currency = 'RUB', timestamp = Date.now()): Extract<StreamEvent, { type: 'donation' }> =>
  ({ id, type: 'donation', source: 'donationalerts', timestamp, userName, amount, currency, message: 'hi' });

const record = (id: string, name: string, amount: number, at: number, amountMain: number | null = amount): DonationRecord =>
  ({ id, name, amount, currency: 'RUB', amountMain, message: '', source: 'donationalerts', at });

describe('bundled fonts', () => {
  it('lists the same families in the app, the generated manifest and the overlay runtime', () => {
    const manifest = JSON.parse(readFileSync(resolve('resources/overlays/assets/fonts/fonts.json'), 'utf8')) as { family: string }[];
    expect(BUNDLED_FONTS.map((f) => f.family)).toEqual(manifest.map((f) => f.family));
    const common = readFileSync(resolve('resources/overlays/assets/common.js'), 'utf8');
    const runtime = JSON.parse(/const BUNDLED_FONTS = (\[.*?\]);/.exec(common)![1]) as string[];
    expect(runtime).toEqual(manifest.map((f) => f.family));
  });

  it('ships every font file fonts.css points at', () => {
    const css = readFileSync(resolve('resources/overlays/assets/fonts/fonts.css'), 'utf8');
    const files = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThanOrEqual(BUNDLED_FONTS.length * 2);
    for (const file of files) expect(() => readFileSync(resolve('resources/overlays/assets/fonts', file))).not.toThrow();
  });

  it('reads font families from the Windows registry listing', () => {
    const out = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      '    Arial (TrueType)    REG_SZ    arial.ttf',
      '    Segoe UI Semibold (TrueType)    REG_SZ    seguisb.ttf',
      '    Cambria & Cambria Math (TrueType)    REG_SZ    cambria.ttc',
      '',
    ].join('\r\n');
    expect(registryFontNames(out)).toEqual(['Arial', 'Segoe UI Semibold', 'Cambria', 'Cambria Math']);
    expect(uniqueSorted(['b', 'A', 'a', '@Hidden', ' '])).toEqual(['A', 'b']);
  });
});

describe('donation board', () => {
  it('logs real donations once, newest first, and skips test events', () => {
    const bus = new EventBus();
    let data: Settings = defaultSettings('ru');
    const ctx = { bus, settings: {
      get: (key: keyof Settings) => data[key],
      set: (key: keyof Settings, value: never) => { data = { ...data, [key]: value }; },
      update: (key: keyof Settings, fn: (value: never) => never) => { data = { ...data, [key]: fn(data[key] as never) }; },
    } } as unknown as AppContext;
    new ProgressTracker(ctx);
    bus.emit('event', donation('a', 'Kira', 100));
    bus.emit('event', donation('b', 'Max', 50));
    bus.emit('event', donation('a', 'Kira', 100));
    bus.emit('event', { ...donation('t', 'Test', 999), source: 'test' });
    expect(data.donationLog.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('builds latest, top (summed per donor), total and count for the session', () => {
    const since = 1000;
    let log: DonationRecord[] = [];
    for (const r of [record('old', 'Kira', 900, 10), record('1', 'Kira', 100, 2000), record('2', 'Max', 300, 3000), record('3', 'kira', 250, 4000), record('4', 'Usd', 5, 5000, null)]) log = appendDonation(log, r);
    const board = donationBoard(log, { period: 'session', count: 2 }, since, 'RUB');
    expect(board.latest.map((d) => d.id)).toEqual(['4', '3']);
    expect(board.top).toEqual([{ name: 'kira', amount: 350, count: 2 }, { name: 'Max', amount: 300, count: 1 }]);
    expect(board.total).toBe(650);
    expect(board.count).toBe(4);
    expect(donationBoard(log, { period: 'all', count: 1 }, since, 'RUB').top[0]).toEqual({ name: 'kira', amount: 1250, count: 3 });
  });

  it('only counts amounts in the main currency', () => {
    expect(donationRecord(donation('x', 'A', 10, 'USD'), 'RUB').amountMain).toBeNull();
    expect(donationRecord({ ...donation('y', 'B', 10, 'USD'), amountMain: 900, amountMainCurrency: 'RUB' }, 'RUB').amountMain).toBe(900);
  });

  it('feeds the donation variables', () => {
    const s = { ...defaultSettings('ru'), currency: 'RUB', stats: { ...defaultSettings('ru').stats, since: 0 }, donationLog: [record('2', 'Max', 300, 3), record('1', 'Kira', 100, 2)] };
    const st = initialRuntimeState();
    expect(resolveStreamVar('lastdonations', '1', s, st)).toBe('Max — 300 RUB');
    expect(resolveStreamVar('topdonors', undefined, s, st)).toBe('Max — 300 RUB, Kira — 100 RUB');
    expect(resolveStreamVar('donationcount', undefined, s, st)).toBe(2);
  });
});

describe('custom variables', () => {
  it('resolve by name and with {var:name}; built-ins win', () => {
    const s = { ...defaultSettings('en'), variables: [{ id: '1', name: 'Merch', value: 'shop.example', description: '' }, { id: '2', name: 'title', value: 'nope', description: '' }] };
    const st = initialRuntimeState();
    st.stream.title = 'Real title';
    expect(resolveStreamVar('merch', undefined, s, st)).toBe('shop.example');
    expect(resolveStreamVar('var', 'MERCH', s, st)).toBe('shop.example');
    expect(resolveStreamVar('title', undefined, s, st)).toBe('Real title');
    expect(resolveStreamVar('var', 'missing', s, st)).toBe('');
    expect(resolveStreamVar('missing', undefined, s, st)).toBeUndefined();
  });

  it('change numbers with +N / -N and replace anything else', () => {
    expect(nextVariableValue('5', '+1')).toBe('6');
    expect(nextVariableValue('', '-2')).toBe('-2');
    expect(nextVariableValue('1,5', '+0.25')).toBe('1.75');
    expect(nextVariableValue('abc', '+1')).toBe('+1');
    expect(nextVariableValue('5', 'ten')).toBe('ten');
  });
});

describe('per-scene variants', () => {
  it('store only the changed fields and apply them to style, config and alert messages', () => {
    const base = defaultSettings('en').chatOverlay;
    const overrides = variantDiff(base, { ...base, fontSize: 40, fontFamily: 'Rubik' });
    expect(overrides).toEqual({ fontSize: 40, fontFamily: 'Rubik' });
    expect(withVariant(base, overrides).fontSize).toBe(40);
    const variant = { id: 'v1', kind: 'chat' as const, scene: 'Game', overrides };
    const msg = applyVariant({ type: 'chatConfig', config: base }, variant) as Extract<OverlayMessage, { type: 'chatConfig' }>;
    expect(msg.config.fontFamily).toBe('Rubik');
    const poll = applyVariant({ type: 'poll', poll: null, style: defaultSettings('en').poll, now: 0, lang: 'en' }, { ...variant, kind: 'poll', overrides: { barColor: '#000000' } }) as Extract<OverlayMessage, { type: 'poll' }>;
    expect(poll.style.barColor).toBe('#000000');
    const chat: OverlayMessage = { type: 'chatClear' };
    expect(applyVariant(chat, variant)).toBe(chat);
  });

  it('are delivered only to browser sources opened with ?v=', async () => {
    const server = new OverlayServer({
      port: 0, mediaDir: resolve('resources'), overlaysDir: resolve('resources/overlays'),
      initialMessages: () => [{ type: 'emoteConfig', config: defaultSettings('en').emoteRain }],
      transform: (_kind, variant, msg) => (variant === 'big' && msg.type === 'emoteConfig' ? { ...msg, config: { ...msg.config, size: 200 } } : msg),
      onClientsChanged: () => undefined,
    });
    await server.start();
    try {
      const first = (query: string) => new Promise<{ config: { size: number } }>((ok, fail) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?kind=emotes${query}`);
        ws.on('message', (raw) => { ok(JSON.parse(raw.toString())); ws.close(); });
        ws.on('error', fail);
      });
      expect((await first('')).config.size).toBe(64);
      expect((await first('&v=big')).config.size).toBe(200);
    } finally {
      await server.stop();
    }
  });
});

describe('OBS StreamHelper group', () => {
  it('names a container per scene or one shared, and recognises it', () => {
    expect(containerName('perScene', 'Game')).toBe('StreamHelper · Game');
    expect(containerName('shared', 'Game')).toBe('StreamHelper');
    expect(containerName('none', 'Game')).toBeNull();
    expect(isContainerName('StreamHelper · BRB')).toBe(true);
    expect(isContainerName('StreamHelpers')).toBe(false);
  });

  it('tells per-scene sources apart by their variant', () => {
    expect(overlayIdentity('http://localhost:1/overlay/chat?v=a')).not.toBe(overlayIdentity('http://localhost:1/overlay/chat?v=b'));
    expect(parseOverlayUrl('http://127.0.0.1:4848/overlay/goal?id=g1&v=x')).toEqual({ kind: 'goal', id: 'g1', variant: 'x' });
    expect(parseOverlayUrl('https://example.com/overlay/goal')).toBeNull();
  });
});

describe('designer overlays and new settings', () => {
  it('render text with live variables, hide hidden elements and turn media into URLs', () => {
    const bus = new EventBus();
    const o = defaultCustomOverlay('en');
    o.elements = [
      { id: 't', name: 't', type: 'text', text: 'Hi {lastfollower} {merch}', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 100, visible: true, locked: false, fontFamily: 'Inter', fontSize: 20, fontWeight: 700, italic: false, uppercase: false, color: '#fff', align: 'left', valign: 'top', letterSpacing: 0, lineHeight: 1, strokeColor: '#000', strokeWidth: 0, shadow: false, autoFit: false },
      { id: 'i', name: 'i', type: 'image', media: 'logo.png', fit: 'contain', radius: 0, x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 100, visible: true, locked: false },
      { id: 'h', name: 'h', type: 'image', media: null, fit: 'contain', radius: 0, x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 100, visible: false, locked: false },
    ];
    const settings = { ...defaultSettings('en'), customOverlays: [o], variables: [{ id: 'v', name: 'merch', value: 'shop', description: '' }], stats: { ...defaultSettings('en').stats, lastFollower: 'Kira' } };
    const ctx = { bus, settings: { all: settings }, state: { current: initialRuntimeState() } } as unknown as AppContext;
    const text = new TextOverlays(ctx, () => ({ forEachClient: () => undefined }));
    const rendered = text.renderCustom(o.id)!;
    expect(rendered.elements.map((e) => e.id)).toEqual(['t', 'i']);
    expect((rendered.elements[0] as { text: string }).text).toBe('Hi Kira shop');
    expect((rendered.elements[1] as { media: string }).media).toBe('/media/logo.png');
    expect(text.renderCustom('missing')).toBeNull();
  });

  it('fills new list fields for old saves and keeps new overlays in every profile', () => {
    const old = { ...defaultBanner('en') } as Partial<ReturnType<typeof defaultBanner>>;
    delete old.tickerWidth;
    const migrated = migrateLists({ ...defaultSettings('en'), banners: [old as ReturnType<typeof defaultBanner>], customOverlays: [null as never, defaultCustomOverlay('en')] });
    expect(migrated.banners[0].tickerWidth).toBe(100);
    expect(migrated.customOverlays).toHaveLength(1);
    expect(migrated.ads[0].fontFamily).toBe('Montserrat');
    expect(ALL_OVERLAY_KINDS).toEqual(expect.arrayContaining(['donations', 'custom']));
    expect(PROFILE_KEYS).toEqual(expect.arrayContaining(['donationsOverlay', 'customOverlays', 'overlayVariants']));
    expect(PROFILE_KEYS).not.toContain('variables');
  });
});

