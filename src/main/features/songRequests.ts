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

/** Result of asking YouTube about a video before it is queued. */
export type VideoCheck = { ok: true; title?: string } | { ok: false; reason: 'notFound' | 'embedBlocked' };
export type VideoLookup = (videoId: string) => Promise<VideoCheck | null>;

/**
 * YouTube oEmbed needs no API key: 200 = embeddable (with title), 401/403 = the owner blocked
 * embedding (it would fail in OBS), 400/404 = removed, private or wrong. `null` = could not check;
 * the request is then accepted and the player reports problems later.
 */
export const oembedLookup: VideoLookup = async (videoId) => {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = await res.json().catch(() => null) as { title?: unknown } | null;
      return { ok: true, title: typeof json?.title === 'string' ? json.title.slice(0, 200) : undefined };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'embedBlocked' };
    if (res.status === 400 || res.status === 404) return { ok: false, reason: 'notFound' };
    return null;
  } catch {
    return null;
  }
};

/** Channel-points bookkeeping; only works for rewards created by this app. */
export interface RedemptionSettler { settle(rewardId: string, redemptionId: string, status: 'FULFILLED' | 'CANCELED'): Promise<void> }

type Rejection = 'noLink' | 'full' | 'duplicate' | 'notFound' | 'embedBlocked' | 'playback';

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
  private paused = false;
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
    private options: { lookup?: VideoLookup; rewards?: RedemptionSettler } = {},
  ) {
    ctx.bus.on('event', (event) => this.onEvent(event));
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'songQueue') this.sync();
      if (key === 'songRequests') void this.onSettingsChanged();
    });
    this.sync();
  }

  get overlayMessage(): OverlayMessage {
    return { type: 'song', request: this.current, nonce: this.nonce, paused: this.paused, config: this.ctx.settings.get('songRequests'), queue: this.ctx.settings.get('songQueue'), lang: this.ctx.settings.get('language') };
  }

  setPlayerConnected(connected: boolean): void {
    if (this.ctx.state.current.songRequests.playerConnected === connected) return;
    this.ctx.state.patch('songRequests', { playerConnected: connected });
    if (!connected) {
      this.generation++;
      this.current = null;
      this.paused = false;
      this.nonce = null;
      this.sync();
      void this.resumeMusic();
    }
    if (connected) void this.maybeStart();
  }

  private get ru(): boolean { return this.ctx.settings.get('language') === 'ru'; }

  private reason(code: Rejection): string {
    const ru = this.ru;
    switch (code) {
      case 'noLink': return ru ? 'в заказе нет ссылки на видео YouTube.' : 'the request has no YouTube video link.';
      case 'full': return ru ? 'очередь заказов заполнена, попробуйте позже.' : 'the song queue is full, try again later.';
      case 'duplicate': return ru ? 'это видео уже есть в очереди.' : 'this video is already queued.';
      case 'notFound': return ru ? 'видео не найдено (удалено, приватное или неверная ссылка).' : 'video not found (removed, private or a wrong link).';
      case 'embedBlocked': return ru ? 'автор запретил воспроизводить это видео вне YouTube. Попробуйте другую загрузку песни.' : 'the owner blocked playing this video outside YouTube. Try another upload of the song.';
      case 'playback': return ru ? 'YouTube не дал воспроизвести это видео.' : 'YouTube refused to play this video.';
    }
  }

  private say(text: string, replyTo?: string): void {
    // Answers to a chat command always go out; redemption notices follow the setting.
    if (!this.reply || (!replyTo && !this.ctx.settings.get('songRequests').replyInChat)) return;
    void this.reply(text, replyTo).catch(() => undefined); // chat may be offline; the request itself is unaffected
  }

  private settle(request: Pick<SongRequest, 'redemption'> | null | undefined, status: 'FULFILLED' | 'CANCELED'): void {
    const r = request?.redemption;
    if (!r || !this.options.rewards) return;
    if (status === 'CANCELED' && !this.ctx.settings.get('songRequests').refundRejected) return;
    // Fails for rewards not created by this app; that is expected and harmless.
    void this.options.rewards.settle(r.rewardId, r.id, status).catch(() => undefined);
  }

  private reject(userName: string, code: Rejection, redemption?: SongRequest['redemption'], replyTo?: string): string {
    const reason = this.reason(code);
    this.ctx.state.patch('songRequests', { lastRejected: { userName, reason, at: Date.now() } });
    this.settle({ redemption }, 'CANCELED');
    const refunded = !!redemption && !!this.options.rewards && this.ctx.settings.get('songRequests').refundRejected;
    this.say(`@${userName}, ${reason}${refunded ? (this.ru ? ' Баллы возвращены.' : ' Points refunded.') : ''}`, replyTo);
    return reason;
  }

  private precheck(videoId: string): Rejection | null {
    const queue = this.ctx.settings.get('songQueue');
    if (queue.some((item) => item.videoId === videoId)) return 'duplicate';
    if (queue.length >= Math.max(1, this.ctx.settings.get('songRequests').maxQueue)) return 'full';
    return null;
  }

  /**
   * One entry point for every viewer request: checks the link, asks YouTube whether the video
   * exists and may be embedded, queues it and tells the viewer. Rejected redemptions are refunded.
   */
  async request(text: string, userName: string, source: SongRequest['source'], id: string, redemption?: SongRequest['redemption'], replyTo?: string): Promise<{ ok: true; position: number } | { ok: false; reason: string }> {
    const url = youtubeUrlInText(text);
    const videoId = url ? youtubeVideoId(url) : null;
    if (!url || !videoId) return { ok: false, reason: this.reject(userName, 'noLink', redemption, replyTo) };
    const early = this.precheck(videoId);
    if (early) return { ok: false, reason: this.reject(userName, early, redemption, replyTo) };
    const check = await (this.options.lookup ?? oembedLookup)(videoId);
    if (check && !check.ok) return { ok: false, reason: this.reject(userName, check.reason, redemption, replyTo) };
    try {
      this.add(url, userName, source, id, { title: check?.title, redemption });
    } catch {
      // The queue changed while YouTube was answering.
      return { ok: false, reason: this.reject(userName, this.precheck(videoId) ?? 'full', redemption, replyTo) };
    }
    const position = this.ctx.settings.get('songQueue').findIndex((item) => item.id === id) + 1;
    const title = check?.title ? `«${check.title}»` : (this.ru ? 'трек' : 'your song');
    this.say(this.ru ? `@${userName}, ${title} в очереди: №${position}.` : `@${userName}, ${title} is queued at #${position}.`, replyTo);
    return { ok: true, position };
  }

  /** The streamer's own "Add" button: same checks, errors go back to the UI. */
  async addManual(url: string): Promise<void> {
    const videoId = youtubeVideoId(url.trim());
    if (!videoId) throw new Error(this.ru ? 'Вставьте ссылку на одно видео YouTube.' : 'Paste a single YouTube video link.');
    const early = this.precheck(videoId);
    if (early) throw new Error(this.reason(early));
    const check = await (this.options.lookup ?? oembedLookup)(videoId);
    if (check && !check.ok) throw new Error(this.reason(check.reason));
    this.add(url.trim(), this.ru ? 'Стример' : 'Streamer', 'manual', undefined, { title: check?.title });
  }

  add(url: string, userName = 'Streamer', source: SongRequest['source'] = 'manual', id = randomBytes(10).toString('hex'), extra: Pick<SongRequest, 'title' | 'redemption'> = {}): void {
    const videoId = youtubeVideoId(url);
    if (!videoId) throw new Error('Send a single YouTube video link');
    const queue = this.ctx.settings.get('songQueue');
    if (queue.length >= Math.max(1, this.ctx.settings.get('songRequests').maxQueue)) throw new Error('Song request queue is full');
    if (queue.some((item) => item.videoId === videoId)) throw new Error('This video is already in the queue');
    const request: SongRequest = { id, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, userName, source, requestedAt: Date.now(),
      ...(extra.title ? { title: extra.title } : {}), ...(extra.redemption ? { redemption: extra.redemption } : {}) };
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
      this.paused = false;
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
    this.settle(this.current, 'FULFILLED');
    await this.dropCurrent();
  }

  /** Pause or resume the playing video in OBS without losing its place. */
  pause(paused: boolean): void {
    if (!this.current || this.paused === paused) return;
    this.paused = paused;
    this.sync();
    this.broadcast(this.overlayMessage);
  }

  /** Reorder the upcoming requests; the playing one stays where it is. */
  move(id: string, index: number): void {
    const queue = this.ctx.settings.get('songQueue');
    const playing = queue.filter((item) => item.id === this.current?.id);
    const upcoming = queue.filter((item) => item.id !== this.current?.id);
    const from = upcoming.findIndex((item) => item.id === id);
    if (from < 0) return;
    const [item] = upcoming.splice(from, 1);
    upcoming.splice(Math.max(0, Math.min(upcoming.length, Math.round(index))), 0, item);
    this.ctx.settings.set('songQueue', [...playing, ...upcoming]);
    this.broadcast(this.overlayMessage);
  }

  /** Remove the playing request and move on to the next one (or give Windows music back). */
  private async dropCurrent(): Promise<void> {
    if (!this.current) return;
    this.paused = false;
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
    // Removed by the streamer before it played: the viewer gets the points back.
    this.settle(this.ctx.settings.get('songQueue').find((item) => item.id === id), 'CANCELED');
    this.ctx.settings.set('songQueue', this.ctx.settings.get('songQueue').filter((item) => item.id !== id));
  }

  /**
   * `kind: 'video'` means this particular video cannot play (removed, embedding blocked):
   * drop it, refund and continue with the next request so the stream is not stuck.
   * Anything else is a player problem (no YouTube access, OBS source) and keeps the request.
   */
  async playerFinished(id: string, nonce: string, error = '', kind: 'video' | 'player' = 'player'): Promise<boolean> {
    if (!this.current || id !== this.current.id || nonce !== this.nonce) return false;
    if (error && kind === 'video') {
      const failed = this.current;
      this.reject(failed.userName, 'playback', failed.redemption);
      this.ctx.state.patch('songRequests', { lastError: `${failed.title ?? failed.url}: ${error.slice(0, 160)}` });
      await this.dropCurrent();
      return true;
    }
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
    this.settle(this.current, 'FULFILLED');
    await this.dropCurrent();
    return true;
  }

  private sync(): void {
    this.ctx.state.patch('songRequests', {
      current: this.current,
      paused: this.paused,
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
      // Replies (queued / rejected) are sent by `request` itself.
      const result = await this.request(parsed.args.join(' '), message.userName, 'chat', `chat_${message.id}`, undefined, message.id);
      if (result.ok) {
        this.chatCooldowns.delete(message.userId);
        this.chatCooldowns.set(message.userId, Date.now() + Math.max(0, cfg.chatCooldownSec) * 1000);
        if (this.chatCooldowns.size > 1000) this.chatCooldowns.delete(this.chatCooldowns.keys().next().value!);
      }
      return true;
    }
    await this.reply?.(response, message.id).catch(() => undefined);
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
    if (!youtubeUrlInText(text)) {
      // A donation without a link is just a donation; a song redemption without one is a mistake.
      if (source !== 'redemption') return;
      if (!text.trim()) this.ctx.state.patch('songRequests', { lastError: this.ru ? 'Заказ не содержит ссылки YouTube. Включите обязательный ввод текста в награде Twitch.' : 'Request has no YouTube link. Require text input on the Twitch reward.' });
    }
    const redemption = event.type === 'redemption' && event.rewardId ? { id: event.id, rewardId: event.rewardId } : undefined;
    void this.request(text, event.userName, source, event.id, redemption).catch((error) => {
      this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error) });
    });
  }
}
