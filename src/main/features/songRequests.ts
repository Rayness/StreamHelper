import { randomBytes } from 'node:crypto';
import type { OverlayMessage, SongRequest, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';
import type { MusicService } from './music';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Accept only individual YouTube videos, never arbitrary viewer-supplied URLs in the OBS player. */
export function youtubeVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    let id = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
      const parts = url.pathname.split('/').filter(Boolean);
      id = parts[0] === 'watch' ? (url.searchParams.get('v') ?? '') : ['shorts', 'live', 'embed'].includes(parts[0]) ? (parts[1] ?? '') : '';
    }
    return VIDEO_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function youtubeUrlInText(text: string): string | null {
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    const url = raw.replace(/[),.!?;]+$/, '');
    if (youtubeVideoId(url)) return url;
  }
  return null;
}

/** Persistent queue for requests from channel points, donations and the streamer's own controls. */
export class SongRequestService {
  private current: SongRequest | null = null;
  private nonce: string | null = null;
  private resumeId: string | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private starting = false;

  constructor(
    private ctx: AppContext,
    private music: MusicService,
    private broadcast: (message: OverlayMessage) => void,
  ) {
    ctx.bus.on('event', (event) => this.onEvent(event));
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'songQueue') this.sync();
      if (key === 'songRequests') void this.onSettingsChanged();
    });
    this.sync();
  }

  get overlayMessage(): OverlayMessage {
    return { type: 'song', request: this.current, nonce: this.nonce, config: this.ctx.settings.get('songRequests'), queue: this.ctx.settings.get('songQueue'), lang: this.ctx.settings.get('language') };
  }

  setPlayerConnected(connected: boolean): void {
    if (this.ctx.state.current.songRequests.playerConnected === connected) return;
    this.ctx.state.patch('songRequests', { playerConnected: connected });
    if (connected) void this.maybeStart();
  }

  add(url: string, userName = 'Streamer', source: SongRequest['source'] = 'manual', id = randomBytes(10).toString('hex')): void {
    const videoId = youtubeVideoId(url);
    if (!videoId) throw new Error('Send a single YouTube video link');
    const queue = this.ctx.settings.get('songQueue');
    if (queue.length >= Math.max(1, this.ctx.settings.get('songRequests').maxQueue)) throw new Error('Song request queue is full');
    if (queue.some((item) => item.videoId === videoId)) throw new Error('This video is already in the queue');
    const request: SongRequest = { id, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, userName, source, requestedAt: Date.now() };
    this.ctx.settings.set('songQueue', [...queue, request]);
    void this.maybeStart();
  }

  async play(id?: string): Promise<void> {
    if (this.ctx.settings.get('songRequests').videoLayout === 'queue') throw new Error('Queue-only mode does not play YouTube videos');
    if (!this.ctx.state.current.songRequests.playerConnected) throw new Error('Add the Song Request browser source to OBS first');
    if (this.starting) return;
    this.starting = true;
    try {
      let queue = this.ctx.settings.get('songQueue');
      if (id) {
        const index = queue.findIndex((item) => item.id === id);
        if (index < 0) throw new Error('Song not found');
        queue = [queue[index], ...queue.filter((item) => item.id !== id)];
        this.ctx.settings.set('songQueue', queue);
      }
      if (!queue.length) return;
      if (!this.resumeId && this.ctx.settings.get('songRequests').pauseWindowsMusic) {
        this.resumeId = await this.music.pauseCurrent();
      }
      if (this.ctx.settings.get('songRequests').videoLayout === 'queue') {
        const id = this.resumeId;
        this.resumeId = null;
        if (id && this.ctx.settings.get('songRequests').resumeWindowsMusic) await this.music.resumeSource(id);
        return;
      }
      this.current = queue[0];
      this.nonce = randomBytes(20).toString('hex');
      this.ctx.state.patch('songRequests', { lastError: null });
      this.sync();
      this.broadcast(this.overlayMessage);
    } finally {
      this.starting = false;
    }
  }

  async skip(): Promise<void> {
    if (!this.current) return;
    this.ctx.settings.set('songQueue', this.ctx.settings.get('songQueue').filter((item) => item.id !== this.current?.id));
    this.current = null;
    this.nonce = null;
    this.sync();
    this.broadcast(this.overlayMessage);
    const next = this.ctx.settings.get('songQueue')[0];
    if (next && this.ctx.settings.get('songRequests').autoPlay && this.ctx.settings.get('songRequests').videoLayout !== 'queue' && this.ctx.state.current.songRequests.playerConnected) {
      await this.play();
    } else if (this.resumeId) {
      const id = this.resumeId;
      this.resumeId = null;
      if (this.ctx.settings.get('songRequests').resumeWindowsMusic) await this.music.resumeSource(id);
    }
  }

  remove(id: string): void {
    if (this.current?.id === id) {
      void this.skip();
      return;
    }
    this.ctx.settings.set('songQueue', this.ctx.settings.get('songQueue').filter((item) => item.id !== id));
  }

  async playerFinished(id: string, nonce: string, error = ''): Promise<boolean> {
    if (!this.current || id !== this.current.id || nonce !== this.nonce) return false;
    if (error) this.ctx.state.patch('songRequests', { lastError: error.slice(0, 200) });
    await this.skip();
    return true;
  }

  private sync(): void {
    this.ctx.state.patch('songRequests', {
      current: this.current,
      queue: this.ctx.settings.get('songQueue').filter((item) => item.id !== this.current?.id),
    });
  }

  private async maybeStart(): Promise<void> {
    if (this.current || this.starting || !this.ctx.settings.get('songRequests').autoPlay || this.ctx.settings.get('songRequests').videoLayout === 'queue' || !this.ctx.state.current.songRequests.playerConnected) return;
    if (this.ctx.settings.get('songQueue').length) {
      try { await this.play(); } catch (error) { this.ctx.state.patch('songRequests', { lastError: String(error) }); }
    }
  }

  private async onSettingsChanged(): Promise<void> {
    if (this.ctx.settings.get('songRequests').videoLayout === 'queue' && this.current) {
      this.current = null;
      this.nonce = null;
      this.sync();
      this.broadcast(this.overlayMessage);
      if (this.resumeId) {
        const id = this.resumeId;
        this.resumeId = null;
        if (this.ctx.settings.get('songRequests').resumeWindowsMusic) await this.music.resumeSource(id);
      }
    } else void this.maybeStart();
  }

  private onEvent(event: StreamEvent): void {
    const settings = this.ctx.settings.get('songRequests');
    if (!settings.enabled || event.source === 'test' || this.seen.has(event.id)) return;
    let text = '';
    let source: SongRequest['source'];
    if (event.type === 'redemption' && settings.rewardTitle.trim() && event.rewardTitle.trim().toLowerCase() === settings.rewardTitle.trim().toLowerCase()) {
      text = event.input;
      source = 'redemption';
    } else if (event.type === 'donation') {
      const amount = event.amountMain ?? (event.currency.toUpperCase() === this.ctx.settings.get('currency').toUpperCase() ? event.amount : 0);
      if (!Number.isFinite(amount) || amount < settings.minDonation) return;
      text = event.message;
      source = 'donation';
    } else return;
    this.seen.add(event.id);
    this.seenOrder.push(event.id);
    if (this.seenOrder.length > 500) this.seen.delete(this.seenOrder.shift()!);
    const url = youtubeUrlInText(text);
    if (!url) return;
    try { this.add(url, event.userName, source, event.id); }
    catch (error) { this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error) }); }
  }
}
