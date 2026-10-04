import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import type { OAuthToken } from '../src/main/core/secrets';
import { StateHub } from '../src/main/core/state';
import { TwitchService } from '../src/main/platforms/twitch/service';

type Call = { method: string; url: string; body: any; auth: string | null };

let calls: Call[];
let handler: (c: Call) => { status: number; json?: unknown };
let secrets: Record<string, OAuthToken | undefined>;
let bus: EventBus;
let state: StateHub;
let twitch: TwitchService;
let chat: ChatMessage[];

beforeEach(() => {
  calls = [];
  handler = () => ({ status: 200, json: { data: [{ message_id: 'sent1', is_sent: true }] } });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const c: Call = {
      method: init.method ?? 'GET',
      url: String(url),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      auth: (init.headers as Record<string, string> | undefined)?.Authorization ?? null,
    };
    calls.push(c);
    const r = handler(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status });
  });
  bus = new EventBus();
  state = new StateHub(bus);
  secrets = { twitch: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 3600_000, scopes: [], userId: '1', login: 'streamer' } };
  const ctx = {
    bus,
    state,
    settings: { get: (k: string) => (k === 'twitch' ? { clientId: 'cid' } : k === 'language' ? 'en' : undefined) },
    secrets: { get: (k: string) => secrets[k], set: (k: string, v: OAuthToken | undefined) => (secrets[k] = v) },
    toast: vi.fn(),
    openExternal: vi.fn(),
    mediaDir: '',
  } as unknown as AppContext;
  twitch = new TwitchService(ctx);
  state.patch('twitch', { account: { userId: '1', login: 'streamer', displayName: 'Streamer' } });
  chat = [];
  bus.on('chat:message', (m) => chat.push(m));
});

afterEach(() => { twitch.stop(); vi.unstubAllGlobals(); });

const chatEvent = (id: string, userId: string, text: string) => ({
  broadcaster_user_id: '1',
  chatter_user_id: userId,
  chatter_user_login: userId === '1' ? 'streamer' : 'viewer',
  chatter_user_name: userId === '1' ? 'Streamer' : 'Viewer',
  message_id: id,
  message: { text, fragments: [{ type: 'text', text }] },
  badges: [],
});
const notify = (type: string, e: unknown) => (twitch as any).onNotification(type, e);

describe('TwitchService', () => {
  it('recognizes an automated echo before the HTTP reply when streamer and bot IDs match', async () => {
    secrets.twitchBot={...secrets.twitch!};
    state.patch('twitchBot',{status:'connected',account:state.current.twitch.account});
    handler=() => { notify('channel.chat.message',chatEvent('early','1','auto')); return {status:200,json:{data:[{is_sent:true}]}}; };
    await twitch.sendMessage('auto');
    expect(chat[0].fromSelf).toBe(true);
    notify('channel.chat.message',chatEvent('manual','1','!test'));
    expect(chat[1].fromSelf).toBeUndefined();
  });
  it('accepts manual streamer commands if the same account was connected as the bot, while ignoring automated echoes', async () => {
    secrets.twitchBot={...secrets.twitch!};
    state.patch('twitchBot',{status:'connected',account:state.current.twitch.account});
    notify('channel.chat.message',chatEvent('manual','1','!test'));
    expect(chat[0].fromSelf).toBeUndefined();
    expect(chat[0].roles.broadcaster).toBe(true);
    await twitch.sendMessage('reply');
    notify('channel.chat.message',chatEvent('sent1','1','reply'));
    expect(chat[1].fromSelf).toBe(true);
    notify('channel.chat.message',chatEvent('manual2','1','!test'));
    expect(chat[2].fromSelf).toBeUndefined();
  });
  it('sends automated messages with the separate bot token and sender ID', async () => {
    secrets.twitchBot = { ...secrets.twitch!, accessToken: 'bot-token', userId: '2', login: 'helper' };
    state.patch('twitchBot', { status: 'connected', account: { userId: '2', login: 'helper', displayName: 'Helper' } });
    await twitch.sendMessage('hello', 'reply');
    expect(calls[0]).toMatchObject({ auth: 'Bearer bot-token', body: { broadcaster_id: '1', sender_id: '2', message: 'hello', reply_parent_message_id: 'reply' } });
    notify('channel.chat.message', chatEvent('bot-echo', '2', 'hello'));
    expect(chat[0].fromSelf).toBe(true);
  });

  it('reports disconnected bot accounts instead of silently using the streamer', async () => {
    secrets.twitchBot = { ...secrets.twitch!, accessToken: 'bot-token', userId: '2' };
    await expect(twitch.sendMessage('hello')).rejects.toThrow('bot account is disconnected');
    expect(calls).toEqual([]);
  });

  it('reports a Twitch chat rejection and does not mark a later manual message as a bot echo', async () => {
    handler = () => ({ status: 200, json: { data: [{ is_sent: false, drop_reason: { message: 'Permission missing' } }] } });
    await expect(twitch.sendMessage('rejected')).rejects.toThrow('Permission missing');
    notify('channel.chat.message', chatEvent('manual', '1', 'rejected'));
    expect(chat[0].fromSelf).toBeUndefined();
  });

  it('does not mark the next identical manual message after recognizing a sent message ID', async () => {
    await twitch.sendMessage('same');
    notify('channel.chat.message', chatEvent('sent1', '1', 'same'));
    notify('channel.chat.message', chatEvent('manual', '1', 'same'));
    expect(chat.map((m) => !!m.fromSelf)).toEqual([true, false]);
  });

  it('cannot restore stream state after logout during a refresh', async () => {
    const pending: ((response: Response) => void)[] = [];
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { pending.push(resolve); }));
    const refresh = twitch.refreshStreamInfo();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    secrets.twitch = undefined;
    (twitch as any).onLoggedOut('broadcaster');
    pending.forEach((resolve) => resolve(new Response(JSON.stringify({ data: [{ title: 'Late title', game_id: '9', viewer_count: 100 }] }))));
    await refresh;
    expect(state.current.stream.title).not.toBe('Late title');
    expect(state.current.twitch.status).toBe('disconnected');
  });
  it('sends chat as the broadcaster and recognizes the echo as its own', async () => {
    await twitch.sendMessage('bot reply');
    const post = calls.find((c) => c.url.endsWith('/chat/messages'))!;
    expect(post.body).toEqual({ broadcaster_id: '1', sender_id: '1', message: 'bot reply' });
    notify('channel.chat.message', chatEvent('sent1', '1', 'bot reply'));
    expect(chat[0].fromSelf).toBe(true);
  });

  it('matches the echo by text when the notification beats the HTTP response', async () => {
    handler = () => ({ status: 200, json: { data: [{ is_sent: true }] } });
    await twitch.sendMessage('race');
    notify('channel.chat.message', chatEvent('x1', '1', 'race'));
    notify('channel.chat.message', chatEvent('x2', '1', 'race')); // the streamer typing the same thing later
    expect(chat.map((m) => !!m.fromSelf)).toEqual([true, false]);
  });

  it('does not mark messages the streamer typed in the app', async () => {
    await twitch.sendMessage('!title hi', undefined, { asBroadcaster: true });
    notify('channel.chat.message', chatEvent('sent1', '1', '!title hi'));
    expect(chat[0].fromSelf).toBeUndefined();
  });

  it('refreshes the token once on 401 and retries', async () => {
    handler = (c) => {
      if (c.url.includes('/oauth2/token')) return { status: 200, json: { access_token: 'new', refresh_token: 'r2', expires_in: 14000 } };
      if (c.auth === 'Bearer old') return { status: 401, json: { message: 'Invalid OAuth token' } };
      return { status: 204 };
    };
    await twitch.deleteMessage('m1');
    const helix = calls.filter((c) => c.url.includes('/moderation/chat'));
    expect(helix.map((c) => c.auth)).toEqual(['Bearer old', 'Bearer new']);
    expect(secrets.twitch?.refreshToken).toBe('r2');
    expect(secrets.twitch?.userId).toBe('1');
  });

  it('logs out when the refresh token is rejected', async () => {
    handler = (c) => (c.url.includes('/oauth2/token') ? { status: 400, json: { message: 'Invalid refresh token' } } : { status: 401 });
    await expect(twitch.deleteMessage('m1')).rejects.toThrow();
    expect(secrets.twitch).toBeUndefined();
    expect(state.current.twitch.status).toBe('disconnected');
  });

  it('turns EventSub notifications into bus events and stream state', () => {
    const events: string[] = [];
    bus.on('event', (e) => events.push(e.type));
    notify('channel.follow', { user_name: 'F', user_login: 'f' });
    notify('channel.subscribe', { user_name: 'G', tier: '1000', is_gift: true });
    notify('stream.online', { started_at: '2026-01-01T00:00:00Z' });
    notify('channel.update', { title: 'New', category_id: '9', category_name: 'Chess' });
    expect(events).toEqual(['follow']);
    expect(state.current.stream).toMatchObject({ live: true, title: 'New', categoryName: 'Chess' });
  });
});
