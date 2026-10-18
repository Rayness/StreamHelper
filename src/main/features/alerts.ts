import { renderAlert } from '@shared/alerts';
export { renderAlert, mediaUrl, sampleEvent } from '@shared/alerts';
import type { RenderedAlert, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';
import { buildSceneDocument, normalizeEventScene, normalizeSceneEvent, selectEventScene, type EventScene, type SceneEventData } from '@shared/eventStudio';

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
  private giftBatches = new Map<string, { event: Extract<StreamEvent, { type: 'giftsub' }>; timer: NodeJS.Timeout }>();
  private seenGifts = new Set<string>();

  constructor(
    private ctx: AppContext,
    private show: (alert: RenderedAlert) => void,
    private skipShown: () => void,
  ) {
    let activeProfile = ctx.settings.get('activeProfileId');
    ctx.bus.on('event', (e) => {
      this.history.unshift(e);
      if (this.history.length > 200) this.history.pop();
      this.enqueueEvent(e);
    });
    ctx.bus.on('settings:changed', () => {
      const nextProfile = ctx.settings.get('activeProfileId');
      if (nextProfile === activeProfile) return;
      activeProfile = nextProfile;
      for (const batch of this.giftBatches.values()) clearTimeout(batch.timer);
      this.giftBatches.clear();
      this.queue = this.queue.filter((alert) => !alert.scene);
      if (this.current?.scene) this.skip();
      this.sync();
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
    for (const batch of this.giftBatches.values()) clearTimeout(batch.timer);
    this.giftBatches.clear();
  }

  enqueueEvent(e: StreamEvent): void {
    const studio = this.ctx.settings.get('alerts').studio;
    if (e.type === 'giftsub' && studio && studio.giftMergeWindowSec > 0 && selectEventScene(studio, e, 0)) {
      if (this.seenGifts.has(e.id)) return;
      this.seenGifts.add(e.id);
      if (this.seenGifts.size > 1000) this.seenGifts.delete(this.seenGifts.values().next().value!);
      // Anonymous gift events must never combine unrelated donors.
      const key = e.anonymous ? e.id : `${e.source}:${(e.userLogin || e.userName).toLowerCase()}:${e.tier}`;
      const existing = this.giftBatches.get(key);
      if (existing) { existing.event = { ...existing.event, count: Math.min(100_000, existing.event.count + e.count), total: Math.max(existing.event.total ?? 0, e.total ?? 0) || undefined }; return; }
      const batch = { event: { ...e }, timer: setTimeout(() => {
        this.giftBatches.delete(key);
        this.enqueueRenderedEvent(batch.event);
      }, Math.min(5, Math.max(0, studio.giftMergeWindowSec)) * 1000) };
      this.giftBatches.set(key, batch);
      return;
    }
    this.enqueueRenderedEvent(e);
  }

  private enqueueRenderedEvent(e: StreamEvent): void {
    const alert = renderAlert(e, this.ctx.settings.get('alerts'), this.ctx.settings.get('currency'), this.ctx.state.current.overlayUrl);
    if (!alert) return;
    this.enqueueAlert(alert);
  }

  /** Studio tests never emit a donation/raid event or mutate counters and statistics. */
  enqueueScene(value: EventScene, sample?: SceneEventData): void {
    const document = normalizeEventScene(value);
    const event = normalizeSceneEvent(sample, document);
    const scene = { document, event };
    this.enqueueAlert({ id: event.id, type: event.type, title: document.name, message: event.message, userName: event.user,
      durationSec: document.durationSec, sound: null, volume: document.volume, image: null, animation: 'fade', tts: false,
      style: this.ctx.settings.get('alerts').style, scene, sceneHtml: buildSceneDocument(document, event, { mediaBaseUrl: this.ctx.state.current.overlayUrl }) });
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
