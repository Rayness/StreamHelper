import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { renderAlert } from '@shared/alerts';
import { donationAmount } from '@shared/events';
import type { StreamEvent } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { DonateXService, normalizeDonateXDonation } from '../src/main/donations/donatex';
import { ProgressTracker } from '../src/main/features/progress';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const TOKEN = 'fixture-external-token';
const SEPARATOR = '\u001e';
const DONATION = {
  id: '4fd9677b-8b17-4c9d-9a9f-c2a7a3f9960b',
  username: ' Alice ',
  message: 'https://youtu.be/dQw4w9WgXcQ',
  currency: 'USD',
  amount: 5,
  amountInRub: 450,
  timestamp: '2026-10-12T18:42:07Z',
};

async function setup(negotiateStatus = 200) {
  const negotiates: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    negotiates.push(req.headers.authorization);
    res.writeHead(negotiateStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(negotiateStatus === 200
      ? { negotiateVersion: 1, connectionId: 'fixture', connectionToken: 'fixture', availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text'] }] }
      : { detail: TOKEN }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    socket.once('message', () => socket.send(`{}${SEPARATOR}`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const dir = mkdtempSync(join(tmpdir(), 'streamhelper-donatex-'));
  const bus = new EventBus();
  const state = new StateHub(bus);
  const settings = new SettingsStore(join(dir, 'settings.json'), bus, 'en');
  settings.set('currency', 'USD');
  const defaultGoal = { ...settings.get('goals')[0], kind: 'donations' as const, current: 0, target: 1000 };
  settings.set('goals', [defaultGoal, { ...defaultGoal, id: 'da-only', donationSources: ['donationalerts'] }]);
  let token: string | undefined;
  const secrets = { get: () => token, set: (_key: string, value: string | undefined) => { token = value; } };
  const ctx = { bus, state, settings, secrets } as unknown as AppContext;
  const service = new DonateXService(ctx, `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public-donations-hub`);
  const events: StreamEvent[] = [];
  new ProgressTracker(ctx);
  bus.on('event', (event) => events.push(event));
  cleanups.push(async () => {
    service.stop();
    wss.clients.forEach((socket) => socket.terminate());
    wss.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    settings.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const publish = (target: string, ...donations: unknown[]) => {
    const frames = donations.map((donation) => JSON.stringify({ type: 1, target, arguments: [donation] }));
    wss.clients.forEach((socket) => socket.send(frames.join(SEPARATOR) + SEPARATOR));
  };
  return { service, state, settings, events, negotiates, publish, token: () => token,
    dropConnection: () => wss.clients.forEach((socket) => socket.terminate()) };
}

describe('DonateX donations', () => {
  it('keeps the original amount and uses a provider conversion only for RUB', () => {
    const event = normalizeDonateXDonation(DONATION, 'Anonymous')!;
    expect(event).toMatchObject({ source: 'donatex', userName: 'Alice', message: DONATION.message, timestamp: Date.parse(DONATION.timestamp) });
    expect(donationAmount(event, 'USD')).toBe(5);
    expect(donationAmount(event, 'RUB')).toBe(450);
    expect(donationAmount(event, 'EUR')).toBeNull();
    expect(normalizeDonateXDonation({ ...DONATION, amount: '5' }, 'Anonymous')).toBeNull();
    expect(normalizeDonateXDonation({ ...DONATION, currency: '' }, 'Anonymous')).toBeNull();
  });

  it('authenticates, deduplicates after reconnect, and only counts real donations in selected goals', async () => {
    const h = await setup();
    await h.service.connect(` ${TOKEN} `);
    expect(h.state.current.donatex.status).toBe('connected');
    expect(h.negotiates).toEqual([`Bearer ${TOKEN}`]);
    expect(h.settings.get('donatex')).toEqual({ enabled: true });
    expect(h.settings.get('donatex')).not.toHaveProperty('token');
    h.publish('DonationCreated', DONATION, DONATION, { ...DONATION, id: 'test', isTest: true, amount: 0 });
    await vi.waitFor(() => expect(h.events).toHaveLength(2));
    expect(h.settings.get('goals').map((goal) => goal.current)).toEqual([450, 0]);
    expect(h.settings.get('donationLog')).toMatchObject([{ source: 'donatex', amountMain: 5 }]);
    expect(h.events[1].source).toBe('test');
    expect(renderAlert(h.events[1], h.settings.get('alerts'), 'RUB')).not.toBeNull();

    h.dropConnection();
    await vi.waitFor(() => expect(h.negotiates).toHaveLength(2), { timeout: 4000 });
    await vi.waitFor(() => expect(h.state.current.donatex.status).toBe('connected'));
    h.publish('DonationRerun', { ...DONATION, id: 'old-donation' });
    h.publish('DonationCreated', DONATION, { ...DONATION, id: 'new-donation' });
    await vi.waitFor(() => expect(h.events.map((event) => event.id)).toEqual([`dx_${DONATION.id}`, 'dx_test', 'dx_new-donation']));
    expect(h.settings.get('donationLog')).toHaveLength(2);
    h.service.disconnect();
    expect(h.state.current.donatex.status).toBe('disconnected');
    expect(h.settings.get('donatex').enabled).toBe(false);
    expect(h.token()).toBeUndefined();
  });

  it('reports a denied token without putting the server response or token in state', async () => {
    const h = await setup(401);
    await h.service.connect(TOKEN);
    expect(h.state.current.donatex).toEqual({ status: 'error', error: 'DonateX denied access. Check your external token.' });
    expect(h.events).toEqual([]);
  });
});
