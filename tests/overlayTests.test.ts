import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { OverlayTests } from '../src/main/features/overlayTests';
import { AlertQueue } from '../src/main/features/alerts';
import { EmoteRain } from '../src/main/features/emotes';

const queues: AlertQueue[] = [];
afterEach(() => queues.splice(0).forEach((queue) => queue.dispose()));
function setup() {
  const settings = defaultSettings('ru');
  const bus = new EventBus();
  const ctx = {bus,settings:{get:(key:keyof typeof settings) => settings[key]},state:new StateHub(bus)} as unknown as AppContext;
  const show = vi.fn(), broadcast = vi.fn(), display = vi.fn(), realEvent = vi.fn();
  const queue = new AlertQueue(ctx,show,vi.fn()); queues.push(queue);
  new EmoteRain(ctx,{broadcast} as any);
  bus.on('event',realEvent);
  return {settings,bus,ctx,show,broadcast,display,realEvent,tests:new OverlayTests(ctx,queue,broadcast,display)};
}

describe('isolated overlay tests with emote rain active', () => {
  it.each(['follow','sub','donation','raid','cheer','redemption'] as const)('tests %s only in alerts without running real-event listeners', (type) => {
    const f = setup(); f.settings.alerts.types[type].enabled=false;
    f.tests.alert(type);
    expect(f.show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({type}));
    expect(f.realEvent).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.display).not.toHaveBeenCalled();
    expect(f.settings.alerts.types[type].enabled).toBe(false);
  });
  it.each([['events','donation','event'],['rewards','redemption','reward'],['collab','raid','collabRaid']] as const)('tests %s only in its own overlay', (kind,type,message) => {
    const f=setup(); f.tests.widget(kind,type);
    expect(f.broadcast).toHaveBeenCalledExactlyOnceWith(kind,expect.objectContaining({type:message}));
    expect(f.show).not.toHaveBeenCalled();
    expect(f.realEvent).not.toHaveBeenCalled();
    expect(f.display.mock.calls.length).toBe(kind==='events'?1:0);
  });
  it('tests the exact selected donation level, including disabled levels and identical thresholds', () => {
    const f=setup();
    f.settings.alerts.donationTiers=[
      {id:'first',minAmount:100,variant:{...f.settings.alerts.types.donation,title:'first'}},
      {id:'second',minAmount:100,variant:{...f.settings.alerts.types.donation,title:'second',enabled:false},style:{...f.settings.alerts.style,fontSize:90}},
    ];
    f.tests.alert('donation',100,'second');
    expect(f.show).toHaveBeenCalledWith(expect.objectContaining({title:'second',style:expect.objectContaining({fontSize:90})}));
    expect(f.realEvent).not.toHaveBeenCalled();
  });
  it('tests the base donation template even if a matching level exists', () => {
    const f=setup(); f.settings.alerts.donationTiers=[{id:'tier',minAmount:1,variant:{...f.settings.alerts.types.donation,title:'level'}}];
    f.tests.alert('donation');
    expect(f.show.mock.calls[0][0].title).not.toBe('level');
  });
  it('continues to burst emotes for a real subscription', () => {
    const f=setup(); f.bus.emit('event',{id:'live',source:'twitch',timestamp:Date.now(),userName:'Ann',type:'sub',tier:'1000',isPrime:false});
    expect(f.broadcast).toHaveBeenCalledWith('emotes',expect.objectContaining({type:'emotes',burst:true}));
    expect(f.show).toHaveBeenCalledTimes(1);
  });
});
