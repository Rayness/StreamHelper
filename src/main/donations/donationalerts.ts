import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';

const DA = 'https://www.donationalerts.com';
const CENTRIFUGO = 'wss://centrifugo.donationalerts.com/connection/websocket';
const SCOPES = 'oauth-user-show oauth-donation-subscribe';

/** Parse one DonationAlerts donation payload (the inner `data` of a centrifugo publication). */
export function normalizeDonation(d: any, anonymousName: string): StreamEvent | null {
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
  if (!d || typeof d !== 'object' || !['number', 'string'].includes(typeof d.amount) || String(d.amount).trim() === '' ||
    (d.name && !['donation', 'donations'].includes(String(d.name).toLowerCase())) || (d.type && d.type !== 'donation')) return null;
  const amount = Number(d.amount);
  const currency = typeof d.currency === 'string' ? d.currency.trim().toUpperCase() : '';
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  const converted = d.amount_in_user_currency === undefined || d.amount_in_user_currency === null || d.amount_in_user_currency === '' ? undefined : Number(d.amount_in_user_currency);
  const convertedCurrency = typeof d.user_currency === 'string' ? d.user_currency.trim().toUpperCase() : '';
  const useConverted = converted !== undefined && Number.isFinite(converted) && converted >= 0 && /^[A-Z]{3}$/.test(convertedCurrency);
  return {
    id: `da_${d.id ?? randomUUID()}`,
    source: 'donationalerts',
    timestamp: Date.now(),
    type: 'donation',
    userName: typeof d.username === 'string' ? d.username.trim() || anonymousName : anonymousName,
    amount,
    currency,
    amountMain: useConverted ? converted : undefined,
    amountMainCurrency: useConverted ? convertedCurrency : undefined,
    message: d.message_type === 'audio' ? '' : (typeof d.message === 'string' ? d.message : ''),
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
  private seenOrder: string[] = [];
  private generation = 0;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private loginTimer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: AppContext,
    private redirectUri: () => string,
    private endpoints = { api: DA, socket: CENTRIFUGO },
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
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = setTimeout(() => {
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
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
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
    const generation = ++this.generation;
    this.cleanup();
    this.ctx.state.patch('donationalerts', { status: 'connecting', error: undefined });
    try {
      const user = await this.api('/api/v1/user/oauth', token.accessToken);
      if (generation !== this.generation || this.stopped) return;
      this.ctx.state.patch('donationalerts', {
        account: { userId: String(user.id), login: user.code, displayName: user.name, avatarUrl: user.avatar },
      });
      this.connectSocket(token.accessToken, String(user.id), user.socket_connection_token);
    } catch (err) {
      if (generation !== this.generation || this.stopped) return;
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
    this.generation++;
    this.loginPending = false;
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
    this.cleanup();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async api(path: string, accessToken: string, body?: unknown): Promise<any> {
    const res = await fetch(this.endpoints.api + path, {
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
    const ws = new WebSocket(this.endpoints.socket);
    this.ws = ws;
    const channel = `$alerts:donation_${userId}`;
    let msgId = 1;
    let subscriptionId = 0;
    this.handshakeTimer = setTimeout(() => ws.close(), 15_000);

    ws.on('open', () => ws.send(JSON.stringify({ params: { token: socketToken }, id: msgId++ })));

    ws.on('message', (raw) => {
      // Centrifugo can send several JSON replies in a single WebSocket frame.
      for (const line of raw.toString().split('\n')) void handle(line);
    });

    const handle = async (raw: string) => {
      if (this.stopped || ws !== this.ws) return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.error) {
        this.ctx.state.patch('donationalerts', { status: 'error', error: String(msg.error.message ?? msg.error.code ?? 'Subscription failed') });
        ws.close();
        return;
      }
      // Connect reply carries our client id; exchange it for a channel subscription token.
      if (msg.id === 1 && msg.result?.client) {
        try {
          const sub = await this.api('/api/v1/centrifuge/subscribe', accessToken, { channels: [channel], client: msg.result.client });
          const chToken = (sub.channels ?? sub)?.find?.((c: any) => c.channel === channel)?.token ?? sub.channels?.[0]?.token;
          if (this.stopped || ws !== this.ws || ws.readyState !== WebSocket.OPEN) return;
          if (typeof chToken !== 'string' || !chToken) throw new Error('DonationAlerts did not return a channel token');
          subscriptionId = msgId++;
          ws.send(JSON.stringify({ params: { channel, token: chToken }, method: 1, id: subscriptionId }));
        } catch (err) {
          if (this.stopped || ws !== this.ws) return;
          this.ctx.state.patch('donationalerts', { status: 'error', error: errorMessage(err) });
          ws.close();
        }
        return;
      }
      if ((subscriptionId && msg.id === subscriptionId && msg.result) || (msg.result?.channel === channel && msg.result?.type === 1)) {
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.attempts = 0;
        this.ctx.state.patch('donationalerts', { status: 'connected', error: undefined });
        if (!this.pingTimer) this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 7, id: msgId++ }));
        }, 20_000);
      }
      const publication = msg.result;
      if (publication?.channel === channel && publication.type !== 1) {
        const data = publication.data;
        this.onDonation(data?.data ?? data);
      }
    };

    ws.on('close', () => {
      if (ws !== this.ws) return;
      this.cleanup();
      this.ctx.state.patch('donationalerts', { status: this.stopped ? 'disconnected' : 'connecting' });
      this.scheduleReconnect();
    });
    ws.on('error', (err) => console.warn('[donationalerts] socket error', err.message));
  }

  private onDonation(d: any): void {
    const event = normalizeDonation(d, this.ctx.settings.get('language') === 'ru' ? 'Аноним' : 'Anonymous');
    if (!event) return;
    const key = event.id;
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.seenOrder.push(key);
      if (this.seenOrder.length > 1000) this.seen.delete(this.seenOrder.shift()!);
    }
    this.ctx.bus.emit('event', event);
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
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on('error', () => undefined);
    ws?.close();
  }
}
