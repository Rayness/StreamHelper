import type { ChatMessage, OverlayMessage, StreamEvent, TtsItem, TtsPlayback, TtsSettings, TtsState, TtsSystemVoice, TtsVoiceId } from '@shared/types';
import { hasBlockedWord, hasProfanity, parseTtsMessage, parseVoiceCommand, pickSystemVoice, spokenName, textLang, ttsAllowed, ttsText, ttsVoice, voiceAlias, wavDurationMs } from '@shared/tts';
import { matchesBannedWord } from '../bot/moderation';
import { errorMessage, type AppContext } from '../core/context';
import type { SpeakJob } from './ttsEngine';

const HISTORY = 15;
/** Silence between two messages. */
const GAP_MS = 600;

export interface TtsDeps {
  broadcast(message: OverlayMessage): void;
  voices(): Promise<TtsSystemVoice[]>;
  /** Synthesize; resolves with the audio URL path and the WAV bytes (for the duration). */
  speak(job: SpeakJob): Promise<{ url: string; wav: Uint8Array }>;
  /** Reply in chat. Never throws. */
  say(text: string): Promise<void>;
  /** Voices viewers picked, by user id, kept between runs. */
  loadUserVoices(): Record<string, TtsVoiceId>;
  saveUserVoices(voices: Record<string, TtsVoiceId>): void;
}

/**
 * Reads chat messages aloud through the TTS overlay. Who may be read (streamer, moderators, VIPs,
 * subscribers, everyone) is set by role; messages wait in line and play one at a time.
 */
export class TtsService {
  private queue: TtsItem[] = [];
  private busy = false;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private current: TtsItem | null = null;
  private lastSpoken = new Map<string, number>();
  private systemVoices: Promise<TtsSystemVoice[]> | null = null;
  private disposed = false;
  private userVoices: Map<string, TtsVoiceId>;

  constructor(
    private ctx: AppContext,
    private deps: TtsDeps,
    private now: () => number = Date.now,
  ) {
    let stored: Record<string, TtsVoiceId> = {};
    try { stored = deps.loadUserVoices() ?? {}; } catch { /* first run */ }
    this.userVoices = new Map(Object.entries(stored).filter(([, v]) => typeof v === 'string'));
    this.patch({ remembered: this.userVoices.size });
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('event', (e) => this.onEvent(e));
    ctx.bus.on('chat:delete', ({ id }) => this.cancel((item) => item.messageId === id));
    ctx.bus.on('chat:clearUser', ({ userId }) => this.cancel((item) => item.userId === userId && item.reason === 'chat'));
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'tts' && !this.cfg.enabled) this.clear();
    });
  }

  private get cfg(): TtsSettings {
    return this.ctx.settings.get('tts');
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  private patch(p: Partial<TtsState>): void {
    this.ctx.state.patch('tts', p);
  }

  private onChat(m: ChatMessage): void {
    const cfg = this.cfg;
    if (!cfg.enabled || m.fromSelf || !ttsAllowed(m.roles, cfg.roles)) return;
    const prefix = this.ctx.settings.get('bot').prefix;
    const command = parseVoiceCommand(m.text, cfg, prefix);
    if (command) return this.onVoiceCommand(m, command);
    const body = parseTtsMessage(m.text, cfg, prefix);
    if (!body) return;
    // The streamer never waits; everyone else has a personal cooldown.
    if (!m.roles.broadcaster && cfg.cooldownSec > 0) {
      const last = this.lastSpoken.get(m.userId) ?? 0;
      if (this.now() - last < cfg.cooldownSec * 1000) return;
    }
    const text = ttsText(m, body, cfg, this.ru);
    if (!text || this.blocked(text)) return;
    if (this.enqueue({ id: this.nextId(), messageId: m.id, userId: m.userId, userName: m.userName, text, voice: this.voiceOf(m.userId), reason: 'chat', at: this.now() })) {
      this.lastSpoken.set(m.userId, this.now());
    }
  }

  /** Banned words of TTS and of the bot's moderation, and swearing. */
  private blocked(text: string): boolean {
    const cfg = this.cfg;
    if (hasBlockedWord(text, cfg.blockedWords)) return true;
    if (cfg.profanityFilter && hasProfanity(text)) return true;
    const words = this.ctx.settings.get('bot').moderation?.words;
    return cfg.useBotWords && !!words?.list.length && matchesBannedWord(text, words.list);
  }

  /** The viewer's own voice while the streamer still offers it, otherwise the default. */
  voiceOf(userId: string): TtsVoiceId {
    const cfg = this.cfg;
    const own = this.userVoices.get(userId);
    return own && (cfg.voices.includes(own) || own === cfg.voice) ? own : cfg.voice;
  }

  private onVoiceCommand(m: ChatMessage, command: NonNullable<ReturnType<typeof parseVoiceCommand>>): void {
    const ru = this.ru;
    const cfg = this.cfg;
    const name = (id: TtsVoiceId) => voiceAlias(id, ru);
    const list = [...new Set([cfg.voice, ...cfg.voices])].map(name).join(', ');
    const pick = `${this.ctx.settings.get('bot').prefix}${cfg.command}`;
    let reply: string;
    if (command.kind === 'set') {
      this.userVoices.set(m.userId, command.voice);
      this.saveVoices();
      reply = ru ? `@${m.userName}, теперь твои сообщения читает голос «${name(command.voice)}»` : `@${m.userName}, your messages are now read by "${name(command.voice)}"`;
    } else if (command.kind === 'reset') {
      this.userVoices.delete(m.userId);
      this.saveVoices();
      reply = ru ? `@${m.userName}, вернул голос по умолчанию: «${name(cfg.voice)}»` : `@${m.userName}, back to the default voice: "${name(cfg.voice)}"`;
    } else if (command.kind === 'unknown') {
      reply = ru ? `@${m.userName}, голоса «${command.word}» нет. Доступны: ${list}` : `@${m.userName}, there's no "${command.word}" voice. Available: ${list}`;
    } else {
      const own = name(this.voiceOf(m.userId));
      reply = ru ? `@${m.userName}, твой голос: «${own}». Сменить: ${pick} <голос> — ${list}` : `@${m.userName}, your voice: "${own}". Change it: ${pick} <voice> — ${list}`;
    }
    void this.deps.say(reply);
  }

  private saveVoices(): void {
    this.patch({ remembered: this.userVoices.size });
    try {
      this.deps.saveUserVoices(Object.fromEntries(this.userVoices));
    } catch (err) {
      console.warn('[tts] save voices', errorMessage(err));
    }
  }

  forgetVoices(): void {
    this.userVoices.clear();
    this.saveVoices();
  }

  private onEvent(e: StreamEvent): void {
    const cfg = this.cfg;
    if (!cfg.enabled || e.type !== 'redemption' || !cfg.rewardTitle.trim()) return;
    if (e.rewardTitle.trim().toLowerCase() !== cfg.rewardTitle.trim().toLowerCase()) return;
    const text = ttsText({ fragments: [] }, e.input ?? '', cfg, this.ru);
    if (!text || this.blocked(text)) return;
    this.enqueue({ id: this.nextId(), messageId: null, userId: '', userName: e.userName, text, voice: cfg.voice, reason: 'reward', at: this.now() });
  }

  /** A sample with a voice, even with TTS switched off, to hear how it sounds. */
  test(voice?: TtsVoiceId): void {
    const ru = this.ru;
    const v = voice ?? this.cfg.voice;
    const text = ru ? 'Привет, чат! Так будут звучать ваши сообщения.' : 'Hello chat! This is how your messages will sound.';
    this.enqueue({ id: this.nextId(), messageId: null, userId: '', userName: ru ? 'Тест' : 'Test', text, voice: v, reason: 'test', at: this.now() }, true);
  }

  /** Stop the message being read now; the next one follows. */
  skip(): void {
    if (!this.current) return;
    this.deps.broadcast({ type: 'ttsStop' });
    this.finish();
  }

  clear(): void {
    this.queue = [];
    this.patch({ queue: [] });
    this.skip();
  }

  async refreshVoices(): Promise<TtsSystemVoice[]> {
    this.systemVoices = this.deps.voices().catch((err) => {
      console.warn('[tts] voices', errorMessage(err));
      return [];
    });
    const voices = await this.systemVoices;
    this.patch({ voices });
    return voices;
  }

  private loadVoices(): Promise<TtsSystemVoice[]> {
    return this.systemVoices ?? this.refreshVoices();
  }

  private nextId(): string {
    return `tts${++this.seq}`;
  }

  private enqueue(item: TtsItem, force = false): boolean {
    if (!force && this.queue.length >= Math.max(1, this.cfg.queueMax)) return false;
    this.queue.push(item);
    this.patch({ queue: [...this.queue] });
    void this.next();
    return true;
  }

  private cancel(match: (item: TtsItem) => boolean): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => !match(item));
    if (this.queue.length !== before) this.patch({ queue: [...this.queue] });
    if (this.current && match(this.current)) this.skip();
  }

  /** What Windows should say: the name first if asked, in the voice and language of the message. */
  async job(item: TtsItem): Promise<SpeakJob> {
    const cfg = this.cfg;
    const def = ttsVoice(item.voice);
    const lang = textLang(item.text);
    const named = cfg.readNames && item.reason !== 'test' && item.userName
      ? `${spokenName(item.userName)} ${lang === 'ru' ? 'пишет' : 'says'}: ${item.text}`
      : item.text;
    const sys = pickSystemVoice(await this.loadVoices(), def.gender, lang, def.gender === 'male' ? cfg.maleVoice : cfg.femaleVoice);
    const rate = Math.min(6, Math.max(0.5, def.rate * (Math.min(200, Math.max(50, cfg.ratePercent)) / 100)));
    return { text: named, voice: sys?.name ?? '', source: sys?.source ?? '', rate, pitch: def.pitch };
  }

  private async next(): Promise<void> {
    if (this.busy || this.disposed) return;
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.current = item;
    this.patch({ current: item, queue: [...this.queue] });
    try {
      const { url, wav } = await this.deps.speak(await this.job(item));
      // Skipped or deleted while it was being synthesized.
      if (this.current !== item || this.disposed) return;
      const def = ttsVoice(item.voice);
      const durationMs = wavDurationMs(wav) || 4000 + item.text.length * 70;
      const play: TtsPlayback = { item, url, effect: def.effect, volume: Math.min(100, Math.max(0, this.cfg.volume)) / 100, durationMs };
      this.deps.broadcast({ type: 'tts', play });
      this.patch({ error: null, history: [item, ...this.ctx.state.current.tts.history.filter((h) => h.id !== item.id)].slice(0, HISTORY) });
      this.timer = setTimeout(() => this.finish(), durationMs + GAP_MS);
    } catch (err) {
      console.warn('[tts]', errorMessage(err));
      this.patch({ error: errorMessage(err) });
      if (this.current === item) this.finish();
    }
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.busy = false;
    this.patch({ current: null });
    void this.next();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
