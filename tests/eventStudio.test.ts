import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSceneDocument, defaultEventStudio, newEventScene, normalizeEventScene, normalizeEventStudio, sceneEventData, scenePresets } from '@shared/eventStudio';
import { renderAlert, sampleEvent } from '@shared/alerts';
import { defaultAlerts, defaultSettings } from '@shared/defaults';
import type { StreamEvent } from '@shared/types';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import type { AppContext } from '../src/main/core/context';
import { AlertQueue } from '../src/main/features/alerts';

const queues: AlertQueue[] = [];
afterEach(() => { for (const queue of queues.splice(0)) queue.dispose(); vi.useRealTimers(); });

describe('event scenes and routing', () => {
  it('keeps standard alerts until explicitly enabled and published', () => {
    const settings = defaultAlerts('en');
    const scene = newEventScene();
    settings.studio = { ...defaultEventStudio(), enabled: true, scenes: [scene], bindings: { donation: scene.id } };
    const event = sampleEvent('donation', 'en', 'USD');
    expect(renderAlert(event, settings)?.scene).toBeUndefined();
    scene.published = true;
    expect(renderAlert(event, settings)?.scene?.document.id).toBe(scene.id);
    settings.studio.enabled = false;
    expect(renderAlert(event, settings)?.scene).toBeUndefined();
    settings.studio.enabled = true;
    settings.types.donation.enabled = false;
    expect(renderAlert(event, settings)).toBeNull();
  });

  it('selects the highest matching donation threshold in the configured currency', () => {
    const settings = defaultAlerts('en');
    const base = { ...newEventScene(), id: 'base', published: true };
    const epic = { ...base, id: 'epic', durationSec: 17 };
    settings.studio = { ...defaultEventStudio(), enabled: true, scenes: [base, epic], bindings: { donation: base.id }, donationLevels: [{ id: 'large', name: '', minAmount: 1000, sceneId: epic.id }] };
    const event = { ...sampleEvent('donation', 'en', 'USD', 10), amountMain: 1000, amountMainCurrency: 'RUB' } as StreamEvent;
    expect(renderAlert(event, settings, 'RUB')).toMatchObject({ durationSec: 17, scene: { document: { id: 'epic' }, event: { amount: 10, currency: 'USD' } } });
    expect(renderAlert(event, settings, 'EUR')?.scene?.document.id).toBe('base');
    expect(renderAlert(sampleEvent('donation', 'en', 'RUB', 999), settings, 'RUB')?.scene?.document.id).toBe('base');
  });

  it('ignores missing, unpublished and incompatible level scenes', () => {
    const settings = defaultAlerts('en');
    const base = { ...newEventScene(), id: 'base', published: true };
    const raid = { ...newEventScene('raid'), id: 'raid', published: true };
    settings.studio = { ...defaultEventStudio(), enabled: true, scenes: [base, raid], bindings: { donation: base.id }, donationLevels: [{ id: 'bad', name: '', minAmount: 1, sceneId: raid.id }] };
    expect(renderAlert(sampleEvent('donation', 'en', 'RUB'), settings, 'RUB')?.scene?.document.id).toBe('base');
  });

  it('normalizes scene parameters and rejects code and object injection limits', () => {
    const scene = newEventScene();
    expect(() => normalizeEventScene({ ...scene, html: 'x'.repeat(200001) })).toThrow();
    expect(() => normalizeEventScene({ ...scene, parameters: { object: {} } })).toThrow();
    expect(() => normalizeEventScene({ ...scene, parameters: JSON.parse('{"__proto__":"bad"}') })).toThrow();
    expect(normalizeEventScene({ ...scene, durationSec: Infinity, width: -1 })).toMatchObject({ durationSec: 10, width: 320 });
    const studio = normalizeEventStudio({ enabled: true, scenes: [null, scene, scene], donationLevels: [{ id: 'bad', minAmount: NaN }] });
    expect(studio.scenes).toHaveLength(1);
    expect(studio.donationLevels).toEqual([]);
  });

  it('passes gift counts, resub months and raid viewers to scripts', () => {
    expect(sceneEventData(sampleEvent('giftsub', 'ru', 'RUB'))).toMatchObject({ count: 5, type: 'giftsub' });
    expect(sceneEventData(sampleEvent('raid', 'ru', 'RUB'))).toMatchObject({ viewers: 42, type: 'raid' });
    expect(sceneEventData(sampleEvent('resub', 'ru', 'RUB'))).toMatchObject({ months: 12, tier: '1000' });
  });

  it('embeds viewer text as escaped data and uses a restrictive sandbox document', () => {
    const scene = newEventScene();
    const event = { ...sceneEventData(sampleEvent('donation', 'en', 'USD')), user: '</script><script>window.hacked=1</script>', message: '<img src=x onerror=alert(1)>' };
    const document = buildSceneDocument(scene, event, { preview: true, mediaBaseUrl: 'http://localhost:1234', playbackId: 'proof' });
    expect(document).not.toContain(event.user);
    expect(document.match(/<\/script>/g)).toHaveLength(1);
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain('http://localhost:1234/media/');
    expect(document).not.toContain('allow-same-origin');
    const script = document.match(/<script>([\s\S]*)<\/script>/)![1];
    expect(() => new Script(script)).not.toThrow();
  });

  it('ships valid localized presets with capped gift and raid effects', () => {
    for (const lang of ['ru', 'en'] as const) {
      const presets = scenePresets(lang);
      expect(presets).toHaveLength(4);
      for (const preset of presets) {
        expect(normalizeEventScene(preset).published).toBe(false);
        expect(() => new Script(preset.js)).not.toThrow();
      }
      expect(presets.find((p) => p.eventType === 'giftsub')?.js).toContain('Math.min(48');
      expect(presets.find((p) => p.eventType === 'raid')?.js).toContain('Math.min(70');
    }
  });
});

function setupQueue() {
  vi.useFakeTimers();
  const settings = defaultSettings('en');
  const bus = new EventBus();
  const state = new StateHub(bus);
  const scene = { ...newEventScene('giftsub'), id: 'gifts', published: true };
  settings.alerts.studio = { ...defaultEventStudio(), enabled: true, scenes: [scene], bindings: { giftsub: scene.id }, giftMergeWindowSec: 1 };
  const ctx = { bus, settings: { get: (key: keyof typeof settings) => settings[key] }, state } as unknown as AppContext;
  const show = vi.fn();
  const queue = new AlertQueue(ctx, show, vi.fn());
  queues.push(queue);
  const gift = (id: string, user: string, count: number): StreamEvent => ({ id, source: 'twitch', timestamp: Date.now(), userName: user, type: 'giftsub', tier: '1000', count, anonymous: false });
  return { queue, show, bus, settings, state, gift };
}

describe('scene queue integration', () => {
  it('combines a donor gift burst once and keeps different donors separate', () => {
    const f = setupQueue();
    f.queue.enqueueEvent(f.gift('a', 'Anna', 5));
    f.queue.enqueueEvent(f.gift('a', 'Anna', 5));
    f.queue.enqueueEvent(f.gift('b', 'Anna', 2));
    f.queue.enqueueEvent(f.gift('c', 'Boris', 3));
    expect(f.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(f.show).toHaveBeenCalledOnce();
    expect(f.show.mock.calls[0][0].scene.event.count).toBe(7);
    expect(f.state.current.alerts.queueLength).toBe(1);
    f.queue.skip(); vi.advanceTimersByTime(600);
    expect(f.show.mock.calls[1][0].scene.event.count).toBe(3);
  });

  it('does not combine unrelated anonymous gifts or replay them into real event consumers', () => {
    const f = setupQueue();
    const listener = vi.fn(); f.bus.on('event', listener);
    f.queue.enqueueEvent({ ...f.gift('a', 'Anonymous', 5), type: 'giftsub', tier: '1000', count: 5, anonymous: true });
    f.queue.enqueueEvent({ ...f.gift('b', 'Anonymous', 2), type: 'giftsub', tier: '1000', count: 2, anonymous: true });
    vi.advanceTimersByTime(1000);
    expect(f.show.mock.calls[0][0].scene.event.count).toBe(5);
    expect(f.state.current.alerts.queueLength).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('cancels pending gifts on profile changes and disposal', () => {
    const f = setupQueue();
    f.queue.enqueueEvent(f.gift('a', 'Anna', 5));
    f.settings.activeProfileId = 'new-profile';
    f.bus.emit('settings:changed', 'activeProfileId');
    vi.advanceTimersByTime(1000);
    expect(f.show).not.toHaveBeenCalled();
    f.queue.enqueueEvent(f.gift('b', 'Anna', 5));
    f.queue.dispose(); vi.advanceTimersByTime(1000);
    expect(f.show).not.toHaveBeenCalled();
  });

  it('runs an explicitly tested draft without emitting a financial event', () => {
    const f = setupQueue();
    const listener = vi.fn(); f.bus.on('event', listener);
    f.queue.enqueueScene(newEventScene('raid'));
    expect(f.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'raid', scene: expect.any(Object) }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('scene profile persistence', () => {
  it('cancels pending gift scenes when the real store creates a new active profile', () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'streamhelper-scene-profile-'));
    const bus = new EventBus();
    const settings = new SettingsStore(join(dir, 'settings.json'), bus, 'en');
    try {
      const scene = { ...newEventScene('giftsub'), published: true };
      settings.set('alerts', { ...settings.get('alerts'), studio: { ...defaultEventStudio(), enabled: true, scenes: [scene], bindings: { giftsub: scene.id } } });
      const show = vi.fn();
      const queue = new AlertQueue({ bus, settings, state: new StateHub(bus) } as AppContext, show, vi.fn());
      queues.push(queue);
      queue.enqueueEvent(sampleEvent('giftsub', 'en', 'USD'));
      settings.createProfile('Fresh', 'empty');
      vi.advanceTimersByTime(2000);
      expect(show).not.toHaveBeenCalled();
    } finally { settings.flush(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('round trips scenes independently across profiles and migrates older invalid records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamhelper-scenes-'));
    const file = join(dir, 'settings.json');
    let store: SettingsStore | undefined;
    try {
      store = new SettingsStore(file, new EventBus(), 'en');
      const first = store.get('activeProfileId');
      const scene = newEventScene('raid');
      store.set('alerts', { ...store.get('alerts'), studio: { ...defaultEventStudio(), scenes: [scene] } });
      store.createProfile('Empty', 'empty');
      expect(store.get('alerts').studio?.scenes).toEqual([]);
      store.activateProfile(first);
      expect(store.get('alerts').studio?.scenes[0].id).toBe(scene.id);
      store.flush();
      const saved = store.all;
      writeFileSync(file, JSON.stringify({ ...saved, alerts: { ...saved.alerts, studio: { scenes: [null, scene] } } }));
      store = new SettingsStore(file, new EventBus(), 'en');
      expect(store.get('alerts').studio?.scenes).toHaveLength(1);
      expect(store.get('alerts').types.donation.enabled).toBe(true);
    } finally { store?.flush(); rmSync(dir, { recursive: true, force: true }); }
  });
});
