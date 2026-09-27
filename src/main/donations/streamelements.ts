import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';

/** StreamElements Astro `channel.tips` message. Only completed, allowed tips enter the activity feed. */
export function normalizeStreamElementsTip(packet: any, anonymousName: string): StreamEvent | null {
  if (packet?.type !== 'message' || packet?.topic !== 'channel.tips') return null;
  const tip = packet.data;
  if (!tip?._id || tip.status !== 'success' || tip.approved !== 'allowed') return null;
  const amount = Number(tip.donation?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    id: `se_${tip._id}`,
    source: 'streamelements',
    type: 'donation',
    timestamp: Date.parse(tip.createdAt) || Date.now(),
    userName: String(tip.donation?.user?.username || '').trim() || anonymousName,
    amount,
    currency: String(tip.donation?.currency || ''),
    message: String(tip.donation?.message || ''),
  };
}

export class StreamElementsService {
  private ws: WebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private generation = 0;
  private retryMs = 2000;
  private seen = new Set<string>();

  constructor(private ctx: AppContext) {}

  start(): void {
    const { enabled, channelId } = this.ctx.settings.get('streamelements');
    const token = this.ctx.secrets.get('streamelementsJwt');
    if (!enabled || !channelId || !token) return;
    this.stop();
    const generation = ++this.generation;
    this.ctx.state.patch('streamelements', { status: 'connecting', error: undefined });
    const ws = new WebSocket('wss://astro.streamelements.com/');
    this.ws = ws;
    ws.on('message', (raw) => {
      if (generation !== this.generation) return;
      let packet: any;
      try { packet = JSON.parse(raw.toString()); } catch { return; }
      if (packet.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'subscribe', nonce: randomUUID(), data: {
          topic: 'channel.tips', room: channelId, token, token_type: 'jwt',
        } }));
      } else if (packet.type === 'response') {
        if (packet.error) {
          this.ctx.state.patch('streamelements', { status: 'error', error: String(packet.data?.message || packet.error) });
          if (packet.error === 'err_unauthorized' || packet.error === 'err_bad_request') this.stopSocket();
        } else {
          this.retryMs = 2000;
          this.ctx.state.patch('streamelements', { status: 'connected', error: undefined });
        }
      } else if (packet.type === 'message') {
        const anonymous = this.ctx.settings.get('language') === 'ru' ? 'Аноним' : 'Anonymous';
        const event = normalizeStreamElementsTip(packet, anonymous);
        if (event && !this.seen.has(event.id)) {
          this.seen.add(event.id);
          if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
          this.ctx.bus.emit('event', event);
        }
      } else if (packet.type === 'reconnect') {
        // Resubscription on a fresh connection is safe; event IDs suppress replay.
        ws.close();
      }
    });
    ws.on('error', (err) => {
      if (generation === this.generation) this.ctx.state.patch('streamelements', { status: 'error', error: err.message });
    });
    ws.on('close', () => {
      if (generation !== this.generation || this.ws !== ws) return;
      this.ws = null;
      if (this.ctx.state.current.streamelements.status !== 'error') this.ctx.state.patch('streamelements', { status: 'connecting' });
      this.retry = setTimeout(() => { this.retry = null; this.start(); }, this.retryMs);
      this.retryMs = Math.min(30_000, this.retryMs * 2);
    });
  }

  connect(channelId: string, token: string): void {
    if (!/^[a-f\d]{24}$/i.test(channelId.trim())) throw new Error('Invalid StreamElements channel ID');
    if (token.trim().length < 20) throw new Error('Invalid StreamElements JWT');
    this.ctx.secrets.set('streamelementsJwt', token.trim());
    this.ctx.settings.set('streamelements', { enabled: true, channelId: channelId.trim() });
    this.start();
  }

  disconnect(): void {
    this.stop();
    this.ctx.secrets.set('streamelementsJwt', undefined);
    this.ctx.settings.set('streamelements', { enabled: false, channelId: '' });
  }

  private stopSocket(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    ++this.generation;
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.terminate();
  }

  stop(): void {
    this.stopSocket();
    this.ctx.state.replace('streamelements', { status: 'disconnected' });
  }
}
