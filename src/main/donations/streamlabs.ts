import io from 'socket.io-client-v2';
import type { StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';

/** Streamlabs socket "event" payload -> donation events. Other types (twitch follows etc.) come from EventSub. */
export function normalizeStreamlabs(payload: any, anonymousName: string): StreamEvent[] {
  if (payload?.type !== 'donation' || !Array.isArray(payload.message)) return [];
  return payload.message
    .map((m: any): StreamEvent | null => {
      const amount = Number(m.amount);
      if (!Number.isFinite(amount)) return null;
      return {
        id: `sl_${m._id ?? m.id ?? Date.now()}`,
        source: 'streamlabs',
        timestamp: Date.now(),
        type: 'donation',
        userName: (m.name || m.from || '').trim() || anonymousName,
        amount,
        currency: m.currency ?? '',
        message: m.message ?? '',
      };
    })
    .filter(Boolean) as StreamEvent[];
}

/**
 * Streamlabs Socket API. The user pastes their "Socket API Token" from
 * streamlabs.com → Settings → API Settings → API Tokens. The endpoint speaks socket.io v2.
 */
export class StreamlabsService {
  private socket: ReturnType<typeof io> | null = null;
  private seen = new Set<string>();

  constructor(private ctx: AppContext) {}

  start(): void {
    const token = this.ctx.secrets.get('streamlabsSocketToken');
    if (!token || !this.ctx.settings.get('streamlabs').enabled) return;
    this.stop();
    this.ctx.state.patch('streamlabs', { status: 'connecting', error: undefined });
    const socket = io(`https://sockets.streamlabs.com?token=${encodeURIComponent(token)}`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelayMax: 30_000,
    });
    this.socket = socket;
    socket.on('connect', () => this.ctx.state.patch('streamlabs', { status: 'connected', error: undefined }));
    socket.on('disconnect', () => this.ctx.state.patch('streamlabs', { status: 'connecting' }));
    socket.on('connect_error', (err: Error) => this.ctx.state.patch('streamlabs', { status: 'error', error: err?.message ?? 'connect error' }));
    socket.on('event', (payload: any) => {
      const anon = this.ctx.settings.get('language') === 'ru' ? 'Аноним' : 'Anonymous';
      for (const ev of normalizeStreamlabs(payload, anon)) {
        if (this.seen.has(ev.id)) continue;
        this.seen.add(ev.id);
        this.ctx.bus.emit('event', ev);
      }
    });
  }

  connect(token: string): void {
    this.ctx.secrets.set('streamlabsSocketToken', token.trim());
    this.ctx.settings.set('streamlabs', { enabled: true });
    this.start();
  }

  disconnect(): void {
    this.stop();
    this.ctx.secrets.set('streamlabsSocketToken', undefined);
    this.ctx.settings.set('streamlabs', { enabled: false });
  }

  stop(): void {
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
    this.ctx.state.replace('streamlabs', { status: 'disconnected' });
  }
}
