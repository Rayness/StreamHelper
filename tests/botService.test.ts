import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatRoles } from '@shared/types';
import { BotService } from '../src/main/bot/bot';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { PlatformRegistry, type ChatPlatform } from '../src/main/platforms/types';
import { SongRequestService } from '../src/main/features/songRequests';

class FakePlatform implements ChatPlatform {
  readonly platform = 'twitch' as const;
  sent: { text: string; replyTo?: string }[] = [];
  deleted: string[] = [];
  timeouts: [string, number][] = [];
  isChatReady() {
    return true;
  }
  async sendMessage(text: string, replyTo?: string) {
    this.sent.push({ text, replyTo });
  }
  async deleteMessage(id: string) {
    this.deleted.push(id);
  }
  async timeout(userId: string, seconds: number) {
    this.timeouts.push([userId, seconds]);
  }
  async ban() {}
  async getFollowedAt() {
    return Date.now() - 3 * 24 * 3600_000;
  }
  async shoutout(login: string) {
    return { displayName: login.toUpperCase(), category: 'Chess' };
  }
}

let seq = 0;
function msg(text: string, roles: Partial<ChatRoles> = {}, userId = 'u1'): ChatMessage {
  return {
    id: `m${seq++}`,
    platform: 'twitch',
    userId,
    userLogin: `user_${userId}`,
    userName: `User${userId}`,
    badges: [],
    roles: { broadcaster: false, moderator: false, vip: false, subscriber: false, ...roles },
    text,
    fragments: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

let platform: FakePlatform;
let bot: BotService;
let settings: SettingsStore;
let bus: EventBus;
const stream = { updateStream: vi.fn(async () => undefined), findCategory: vi.fn(async (q: string) => ({ id: '42', name: q })) };

beforeEach(() => {
  bus = new EventBus();
  settings = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'sh-')), 'settings.json'), bus, 'en');
  const state = new StateHub(bus);
  const ctx = { bus, settings, state, toast: vi.fn(), secrets: {}, openExternal: vi.fn(), mediaDir: '' } as unknown as AppContext;
  platform = new FakePlatform();
  const registry = new PlatformRegistry();
  registry.register(platform);
  bot = new BotService(ctx, registry, stream);
  bot.start();
  stream.updateStream.mockClear();
});

afterEach(() => { bot.stop(); settings.flush(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('BotService', () => {
  it('responds to broadcaster commands while the stream is offline', async () => {
    const b=settings.get('bot');
    settings.set('bot',{...b,commands:[{...b.commands[0],enabled:true,trigger:'test',aliases:[],response:'works offline',permission:'broadcaster',cooldownSec:0,userCooldownSec:0}]});
    await bot.onMessage(msg('!test',{broadcaster:true},'streamer'));
    expect(platform.sent.map((message)=>message.text)).toEqual(['works offline']);
  });
  it('accepts a song command through the real bot even with link moderation enabled', async () => {
    bot.stop();
    const state = new StateHub(bus);
    const ctx = { bus, settings, state } as AppContext;
    const registry = new PlatformRegistry(); registry.register(platform);
    const songs = new SongRequestService(ctx, { pauseCurrent: async () => null, resumeSource: async () => undefined } as any, () => undefined, (text, id) => platform.sendMessage(text, id), { lookup: async () => null });
    settings.set('songRequests', { ...settings.get('songRequests'), enabled:true });
    const config = settings.get('bot');
    settings.set('bot', { ...config, moderation:{ ...config.moderation, links:{ ...config.moderation.links, enabled:true, allowed:[] } } });
    bot = new BotService(ctx, registry, stream, songs);
    await bot.onMessage(msg('!sr https://youtu.be/M7lc1UVf-VE'));
    expect(settings.get('songQueue')).toMatchObject([{ source:'chat', videoId:'M7lc1UVf-VE' }]);
    expect(platform.sent[0].text).toContain('is queued at #1');
    expect(platform.deleted).toEqual([]);
  });
  it('answers custom commands and aliases with variables', async () => {
    const b = settings.get('bot');
    settings.set('bot', {
      ...b,
      commands: [{ ...b.commands[0], trigger: 'hi', aliases: ['hello'], response: 'Hi {user}, to {touser}!', cooldownSec: 0 }],
    });
    await bot.onMessage(msg('!hi @Bob'));
    await bot.onMessage(msg('!HELLO'));
    expect(platform.sent.map((s) => s.text)).toEqual(['Hi Useru1, to Bob!', 'Hi Useru1, to Useru1!']);
  });

  it('applies cooldowns but lets moderators through', async () => {
    const b = settings.get('bot');
    settings.set('bot', { ...b, commands: [{ ...b.commands[0], trigger: 'cd', aliases: [], response: 'x', cooldownSec: 60 }] });
    await bot.onMessage(msg('!cd'));
    await bot.onMessage(msg('!cd', {}, 'u2'));
    await bot.onMessage(msg('!cd', { moderator: true }, 'u3'));
    expect(platform.sent).toHaveLength(2);
  });

  it('respects permissions', async () => {
    const b = settings.get('bot');
    settings.set('bot', { ...b, commands: [{ ...b.commands[0], trigger: 'vip', aliases: [], response: 'ok', permission: 'vip', cooldownSec: 0 }] });
    await bot.onMessage(msg('!vip', { subscriber: true }));
    await bot.onMessage(msg('!vip', { vip: true }));
    expect(platform.sent).toHaveLength(1);
  });

  it('counts with {count+:name} and the !count builtin', async () => {
    const b = settings.get('bot');
    settings.set('bot', { ...b, commands: [{ ...b.commands[0], trigger: 'death', aliases: [], response: 'Deaths: {count+:deaths}', cooldownSec: 0 }] });
    await bot.onMessage(msg('!death'));
    await bot.onMessage(msg('!death'));
    await bot.onMessage(msg('!count deaths =10', { moderator: true }));
    expect(platform.sent.map((s) => s.text)).toEqual(['Deaths: 1', 'Deaths: 2', 'Counter deaths: 10']);
    expect(settings.get('bot').counters.deaths).toBe(10);
  });

  it('changes the title only for moderators', async () => {
    await bot.onMessage(msg('!title New title'));
    expect(stream.updateStream).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    await bot.onMessage(msg('!title New title', { moderator: true }, 'mod'));
    expect(stream.updateStream).toHaveBeenCalledWith({ title: 'New title' });
  });

  it('moderates links and honours !permit', async () => {
    const b = settings.get('bot');
    settings.set('bot', { ...b, moderation: { ...b.moderation, links: { ...b.moderation.links, enabled: true, action: 'timeout', timeoutSec: 30 } } });
    const bad = msg('buy at spam.com', {}, 'spammer');
    await bot.onMessage(bad);
    expect(platform.timeouts).toEqual([['spammer', 30]]);
    await bot.onMessage(msg('!permit user_friend', { moderator: true }, 'mod'));
    await bot.onMessage(msg('look spam.com', {}, 'friend'));
    expect(platform.timeouts).toHaveLength(1);
  });

  it('posts event messages but ignores test events', async () => {
    bus.emit('event', { id: 'e1', source: 'twitch', timestamp: 0, type: 'raid', userName: 'Raider', viewers: 10 });
    bus.emit('event', { id: 'e2', source: 'test', timestamp: 0, type: 'raid', userName: 'Test', viewers: 10 });
    await flush();
    expect(platform.sent.map((s) => s.text)).toEqual(['Welcome raiders from Raider!']);
  });

  it('never reacts to its own messages', async () => {
    const own = { ...msg('!commands'), fromSelf: true };
    await bot.onMessage(own);
    expect(platform.sent).toHaveLength(0);
  });
});
