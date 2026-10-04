import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { reconcile } from '@shared/reconcile';
import { normalizeWorkspaceCards } from '@shared/workspace';
import type { StreamEvent } from '@shared/types';
import { donationAmount } from '@shared/events';
import { goalIncrement, subathonSeconds } from '../src/main/features/progress';
import { renderAlert } from '@shared/alerts';
import { defaultSettings } from '@shared/defaults';
import { OverlayHub } from '../src/main/overlay/hub';
import type { AppContext } from '../src/main/core/context';

describe('stream authority and idle work', () => {
  it('takes one active alert snapshot when an overlay reconnects at the display deadline', () => {
    const settings = defaultSettings('en');
    const alert = renderAlert({ id:'reconnect', source:'test', timestamp:1, userName:'Ann', type:'follow' }, settings.alerts)!;
    const active = vi.fn().mockReturnValueOnce(alert).mockReturnValue(null);
    const ctx = { bus:new EventBus(), settings:{ all:settings } } as AppContext;
    const hub = new OverlayHub(ctx, {} as any, {} as any, { alerts:()=>({ get activeAlert() { return active(); } }) } as any);
    expect(hub.initialMessages('alerts',null)).toEqual([{ type:'profileVisibility',visible:true },{ type:'alert',alert }]);
    expect(active).toHaveBeenCalledTimes(1);
  });
  it('cannot apply a RUB conversion to a USD goal or another selected application currency', () => {
    const settings = defaultSettings('en');
    const event = { id: 'currency', timestamp: 1, source: 'donationalerts', userName: 'Ann', type: 'donation', amount: 5, currency: 'USD', amountMain: 450, amountMainCurrency: 'RUB', message: '' } as const;
    expect(donationAmount(event, 'USD')).toBe(5);
    expect(donationAmount(event, 'RUB')).toBe(450);
    expect(donationAmount(event, 'EUR')).toBeNull();
    expect(goalIncrement({ ...settings.goals[0], kind: 'donations', currency: 'USD' }, event)).toBe(5);
    expect(subathonSeconds({ ...settings.timers[0], addSec: { ...settings.timers[0].addSec, donationPerUnit: 1 } }, event, 'EUR')).toBe(0);
    settings.alerts.types.donation.minAmount = 100;
    expect(renderAlert(event, settings.alerts, 'USD')).toBeNull();
    expect(renderAlert(event, settings.alerts, 'RUB')).not.toBeNull();
  });
  it('blocks Twitch activity relayed through donation providers for every bus consumer', () => {
    const bus = new EventBus(); const consume = vi.fn(); bus.on('event', consume);
    const event = { id: 'e', timestamp: 1, userName: 'A', type: 'follow' };
    for (const source of ['donationalerts', 'streamlabs', 'streamelements']) bus.emit('event', { ...event, source } as StreamEvent);
    expect(consume).not.toHaveBeenCalled();
    bus.emit('event', { ...event, source: 'twitch' } as StreamEvent);
    bus.emit('event', { ...event, source: 'test' } as StreamEvent);
    bus.emit('event', { id: 'd', timestamp: 1, source: 'donationalerts', userName: 'A', type: 'donation', amount: 5, currency: 'RUB', message: '' });
    expect(consume).toHaveBeenCalledTimes(3);
  });

  it('does not push state when an unchanged primitive or object field is patched', () => {
    const bus = new EventBus(); const state = new StateHub(bus); const dirty = vi.fn(); bus.on('state:dirty', dirty);
    state.patch('overlayClients', 0); state.patch('alerts', { paused: false });
    expect(dirty).not.toHaveBeenCalled();
    state.patch('alerts', { paused: true }); expect(dirty).toHaveBeenCalledTimes(1);
  });

  it('preserves unchanged selector references after IPC cloning', () => {
    const previous = { alerts: { paused: false }, obs: { scenes: ['Game'], connected: false } };
    const next = reconcile(previous, { alerts: { paused: false }, obs: { scenes: ['Game'], connected: true } });
    expect(next.alerts).toBe(previous.alerts); expect(next.obs.scenes).toBe(previous.obs.scenes); expect(next.obs).not.toBe(previous.obs);
    expect(reconcile(previous, structuredClone(previous))).toBe(previous);
    expect(reconcile([1, 2], [1])).toEqual([1]);
  });

  it('keeps an intentionally empty workspace and drops invalid or duplicate cards', () => {
    expect(normalizeWorkspaceCards([])).toEqual([]);
    expect(normalizeWorkspaceCards(['chat', 'song', 'chat', 'wrong'])).toEqual(['chat', 'song']);
  });
});

describe('alert viewport placement', () => {
  const context: any = { window: {}, URLSearchParams, location: { search: '' } };
  runInNewContext(readFileSync(resolve('resources/overlays/assets/common.js'), 'utf8'), context);
  const bounds = context.window.SH.alertBounds;
  it.each(['center', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'])('keeps long content inside the viewport with %s anchor', (anchor) => {
    for (const width of [320, 1280, 1920]) for (const x of [0, 20, 50, 100]) for (const y of [0, 10, 50, 100]) {
      const height = width * 9 / 16;
      const result = bounds(width, height, width * .9, height * 2, { anchor, x, y, safeMargin: 24 });
      expect(result.left).toBeGreaterThanOrEqual(24 - .001);
      expect(result.top).toBeGreaterThanOrEqual(24 - .001);
      expect(result.left + width * .9 * result.scale).toBeLessThanOrEqual(width - 24 + .001);
      expect(result.top + height * 2 * result.scale).toBeLessThanOrEqual(height - 24 + .001);
    }
  });
});
