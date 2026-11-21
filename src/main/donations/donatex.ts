import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from '@microsoft/signalr';
import type { StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';

const HUB_URL = 'https://donatex.gg/api/public-donations-hub';
const INITIAL_RETRY_MS = 2000;

export function normalizeDonateXDonation(payload: unknown, anonymousName: string): Extract<StreamEvent, { type: 'donation' }> | null {
  if (!payload || typeof payload !== 'object') return null;
  const { id, username, message, amount, amountInRub, currency, timestamp, isTest } = payload as Record<string, unknown>;
  if (typeof id !== 'string' || !id.trim()) return null;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || (amount === 0 && isTest !== true)) return null;
  if (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) return null;
  const code = currency.toUpperCase();
  const useRubConversion = code !== 'RUB' && typeof amountInRub === 'number' && Number.isFinite(amountInRub) && amountInRub > 0;
  const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;

  return {
    id: `dx_${id}`,
    source: isTest === true ? 'test' : 'donatex',
    type: 'donation',
    timestamp: Number.isFinite(time) ? time : Date.now(),
    userName: (typeof username === 'string' && username.trim()) || anonymousName,
    amount,
    currency: code,
    message: typeof message === 'string' ? message : '',
    ...(useRubConversion ? { amountMain: amountInRub, amountMainCurrency: 'RUB' } : {}),
  };
}

export class DonateXService {
  private connection: HubConnection | null = null;
  private retry: NodeJS.Timeout | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private seen = new Set<string>();

  constructor(private ctx: AppContext, private hubUrl = HUB_URL) {}

  async start(): Promise<void> {
    const token = this.ctx.secrets.get('donatexToken');
    if (this.connection || !token || !this.ctx.settings.get('donatex').enabled) return;

    const connection = new HubConnectionBuilder()
      .withUrl(this.hubUrl, { accessTokenFactory: () => token, timeout: 10_000 })
      .configureLogging(LogLevel.None)
      .build();
    this.connection = connection;
    connection.on('DonationCreated', (payload: unknown) => {
      if (this.connection !== connection) return;
      const event = normalizeDonateXDonation(payload, this.ctx.settings.get('language') === 'ru' ? 'Аноним' : 'Anonymous');
      if (!event || this.seen.has(event.id)) return;
      this.seen.add(event.id);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
      this.ctx.bus.emit('event', event);
    });
    connection.onclose(() => {
      if (this.connection !== connection) return;
      this.ctx.state.replace('donatex', { status: 'connecting' });
      this.scheduleRetry(connection);
    });
    await this.open(connection);
  }

  private async open(connection: HubConnection): Promise<void> {
    this.ctx.state.replace('donatex', { status: 'connecting' });
    try {
      await connection.start();
      if (this.connection !== connection || connection.state !== HubConnectionState.Connected) return;
      this.retryMs = INITIAL_RETRY_MS;
      this.ctx.state.replace('donatex', { status: 'connected' });
    } catch (error) {
      if (this.connection !== connection) return;
      // SignalR wraps negotiation HTTP errors and keeps the status in their message.
      const refused = error instanceof Error && /Status code '(401|403)'/i.test(error.message);
      const ru = this.ctx.settings.get('language') === 'ru';
      const hint = refused
        ? (ru ? 'DonateX отклонил доступ. Проверьте внешний токен.' : 'DonateX denied access. Check your external token.')
        : (ru ? 'Не удалось подключиться к DonateX. Пробуем снова.' : 'Could not connect to DonateX. Retrying.');
      this.ctx.state.replace('donatex', { status: 'error', error: hint });
      if (!refused) this.scheduleRetry(connection);
    }
  }

  private scheduleRetry(connection: HubConnection): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.connection === connection) void this.open(connection);
    }, this.retryMs);
    this.retryMs = Math.min(30_000, this.retryMs * 2);
  }

  connect(value: string): Promise<void> {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token || /\s/.test(token)) {
      throw new Error(this.ctx.settings.get('language') === 'ru' ? 'Введите внешний токен DonateX' : 'Enter a DonateX external token');
    }
    this.stop();
    this.ctx.secrets.set('donatexToken', token);
    this.ctx.settings.set('donatex', { enabled: true });
    return this.start();
  }

  disconnect(): void {
    this.stop();
    this.ctx.secrets.set('donatexToken', undefined);
    this.ctx.settings.set('donatex', { enabled: false });
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.retryMs = INITIAL_RETRY_MS;
    const connection = this.connection;
    this.connection = null;
    void connection?.stop().catch(() => {});
    this.ctx.state.replace('donatex', { status: 'disconnected' });
  }
}
