import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import type { SecretsData } from '../src/main/core/secrets';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { KawakiApi, KawakiError } from '../src/main/integrations/kawaki/api';
import { fromWatchList, KawakiService } from '../src/main/integrations/kawaki/service';
import { BotService } from '../src/main/bot/bot';
import { PlatformRegistry, type ChatPlatform } from '../src/main/platforms/types';

type Route = (url: string, init: RequestInit) => { status: number; body: unknown };

function fakeFetch(route: Route) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { status, body } = route(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const ok = (data: unknown) => ({ status: 200, body: { ok: true, data } });
const fail = (status: number, code: string) => ({ status, body: { ok: false, error: { code, message: code } } });

function makeCtx(secrets: SecretsData = {}) {
  const bus = new EventBus();
  const settings = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'sh-')), 'settings.json'), bus, 'en');
  const state = new StateHub(bus);
  const store = { ...secrets };
  const secretStore = {
    get: (k: keyof SecretsData) => store[k],
    set: (k: keyof SecretsData, v: unknown) => {
      if (v === undefined) delete store[k];
      else (store as Record<string, unknown>)[k] = v;
    },
  };
  const ctx = { bus, settings, state, toast: vi.fn(), secrets: secretStore, openExternal: vi.fn(), mediaDir: '' } as unknown as AppContext;
  return { ctx, bus, settings, state, store };
}

const session = (over: Partial<NonNullable<SecretsData['kawaki']>> = {}) => ({
  accessToken: 'acc1',
  accessExpiresAt: Date.now() + 10 * 60_000,
  refreshToken: 'ref1',
  refreshExpiresAt: Date.now() + 90 * 86400_000,
  userId: 'u1',
  username: 'rayness',
  ...over,
});

const anime = { id: 'a1', externalId: 52991, title: 'Фрирен', titleEn: 'Frieren', posterUrl: 'p.jpg', episodeCount: 28 };

describe('KawakiApi', () => {
  it('unwraps envelopes and surfaces error codes', async () => {
    const { fn, calls } = fakeFetch((url) => (url.endsWith('/me') ? ok({ user: { id: 'u', username: 'x' } }) : fail(401, 'UNAUTHORIZED')));
    const api = new KawakiApi(() => 'https://kawaki.test/', fn);
    await expect(api.me('tok')).resolves.toEqual({ user: { id: 'u', username: 'x' } });
    expect(calls[0].url).toBe('https://kawaki.test/api/v1/me');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    await expect(api.nowWatching('tok')).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('treats a non-JSON 404 as NOT_FOUND', async () => {
    const fn = vi.fn(async () => new Response('<html>404</html>', { status: 404 })) as unknown as typeof fetch;
    const api = new KawakiApi(() => 'https://kawaki.test', fn);
    await expect(api.nowWatching('t')).rejects.toBeInstanceOf(KawakiError);
    await expect(api.nowWatching('t')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('KawakiService', () => {
  it('reads what is playing from /me/now-watching', async () => {
    const { ctx, state, bus } = makeCtx({ kawaki: session() });
    const { fn } = fakeFetch((url) => {
      if (url.includes('/me/now-watching')) return ok({ nowWatching: { anime, episode: { id: 'e', number: 12 }, progress: 300, duration: 1440, updatedAt: '' } });
      if (url.endsWith('/partners')) return ok({ partners: [{ slug: 'ray', displayName: 'Ray', username: 'Rayness' }] });
      return fail(404, 'NOT_FOUND');
    });
    const seen: unknown[] = [];
    bus.on('kawaki:now', (n) => seen.push(n));
    const svc = new KawakiService(ctx, { updateTitle: vi.fn(), canUpdateTitle: () => false }, new KawakiApi(() => 'https://kawaki.test', fn));
    await svc.refresh();
    await new Promise((r) => setTimeout(r, 5));
    const now = state.current.kawaki.nowWatching!;
    expect(now).toMatchObject({ title: 'Фрирен', episode: 12, episodesTotal: 28, progressSec: 300, source: 'live', url: 'https://kawaki.test/anime/52991' });
    expect(seen).toHaveLength(1);
    expect(state.current.kawaki.partner).toEqual({ slug: 'ray', displayName: 'Ray', liveUrl: 'https://kawaki.test/live/ray' });
    svc.stop();
  });

  it('falls back to the Watching list while the endpoint is not deployed', async () => {
    const { ctx, state } = makeCtx({ kawaki: session() });
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('/me/now-watching')) return fail(404, 'NOT_FOUND');
      if (url.includes('/me/watchlist')) return ok({ items: [{ episodesWatched: 4, anime }] });
      return ok({ partners: [] });
    });
    const svc = new KawakiService(ctx, { updateTitle: vi.fn(), canUpdateTitle: () => false }, new KawakiApi(() => 'https://kawaki.test', fn));
    await svc.refresh();
    await svc.refresh();
    expect(state.current.kawaki.nowWatching).toMatchObject({ source: 'list', episode: 5 });
    // The missing endpoint is asked once, not on every poll.
    expect(calls.filter((c) => c.url.includes('now-watching'))).toHaveLength(1);
  });

  it('refreshes an expired access token once for parallel calls and stores the rotated pair', async () => {
    const { ctx, store } = makeCtx({ kawaki: session({ accessExpiresAt: Date.now() - 1000 }) });
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/auth/refresh')
        ? ok({ tokens: { accessToken: 'acc2', accessTokenExpiresAt: Date.now() + 900_000, refreshToken: 'ref2', refreshTokenExpiresAt: Date.now() + 1e9, sessionId: 's' } })
        : fail(404, 'NOT_FOUND'),
    );
    const svc = new KawakiService(ctx, { updateTitle: vi.fn(), canUpdateTitle: () => false }, new KawakiApi(() => 'https://kawaki.test', fn));
    const [a, b] = await Promise.all([svc.token(), svc.token()]);
    expect([a, b]).toEqual(['acc2', 'acc2']);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(store.kawaki).toMatchObject({ accessToken: 'acc2', refreshToken: 'ref2', username: 'rayness' });
  });

  it('logs out locally when the refresh token is rejected', async () => {
    const { ctx, state, store } = makeCtx({ kawaki: session({ accessExpiresAt: 0 }) });
    const { fn } = fakeFetch(() => fail(401, 'INVALID_REFRESH_TOKEN'));
    const svc = new KawakiService(ctx, { updateTitle: vi.fn(), canUpdateTitle: () => false }, new KawakiApi(() => 'https://kawaki.test', fn));
    await svc.start();
    expect(store.kawaki).toBeUndefined();
    expect(state.current.kawaki.status).toBe('error');
    svc.stop();
  });

  it('renames the stream from the template when the episode changes', async () => {
    const { ctx, settings, state } = makeCtx({ kawaki: session() });
    settings.set('kawaki', { ...settings.get('kawaki'), autoTitle: true, titleTemplate: '{anime} — ep {episode}' });
    let ep = 1;
    const { fn } = fakeFetch((url) =>
      url.includes('/me/now-watching') ? ok({ nowWatching: { anime, episode: { id: 'e', number: ep }, progress: 1, duration: 10, updatedAt: '' } }) : ok({ partners: [] }),
    );
    const updateTitle = vi.fn(async () => undefined);
    const svc = new KawakiService(ctx, { updateTitle, canUpdateTitle: () => true }, new KawakiApi(() => 'https://kawaki.test', fn));
    await svc.refresh();
    await new Promise((r) => setTimeout(r, 5));
    expect(updateTitle).toHaveBeenCalledWith('Фрирен — ep 1');
    expect(state.current.kawaki.nowWatching!.episode).toBe(1);
    ep = 1;
    await svc.refresh();
    expect(updateTitle).toHaveBeenCalledTimes(1);
  });

  it('maps a Watching-list item to the next episode', () => {
    const api = new KawakiApi(() => 'https://kawaki.test');
    expect(fromWatchList({ episodesWatched: 28, anime }, api).episode).toBe(28);
    expect(fromWatchList({ anime }, api).episode).toBe(1);
  });
});

describe('!anime command', () => {
  it('answers with the Kawaki template or says nothing is playing', async () => {
    // Cooldowns capture Date.now when the bot is built, so fake time has to come first.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { ctx, state } = makeCtx();
    const sent: string[] = [];
    const platform: ChatPlatform = {
      platform: 'twitch',
      isChatReady: () => true,
      sendMessage: async (t) => void sent.push(t),
      deleteMessage: async () => undefined,
      timeout: async () => undefined,
      ban: async () => undefined,
      getFollowedAt: async () => null,
      shoutout: async () => null,
    };
    const reg = new PlatformRegistry();
    reg.register(platform);
    const bot = new BotService(ctx, reg, { updateStream: vi.fn(), findCategory: vi.fn() });
    const m = (text: string) => ({
      id: text + Math.random(),
      platform: 'twitch' as const,
      userId: 'u',
      userLogin: 'u',
      userName: 'U',
      badges: [],
      roles: { broadcaster: false, moderator: false, vip: false, subscriber: false },
      text,
      fragments: [],
      timestamp: 0,
    });
    try {
      await bot.onMessage(m('!anime'));
      state.patch('kawaki', {
        nowWatching: { animeId: 'a', externalId: 7, title: 'Frieren', titleEn: null, posterUrl: null, episode: 3, episodesTotal: null, progressSec: null, durationSec: null, url: 'https://kawaki.ru/anime/7', source: 'live' },
      });
      // Built-in commands share a 5-second cooldown.
      vi.setSystemTime(Date.now() + 6000);
      await bot.onMessage(m('!anime'));
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toEqual(['Not watching anything right now', 'Watching "Frieren", episode 3: https://kawaki.ru/anime/7']);
  });
});
