import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { EventSubSocket } from '../src/main/platforms/twitch/eventsub';

let n = 0;
const meta = (type: string, id = `m${n++}`) => ({ message_id: id, message_type: type, message_timestamp: new Date().toISOString() });
const welcome = (sessionId: string, keepalive = 10) => ({ metadata: meta('session_welcome'), payload: { session: { id: sessionId, keepalive_timeout_seconds: keepalive } } });
const notification = (type: string, event: unknown, id?: string) => ({ metadata: meta('notification', id), payload: { subscription: { type }, event } });

class FakeTwitch {
  wss = new WebSocketServer({ port: 0 });
  sockets: WebSocket[] = [];
  paths: string[] = [];
  constructor(onConnect: (ws: WebSocket, path: string, index: number) => void) {
    this.wss.on('connection', (ws, req) => {
      this.sockets.push(ws);
      this.paths.push(req.url ?? '');
      onConnect(ws, req.url ?? '', this.sockets.length - 1);
    });
  }
  get url() {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/ws`;
  }
  close() {
    this.sockets.forEach((s) => s.terminate());
    return new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

function harness(fake: FakeTwitch) {
  const sessions: string[] = [];
  const events: [string, any][] = [];
  const statuses: string[] = [];
  const sock = new EventSubSocket(
    {
      onSession: async (id) => void sessions.push(id),
      onNotification: (type, e) => void events.push([type, e]),
      onStatus: (s) => void statuses.push(s),
    },
    fake.url,
    [20, 20],
  );
  cleanup.push(() => sock.stop(), () => fake.close());
  return { sock, sessions, events, statuses };
}

describe('EventSubSocket', () => {
  it('recovers when a migration socket closes before welcome', async () => {
    const fake = new FakeTwitch((ws, path, i) => {
      if (path.includes('migrate')) ws.close(4000, 'migration failed');
      else send(ws, welcome(`s${i}`));
    });
    const h = harness(fake); h.sock.start();
    await until(() => h.sessions.length === 1);
    send(fake.sockets[0], { metadata: meta('session_reconnect'), payload: { session: { reconnect_url: fake.url + '?migrate=1' } } });
    await until(() => h.sessions.length === 2);
    expect(fake.paths).toEqual(['/ws', '/ws?migrate=1', '/ws']);
  });

  it('ignores completion of a pending subscription after stop', async () => {
    const fake = new FakeTwitch((ws) => send(ws, welcome('pending')));
    let complete!: () => void;
    const statuses: string[] = [];
    const sock = new EventSubSocket({ onSession: () => new Promise<void>((resolve) => { complete = resolve; }), onNotification: () => undefined, onStatus: (s) => statuses.push(s) }, fake.url);
    cleanup.push(() => sock.stop(), () => fake.close());
    sock.start();
    await until(() => !!complete);
    sock.stop(); complete();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statuses.at(-1)).toBe('disconnected');
    expect(statuses).not.toContain('connected');
  });
  it('subscribes on welcome and delivers notifications once', async () => {
    const fake = new FakeTwitch((ws) => send(ws, welcome('s1')));
    const h = harness(fake);
    h.sock.start();
    await until(() => h.statuses.includes('connected'));
    expect(h.sessions).toEqual(['s1']);

    const ws = fake.sockets[0];
    send(ws, notification('channel.follow', { user_name: 'A' }, 'dup'));
    send(ws, notification('channel.follow', { user_name: 'A' }, 'dup')); // Twitch may redeliver
    send(ws, notification('channel.raid', { viewers: 5 }));
    await until(() => h.events.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.events.map(([t]) => t)).toEqual(['channel.follow', 'channel.raid']);
  });

  it('migrates on session_reconnect without resubscribing', async () => {
    const fake = new FakeTwitch((ws, path, i) => {
      if (i === 0) send(ws, welcome('s1'));
      else send(ws, welcome('s1-migrated'));
      void path;
    });
    const h = harness(fake);
    h.sock.start();
    await until(() => h.sessions.length === 1);
    send(fake.sockets[0], { metadata: meta('session_reconnect'), payload: { session: { id: 's1', reconnect_url: fake.url + '?migrate=1' } } });
    await until(() => fake.sockets.length === 2);
    await until(() => fake.sockets[0].readyState === fake.sockets[0].CLOSED);
    expect(fake.paths[1]).toContain('migrate=1');
    expect(h.sessions).toEqual(['s1']); // subscriptions carried over

    send(fake.sockets[1], notification('channel.cheer', { bits: 100 }));
    await until(() => h.events.length === 1);
  });

  it('reconnects with a fresh session when the socket drops', async () => {
    const fake = new FakeTwitch((ws, _p, i) => send(ws, welcome(`s${i + 1}`)));
    const h = harness(fake);
    h.sock.start();
    await until(() => h.sessions.length === 1);
    fake.sockets[0].close(4000, 'server error');
    await until(() => h.sessions.length === 2);
    expect(h.sessions).toEqual(['s1', 's2']);
  });

  it('reconnects when keepalives stop', async () => {
    // keepalive 0s -> watchdog fires after the 5s grace; keep it short by sending nothing else.
    const fake = new FakeTwitch((ws, _p, i) => send(ws, welcome(`k${i + 1}`, 0)));
    const h = harness(fake);
    h.sock.start();
    await until(() => h.sessions.length === 2, 8000);
  }, 10_000);
});
