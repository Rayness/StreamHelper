import { renderTemplate } from '@shared/template';
import type { Banner, Label, OverlayMessage, RenderedBanner, Settings } from '@shared/types';
import type { AppContext } from '../core/context';
import { mediaUrl } from './alerts';
import { resolveStreamVar } from './vars';

const TICK_MS = 2000;

export interface TextOverlayTarget {
  forEachClient(kind: 'banner' | 'label', fn: (id: string | null) => OverlayMessage | null): void;
}

/** Whether a banner is on screen right now: manual toggle, or inside its scheduled pop-up window. */
export function bannerShown(b: Banner, showUntil: number | undefined, now: number): boolean {
  if (showUntil !== undefined && showUntil > now) return true;
  if (!b.visible) return false;
  return b.scheduleEveryMin <= 0;
}

/**
 * Banners and labels are text overlays with live variables ({lastfollower}, {uptime}, {anime}...).
 * They are re-rendered on every relevant change and on a slow tick for clocks, and only sent when
 * the rendered text actually changed.
 */
export class TextOverlays {
  private timer: NodeJS.Timeout | null = null;
  private showUntil = new Map<string, number>();
  private nextShowAt = new Map<string, number>();
  private lastSent = new Map<string, string>();

  constructor(
    private ctx: AppContext,
    private target: () => TextOverlayTarget,
  ) {
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'banners' || key === 'labels' || key === 'stats' || key === 'bot' || key === 'language' || key === 'currency') this.update();
    });
    ctx.bus.on('stream:update', () => this.update());
    ctx.bus.on('kawaki:now', () => this.update());
  }

  start(): void {
    this.timer = setInterval(() => this.update(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private get s(): Settings {
    return this.ctx.settings.all;
  }

  private text(template: string): string {
    const s = this.s;
    const st = this.ctx.state.current;
    return renderTemplate(template, (name, arg) => resolveStreamVar(name, arg, s, st));
  }

  /** Pop a banner up for its show time now (the "Show now" button, or a hotkey). */
  showNow(id: string): void {
    const b = this.s.banners.find((x) => x.id === id);
    if (!b) return;
    this.showUntil.set(id, Date.now() + Math.max(3, b.scheduleShowSec) * 1000);
    this.update();
  }

  /** Hotkey / action: flip the manual toggle. */
  toggle(id: string): void {
    this.ctx.settings.update('banners', (list) => list.map((b) => (b.id === id ? { ...b, visible: !b.visible } : b)));
    this.showUntil.delete(id);
  }

  private runSchedule(now: number): void {
    for (const b of this.s.banners) {
      if (!b.visible || b.scheduleEveryMin <= 0) {
        this.nextShowAt.delete(b.id);
        continue;
      }
      const next = this.nextShowAt.get(b.id);
      if (next === undefined || next <= now) {
        // First pop-up right after it's switched on, then every N minutes.
        this.showUntil.set(b.id, now + Math.max(3, b.scheduleShowSec) * 1000);
        this.nextShowAt.set(b.id, now + b.scheduleEveryMin * 60_000);
      }
    }
  }

  renderBanner(id: string | null, now = Date.now()): RenderedBanner | null {
    const banners = this.s.banners;
    const b = (id ? banners.find((x) => x.id === id) : banners[0]) ?? null;
    if (!b) return null;
    return {
      ...b,
      slides: b.slides.filter((sl) => sl.text.trim() || sl.image).map((sl) => ({ id: sl.id, text: this.text(sl.text), image: mediaUrl(sl.image) })),
      shown: bannerShown(b, this.showUntil.get(b.id), now),
    };
  }

  renderLabel(id: string | null): (Label & { text: string }) | null {
    const labels = this.s.labels;
    const l = (id ? labels.find((x) => x.id === id) : labels[0]) ?? null;
    return l ? { ...l, text: this.text(l.template) } : null;
  }

  update(): void {
    const now = Date.now();
    this.runSchedule(now);
    const shown = this.s.banners.filter((b) => bannerShown(b, this.showUntil.get(b.id), now)).map((b) => b.id);
    const prevShown = this.ctx.state.current.bannersShown;
    if (shown.join() !== prevShown.join()) this.ctx.state.replace('bannersShown', shown);
    const t = this.target();
    // Several overlays can show the same banner: decide once per id per tick, then send to all of them.
    const tick = new Map<string, OverlayMessage | null>();
    const once = (key: string, make: () => OverlayMessage) => {
      if (!tick.has(key)) tick.set(key, this.changed(key, make()));
      return tick.get(key)!;
    };
    t.forEachClient('banner', (id) => once(`b:${id}`, () => ({ type: 'banner', banner: this.renderBanner(id, now) })));
    t.forEachClient('label', (id) => once(`l:${id}`, () => ({ type: 'label', label: this.renderLabel(id) })));
  }

  private changed(key: string, msg: OverlayMessage): OverlayMessage | null {
    const json = JSON.stringify(msg);
    if (this.lastSent.get(key) === json) return null;
    this.lastSent.set(key, json);
    return msg;
  }

  /** New overlay connected: it needs the current state even if nothing changed. */
  initial(kind: 'banner' | 'label', id: string | null): OverlayMessage {
    return kind === 'banner' ? { type: 'banner', banner: this.renderBanner(id) } : { type: 'label', label: this.renderLabel(id) };
  }
}
