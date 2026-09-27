import type { OverlayMessage } from '@shared/types';
import type { AppContext } from '../core/context';
import type { StageDeps } from './stage';
import { mediaUrl } from './alerts';

/** Rotates graphic campaigns on the stream, with explicit manual control and optional schedules. */
export class AdsService {
  private timer: NodeJS.Timeout | null = null;
  private nextAt = new Map<string, number>();

  constructor(private ctx: AppContext, private deps: StageDeps) {
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'ads') {
        this.nextAt.clear();
      }
    });
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  overlayMessage(id?: string | null): OverlayMessage {
    const active = this.ctx.state.current.ad;
    const campaign = this.ctx.settings.get('ads').find((c) => c.id === (id ?? active.activeId));
    return { type: 'ad', campaign: campaign && campaign.media ? { ...campaign, media: mediaUrl(campaign.media) } : null, endsAt: id ? null : active.endsAt };
  }

  show(id: string): void {
    const campaign = this.ctx.settings.get('ads').find((c) => c.id === id);
    if (!campaign || !campaign.media) throw new Error('Choose an image or video for this campaign');
    const now = Date.now();
    this.ctx.state.replace('ad', { activeId: id, endsAt: now + Math.max(3, campaign.durationSec) * 1000 });
    if (campaign.everyMin > 0) this.nextAt.set(id, now + campaign.everyMin * 60_000);
    this.push();
  }

  hide(): void {
    const id = this.ctx.state.current.ad.activeId;
    if (id) {
      const campaign = this.ctx.settings.get('ads').find((c) => c.id === id);
      if (campaign?.everyMin) this.nextAt.set(id, Date.now() + campaign.everyMin * 60_000);
    }
    this.ctx.state.replace('ad', { activeId: null, endsAt: null });
    this.push();
  }

  tick(now = Date.now()): void {
    const active = this.ctx.state.current.ad;
    if (active.activeId) {
      const stillExists = this.ctx.settings.get('ads').some((c) => c.id === active.activeId && c.media);
      if (!stillExists || (active.endsAt !== null && active.endsAt <= now)) this.hide();
      return;
    }
    const campaigns = this.ctx.settings.get('ads');
    const known = new Set(campaigns.map((c) => c.id));
    for (const id of this.nextAt.keys()) if (!known.has(id)) this.nextAt.delete(id);
    for (const campaign of campaigns) {
      if (!campaign.enabled || !campaign.media || campaign.everyMin <= 0) {
        this.nextAt.delete(campaign.id);
        continue;
      }
      if (!this.nextAt.has(campaign.id)) this.nextAt.set(campaign.id, now + campaign.everyMin * 60_000);
      if (now < this.nextAt.get(campaign.id)!) continue;
      if (campaign.onlyWhenLive && !this.ctx.state.current.stream.live && !this.ctx.state.current.obs.streaming) continue;
      this.show(campaign.id);
      return;
    }
  }

  private push(): void {
    this.deps.broadcast('ad', this.overlayMessage());
  }
}
