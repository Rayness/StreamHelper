import { eventAmount, eventVars } from '@shared/events';
import { renderTemplate } from '@shared/template';
import type { AlertSettings, AlertType, RenderedAlert, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';

export function mediaUrl(name: string | null): string | null {
  return name ? `/media/${encodeURIComponent(name)}` : null;
}

/** Turn an event into what the alert overlay shows. Returns null if this alert is disabled or below threshold. */
export function renderAlert(e: StreamEvent, settings: AlertSettings): RenderedAlert | null {
  const v = settings.types[e.type];
  if (!v?.enabled) return null;
  if (v.minAmount > 0 && eventAmount(e) < v.minAmount) return null;
  const vars = eventVars(e);
  return {
    id: e.id,
    type: e.type,
    title: renderTemplate(v.title, vars),
    message: renderTemplate(v.message, vars),
    userName: e.userName,
    durationSec: v.durationSec,
    sound: mediaUrl(v.sound),
    volume: v.volume,
    image: mediaUrl(v.image),
    animation: v.animation,
    tts: v.tts,
    style: settings.style,
  };
}

/**
 * One queue shared by every alert overlay, so two browser sources never show the same alert
 * out of sync and pause/skip work globally.
 */
export class AlertQueue {
  private queue: RenderedAlert[] = [];
  private current: RenderedAlert | null = null;
  private timer: NodeJS.Timeout | null = null;
  private history: StreamEvent[] = [];

  constructor(
    private ctx: AppContext,
    private show: (alert: RenderedAlert) => void,
    private skipShown: () => void,
  ) {
    ctx.bus.on('event', (e) => {
      this.history.unshift(e);
      if (this.history.length > 200) this.history.pop();
      this.enqueueEvent(e);
    });
  }

  get recentEvents(): StreamEvent[] {
    return this.history;
  }

  enqueueEvent(e: StreamEvent): void {
    const alert = renderAlert(e, this.ctx.settings.get('alerts'));
    if (!alert) return;
    this.queue.push(alert);
    this.sync();
    this.next();
  }

  replay(eventId: string): void {
    const e = this.history.find((h) => h.id === eventId);
    if (e) this.enqueueEvent({ ...e, id: `${e.id}_r${Date.now().toString(36)}` });
  }

  setPaused(paused: boolean): void {
    this.ctx.state.patch('alerts', { paused });
    if (!paused) this.next();
  }

  togglePause(): void {
    this.setPaused(!this.ctx.state.current.alerts.paused);
  }

  skip(): void {
    if (!this.current) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.skipShown();
    this.sync();
    // Small gap so the overlay's exit animation can finish.
    setTimeout(() => this.next(), 400);
  }

  private next(): void {
    if (this.current || this.ctx.state.current.alerts.paused) return;
    const alert = this.queue.shift();
    if (!alert) return;
    this.current = alert;
    this.show(alert);
    this.sync();
    const gap = this.ctx.settings.get('alerts').gapSec;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.current = null;
        this.sync();
        this.next();
      },
      (alert.durationSec + Math.max(0, gap)) * 1000,
    );
  }

  private sync(): void {
    this.ctx.state.patch('alerts', { queueLength: this.queue.length, current: this.current?.title ?? null });
  }
}

let testSeq = 0;

/** A realistic sample event for the "Test" buttons. */
export function sampleEvent(type: AlertType, lang: 'ru' | 'en', currency: string): StreamEvent {
  const base = { id: `test_${Date.now().toString(36)}_${testSeq++}`, source: 'test' as const, timestamp: Date.now(), userName: 'StreamHelper' };
  const msg = lang === 'ru' ? 'Это тестовое сообщение. Отличный стрим!' : 'This is a test message. Great stream!';
  switch (type) {
    case 'follow':
      return { ...base, type };
    case 'sub':
      return { ...base, type, tier: '1000', isPrime: false };
    case 'resub':
      return { ...base, type, tier: '1000', months: 12, streak: 6, message: msg };
    case 'giftsub':
      return { ...base, type, tier: '1000', count: 5, anonymous: false };
    case 'cheer':
      return { ...base, type, bits: 500, message: msg, anonymous: false };
    case 'raid':
      return { ...base, type, viewers: 42 };
    case 'donation':
      return { ...base, type, amount: currency === 'RUB' ? 500 : 10, currency, message: msg };
    case 'redemption':
      return { ...base, type, rewardTitle: lang === 'ru' ? 'Выпить воды' : 'Hydrate', cost: 1000, input: '' };
  }
}
