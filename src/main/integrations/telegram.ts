import type { StreamInfo, TelegramSettings } from '@shared/types';
import { formatDuration, renderTemplate } from '@shared/template';
import { errorMessage, type AppContext } from '../core/context';
import type { SecretsData } from '../core/secrets';

const API = 'https://api.telegram.org';
/** The app opened this long after going live: too late for a "we're live" post. */
const LATE_MS = 60 * 60_000;
/** Back live within this after the stream dropped: the same announcement comes back instead of a new one. */
const REJOIN_MS = 10 * 60_000;

type Post = NonNullable<SecretsData['telegramPost']>;

export class TelegramError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
  }
}

export function validTelegramToken(token: string): boolean {
  return /^\d{5,15}:[\w-]{30,60}$/.test(token);
}

/** "https://t.me/name", "t.me/name", "name" → "@name"; numeric ids ("-100…") stay as they are. */
export function telegramChatId(raw: string): string {
  const v = raw.trim().replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '').replace(/[/?#].*$/, '');
  if (/^-?\d{5,20}$/.test(v)) return v;
  const name = v.replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? `@${name}` : '';
}

export interface TelegramDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

interface TgChat { id: number; type: string; title?: string; username?: string }
interface TgMessage { message_id: number }

/**
 * Announces the stream in the streamer's Telegram channel or group through their own bot: a post
 * with the stream preview and a "Watch" button when the stream starts, changed to "stream ended"
 * when it stops. A restart of the app mid-stream or a short drop of the stream does not post twice.
 */
export class TelegramService {
  private lastLive: boolean;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private off: () => void;

  constructor(private ctx: AppContext, private deps: TelegramDeps = {}) {
    this.lastLive = ctx.state.current.stream.live;
    this.off = ctx.bus.on('stream:update', (s) => this.onStream(s));
  }

  private get cfg(): TelegramSettings {
    return this.ctx.settings.get('telegram');
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get token(): string | undefined {
    return this.ctx.secrets.get('telegramBotToken');
  }

  start(): void {
    const cfg = this.cfg;
    const on = cfg.enabled && !!this.token && !!cfg.chatId;
    this.ctx.state.replace('telegram', on
      ? { status: 'connected', account: { userId: cfg.chatId, login: cfg.botName, displayName: cfg.chatTitle || cfg.chatId } }
      : { status: 'disconnected' });
  }

  /** Checks that the token works and the bot may post in the chat before saving anything. */
  async connect(rawToken: string, rawChat: string): Promise<void> {
    const ru = this.ru;
    const token = rawToken.trim();
    if (!validTelegramToken(token)) throw new Error(ru ? 'Это не похоже на токен бота. Его выдаёт @BotFather: 123456789:AA…' : "That doesn't look like a bot token. @BotFather gives it out: 123456789:AA…");
    const chatId = telegramChatId(rawChat);
    if (!chatId) throw new Error(ru ? 'Укажите канал: @имя_канала, ссылку t.me/… или числовой id' : 'Enter the channel: @channel_name, a t.me/… link or a numeric id');
    const me = await this.api<{ id: number; username?: string }>(token, 'getMe');
    const chat = await this.api<TgChat>(token, 'getChat', { chat_id: chatId }).catch((err) => {
      throw new Error(ru ? `Бот не видит «${chatId}». Добавьте его в канал или группу. (${errorMessage(err)})` : `The bot can't see "${chatId}". Add it to the channel or group. (${errorMessage(err)})`);
    });
    const member = await this.api<{ status: string; can_post_messages?: boolean }>(token, 'getChatMember', { chat_id: chat.id, user_id: me.id });
    const admin = member.status === 'administrator' || member.status === 'creator';
    if (chat.type === 'channel' ? !admin || member.can_post_messages === false : member.status === 'left' || member.status === 'kicked') {
      throw new Error(ru ? 'Сделайте бота администратором канала с правом публиковать сообщения' : 'Make the bot an admin of the channel who may post messages');
    }
    this.ctx.secrets.set('telegramBotToken', token);
    this.ctx.secrets.set('telegramPost', undefined);
    this.ctx.settings.set('telegram', { ...this.cfg, enabled: true, chatId: String(chat.id), chatTitle: chat.title ?? (chat.username ? `@${chat.username}` : String(chat.id)), botName: me.username ?? '' });
    this.start();
  }

  disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ctx.secrets.set('telegramBotToken', undefined);
    this.ctx.secrets.set('telegramPost', undefined);
    this.ctx.settings.set('telegram', { ...this.cfg, enabled: false });
    this.ctx.state.replace('telegram', { status: 'disconnected' });
  }

  /** The announcement as it would look right now, posted once (not pinned, not remembered). */
  async test(): Promise<void> {
    const token = this.requireToken();
    const live = this.ctx.state.current.stream.live;
    const text = this.render(this.cfg.liveMessage, this.ctx.state.current.stream.startedAt ?? this.now());
    await this.post(token, text, live && this.cfg.withPreview);
    this.ctx.state.patch('telegram', { status: 'connected', error: undefined });
  }

  private onStream(s: StreamInfo): void {
    const was = this.lastLive;
    this.lastLive = s.live;
    if (was === s.live) return;
    const cfg = this.cfg;
    if (!cfg.enabled || !this.token) return;
    if (s.live) {
      if (!cfg.notifyLive) return;
      const now = this.now();
      const startedAt = s.startedAt ?? now;
      const post = this.ctx.secrets.get('telegramPost');
      // Already announced: the app was restarted, or the stream dropped for a moment.
      if (post && post.chatId === cfg.chatId) {
        if (!post.endedAt && Math.abs(post.startedAt - startedAt) < 5 * 60_000) return;
        if (post.endedAt && now - post.endedAt < REJOIN_MS) return this.enqueue(() => this.revive(post));
      }
      if (now - startedAt > LATE_MS) return;
      if (this.timer) clearTimeout(this.timer);
      const wait = Math.max(0, Math.max(0, cfg.delaySec) * 1000 - (now - startedAt));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.enqueue(() => this.announce(startedAt));
      }, wait);
    } else {
      // Ended before the announcement went out: nothing to post.
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.enqueue(() => this.finish());
    }
  }

  private async announce(startedAt: number): Promise<void> {
    if (!this.ctx.state.current.stream.live) return;
    const token = this.requireToken();
    const cfg = this.cfg;
    const { messageId, photo } = await this.post(token, this.render(cfg.liveMessage, startedAt), cfg.withPreview);
    const pinned = cfg.pin ? await this.pin(token, messageId) : false;
    this.ctx.secrets.set('telegramPost', { startedAt, chatId: cfg.chatId, messageId, photo, pinned });
    this.ctx.state.patch('telegram', { status: 'connected', error: undefined });
  }

  /** Back live soon after a drop: the "ended" post turns back into the live one. */
  private async revive(post: Post): Promise<void> {
    const token = this.requireToken();
    const cfg = this.cfg;
    await this.edit(token, post, this.render(cfg.liveMessage, post.startedAt), true);
    const pinned = cfg.pin && !post.pinned ? await this.pin(token, post.messageId) : post.pinned;
    const { endedAt: _ended, ...live } = post;
    this.ctx.secrets.set('telegramPost', { ...live, pinned });
  }

  private async finish(): Promise<void> {
    const post = this.ctx.secrets.get('telegramPost');
    if (!post || post.endedAt || post.chatId !== this.cfg.chatId) return;
    const token = this.requireToken();
    const cfg = this.cfg;
    if (cfg.editOnOffline) await this.edit(token, post, this.render(cfg.offlineMessage, post.startedAt), false);
    if (post.pinned) await this.api(token, 'unpinChatMessage', { chat_id: post.chatId, message_id: post.messageId }).catch((err) => console.info('[telegram] unpin', errorMessage(err)));
    this.ctx.secrets.set('telegramPost', { ...post, pinned: false, endedAt: this.now() });
  }

  private render(template: string, startedAt: number): string {
    const s = this.ctx.state.current.stream;
    const account = this.ctx.state.current.twitch.account;
    const ru = this.ru;
    return renderTemplate(template, {
      title: s.title || (ru ? 'Стрим' : 'Stream'),
      game: s.categoryName || (ru ? 'без категории' : 'no category'),
      link: account ? `https://twitch.tv/${account.login}` : '',
      name: account?.displayName ?? '',
      duration: formatDuration(this.now() - startedAt, ru ? 'ru' : 'en'),
    }).trim();
  }

  private buttons(): Record<string, unknown> | undefined {
    const login = this.ctx.state.current.twitch.account?.login;
    const text = this.cfg.buttonText.trim();
    return login && text ? { inline_keyboard: [[{ text: text.slice(0, 64), url: `https://twitch.tv/${login}` }]] } : undefined;
  }

  /** A photo post with the stream preview, or a text post when there is no preview to show. */
  private async post(token: string, text: string, withPreview: boolean): Promise<{ messageId: number; photo: boolean }> {
    const cfg = this.cfg;
    const common = { chat_id: cfg.chatId, disable_notification: cfg.silent, reply_markup: this.buttons() };
    const login = this.ctx.state.current.twitch.account?.login;
    if (withPreview && login) {
      try {
        // A fresh address each time, or Telegram reuses the picture it fetched last stream.
        const photo = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-1280x720.jpg?t=${this.now()}`;
        const m = await this.api<TgMessage>(token, 'sendPhoto', { ...common, photo, caption: text.slice(0, 1024) });
        return { messageId: m.message_id, photo: true };
      } catch (err) {
        console.info('[telegram] preview', errorMessage(err));
      }
    }
    const m = await this.api<TgMessage>(token, 'sendMessage', { ...common, text: text.slice(0, 4096) || '🔴' });
    return { messageId: m.message_id, photo: false };
  }

  private async edit(token: string, post: Post, text: string, withButton: boolean): Promise<void> {
    // Leaving reply_markup out takes the button away.
    const common = { chat_id: post.chatId, message_id: post.messageId, ...(withButton ? { reply_markup: this.buttons() } : {}) };
    await (post.photo
      ? this.api(token, 'editMessageCaption', { ...common, caption: text.slice(0, 1024) })
      : this.api(token, 'editMessageText', { ...common, text: text.slice(0, 4096) || '⚫' })
    ).catch((err) => {
      // The post was deleted by hand, or the text did not change.
      if (!/not modified|not found|can't be edited/i.test(errorMessage(err))) throw err;
    });
  }

  private async pin(token: string, messageId: number): Promise<boolean> {
    try {
      await this.api(token, 'pinChatMessage', { chat_id: this.cfg.chatId, message_id: messageId, disable_notification: true });
      return true;
    } catch (err) {
      console.info('[telegram] pin', errorMessage(err));
      return false;
    }
  }

  private requireToken(): string {
    const token = this.token;
    if (!token || !this.cfg.enabled || !this.cfg.chatId) throw new Error(this.ru ? 'Telegram не подключён' : 'Telegram is not connected');
    return token;
  }

  private async api<T = unknown>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await (this.deps.fetch ?? fetch)(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
    if (!json?.ok) throw new TelegramError((json?.description ?? `Telegram HTTP ${res.status}`).split(token).join('…'), json?.error_code ?? res.status);
    return json.result as T;
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((err) => {
      console.warn('[telegram]', errorMessage(err));
      if (this.cfg.enabled) this.ctx.state.patch('telegram', { status: 'error', error: errorMessage(err) });
    });
  }

  /** Waits for posts already on their way (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  dispose(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
