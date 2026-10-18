import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultTts } from '@shared/defaults';
import { ALL_OVERLAY_KINDS } from '@shared/profiles';
import { hasBlockedWord, hasProfanity, parseTtsMessage, parseVoiceCommand, pickSystemVoice, spokenName, textLang, ttsAllowed, ttsText, wavDurationMs } from '@shared/tts';
import type { ChatMessage, ChatRoles, OverlayMessage, TtsSystemVoice } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import { TtsService } from '../src/main/features/tts';
import type { SpeakJob } from '../src/main/features/ttsEngine';

const NONE: ChatRoles = { broadcaster: false, moderator: false, vip: false, subscriber: false };

function makeCtx() {
  const bus = new EventBus();
  const settings = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'sh-tts-')), 'settings.json'), bus, 'ru');
  const state = new StateHub(bus);
  const ctx = { bus, settings, state, toast: vi.fn(), secrets: {}, openExternal: vi.fn(), mediaDir: '' } as unknown as AppContext;
  return { ctx, bus, settings, state };
}

let seq = 0;
function chat(text: string, roles: Partial<ChatRoles> = {}, userId = 'u1'): ChatMessage {
  return { id: `m${seq++}`, platform: 'twitch', userId, userLogin: userId, userName: `User_${userId}`, badges: [], roles: { ...NONE, ...roles }, text, fragments: [{ type: 'text', text }], timestamp: Date.now() };
}

function wav(ms: number): Uint8Array {
  const byteRate = 32000;
  const data = Math.round((ms / 1000) * byteRate);
  const buf = new Uint8Array(46 + data);
  const v = new DataView(buf.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => { buf[at + i] = c.charCodeAt(0); });
  put(0, 'RIFF'); v.setUint32(4, 38 + data, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 18, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, byteRate, true);
  put(38, 'data'); v.setUint32(42, data, true);
  return buf;
}

describe('tts helpers', () => {
  it('checks roles: any enabled role is enough, "viewer" lets everyone in', () => {
    const roles = defaultTts('ru').roles;
    expect(ttsAllowed({ ...NONE, vip: true }, roles)).toBe(true);
    expect(ttsAllowed({ ...NONE, moderator: true }, roles)).toBe(true);
    expect(ttsAllowed({ ...NONE, subscriber: true }, roles)).toBe(false);
    expect(ttsAllowed(NONE, roles)).toBe(false);
    expect(ttsAllowed(NONE, { ...roles, viewer: true })).toBe(true);
    expect(ttsAllowed({ ...NONE, vip: true }, { ...roles, vip: false })).toBe(false);
  });

  it('reads messages with the prefix, or every message but commands', () => {
    const cfg = defaultTts('ru');
    expect(parseTtsMessage('!!! привет', cfg, '!')).toBe('привет');
    expect(parseTtsMessage('!!!привет', cfg, '!')).toBe('привет');
    expect(parseTtsMessage('!!!', cfg, '!')).toBeNull();
    expect(parseTtsMessage('просто текст', cfg, '!')).toBeNull();
    const all = { ...cfg, mode: 'all' as const };
    expect(parseTtsMessage('просто текст', all, '!')).toBe('просто текст');
    expect(parseTtsMessage('!!! с префиксом', all, '!')).toBe('с префиксом');
    expect(parseTtsMessage('!uptime', all, '!')).toBeNull();
  });

  it('parses the voice command', () => {
    const cfg = defaultTts('ru');
    expect(parseVoiceCommand('!tts keltuzad', cfg, '!')).toEqual({ kind: 'set', voice: 'lich' });
    expect(parseVoiceCommand("!TTS Кел'Тузад", cfg, '!')).toEqual({ kind: 'set', voice: 'lich' });
    expect(parseVoiceCommand('!tts робот', cfg, '!')).toEqual({ kind: 'set', voice: 'robot' });
    expect(parseVoiceCommand('!tts', cfg, '!')).toEqual({ kind: 'show' });
    expect(parseVoiceCommand('!tts сброс', cfg, '!')).toEqual({ kind: 'reset' });
    expect(parseVoiceCommand('!tts шрек', cfg, '!')).toEqual({ kind: 'unknown', word: 'шрек' });
    expect(parseVoiceCommand('!tts робот', { ...cfg, voices: ['female'] }, '!')).toEqual({ kind: 'unknown', word: 'робот' });
    expect(parseVoiceCommand('!ttsx', cfg, '!')).toBeNull();
    expect(parseVoiceCommand('!!! привет', cfg, '!')).toBeNull();
  });

  it('catches swearing without false alarms', () => {
    for (const bad of ['ну ты сука', 'Бля, опять', 'пиздец', 'нахуй', 'ХУЙ', 'xyй', 'х.у.й', 'заебал', 'уебок', 'what the fuck', 'Fucking hell', 'mudak мудак'])
      expect(hasProfanity(bad), bad).toBe(true);
    for (const ok of ['хлеба купи', 'себе и тебе', 'оскорблять нельзя', 'употреблять', 'бледный', 'мандарин', 'небо', 'художник', 'хуже некуда', 'Scunthorpe', 'мудрый', 'сукно', 'ребята привет', 'потребитель'])
      expect(hasProfanity(ok), ok).toBe(false);
  });

  it('cleans the text', () => {
    const cfg = defaultTts('ru');
    const m = { fragments: [{ type: 'text' as const, text: 'привет ' }, { type: 'emote' as const, text: 'Kappa', url: '' }] };
    expect(ttsText(m, 'привет Kappa', cfg, true)).toBe('привет');
    expect(ttsText({ fragments: [] }, 'смотри https://example.com/x ааааааа', cfg, true)).toBe('смотри ссылка ааа');
    expect(ttsText({ fragments: [] }, '!!! ???', cfg, true)).toBe('');
    expect(ttsText({ fragments: [] }, 'слово '.repeat(100), { ...cfg, maxLength: 30 }, true).length).toBeLessThanOrEqual(31);
    expect(hasBlockedWord('Плохое СЛОВО тут', ['слово'])).toBe(true);
    expect(hasBlockedWord('всё хорошо', ['', 'слово'])).toBe(false);
  });

  it('picks a Windows voice by gender and language', () => {
    const voices: TtsSystemVoice[] = [
      { name: 'Microsoft Irina Desktop', lang: 'ru-RU', gender: 'female', source: 'sapi' },
      { name: 'Microsoft Irina', lang: 'ru-RU', gender: 'female', source: 'onecore' },
      { name: 'Microsoft Pavel', lang: 'ru-RU', gender: 'male', source: 'onecore' },
      { name: 'Microsoft Zira Desktop', lang: 'en-US', gender: 'female', source: 'sapi' },
    ];
    expect(pickSystemVoice(voices, 'female', 'ru', '')?.name).toBe('Microsoft Irina');
    expect(pickSystemVoice(voices, 'male', 'ru', '')?.name).toBe('Microsoft Pavel');
    expect(pickSystemVoice(voices, 'male', 'en', '')?.name).toBe('Microsoft Zira Desktop');
    expect(pickSystemVoice(voices, 'female', 'ru', 'Microsoft Irina Desktop')?.name).toBe('Microsoft Irina Desktop');
    // The chosen voice doesn't speak English: an English one is used for English text.
    expect(pickSystemVoice(voices, 'female', 'en', 'Microsoft Irina')?.name).toBe('Microsoft Zira Desktop');
    expect(pickSystemVoice([], 'female', 'ru', '')).toBeNull();
    expect(textLang('Привет, chat')).toBe('ru');
    expect(textLang('hello')).toBe('en');
    expect(spokenName('Cool_Guy42')).toBe('Cool Guy 42');
  });

  it('reads the WAV length, including an 18-byte fmt chunk', () => {
    expect(wavDurationMs(wav(1500))).toBe(1500);
    expect(wavDurationMs(new Uint8Array(10))).toBe(0);
  });

  it('is a known overlay kind', () => {
    expect(ALL_OVERLAY_KINDS).toContain('tts');
  });
});

describe('TtsService', () => {
  function setup(patch: Partial<ReturnType<typeof defaultTts>> = {}) {
    const env = makeCtx();
    env.settings.set('tts', { ...env.settings.get('tts'), enabled: true, command: 'tts', cooldownSec: 0, ...patch });
    const sent: OverlayMessage[] = [];
    let release: (() => void) | null = null;
    const speak = vi.fn(async (_job: SpeakJob) => {
      await new Promise<void>((r) => { release = r; });
      return { url: '/tts/x.wav', wav: wav(1000) };
    });
    const voices = vi.fn(async (): Promise<TtsSystemVoice[]> => [{ name: 'Microsoft Pavel', lang: 'ru-RU', gender: 'male', source: 'onecore' }]);
    const said: string[] = [];
    let stored: Record<string, string> = {};
    const svc = new TtsService(env.ctx, {
      broadcast: (m) => sent.push(m), speak, voices,
      say: async (text) => { said.push(text); },
      loadUserVoices: () => stored as never,
      saveUserVoices: (v) => { stored = { ...v }; },
    });
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    return { ...env, svc, sent, speak, flush, said, stored: () => stored, done: async () => { await flush(); release?.(); await flush(); } };
  }

  it('reads allowed roles only and plays one message at a time', async () => {
    vi.useFakeTimers();
    const { bus, svc, sent, speak, done, state } = setup();
    bus.emit('chat:message', chat('!!! от зрителя'));
    bus.emit('chat:message', chat('!!! от випа', { vip: true }, 'v'));
    bus.emit('chat:message', chat('!!! от модера', { moderator: true }, 'm'));
    await done();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toMatchObject({ text: 'User v пишет: от випа' });
    expect(sent).toHaveLength(1);
    expect(state.current.tts.queue.map((q) => q.text)).toEqual(['от модера']);
    vi.advanceTimersByTime(1700);
    await done();
    expect(speak).toHaveBeenCalledTimes(2);
    svc.dispose();
    vi.useRealTimers();
  });

  it('uses the male Windows voice for male presets', async () => {
    const { svc } = setup();
    const job = await svc.job({ id: 'x', messageId: null, userId: '', userName: 'A', text: 'привет', voice: 'giant', reason: 'test', at: 0 });
    expect(job).toMatchObject({ voice: 'Microsoft Pavel', source: 'onecore', pitch: 0, text: 'привет' });
  });

  it('applies the per-viewer cooldown but not to the streamer', async () => {
    const { bus, state } = setup({ cooldownSec: 60, queueMax: 10 });
    bus.emit('chat:message', chat('!!! раз', { vip: true }, 'v'));
    bus.emit('chat:message', chat('!!! два', { vip: true }, 'v'));
    bus.emit('chat:message', chat('!!! три', { broadcaster: true }, 's'));
    bus.emit('chat:message', chat('!!! четыре', { broadcaster: true }, 's'));
    const texts = [state.current.tts.current, ...state.current.tts.queue].map((i) => i?.text);
    expect(texts).toEqual(['раз', 'три', 'четыре']);
  });

  it('drops a deleted message and respects the queue limit', async () => {
    const { bus, state } = setup({ queueMax: 1 });
    bus.emit('chat:message', chat('!!! первое', { vip: true }, 'a'));
    const second = chat('!!! второе', { vip: true }, 'b');
    bus.emit('chat:message', second);
    bus.emit('chat:message', chat('!!! третье', { vip: true }, 'c'));
    expect(state.current.tts.queue.map((q) => q.text)).toEqual(['второе']);
    bus.emit('chat:delete', { id: second.id });
    expect(state.current.tts.queue).toEqual([]);
  });

  it('skips the current message and stops the overlay', async () => {
    const { bus, svc, sent, state } = setup();
    bus.emit('chat:message', chat('!!! первое', { vip: true }, 'a'));
    expect(state.current.tts.current?.text).toBe('первое');
    svc.skip();
    expect(sent).toContainEqual({ type: 'ttsStop' });
    expect(state.current.tts.current).toBeNull();
  });

  it('reads a channel points reward for anyone', async () => {
    const { bus, state } = setup({ rewardTitle: 'Озвучка' });
    bus.emit('event', { id: 'r1', source: 'twitch', type: 'redemption', userName: 'Fan', timestamp: Date.now(), rewardTitle: 'озвучка', cost: 100, input: 'Всем привет' });
    expect(state.current.tts.current).toMatchObject({ text: 'Всем привет', reason: 'reward' });
  });

  it('remembers the voice a viewer picked and uses it for their messages', () => {
    const { bus, state, said, stored, svc } = setup({ queueMax: 10 });
    bus.emit('chat:message', chat('!tts keltuzad', { vip: true }, 'v'));
    expect(said[0]).toContain('келтузад');
    expect(stored()).toEqual({ v: 'lich' });
    expect(state.current.tts.remembered).toBe(1);
    // The command itself is not read.
    expect(state.current.tts.current).toBeNull();
    bus.emit('chat:message', chat('!!! я лич', { vip: true }, 'v'));
    bus.emit('chat:message', chat('!!! а я обычный', { moderator: true }, 'm'));
    expect([state.current.tts.current, ...state.current.tts.queue].map((i) => [i?.text, i?.voice])).toEqual([['я лич', 'lich'], ['а я обычный', 'female']]);
    svc.dispose();
  });

  it('keeps the choice between runs and forgets it on reset', () => {
    const env = setup();
    env.bus.emit('chat:message', chat('!tts робот', { vip: true }, 'v'));
    expect(env.svc.voiceOf('v')).toBe('robot');
    env.settings.set('tts', { ...env.settings.get('tts'), voices: ['female'] });
    expect(env.svc.voiceOf('v')).toBe('female');
    env.bus.emit('chat:message', chat('!tts сброс', { vip: true }, 'v'));
    expect(env.stored()).toEqual({});
    env.settings.set('tts', { ...env.settings.get('tts'), voices: ['giant'] });
    const again = new TtsService(env.ctx, { broadcast: () => 0, speak: env.speak, voices: async () => [], say: async () => undefined, loadUserVoices: () => ({ x: 'giant' }), saveUserVoices: () => undefined });
    expect(again.voiceOf('x')).toBe('giant');
  });

  it("doesn't let viewers without a role pick voices", () => {
    const { bus, said, stored } = setup();
    bus.emit('chat:message', chat('!tts робот'));
    expect(said).toEqual([]);
    expect(stored()).toEqual({});
  });

  it('skips swearing and the bot banned words', () => {
    const { bus, settings, state } = setup({ mode: 'all', queueMax: 10 });
    const bot = settings.get('bot');
    settings.set('bot', { ...bot, moderation: { ...bot.moderation, words: { ...bot.moderation.words, list: ['казино'] } } });
    bus.emit('chat:message', chat('ну ты сука', { vip: true }, 'a'));
    bus.emit('chat:message', chat('заходи в казино', { vip: true }, 'b'));
    bus.emit('chat:message', chat('всем привет', { vip: true }, 'c'));
    expect([state.current.tts.current, ...state.current.tts.queue].map((i) => i?.text)).toEqual(['всем привет']);
  });

  it('does nothing while switched off', () => {
    const { bus, state } = setup({ enabled: false });
    bus.emit('chat:message', chat('!!! привет', { broadcaster: true }));
    expect(state.current.tts.current).toBeNull();
  });
});
