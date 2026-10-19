import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { maskProfanity } from '@shared/tts';
import type { OverlayMessage, Settings } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CaptionsService, createCaptionsRoutes, parseHeard } from '../src/main/features/captions';
import { telegramChatId, TelegramService, validTelegramToken } from '../src/main/integrations/telegram';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const MIN = 60_000;

function context(lang: 'ru' | 'en' = 'en') {
  const bus = new EventBus();
  const state = new StateHub(bus);
  let settings: Settings = defaultSettings(lang);
  const secrets: Record<string, unknown> = {};
  const ctx = {
    bus, state,
    settings: {
      get: (key: keyof Settings) => settings[key],
      set: (key: keyof Settings, value: never) => { settings = { ...settings, [key]: value }; bus.emit('settings:changed', key); },
    },
    secrets: { get: (key: string) => secrets[key], set: (key: string, value: unknown) => { secrets[key] = value; } },
    toast: vi.fn(),
  } as unknown as AppContext;
  return { ctx, bus, state, secrets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('telegram helpers', () => {
  it('accepts bot tokens and channel names in the usual forms', () => {
    expect(validTelegramToken(TOKEN)).toBe(true);
    expect(validTelegramToken('nope')).toBe(false);
    expect(telegramChatId('https://t.me/my_channel')).toBe('@my_channel');
    expect(telegramChatId('@my_channel')).toBe('@my_channel');
    expect(telegramChatId('my_channel')).toBe('@my_channel');
    expect(telegramChatId('-1001234567890')).toBe('-1001234567890');
    expect(telegramChatId('a b')).toBe('');
  });
});

describe('telegram announcements', () => {
  function setup() {
    vi.useFakeTimers();
    const env = context();
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let nextId = 100;
    const fail: Record<string, string> = {};
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      const method = url.split('/').pop()!;
      const body = JSON.parse(init.body);
      calls.push({ method, body });
      if (fail[method]) return { status: 400, json: async () => ({ ok: false, error_code: 400, description: fail[method] }) };
      const result = method === 'getMe' ? { id: 7, username: 'my_bot' }
        : method === 'getChat' ? { id: -1001, type: 'channel', title: 'My channel' }
          : method === 'getChatMember' ? { status: 'administrator', can_post_messages: true }
            : method.startsWith('send') ? { message_id: nextId++ } : true;
      return { status: 200, json: async () => ({ ok: true, result }) };
    });
    const tg = new TelegramService(env.ctx, { fetch: fetchMock as unknown as typeof fetch });
    env.state.patch('twitch', { status: 'connected', account: { userId: '1', login: 'streamer', displayName: 'Streamer' } });
    const live = (on: boolean, startedAt: number | null = Date.now()) => {
      env.state.patch('stream', { ...env.state.current.stream, live: on, title: 'Speedrun', categoryName: 'Celeste', startedAt: on ? startedAt : null });
      env.bus.emit('stream:update', env.state.current.stream);
    };
    return { ...env, tg, calls, fail, live, fetchMock, methods: () => calls.map((c) => c.method) };
  }

  it('checks the bot and the channel before saving them', async () => {
    const { tg, ctx, state, fail, secrets } = setup();
    await expect(tg.connect('bad', '@x_channel')).rejects.toThrow('bot token');
    fail.getChatMember = 'member not found';
    await expect(tg.connect(TOKEN, '@my_channel')).rejects.toThrow();
    expect(secrets.telegramBotToken).toBeUndefined();
    delete fail.getChatMember;
    await tg.connect(TOKEN, 't.me/my_channel');
    expect(ctx.settings.get('telegram')).toMatchObject({ enabled: true, chatId: '-1001', chatTitle: 'My channel', botName: 'my_bot' });
    expect(state.current.telegram.status).toBe('connected');
    expect(secrets.telegramBotToken).toBe(TOKEN);
  });

  it('posts once after the delay, pins it, and turns it into "ended" when the stream stops', async () => {
    const { tg, ctx, calls, live, methods } = setup();
    await tg.connect(TOKEN, '@my_channel');
    ctx.settings.set('telegram', { ...ctx.settings.get('telegram'), pin: true, delaySec: 60 });
    calls.length = 0;
    live(true);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await tg.idle();
    expect(methods()).toEqual(['sendPhoto', 'pinChatMessage']);
    const photo = calls[0].body;
    expect(photo.chat_id).toBe('-1001');
    expect(String(photo.photo)).toContain('live_user_streamer-1280x720.jpg');
    expect(photo.caption).toBe('🔴 Live now!\nSpeedrun\nPlaying: Celeste\nhttps://twitch.tv/streamer');
    expect(photo.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Watch', url: 'https://twitch.tv/streamer' }]] });
    await vi.advanceTimersByTimeAsync(90 * MIN);
    live(false);
    await tg.idle();
    expect(methods().slice(2)).toEqual(['editMessageCaption', 'unpinChatMessage']);
    expect(calls[2].body).toMatchObject({ message_id: 100, caption: '⚫ Stream ended (1h 31m). Thanks for watching!\nSpeedrun' });
    expect(calls[2].body.reply_markup).toBeUndefined();
  });

  it('does not post again after a restart mid-stream or a short drop, and falls back to text without a preview', async () => {
    const { tg, ctx, state, calls, live, methods, fail, fetchMock } = setup();
    await tg.connect(TOKEN, '@my_channel');
    ctx.settings.set('telegram', { ...ctx.settings.get('telegram'), delaySec: 0 });
    fail.sendPhoto = 'wrong file identifier/HTTP URL specified';
    calls.length = 0;
    const startedAt = Date.now();
    live(true, startedAt);
    await vi.advanceTimersByTimeAsync(0);
    await tg.idle();
    expect(methods()).toEqual(['sendPhoto', 'sendMessage']);
    // The app restarts: it starts offline and then learns the stream is live.
    tg.dispose();
    state.patch('stream', { ...state.current.stream, live: false });
    const again = new TelegramService(ctx, { fetch: fetchMock as unknown as typeof fetch });
    live(true, startedAt);
    await vi.advanceTimersByTimeAsync(5000);
    await again.idle();
    expect(methods()).toHaveLength(2);
    // Dropped and back within minutes: the post comes back instead of a new one.
    live(false);
    await again.idle();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    live(true, Date.now());
    await vi.advanceTimersByTimeAsync(0);
    await again.idle();
    expect(methods().slice(2)).toEqual(['editMessageText', 'editMessageText']);
    expect(calls[2].body.text).toContain('Stream ended');
    expect(calls[3].body.text).toContain('Live now');
    again.dispose();
  });

  it('skips a stream that ended before its announcement', async () => {
    const { tg, ctx, calls, live } = setup();
    await tg.connect(TOKEN, '@my_channel');
    calls.length = 0;
    live(true);
    await vi.advanceTimersByTimeAsync(30_000);
    live(false);
    await vi.advanceTimersByTimeAsync(120_000);
    await tg.idle();
    expect(calls).toHaveLength(0);
    expect(ctx.settings.get('telegram').enabled).toBe(true);
  });
});

describe('live captions', () => {
  function setup(patch: Partial<Settings['captions']> = {}) {
    const env = context();
    env.ctx.settings.set('captions', { ...env.ctx.settings.get('captions'), enabled: true, maxLines: 2, ...patch });
    const sent: OverlayMessage[] = [];
    let now = 1_000_000;
    const captions = new CaptionsService(env.ctx, { broadcast: (m) => void sent.push(m), now: () => now });
    const last = () => sent[sent.length - 1] as Extract<OverlayMessage, { type: 'captions' }>;
    return { ...env, captions, sent, last, tick: (ms: number) => { now += ms; } };
  }

  it('checks what the page sends', () => {
    expect(parseHeard({ text: ' hi   there ', final: true })).toEqual({ text: 'hi there', final: true });
    expect(parseHeard({ text: 'x', final: 'yes' })).toBeNull();
    expect(parseHeard(null)).toBeNull();
    expect(parseHeard({ text: 'a'.repeat(1000), final: false })?.text).toHaveLength(400);
  });

  it('shows the phrase being spoken, then keeps the last finished lines', () => {
    const { captions, last, state } = setup();
    captions.hear({ text: 'hello', final: false });
    expect(last()).toMatchObject({ interim: 'hello', lines: [] });
    captions.hear({ text: 'hello world', final: true, translation: 'привет мир' });
    captions.hear({ text: 'second', final: true });
    captions.hear({ text: 'third', final: true });
    expect(last().interim).toBe('');
    expect(last().lines.map((l) => l.text)).toEqual(['second', 'third']);
    expect(state.current.captions.lines.map((l) => l.text)).toEqual(['hello world', 'second', 'third']);
    expect(state.current.captions.lines[0].translation).toBe('привет мир');
    expect(state.current.captions.listening).toBe(true);
    captions.dispose();
  });

  it('hides swearing, ignores the page while captions are off, and forgets a closed page', () => {
    const { captions, last, ctx, sent, state, tick } = setup();
    captions.hear({ text: 'ну блять опять', final: true });
    expect(last().lines[0].text).toBe('ну б*** опять');
    ctx.settings.set('captions', { ...ctx.settings.get('captions'), enabled: false });
    const count = sent.length;
    captions.hear({ text: 'not shown', final: true });
    expect(sent).toHaveLength(count);
    expect(state.current.captions.lines).toEqual([]);
    tick(100_000);
    (captions as unknown as { check(): void }).check();
    expect(state.current.captions.listening).toBe(false);
    captions.dispose();
  });

  it('serves the microphone page and takes its text only with the token', async () => {
    const { captions, ctx, state } = setup();
    const routes = createCaptionsRoutes({
      token: 'secret-token',
      htmlPath: join(__dirname, '..', 'resources', 'overlays', 'captions-mic.html'),
      service: captions,
      settings: () => ({ captions: ctx.settings.get('captions'), language: 'en' }),
    });
    const server = createServer((req, res) => {
      void routes(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/captions/mic`)).status).toBe(403);
      expect((await fetch(`${base}/captions/mic?token=wrong-token!`)).status).toBe(403);
      const page = await fetch(`${base}/captions/mic?token=secret-token`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('webkitSpeechRecognition');
      expect(await (await fetch(`${base}/captions/config?token=secret-token`)).json()).toMatchObject({ enabled: true, language: 'en-US', translateTo: '' });
      const post = (path: string, body: unknown) => fetch(`${base}/captions/${path}?token=secret-token`, { method: 'POST', body: JSON.stringify(body) });
      expect((await post('push', { text: 'from the browser', final: true })).status).toBe(200);
      expect(state.current.captions.lines.map((l) => l.text)).toEqual(['from the browser']);
      expect((await post('push', { nope: 1 })).status).toBe(400);
      await post('ping', { error: 'mic blocked' });
      expect(state.current.captions.error).toBe('mic blocked');
    } finally {
      server.close();
      captions.dispose();
    }
  });

  it('masks swear words but keeps ordinary ones', () => {
    expect(maskProfanity('хлеба и сука, ладно')).toBe('хлеба и с***, ладно');
    expect(maskProfanity('what the fuck!')).toBe('what the f***!');
  });
});
