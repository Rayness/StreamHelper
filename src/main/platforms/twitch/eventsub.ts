import WebSocket from 'ws';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

export interface EventSubHandlers {
  /** A fresh session started: create subscriptions for it (must happen within 10 seconds). */
  onSession: (sessionId: string) => Promise<void>;
  onNotification: (subscriptionType: string, event: any) => void;
  onRevocation?: (subscriptionType: string, status: string) => void;
  onStatus: (status: 'connecting' | 'connected' | 'disconnected', error?: string) => void;
}

/**
 * EventSub over WebSocket. Handles keepalive watchdog, Twitch-initiated migrations
 * (session_reconnect keeps subscriptions) and our own reconnects (new session, resubscribe).
 */
export class EventSubSocket {
  private ws: WebSocket | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private keepaliveMs = 10_000;
  private attempts = 0;
  private stopped = true;
  private migration: WebSocket | null = null;
  private migrationTimer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];

  constructor(
    private handlers: EventSubHandlers,
    private url = EVENTSUB_URL,
    private retryDelays = [1000, 2000, 5000, 10_000, 30_000],
  ) {}

  start(): void {
    this.stop();
    this.stopped = false;
    this.attempts = 0;
    this.open(this.url, false);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.migration?.removeAllListeners();
    this.migration?.on('error', () => undefined);
    this.migration?.terminate();
    this.migration = null;
    ws?.removeAllListeners();
    ws?.on('error', () => undefined);
    ws?.close();
    this.handlers.onStatus('disconnected');
  }

  private open(url: string, isMigration: boolean): void {
    if (!isMigration) this.handlers.onStatus('connecting');
    const ws = new WebSocket(url);
    if (isMigration) {
      this.migration?.terminate();
      this.migration = ws;
      if (this.migrationTimer) clearTimeout(this.migrationTimer);
      this.migrationTimer = setTimeout(() => this.scheduleReconnect('migration welcome timeout'), 10_000);
    }
    const previous = isMigration ? this.ws : null;
    if (!isMigration) this.ws = ws;

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || this.stopped) return;
      if (ws !== this.ws && !(ws === this.migration && msg.metadata?.message_type === 'session_welcome')) return;
      this.onMessage(ws, msg, isMigration, previous);
    });

    ws.on('close', (code) => {
      if ((ws !== this.ws && ws !== this.migration) || this.stopped) return;
      this.scheduleReconnect(`closed (${code})`);
    });

    ws.on('error', (err) => {
      if (ws !== this.ws || this.stopped) return;
      console.warn('[eventsub] socket error', err.message);
    });
  }

  private onMessage(ws: WebSocket, msg: any, isMigration: boolean, previous: WebSocket | null): void {
    const type: string = msg.metadata?.message_type;
    const id: string | undefined = msg.metadata?.message_id;
    if (id && this.isDuplicate(id)) return;
    this.resetWatchdog();

    switch (type) {
      case 'session_welcome': {
        const session = msg.payload?.session;
        if (!session?.id) return;
        this.keepaliveMs = (session.keepalive_timeout_seconds ?? 10) * 1000;
        // Re-arm with the interval this session actually uses.
        this.resetWatchdog();
        if (isMigration) {
          // Twitch moved us to a new edge server; subscriptions carry over.
          this.ws = ws;
          this.migration = null;
          if (this.migrationTimer) clearTimeout(this.migrationTimer);
          this.migrationTimer = null;
          previous?.removeAllListeners();
          previous?.on('error', () => undefined);
          previous?.close();
          this.handlers.onStatus('connected');
          return;
        }
        this.handlers
          .onSession(session.id)
          .then(() => {
            if (this.stopped || ws !== this.ws) return;
            this.attempts = 0;
            this.handlers.onStatus('connected');
          })
          .catch((err) => {
            if (this.stopped || ws !== this.ws) return;
            console.error('[eventsub] subscribing failed', err);
            this.handlers.onStatus('disconnected', String(err?.message ?? err));
            this.scheduleReconnect('subscribe failed');
          });
        return;
      }
      case 'session_keepalive':
        return;
      case 'notification':
        if (!msg.payload?.subscription?.type || !msg.payload.event) return;
        this.handlers.onNotification(msg.payload.subscription.type, msg.payload.event);
        return;
      case 'session_reconnect':
        if (typeof msg.payload?.session?.reconnect_url === 'string') this.open(msg.payload.session.reconnect_url, true);
        return;
      case 'revocation':
        if (msg.payload?.subscription) this.handlers.onRevocation?.(msg.payload.subscription.type, msg.payload.subscription.status);
        return;
    }
  }

  private isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 1000) this.seen.delete(this.seenOrder.shift()!);
    return false;
  }

  private resetWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.scheduleReconnect('keepalive timeout'), this.keepaliveMs + 5_000);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    console.warn('[eventsub] reconnecting:', reason);
    this.clearTimers();
    const old = this.ws;
    this.ws = null;
    this.migration?.removeAllListeners();
    this.migration?.on('error', () => undefined);
    this.migration?.terminate();
    this.migration = null;
    old?.removeAllListeners();
    old?.on('error', () => undefined);
    old?.terminate();
    this.handlers.onStatus('connecting');
    const delay = this.retryDelays[Math.min(this.attempts++, this.retryDelays.length - 1)];
    this.retryTimer = setTimeout(() => this.open(this.url, false), delay);
  }

  private clearTimers(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.migrationTimer) clearTimeout(this.migrationTimer);
    this.migrationTimer = null;
    this.watchdog = this.retryTimer = null;
  }
}
