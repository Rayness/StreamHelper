import { renderAlert } from '@shared/alerts';
export { renderAlert, mediaUrl, sampleEvent } from '@shared/alerts';
import type { RenderedAlert, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';

/**
 * One queue shared by every alert overlay, so two browser sources never show the same alert
 * out of sync and pause/skip work globally.
 */
export class AlertQueue {
  private queue: RenderedAlert[] = [];
  private current: RenderedAlert | null = null;
  private timer: NodeJS.Timeout | null = null;
  private history: StreamEvent[] = [];
  private displayUntil = 0;
  private gapTimer: NodeJS.Timeout | null = null;

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

  get activeAlert(): RenderedAlert | null {
    if (!this.current || this.displayUntil <= Date.now()) return null;
    return { ...this.current, durationSec: Math.max(.1, (this.displayUntil - Date.now()) / 1000) };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.timer = this.gapTimer = null;
  }

  enqueueEvent(e: StreamEvent): void {
    const alert = renderAlert(e, this.ctx.settings.get('alerts'), this.ctx.settings.get('currency'));
    if (!alert) return;
    this.enqueueAlert(alert);
  }

  enqueueAlert(alert: RenderedAlert): void {
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
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => { this.gapTimer = null; this.next(); }, 600);
  }

  private next(): void {
    if (this.current || this.gapTimer || this.ctx.state.current.alerts.paused) return;
    const alert = this.queue.shift();
    if (!alert) return;
    this.current = alert;
    this.displayUntil = Date.now() + alert.durationSec * 1000;
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
