import type { ChatMessage, ChatRoles, TtsEffect, TtsRoles, TtsSettings, TtsSystemVoice, TtsVoiceId } from './types';

export interface TtsVoiceDef {
  id: TtsVoiceId;
  gender: 'female' | 'male';
  /** Windows speaking rate, 1 = normal (0.5–6). */
  rate: number;
  /** Windows pitch, 1 = normal (0–2). */
  pitch: number;
  effect: TtsEffect;
  /** Names viewers type after the command: "!tts robot hi". */
  aliases: string[];
}

export const TTS_VOICES: readonly TtsVoiceDef[] = [
  { id: 'female', gender: 'female', rate: 1, pitch: 1, effect: 'none', aliases: ['female', 'woman', 'женский', 'женщина', 'девушка'] },
  { id: 'male', gender: 'male', rate: 1, pitch: 1, effect: 'none', aliases: ['male', 'man', 'мужской', 'мужчина', 'парень'] },
  { id: 'chipmunk', gender: 'female', rate: 1.3, pitch: 2, effect: 'none', aliases: ['chipmunk', 'бурундук'] },
  { id: 'giant', gender: 'male', rate: 0.8, pitch: 0, effect: 'none', aliases: ['giant', 'великан', 'бас'] },
  { id: 'robot', gender: 'male', rate: 0.9, pitch: 0.6, effect: 'robot', aliases: ['robot', 'робот'] },
  { id: 'radio', gender: 'male', rate: 1.1, pitch: 1, effect: 'radio', aliases: ['radio', 'рация', 'радио'] },
  { id: 'fast', gender: 'female', rate: 2.2, pitch: 1.1, effect: 'none', aliases: ['fast', 'тараторка', 'быстрый'] },
  { id: 'lich', gender: 'male', rate: 0.75, pitch: 0, effect: 'echo', aliases: ['keltuzad', 'kelthuzad', 'lich', 'келтузад', 'кельтузад', 'лич'] },
];

export const ttsVoice = (id: TtsVoiceId): TtsVoiceDef => TTS_VOICES.find((v) => v.id === id) ?? TTS_VOICES[0];

/** Whether a chatter with these roles may have messages read. Every matching role counts. */
export function ttsAllowed(roles: ChatRoles, allowed: TtsRoles): boolean {
  if (allowed.viewer) return true;
  return (roles.broadcaster && allowed.broadcaster) || (roles.moderator && allowed.moderator) || (roles.vip && allowed.vip) || (roles.subscriber && allowed.subscriber);
}

/**
 * What to read from a chat message, or null when it isn't for TTS. `all` reads every message except
 * commands; `prefix` only messages starting with the trigger ("!!! hello"), without it.
 */
export function parseTtsMessage(text: string, cfg: Pick<TtsSettings, 'mode' | 'trigger'>, prefix: string): string | null {
  const trimmed = text.trim();
  const trigger = cfg.trigger.trim();
  if (trigger && trimmed.startsWith(trigger)) return trimmed.slice(trigger.length).trim() || null;
  if (cfg.mode === 'prefix') return null;
  if (prefix && trimmed.startsWith(prefix)) return null;
  return trimmed || null;
}

const RESET_WORDS = ['reset', 'default', 'сброс', 'сбросить', 'обычный'];

export type TtsVoiceCommand =
  | { kind: 'show' }
  | { kind: 'set'; voice: TtsVoiceId }
  | { kind: 'reset' }
  | { kind: 'unknown'; word: string };

/** "!tts" (show), "!tts robot" (pick), "!tts reset" (forget); null when it's not the voice command. */
export function parseVoiceCommand(text: string, cfg: Pick<TtsSettings, 'command' | 'voices' | 'voice'>, prefix: string): TtsVoiceCommand | null {
  const command = cfg.command.trim().toLowerCase();
  if (!command) return null;
  const [first = '', ...rest] = text.trim().split(/\s+/);
  if (first.toLowerCase() !== `${prefix}${command}`) return null;
  const word = rest.join('').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!word) return { kind: 'show' };
  if (RESET_WORDS.includes(word)) return { kind: 'reset' };
  const voice = TTS_VOICES.find((v) => v.aliases.includes(word) && (cfg.voices.includes(v.id) || cfg.voice === v.id));
  return voice ? { kind: 'set', voice: voice.id } : { kind: 'unknown', word };
}

/** What viewers type to pick a voice, in the given language. */
export function voiceAlias(id: TtsVoiceId, ru: boolean): string {
  const v = ttsVoice(id);
  return v.aliases.find((a) => /[а-яё]/i.test(a) === ru) ?? v.aliases[0];
}

// Roots of Russian and English swearing. Russian roots are matched at the start of a word (after
// a usual prefix) so "хлеба", "оскорблять" or "употреблять" are not caught.
const RU_PREFIX = '(?:за|от|у|вы|до|на|по|при|раз|рас|под|про|пере|съ|из|недо|об|с|в|о|ни)?';
const PROFANITY = [
  new RegExp(`(?:^|[^а-я])${RU_PREFIX}(?:ху[йеияю]|пизд|п[иеё]д[оа]р|еб[аёлнуиыщ]|ебе[тш]|уеб|бля|муда|муди|гандон|залуп|шлюх|сук[аиу]|сучк|дроч)`, 'u'),
  /\b(?:fuck|shit|bitch|cunt|nigg|fag+ot|whore|dickhead|asshole|motherf)/,
];
/** Latin look-alikes people type to slip past filters ("xyй"). */
const LOOKALIKE: Record<string, string> = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', b: 'в', h: 'н', '0': 'о', '3': 'з', '6': 'б', 'ё': 'е' };

export function hasProfanity(text: string): boolean {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  if (PROFANITY[1].test(lower)) return true;
  // Words mixing scripts are read as Cyrillic; separators inside a word ("х.у.й") are dropped.
  const words = lower.split(/\s+/).map((w) => {
    const joined = w.replace(/[.\-_*]+/g, '');
    return /[а-я]/.test(joined) ? [...joined].map((ch) => LOOKALIKE[ch] ?? ch).join('') : joined;
  });
  return words.some((w) => PROFANITY[0].test(w));
}

const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:com|ru|tv|net|org|io|gg|me|ly|be)(?:\/\S*)?/gi;

/**
 * The text as it should sound: without emotes and links if asked, "аааааа" shortened, cut to the
 * limit. Empty when nothing is left to read.
 */
export function ttsText(m: Pick<ChatMessage, 'fragments'>, body: string, cfg: Pick<TtsSettings, 'skipEmotes' | 'skipLinks' | 'maxLength'>, ru: boolean): string {
  let text = body;
  if (cfg.skipEmotes) {
    const emotes = new Set(m.fragments.filter((f) => f.type === 'emote').map((f) => f.text));
    if (emotes.size) text = text.split(/\s+/).filter((w) => !emotes.has(w)).join(' ');
  }
  if (cfg.skipLinks) text = text.replace(LINK, ru ? 'ссылка' : 'link');
  text = text
    .replace(/(.)\1{3,}/gu, '$1$1$1')
    .replace(/\s+/g, ' ')
    .trim();
  const max = Math.max(10, cfg.maxLength);
  if (text.length > max) text = `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

export function hasBlockedWord(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => w.trim() && lower.includes(w.trim().toLowerCase()));
}

/** "ru" when the text is mostly Cyrillic, otherwise "en". */
export function textLang(text: string): 'ru' | 'en' {
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  return cyr >= lat && cyr > 0 ? 'ru' : 'en';
}

/** "Cool_Guy_42" → "Cool Guy 42", so the name sounds like a name. */
export function spokenName(name: string): string {
  return name.replace(/[_\-.]+/g, ' ').replace(/([a-zа-яё])(\d)/gi, '$1 $2').trim();
}

/**
 * The Windows voice for a message: the streamer's choice for that gender if it speaks the message's
 * language, otherwise one of that language and gender, then any voice of that language.
 */
export function pickSystemVoice(voices: TtsSystemVoice[], gender: 'female' | 'male', lang: 'ru' | 'en', preferred: string): TtsSystemVoice | null {
  const ofLang = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const chosen = voices.find((v) => v.name === preferred);
  if (chosen && (chosen.lang.toLowerCase().startsWith(lang) || !ofLang.length)) return chosen;
  // OneCore voices sound better and include male Russian voices; desktop ones are the fallback.
  const rank = (list: TtsSystemVoice[]) => [...list].sort((a, b) => (a.source === b.source ? 0 : a.source === 'onecore' ? -1 : 1));
  return rank(ofLang.filter((v) => v.gender === gender))[0] ?? rank(ofLang)[0] ?? rank(voices.filter((v) => v.gender === gender))[0] ?? rank(voices)[0] ?? null;
}

/** Length of a PCM WAV file in milliseconds, 0 when the header can't be read. */
export function wavDurationMs(buf: Uint8Array): number {
  if (buf.length < 44) return 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (at: number) => String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 0;
  let byteRate = 0;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 16 <= buf.length) byteRate = view.getUint32(at + 16, true);
    if (id === 'data') return byteRate ? Math.round((Math.min(size, buf.length - at - 8) / byteRate) * 1000) : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}
