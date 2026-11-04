import type { ChatMessage, OverlayMessage, ShoutoutCard, ShoutoutClip, ShoutoutSettings, ShoutoutState, StreamEvent, StreamInfo } from '@shared/types';
import { renderTemplate } from '@shared/template';
import { errorMessage, type AppContext } from '../core/context';

const LOGIN = /^[a-z0-9_]{2,25}$/;
const HISTORY = 10;
/** Recent clips first, then all-time ones when a channel made none lately. */
const RECENT_DAYS = 30;
/** Twitch allows one shoutout every 2 minutes; a few seconds on top so it is not refused. */
const NATIVE_GAP_MS = 2 * 60_000 + 5_000;
/** ...and the same channel once an hour. */
const NATIVE_SAME_MS = 60 * 60_000;
/** Refused for cooldown this many times = give up on that channel. */
const NATIVE_TRIES = 3;
/** Chat bots have plenty of followers but are not streamers worth a shoutout. */
const CHAT_BOTS = new Set(['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'botrix', 'sery_bot', 'soundalerts', 'commanderroot', 'kofistreambot', 'pokemoncommunitygame', 'blerp']);

export interface ChannelInfo {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string;
  game: string;
  title: string;
}

export interface ShoutoutDeps {
  broadcast(message: OverlayMessage): void;
  /** Post to chat. Never throws. */
  say(text: string): Promise<void>;
  /** Null when there is no such channel. */
  channel(login: string): Promise<ChannelInfo | null>;
  /** Most viewed first. */
  clips(userId: string, days?: number): Promise<ShoutoutClip[]>;
  native(userId: string): Promise<void>;
  /** How many followers a channel has. */
  followers(userId: string): Promise<number>;
  rand?: () => number;
  now?: () => number;
}

/** "@Name", "twitch.tv/name" or "name" → "name". */
export function shoutoutLogin(raw: string): string {
  return raw.trim().replace(/^@/, '').replace(/^(https?:\/\/)?(www\.|m\.)?twitch\.tv\//i, '').replace(/[/?#].*$/, '').toLowerCase();
}

/** Which clip to play. Twitch lists clips most viewed first. */
export function pickClip(clips: ShoutoutClip[], pick: ShoutoutSettings['clipPick'], rand: () => number = Math.random): ShoutoutClip | null {
  const usable = clips.filter((c) => c.id && c.durationSec > 0);
  if (!usable.length) return null;
  if (pick === 'random') return usable[Math.floor(rand() * Math.min(usable.length, 10))] ?? usable[0];
  return usable[0];
}

/** How long a card stays on screen: its clip (cut to the limit) or the plain card time. */
export function cardDurationMs(card: ShoutoutCard, cfg: ShoutoutSettings): number {
  if (card.clip && cfg.playClip) return (Math.min(card.clip.durationSec, Math.max(5, cfg.clipMaxSec)) + 2) * 1000;
  return Math.max(3, cfg.cardSec) * 1000;
}

interface Pending {
  login: string;
  reason: ShoutoutCard['reason'];
  viewers: number | null;
  followers?: number | null;
  /** Already looked up (manual shoutouts and tests). */
  card?: ShoutoutCard;
}

interface NativePending {
  userId: string;
  name: string;
  tries: number;
}

/**
 * Shoutouts for raiders, friends and streamers who come to chat: a chat message, Twitch's own shoutout
 * and an on-screen card with the channel's avatar, category and one of its clips. Several in a row wait
 * their turn; Twitch's own shoutouts have a queue of their own that waits out Twitch's cooldowns.
 */
export class ShoutoutService {
  private pending: Pending[] = [];
  private nativeQueue: NativePending[] = [];
  private nativeBusy = false;
  private nativeTimer: NodeJS.Timeout | null = null;
  /** When Twitch last accepted (or refused for cooldown) a shoutout; null = none yet. */
  private lastNativeAt: number | null = null;
  /** Twitch user id → when Twitch last accepted a shoutout for that channel. */
  private nativeDone = new Map<string, number>();
  /** Chatters already checked this stream (user ids). */
  private checked = new Set<string>();
  /** Channels shouted out this stream, by any route (logins). */
  private shouted = new Set<string>();
  private wasLive: boolean;
  private busy = false;
  private hideTimer: NodeJS.Timeout | null = null;
  private delayTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private seq = 0;

  constructor(
    private ctx: AppContext,
    private deps: ShoutoutDeps,
  ) {
    this.wasLive = ctx.state.current.stream.live;
    ctx.bus.on('event', (e) => this.onEvent(e));
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('stream:update', (s) => this.onStream(s));
    ctx.bus.on('shoutout:command', ({ login, userId }) => {
      const cfg = this.cfg;
      this.shouted.add(login);
      if (cfg.nativeShoutout) this.requestNative(userId, login);
      if (cfg.onCommand && cfg.showCard) this.enqueue({ login, reason: 'command', viewers: null });
    });
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'shoutout' || key === 'language') this.push();
    });
  }

  private get cfg(): ShoutoutSettings {
    return this.ctx.settings.get('shoutout');
  }

  private get state(): ShoutoutState {
    return this.ctx.state.current.shoutout;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  overlayMessage(): OverlayMessage {
    return { type: 'shoutout', card: this.state.current, endsAt: this.state.endsAt, style: this.cfg, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  private onEvent(e: StreamEvent): void {
    if (e.type !== 'raid') return;
    const cfg = this.cfg;
    if (!cfg.onRaid || e.viewers < Math.max(0, cfg.minViewers)) return;
    this.enqueue({ login: e.userLogin || e.userName, reason: 'raid', viewers: e.viewers });
  }

  /** A new stream starts over: everyone in chat is checked again. */
  private onStream(s: StreamInfo): void {
    if (s.live && !this.wasLive) {
      this.checked.clear();
      this.shouted.clear();
    }
    this.wasLive = s.live;
  }

  /** The first message of a streamer this stream: shout them out when they have enough followers. */
  private onChat(m: ChatMessage): void {
    if (!this.cfg.onChatter || m.platform !== 'twitch' || m.fromSelf || m.roles.broadcaster || !m.userId) return;
    if (!this.ctx.state.current.stream.live) return;
    const login = shoutoutLogin(m.userLogin);
    if (!LOGIN.test(login) || CHAT_BOTS.has(login) || this.checked.has(m.userId) || this.shouted.has(login)) return;
    this.checked.add(m.userId);
    this.deps.followers(m.userId).then(
      (followers) => {
        const cfg = this.cfg;
        if (this.disposed || !cfg.onChatter || followers < Math.max(1, cfg.minFollowers)) return;
        this.enqueue({ login, reason: 'chatter', viewers: null, followers });
      },
      (err) => {
        // Look again on their next message.
        this.checked.delete(m.userId);
        console.warn('[shoutout] followers', errorMessage(err));
      },
    );
  }

  /** A shoutout by hand from the app: checks the channel first so a typo is reported right away. */
  async show(raw: string): Promise<void> {
    const login = shoutoutLogin(raw);
    if (!LOGIN.test(login)) throw new Error(this.ru ? 'Введите ник канала на Twitch' : 'Enter a Twitch channel name');
    const card = await this.build({ login, reason: 'manual', viewers: null });
    if (!card) throw new Error(this.ru ? `Канал ${login} не найден на Twitch` : `Channel ${login} not found on Twitch`);
    this.enqueue({ login, reason: 'manual', viewers: null, card });
  }

  /** A sample card without Twitch, to set up the overlay. */
  test(): void {
    const ru = this.ru;
    const card: ShoutoutCard = {
      id: `test:${Date.now()}`,
      userId: '',
      login: 'streamhelper',
      displayName: ru ? 'Дружественный_канал' : 'Friendly_channel',
      avatarUrl: '',
      game: 'Just Chatting',
      title: ru ? 'Тестовый шаутаут — так будет выглядеть карточка' : 'Test shoutout — this is how the card looks',
      viewers: 42,
      reason: 'test',
      clip: null,
      at: Date.now(),
    };
    this.enqueue({ login: card.login, reason: 'test', viewers: card.viewers, card });
  }

  /** Hide the card on screen now; the next one in line follows. */
  skip(): void {
    if (this.state.current) this.hide();
  }

  private enqueue(item: Pending): void {
    const login = shoutoutLogin(item.login);
    if (!LOGIN.test(login)) return;
    // The same channel twice in a row (a raid followed by !so) is shown once.
    if (item.reason !== 'test' && (this.state.current?.login === login || this.pending.some((p) => p.login === login))) return;
    // A streamer who raided or was shouted out already this stream is not shouted out again for chatting.
    if (item.reason === 'chatter' && this.shouted.has(login)) return;
    if (item.reason !== 'test') this.shouted.add(login);
    this.pending.push({ ...item, login });
    this.ctx.state.patch('shoutout', { queue: this.pending.map((p) => p.login) });
    void this.next();
  }

  private async next(): Promise<void> {
    if (this.busy || this.disposed) return;
    const item = this.pending.shift();
    this.ctx.state.patch('shoutout', { queue: this.pending.map((p) => p.login) });
    if (!item) return;
    this.busy = true;
    try {
      // Let the raid alert play first.
      if (item.reason === 'raid') await this.wait(Math.max(0, this.cfg.delaySec) * 1000);
      if (this.disposed) return;
      const card = item.card ?? await this.build(item);
      if (!card) {
        this.ctx.state.patch('shoutout', { error: this.ru ? `Канал ${item.login} не найден на Twitch` : `Channel ${item.login} not found on Twitch` });
        return this.release();
      }
      this.ctx.state.patch('shoutout', { error: null });
      if (item.reason === 'raid' || item.reason === 'manual' || item.reason === 'chatter') await this.announce(card);
      if (this.cfg.showCard || item.reason === 'test') this.display(card);
      else this.release();
    } catch (err) {
      console.warn('[shoutout]', errorMessage(err));
      this.ctx.state.patch('shoutout', { error: errorMessage(err) });
      this.release();
    }
  }

  private async build(item: Pending): Promise<ShoutoutCard | null> {
    const ch = await this.deps.channel(item.login);
    if (!ch) return null;
    let clip: ShoutoutClip | null = null;
    const cfg = this.cfg;
    if (cfg.playClip && cfg.showCard) {
      try {
        let clips = cfg.clipPick === 'recent' ? await this.deps.clips(ch.id, RECENT_DAYS) : [];
        if (!clips.length) clips = await this.deps.clips(ch.id);
        clip = pickClip(clips, cfg.clipPick, this.deps.rand);
      } catch (err) {
        // No clip is not a reason to skip the shoutout.
        console.warn('[shoutout] clips', errorMessage(err));
      }
    }
    return {
      id: `so${++this.seq}:${ch.login}`,
      userId: ch.id,
      login: ch.login,
      displayName: ch.displayName,
      avatarUrl: ch.avatarUrl,
      game: ch.game,
      title: ch.title,
      viewers: item.viewers,
      followers: item.followers ?? null,
      reason: item.reason,
      clip,
      at: Date.now(),
    };
  }

  /** Chat message and Twitch's own shoutout. The bot command posted its message itself. */
  private async announce(card: ShoutoutCard): Promise<void> {
    const cfg = this.cfg;
    const template = card.reason === 'chatter' ? cfg.chatterMessage : cfg.chatMessage;
    if (template.trim()) {
      const game = card.game || (this.ru ? 'нет' : 'none yet');
      await this.deps.say(renderTemplate(template, { name: card.displayName, login: card.login, game, title: card.title, viewers: card.viewers ?? '', followers: card.followers ?? '' }));
    }
    if (cfg.nativeShoutout) this.requestNative(card.userId, card.displayName);
  }

  /**
   * Twitch's own shoutout, in a queue: Twitch takes one every 2 minutes and the same channel once an hour,
   * so a shoutout right after another one waits its turn instead of being lost.
   */
  private requestNative(userId: string, name: string): void {
    if (!userId || this.disposed) return;
    const done = this.nativeDone.get(userId);
    if (done !== undefined && this.now() - done < NATIVE_SAME_MS) return;
    if (this.nativeQueue.some((q) => q.userId === userId)) return;
    this.nativeQueue.push({ userId, name, tries: 0 });
    this.patchNative(this.state.nativeNextAt);
    this.pumpNative();
  }

  private pumpNative(): void {
    if (this.nativeBusy || this.nativeTimer || this.disposed) return;
    const item = this.nativeQueue[0];
    if (!item) return this.patchNative(null);
    const wait = this.lastNativeAt === null ? 0 : this.lastNativeAt + NATIVE_GAP_MS - this.now();
    if (wait > 0) {
      this.patchNative(this.now() + wait);
      this.nativeTimer = setTimeout(() => { this.nativeTimer = null; this.pumpNative(); }, wait);
      return;
    }
    this.nativeBusy = true;
    this.patchNative(this.now());
    this.deps.native(item.userId).then(
      () => {
        this.lastNativeAt = this.now();
        this.nativeDone.set(item.userId, this.lastNativeAt);
        this.nativeQueue.shift();
      },
      (err) => {
        if ((err as { status?: number })?.status === 429 && ++item.tries < NATIVE_TRIES) {
          // Still on Twitch's cooldown (maybe a shoutout from outside the app): try again later.
          this.lastNativeAt = this.now();
          return;
        }
        // Offline, no viewers, no rights: the chat message is the main part.
        this.nativeQueue.shift();
        console.info('[shoutout] native', errorMessage(err));
      },
    ).finally(() => {
      this.nativeBusy = false;
      this.pumpNative();
    });
  }

  private patchNative(nextAt: number | null): void {
    this.ctx.state.patch('shoutout', { nativeQueue: this.nativeQueue.map((q) => q.name), nativeNextAt: this.nativeQueue.length ? nextAt : null });
  }

  private display(card: ShoutoutCard): void {
    const endsAt = Date.now() + cardDurationMs(card, this.cfg);
    this.ctx.state.patch('shoutout', { current: card, endsAt, history: [card, ...this.state.history.filter((c) => c.id !== card.id)].slice(0, HISTORY) });
    this.push();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), endsAt - Date.now());
  }

  private hide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.ctx.state.patch('shoutout', { current: null, endsAt: null });
    this.push();
    this.release();
  }

  private release(): void {
    this.busy = false;
    void this.next();
  }

  private wait(ms: number): Promise<void> {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => {
      this.delayTimer = setTimeout(() => { this.delayTimer = null; resolve(); }, ms);
    });
  }

  private push(): void {
    this.deps.broadcast(this.overlayMessage());
  }

  dispose(): void {
    this.disposed = true;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.delayTimer) clearTimeout(this.delayTimer);
    if (this.nativeTimer) clearTimeout(this.nativeTimer);
  }
}
