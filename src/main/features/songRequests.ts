import { randomBytes } from 'node:crypto';
import type { ChatMessage, OverlayMessage, SongRequest, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';
import type { MusicService } from './music';
import { hasPermission } from '../bot/permissions';
import { parseCommand } from '../bot/variables';
import { donationAmount } from '@shared/events';

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
  private autoBlocked = false;
  private generation = 0;
  private chatCooldowns = new Map<string, number>();

  constructor(
    private ctx: AppContext,
    private music: MusicService,
    private broadcast: (message: OverlayMessage) => void,
    private reply?: (text: string, replyTo?: string) => Promise<void>,
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
    if (!connected) {
      this.generation++;
      this.current = null;
      this.nonce = null;
      this.sync();
      void this.resumeMusic();
    }
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
    this.autoBlocked = false;
    const generation = this.generation;
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
      if (generation !== this.generation || !this.ctx.state.current.songRequests.playerConnected) {
        await this.resumeMusic();
        return;
      }
      if (this.ctx.settings.get('songRequests').videoLayout === 'queue') {
        await this.resumeMusic();
        return;
      }
      // The streamer can remove/reorder requests while the Windows player is pausing.
      queue = this.ctx.settings.get('songQueue');
      if (!queue.length) { await this.resumeMusic(); return; }
      this.current = queue[0];
      this.nonce = randomBytes(20).toString('hex');
      this.ctx.state.patch('songRequests', { lastError: null });
      this.sync();
      this.broadcast(this.overlayMessage);
    } finally {
      this.starting = false;
      if (generation !== this.generation) void this.maybeStart();
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
    if (error) {
      // A blocked embed/network failure must never consume a paid request or drain the queue.
      this.autoBlocked = true;
      this.ctx.state.patch('songRequests', { lastError: error.slice(0, 200) });
      this.current = null;
      this.nonce = null;
      this.sync();
      this.broadcast(this.overlayMessage);
      await this.resumeMusic();
      return true;
    }
    await this.skip();
    return true;
  }

  private sync(): void {
    this.ctx.state.patch('songRequests', {
      current: this.current,
      queue: this.ctx.settings.get('songQueue').filter((item) => item.id !== this.current?.id),
    });
  }

  private async resumeMusic(): Promise<void> {
    const id = this.resumeId;
    this.resumeId = null;
    if (id && this.ctx.settings.get('songRequests').resumeWindowsMusic) {
      try { await this.music.resumeSource(id); }
      catch (error) { this.ctx.state.patch('songRequests', { lastError: String(error) }); }
    }
  }

  async handleChat(message: ChatMessage): Promise<boolean> {
    const cfg = this.ctx.settings.get('songRequests');
    if (!cfg.enabled || !cfg.chatEnabled || message.fromSelf || message.platform !== 'twitch') return false;
    const parsed = parseCommand(message.text, this.ctx.settings.get('bot').prefix);
    const command = cfg.chatCommand.trim().replace(/^[!\/]+/, '').toLowerCase();
    if (!parsed || !command || ![command, ...(command === 'sr' ? ['songrequest'] : [])].includes(parsed.name)) return false;
    const ru = this.ctx.settings.get('language') === 'ru';
    let response: string;
    if (!hasPermission(message.roles, cfg.chatPermission)) response = ru ? 'У вас нет доступа к заказу музыки.' : 'You cannot request songs.';
    else if ((this.chatCooldowns.get(message.userId) ?? 0) > Date.now()) return true;
    else {
      try {
        const url = youtubeUrlInText(parsed.args.join(' '));
        if (!url) throw new Error(ru ? 'Укажите ссылку на одно видео YouTube.' : 'Provide a single YouTube video link.');
        this.add(url, message.userName, 'chat', `chat_${message.id}`);
        this.chatCooldowns.delete(message.userId);
        this.chatCooldowns.set(message.userId, Date.now() + Math.max(0, cfg.chatCooldownSec) * 1000);
        if (this.chatCooldowns.size > 1000) this.chatCooldowns.delete(this.chatCooldowns.keys().next().value!);
        response = ru ? `${message.userName}, трек добавлен в очередь.` : `${message.userName}, your song is queued.`;
      } catch (error) { response = String((error as Error).message ?? error); }
    }
    await this.reply?.(response, message.id);
    return true;
  }

  private async maybeStart(): Promise<void> {
    if (this.current || this.starting || this.autoBlocked || !this.ctx.settings.get('songRequests').autoPlay || this.ctx.settings.get('songRequests').videoLayout === 'queue' || !this.ctx.state.current.songRequests.playerConnected) return;
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
    if (event.type === 'redemption' && (settings.rewardId ? event.rewardId === settings.rewardId :
      settings.rewardTitle.trim() && event.rewardTitle.trim().toLowerCase() === settings.rewardTitle.trim().toLowerCase())) {
      text = event.input;
      source = 'redemption';
    } else if (event.type === 'donation') {
      const amount = donationAmount(event, this.ctx.settings.get('currency'));
      if (amount === null || !Number.isFinite(amount) || amount < settings.minDonation) return;
      text = event.message;
      source = 'donation';
    } else return;
    this.seen.add(event.id);
    this.seenOrder.push(event.id);
    if (this.seenOrder.length > 500) this.seen.delete(this.seenOrder.shift()!);
    const url = youtubeUrlInText(text);
    if (!url) {
      if (source === 'redemption') this.ctx.state.patch('songRequests', { lastError: this.ctx.settings.get('language') === 'ru' ? 'Заказ не содержит ссылки YouTube. Включите обязательный ввод текста в награде Twitch.' : 'Request has no YouTube link. Require text input on the Twitch reward.' });
      return;
    }
    try { this.add(url, event.userName, source, event.id); }
    catch (error) { this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error) }); }
  }
}
