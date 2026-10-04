import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { defaultSettings } from '@shared/defaults';
import type { StreamEvent } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { DonationAlertsService, normalizeDonation } from '../src/main/donations/donationalerts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.unstubAllGlobals(); });

function setup(rejectSubscription = false) {
  const bus = new EventBus();
  const state = new StateHub(bus);
  const settings = defaultSettings('en');
  settings.donationalerts.enabled = true;
  let socket: WebSocket;
  const received: any[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()); received.push(msg);
      if (msg.id === 1) ws.send(JSON.stringify({ id: 1, result: { client: 'client-id' } }));
      if (msg.method === 1) ws.send(JSON.stringify(rejectSubscription ? { id: msg.id, error: { code: 103, message: 'Permission denied' } } : { id: msg.id, result: {} }));
    });
  });
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.includes('/user/oauth')
    ? { data: { id: 1, code: 'streamer', name: 'Streamer', socket_connection_token: 'socket-token' } }
    : { channels: [{ channel: '$alerts:donation_1', token: 'channel-token' }] }), { status: 200 }));
  const ctx = { bus, state, settings: { get: (key: keyof typeof settings) => settings[key] }, secrets: { get: () => ({ accessToken: 'access' }) } } as unknown as AppContext;
  const service = new DonationAlertsService(ctx, () => '', { api: 'https://fake.invalid', socket: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` });
  const events: StreamEvent[] = [];
  bus.on('event', (e) => events.push(e));
  cleanup.push(() => service.stop(), () => { wss.clients.forEach((ws) => ws.terminate()); return new Promise<void>((resolve) => wss.close(() => resolve())); });
  return { service, state, events, received, publish: (payload: unknown) => socket.send(JSON.stringify(payload)) };
}

describe('DonationAlerts protocol', () => {
  it('decodes string donations, preserves text and normalizes numeric amounts', () => {
    expect(normalizeDonation(JSON.stringify({ id: 10, name: 'donation', username: ' Ann ', amount: '12.50', currency: 'usd', message: 'hello ', message_type: 'text' }), 'Anonymous'))
      .toMatchObject({ id: 'da_10', userName: 'Ann', amount: 12.5, currency: 'USD', message: 'hello ' });
    expect(normalizeDonation({ id: 11, amount: 3, currency: 'USD', amount_in_user_currency: null, message_type: 'audio', message: 'audio/url' }, 'Anonymous'))
      .toMatchObject({ amountMain: undefined, message: '' });
  });

  it.each([null, '', { amount: '' }, { amount: ' ', currency: 'RUB' }, { amount: true, currency: 'RUB' }, { amount: null }, { amount: -1 }, { amount: 'NaN' }, { amount: 5 }, { name: 'follow', amount: 5 }, { type: 'subscription', amount: 5 }])('rejects malformed or non-donation payload %j', (value) => {
    expect(normalizeDonation(value, 'Anonymous')).toBeNull();
  });

  it('uses a converted amount only when its currency is supplied', () => {
    const payload = { id: 12, amount: 5, currency: 'USD', amount_in_user_currency: '450' };
    expect(normalizeDonation(payload, 'Anonymous')).toMatchObject({ amount: 5, currency: 'USD', amountMain: undefined });
    expect(normalizeDonation({ ...payload, user_currency: 'RUB' }, 'Anonymous')).toMatchObject({ amountMain: 450, amountMainCurrency: 'RUB' });
  });

  it('waits for acknowledgement and delivers nested JSON publications only once', async () => {
    const h = setup();
    await h.service.start();
    await vi.waitFor(() => expect(h.state.current.donationalerts.status).toBe('connected'));
    expect(h.received.find((msg) => msg.method === 1).params.token).toBe('channel-token');
    const donation = { id: 9, name: 'donation', username: 'Bob', amount: 500, currency: 'RUB', message: 'hi' };
    h.publish({ result: { channel: '$alerts:donation_1', data: { data: JSON.stringify(donation) } } });
    h.publish({ result: { channel: '$alerts:donation_1', data: donation } });
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    expect(h.events[0]).toMatchObject({ userName: 'Bob', amount: 500, message: 'hi' });
  });

  it('does not report a rejected subscription as connected', async () => {
    const h = setup(true);
    await h.service.start();
    await vi.waitFor(() => expect(h.state.current.donationalerts.error).toBe('Permission denied'));
    expect(h.state.current.donationalerts.status).not.toBe('connected');
  });

  it('cannot resurrect a socket when logout happens during the user request', async () => {
    const h = setup();
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((done) => { resolve = done; }));
    const start = h.service.start();
    h.service.stop();
    resolve(new Response(JSON.stringify({ data: { id: 1, socket_connection_token: 'x' } })));
    await start;
    expect(h.received).toHaveLength(0);
  });
});
