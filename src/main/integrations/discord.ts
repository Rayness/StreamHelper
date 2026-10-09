import type { StreamEvent, StreamInfo } from '@shared/types';
import type { AppContext } from '../core/context';

export function validDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'discord.com' &&
      /^\/api\/webhooks\/\d{15,25}\/[A-Za-z0-9._-]+$/.test(parsed.pathname) && !parsed.search && !parsed.hash;
  } catch { return false; }
}

/** Sends selected stream events to the streamer's Discord channel using a saved webhook. */
export class DiscordService {
  private lastLive: boolean;
  private queue: Promise<void> = Promise.resolve();

  constructor(private ctx: AppContext) {
    this.lastLive = ctx.state.current.stream.live;
    ctx.bus.on('stream:update', (stream) => this.onStream(stream));
    ctx.bus.on('event', (event) => this.onEvent(event));
  }

  start(): void {
    const configured = this.ctx.settings.get('discord').enabled && !!this.ctx.secrets.get('discordWebhookUrl');
    this.ctx.state.replace('discord', { status: configured ? 'connected' : 'disconnected' });
  }

  connect(url: string): void {
    if (!validDiscordWebhook(url.trim())) throw new Error('Invalid Discord webhook URL');
    this.ctx.secrets.set('discordWebhookUrl', url.trim());
    this.ctx.settings.set('discord', { ...this.ctx.settings.get('discord'), enabled: true });
    this.start();
  }

  disconnect(): void {
    this.ctx.secrets.set('discordWebhookUrl', undefined);
    this.ctx.settings.set('discord', { ...this.ctx.settings.get('discord'), enabled: false });
    this.ctx.state.replace('discord', { status: 'disconnected' });
  }

  async test(): Promise<void> {
    await this.send(this.ctx.settings.get('language') === 'ru' ? 'StreamHelper: тестовое уведомление ✅' : 'StreamHelper: test notification ✅');
  }

  private onStream(stream: StreamInfo): void {
    const previous = this.lastLive;
    this.lastLive = stream.live;
    if (previous === stream.live) return;
    const options = this.ctx.settings.get('discord');
    if (!options.enabled) return;
    const ru = this.ctx.settings.get('language') === 'ru';
    if (stream.live && options.notifyLive) {
      const channel = this.ctx.state.current.twitch.account?.login;
      const title = stream.title || (ru ? 'Трансляция началась' : 'Stream is live');
      const link = channel ? `\nhttps://twitch.tv/${channel}` : '';
      this.enqueue(`${ru ? '🔴 В эфире' : '🔴 Live now'}: ${title}${link}`);
    } else if (!stream.live && options.notifyOffline) {
      this.enqueue(ru ? 'Стрим завершён. Спасибо за просмотр!' : 'Stream ended. Thanks for watching!');
    }
  }

  private onEvent(event: StreamEvent): void {
    if (event.type !== 'donation' || event.source === 'test') return;
    const options = this.ctx.settings.get('discord');
    if (!options.enabled || !options.notifyDonations) return;
    const prefix = this.ctx.settings.get('language') === 'ru' ? '💜 Новый донат' : '💜 New donation';
    this.enqueue(`${prefix}: ${event.userName} — ${event.amount} ${event.currency}${event.message ? `\n${event.message}` : ''}`);
  }

  /** For other features (clips, stream recap). Fails when the webhook isn't connected. */
  notify(content: string): Promise<void> {
    const job = this.queue.then(() => this.send(content));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** A message with an image attached (the stream recap card). */
  async sendImage(content: string, png: Buffer, filename: string): Promise<void> {
    const url = this.ctx.secrets.get('discordWebhookUrl');
    if (!url || !this.ctx.settings.get('discord').enabled) throw new Error('Discord webhook is not connected');
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
    const response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
  }

  private enqueue(content: string): void {
    this.queue = this.queue.then(() => this.send(content)).catch((err) => {
      if (this.ctx.settings.get('discord').enabled) this.ctx.state.patch('discord', { status: 'error', error: err instanceof Error ? err.message : String(err) });
    });
  }

  private async send(content: string): Promise<void> {
    const url = this.ctx.secrets.get('discordWebhookUrl');
    if (!url || !this.ctx.settings.get('discord').enabled) throw new Error('Discord webhook is not connected');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
    this.ctx.state.patch('discord', { status: 'connected', error: undefined });
  }
}
