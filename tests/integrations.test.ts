import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { normalizeStreamElementsTip } from '../src/main/donations/streamelements';
import { DiscordService, validDiscordWebhook } from '../src/main/integrations/discord';
import { StreamerBotService } from '../src/main/integrations/streamerbot';

function context() {
  const bus = new EventBus();
  const state = new StateHub(bus);
  let settings = defaultSettings('en');
  const secretValues: Record<string, string | undefined> = {};
  const ctx = {
    bus, state,
    settings: {
      get: (key: keyof typeof settings) => settings[key],
      set: (key: keyof typeof settings, value: never) => { settings = { ...settings, [key]: value }; },
    },
    secrets: {
      get: (key: string) => secretValues[key],
      set: (key: string, value: string | undefined) => { secretValues[key] = value; },
    },
  } as unknown as AppContext;
  return { ctx, bus, state };
}

afterEach(() => vi.unstubAllGlobals());

describe('StreamElements tips', () => {
  const packet = {
    type: 'message', topic: 'channel.tips', data: {
      _id: 'tip-1', status: 'success', approved: 'allowed', createdAt: '2026-09-26T12:00:00Z',
      donation: { user: { username: 'Viewer' }, amount: 4.2, currency: 'USD', message: 'Hi' },
    },
  };

  it('normalizes a completed tip for shared alerts and goals', () => {
    expect(normalizeStreamElementsTip(packet, 'Anonymous')).toMatchObject({
      id: 'se_tip-1', source: 'streamelements', type: 'donation', userName: 'Viewer', amount: 4.2,
    });
  });

  it('ignores pending, blocked, and unrelated events', () => {
    expect(normalizeStreamElementsTip({ ...packet, topic: 'channel.activities' }, 'Anonymous')).toBeNull();
    expect(normalizeStreamElementsTip({ ...packet, data: { ...packet.data, status: 'pending' } }, 'Anonymous')).toBeNull();
    expect(normalizeStreamElementsTip({ ...packet, data: { ...packet.data, approved: 'blocked' } }, 'Anonymous')).toBeNull();
  });
});

describe('Streamer.bot HTTP integration', () => {
  it('loads actions and executes the selected ID on loopback', async () => {
    const { ctx, state } = context();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ actions: [{ id: 'abc', name: 'Confetti' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    const service = new StreamerBotService(ctx);
    service.connect(7474);
    await vi.waitFor(() => expect(state.current.streamerbot.status).toBe('connected'));
    expect(state.current.streamerbot.actions).toEqual([{ id: 'abc', name: 'Confetti' }]);
    await service.run('abc');
    expect(fetchMock).toHaveBeenLastCalledWith('http://127.0.0.1:7474/DoAction', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: { id: 'abc' } }),
    }));
    service.stop();
  });
});

describe('Discord webhook integration', () => {
  const url = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz';

  it('accepts only Discord webhook endpoints', () => {
    expect(validDiscordWebhook(url)).toBe(true);
    expect(validDiscordWebhook('https://example.com/api/webhooks/123456789012345678/token')).toBe(false);
    expect(validDiscordWebhook('http://discord.com/api/webhooks/123456789012345678/token')).toBe(false);
  });

  it('announces the live transition once and disables mentions', async () => {
    const { ctx, bus } = context();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    const discord = new DiscordService(ctx);
    discord.connect(url);
    const live = { ...ctx.state.current.stream, live: true, title: '@everyone Watch me!' };
    bus.emit('stream:update', live);
    bus.emit('stream:update', live);
    await discord.test();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });
});
