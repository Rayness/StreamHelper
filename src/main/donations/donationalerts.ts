import WebSocket from 'ws';
import type { StreamEvent } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';

const DA = 'https://www.donationalerts.com';
const CENTRIFUGO = 'wss://centrifugo.donationalerts.com/connection/websocket';
const SCOPES = 'oauth-user-show oauth-donation-subscribe';

/** Parse one DonationAlerts donation payload (the inner `data` of a centrifugo publication). */
export function normalizeDonation(d: any, anonymousName: string): StreamEvent | null {
  if (!d || d.amount === undefined) return null;
  const amount = Number(d.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    id: `da_${d.id ?? Date.now()}`,
    source: 'donationalerts',
    timestamp: Date.now(),
    type: 'donation',
    userName: (d.username || '').trim() || anonymousName,
    amount,
    currency: d.currency ?? '',
    amountMain: d.amount_in_user_currency !== undefined ? Number(d.amount_in_user_currency) : undefined,
    message: d.message_type === 'audio' ? '' : (d.message ?? ''),
  };
}

export class DonationAlertsService {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = true;
  private loginPending = false;
  private seen = new Set<string>();

  constructor(
    private ctx: AppContext,
    private redirectUri: () => string,
  ) {}

  get connected(): boolean {
    return this.ctx.state.current.donationalerts.status === 'connected';
  }

  // ---------- auth ----------

  login(): void {
    const clientId = this.ctx.settings.get('donationalerts').clientId.trim();
    if (!clientId) {
      this.ctx.toast('error', 'toast.daNoClientId');
      return;
    }
    this.loginPending = true;
    this.ctx.state.patch('donationalerts', { status: 'connecting', error: undefined });
    const url = new URL(`${DA}/oauth/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('scope', SCOPES);
    this.ctx.openExternal(url.toString());
    // If the user closes the browser tab, don't stay "connecting" forever.
    setTimeout(() => {
      if (this.loginPending) {
        this.loginPending = false;
        if (!this.ctx.secrets.get('donationalerts')) this.ctx.state.patch('donationalerts', { status: 'disconnected' });
      }
    }, 5 * 60_000);
  }

  /** Called by the local HTTP server when the OAuth redirect page posts the token back. */
  async completeLogin(accessToken: string, expiresIn?: number): Promise<boolean> {
    if (!this.loginPending) return false;
    this.loginPending = false;
    this.ctx.secrets.set('donationalerts', {
      accessToken,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      scopes: SCOPES.split(' '),
    });
    this.ctx.settings.set('donationalerts', { ...this.ctx.settings.get('donationalerts'), enabled: true });
    await this.start();
    if (this.connected) this.ctx.toast('success', 'toast.daConnected');
    return true;
  }

  logout(): void {
    this.stop();
    this.ctx.secrets.set('donationalerts', undefined);
    this.ctx.settings.set('donationalerts', { ...this.ctx.settings.get('donationalerts'), enabled: false });
    this.ctx.state.replace('donationalerts', { status: 'disconnected' });
  }

  // ---------- connection ----------

  async start(): Promise<void> {
    const token = this.ctx.secrets.get('donationalerts');
    if (!token || !this.ctx.settings.get('donationalerts').enabled) return;
    this.stopped = false;
    this.ctx.state.patch('donationalerts', { status: 'connecting', error: undefined });
    try {
      const user = await this.api('/api/v1/user/oauth', token.accessToken);
      this.ctx.state.patch('donationalerts', {
        account: { userId: String(user.id), login: user.code, displayName: user.name, avatarUrl: user.avatar },
      });
      this.connectSocket(token.accessToken, String(user.id), user.socket_connection_token);
    } catch (err) {
      if ((err as { status?: number }).status === 401) {
        this.logout();
        this.ctx.toast('error', 'toast.daSessionExpired');
        return;
      }
      this.ctx.state.patch('donationalerts', { status: 'error', error: errorMessage(err) });
      this.scheduleReconnect();
    }
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async api(path: string, accessToken: string, body?: unknown): Promise<any> {
    const res = await fetch(DA + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`DonationAlerts ${path} -> ${res.status}`), { status: res.status });
    const json: any = await res.json();
    return json.data ?? json;
  }

  private connectSocket(accessToken: string, userId: string, socketToken: string): void {
    this.cleanup();
    const ws = new WebSocket(CENTRIFUGO);
    this.ws = ws;
    const channel = `$alerts:donation_${userId}`;
    let msgId = 1;

    ws.on('open', () => ws.send(JSON.stringify({ params: { token: socketToken }, id: msgId++ })));

    ws.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Connect reply carries our client id; exchange it for a channel subscription token.
      if (msg.id === 1 && msg.result?.client) {
        try {
          const sub = await this.api('/api/v1/centrifuge/subscribe', accessToken, { channels: [channel], client: msg.result.client });
          const chToken = (sub.channels ?? sub)?.find?.((c: any) => c.channel === channel)?.token ?? sub.channels?.[0]?.token;
          ws.send(JSON.stringify({ params: { channel, token: chToken }, method: 1, id: msgId++ }));
          this.attempts = 0;
          this.ctx.state.patch('donationalerts', { status: 'connected', error: undefined });
          this.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 7, id: msgId++ }));
          }, 20_000);
        } catch (err) {
          this.ctx.state.patch('donationalerts', { status: 'error', error: errorMessage(err) });
          ws.close();
        }
        return;
      }
      const pub = msg.result?.data?.data;
      if (msg.result?.channel === channel && pub) this.onDonation(pub);
    });

    ws.on('close', () => {
      if (ws !== this.ws) return;
      this.ctx.state.patch('donationalerts', { status: this.stopped ? 'disconnected' : 'connecting' });
      this.scheduleReconnect();
    });
    ws.on('error', (err) => console.warn('[donationalerts] socket error', err.message));
  }

  private onDonation(d: any): void {
    const key = String(d.id ?? '');
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const event = normalizeDonation(d, this.ctx.settings.get('language') === 'ru' ? 'Аноним' : 'Anonymous');
    if (event) this.ctx.bus.emit('event', event);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = [2000, 5000, 10_000, 30_000, 60_000][Math.min(this.attempts++, 4)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on('error', () => undefined);
    ws?.close();
  }
}
