import type { OverlayMessage, ShoutoutCard, ShoutoutClip, ShoutoutSettings, ShoutoutState, StreamEvent } from '@shared/types';
import { renderTemplate } from '@shared/template';
import { errorMessage, type AppContext } from '../core/context';

const LOGIN = /^[a-z0-9_]{2,25}$/;
const HISTORY = 10;
/** Recent clips first, then all-time ones when a channel made none lately. */
const RECENT_DAYS = 30;

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
  rand?: () => number;
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
  /** Already looked up (manual shoutouts and tests). */
  card?: ShoutoutCard;
}

/**
 * Shoutouts for raiders and friends: a chat message, Twitch's own shoutout and an on-screen card
 * with the channel's avatar, category and one of its clips. Several raids in a row wait their turn.
 */
export class ShoutoutService {
  private pending: Pending[] = [];
  private busy = false;
  private hideTimer: NodeJS.Timeout | null = null;
  private delayTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private seq = 0;

  constructor(
    private ctx: AppContext,
    private deps: ShoutoutDeps,
  ) {
    ctx.bus.on('event', (e) => this.onEvent(e));
    ctx.bus.on('shoutout:command', ({ login }) => {
      const cfg = this.cfg;
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
      if (item.reason === 'raid' || item.reason === 'manual') await this.announce(card);
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
      reason: item.reason,
      clip,
      at: Date.now(),
    };
  }

  /** Chat message and Twitch's own shoutout. The bot command already did both itself. */
  private async announce(card: ShoutoutCard): Promise<void> {
    const cfg = this.cfg;
    if (cfg.chatMessage.trim()) {
      const game = card.game || (this.ru ? 'нет' : 'none yet');
      await this.deps.say(renderTemplate(cfg.chatMessage, { name: card.displayName, login: card.login, game, title: card.title, viewers: card.viewers ?? '' }));
    }
    // Twitch refuses while offline and between cooldowns; the chat message is the main part.
    if (cfg.nativeShoutout && card.userId) await this.deps.native(card.userId).catch((err) => console.info('[shoutout] native', errorMessage(err)));
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
  }
}
