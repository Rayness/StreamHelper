import { twitchClientId } from '@shared/defaults';
import type { AccountInfo, Category, ChatMessage, StreamInfo } from '@shared/types';
import { errorMessage, type AppContext } from '../../core/context';
import type { OAuthToken } from '../../core/secrets';
import type { ChatPlatform } from '../types';
import { loadBadges, loadThirdPartyEmotes, type BadgeMap } from './assets';
import {
  BOT_SCOPES,
  BROADCASTER_SCOPES,
  pollDeviceCode,
  revokeToken,
  startDeviceCode,
  TokenManager,
  TwitchAuthError,
  validateToken,
} from './auth';
import { EventSubSocket } from './eventsub';
import { HelixClient, HelixError } from './helix';
import { normalizeChatMessage, normalizeStreamEvent } from './normalize';

type Account = 'broadcaster' | 'bot';

const STREAM_POLL_MS = 60_000;
const VALIDATE_MS = 60 * 60_000;

/** Twitch: auth for broadcaster (+ optional bot account), EventSub, Helix and the ChatPlatform contract. */
export class TwitchService implements ChatPlatform {
  readonly platform = 'twitch' as const;

  private tokens: Record<Account, TokenManager>;
  private helix: Record<Account, HelixClient>;
  private eventsub: EventSubSocket;
  private loginAborts: Partial<Record<Account, AbortController>> = {};
  private badges: BadgeMap = new Map();
  private emotes = new Map<string, string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private validateTimer: NodeJS.Timeout | null = null;
  private eventsubConnected = false;
  /** Texts we just sent, to recognize our own messages when the bot speaks as the broadcaster. */
  private pendingSent: { text: string; at: number }[] = [];
  private sentIds = new Map<string, number>();
  private retryTimers: Partial<Record<Account, NodeJS.Timeout>> = {};
  private accountGeneration: Record<Account, number> = { broadcaster: 0, bot: 0 };

  constructor(private ctx: AppContext) {
    const clientId = () => twitchClientId(ctx.settings.get('twitch').clientId);
    const secretKey = { broadcaster: 'twitch', bot: 'twitchBot' } as const;
    const mk = (acc: Account) =>
      new TokenManager(
        clientId,
        () => ctx.secrets.get(secretKey[acc]),
        (t) => {
          ctx.secrets.set(secretKey[acc], t);
          if (!t) this.onLoggedOut(acc, 'session_expired');
        },
      );
    this.tokens = { broadcaster: mk('broadcaster'), bot: mk('bot') };
    this.helix = { broadcaster: new HelixClient(clientId, this.tokens.broadcaster), bot: new HelixClient(clientId, this.tokens.bot) };

    this.eventsub = new EventSubSocket({
      onSession: (id) => this.subscribeAll(id),
      onNotification: (type, event) => this.onNotification(type, event),
      onRevocation: (type, status) => this.ctx.state.patch('twitch', { subscriptionErrors: { ...this.ctx.state.current.twitch.subscriptionErrors, [type]: status } }),
      onStatus: (status, error) => {
        this.eventsubConnected = status === 'connected';
        if (!this.tokens.broadcaster.token) return;
        this.ctx.state.patch('twitch', { status: status === 'disconnected' && error ? 'error' : status, error });
      },
    });
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    await Promise.all([this.startAccount('broadcaster'), this.startAccount('bot')]);
  }

  stop(): void {
    for (const acc of ['broadcaster', 'bot'] as const) {
      this.accountGeneration[acc]++;
      this.loginAborts[acc]?.abort();
      if (this.retryTimers[acc]) clearTimeout(this.retryTimers[acc]);
    }
    this.retryTimers = {};
    this.eventsub.stop();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.validateTimer) clearInterval(this.validateTimer);
    this.pollTimer = this.validateTimer = null;
  }

  private stateKey(acc: Account) {
    return acc === 'broadcaster' ? 'twitch' : 'twitchBot';
  }

  private async startAccount(acc: Account): Promise<void> {
    const token = this.tokens[acc].token;
    if (!token) return;
    const generation = ++this.accountGeneration[acc];
    if (this.retryTimers[acc]) clearTimeout(this.retryTimers[acc]);
    this.ctx.state.patch(this.stateKey(acc), { status: 'connecting', error: undefined });
    try {
      const account = await this.identify(acc, generation);
      if (generation !== this.accountGeneration[acc] || !this.tokens[acc].token) return;
      this.ctx.state.patch(this.stateKey(acc), { account, status: acc === 'bot' ? 'connected' : 'connecting' });
      if (acc === 'broadcaster') await this.startBroadcaster(account, generation);
    } catch (err) {
      if (generation !== this.accountGeneration[acc]) return;
      if (err instanceof HelixError && err.status === 401) return this.onLoggedOut(acc, 'session_expired');
      console.error(`[twitch] ${acc} start failed`, err);
      this.ctx.state.patch(this.stateKey(acc), { status: 'error', error: errorMessage(err) });
      // Network hiccup on startup: try again shortly.
      this.retryTimers[acc] = setTimeout(() => {
        if (this.tokens[acc].token && this.ctx.state.current[this.stateKey(acc)].status === 'error') void this.startAccount(acc);
      }, 15_000);
    }
  }

  /** Validate the token and fetch profile data. */
  private async identify(acc: Account, generation = this.accountGeneration[acc]): Promise<AccountInfo> {
    let token = this.tokens[acc].token!;
    let v = await validateToken(token.accessToken);
    if (!v) {
      token = await this.tokens[acc].refresh();
      v = await validateToken(token.accessToken);
      if (!v) throw new HelixError('unauthorized', 401);
    }
    if (generation !== this.accountGeneration[acc] || this.tokens[acc].token?.accessToken !== token.accessToken) throw new Error('Twitch account changed');
    if (token.userId !== v.userId || token.login !== v.login || JSON.stringify(token.scopes) !== JSON.stringify(v.scopes)) {
      this.ctx.secrets.set(acc === 'broadcaster' ? 'twitch' : 'twitchBot', { ...token, userId: v.userId, login: v.login, scopes: v.scopes });
    }
    const users = await this.helix[acc].get('/users', { id: v.userId });
    const u = users.data?.[0];
    return { userId: v.userId, login: v.login, displayName: u?.display_name ?? v.login, avatarUrl: u?.profile_image_url };
  }

  private async startBroadcaster(account: AccountInfo, generation: number): Promise<void> {
    const [badges, emotes] = await Promise.all([
      loadBadges(this.helix.broadcaster, account.userId).catch(() => new Map()),
      loadThirdPartyEmotes(account.userId).catch(() => new Map<string, string>()),
    ]);
    if (generation !== this.accountGeneration.broadcaster || !this.tokens.broadcaster.token) return;
    this.badges = badges;
    this.emotes = emotes;
    this.eventsub.start();
    await this.refreshStreamInfo().catch((err) => console.warn('[twitch] stream info failed', errorMessage(err)));
    if (generation !== this.accountGeneration.broadcaster || !this.tokens.broadcaster.token) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.refreshStreamInfo().catch(() => undefined), STREAM_POLL_MS);
    if (this.validateTimer) clearInterval(this.validateTimer);
    this.validateTimer = setInterval(() => void this.revalidate(), VALIDATE_MS);
  }

  private async revalidate(): Promise<void> {
    for (const acc of ['broadcaster', 'bot'] as Account[]) {
      const t = this.tokens[acc].token;
      if (!t) continue;
      try {
        if (!(await validateToken(t.accessToken))) await this.tokens[acc].refresh();
      } catch (err) {
        console.warn(`[twitch] revalidate ${acc} failed`, errorMessage(err));
      }
    }
  }

  // ---------- login / logout ----------

  async login(acc: Account): Promise<void> {
    const clientId = twitchClientId(this.ctx.settings.get('twitch').clientId);
    if (!clientId) {
      this.ctx.toast('error', 'toast.twitchNoClientId');
      return;
    }
    this.loginAborts[acc]?.abort();
    const abort = new AbortController();
    this.loginAborts[acc] = abort;
    const scopes = acc === 'broadcaster' ? BROADCASTER_SCOPES : BOT_SCOPES;
    const key = this.stateKey(acc);
    try {
      const start = await startDeviceCode(clientId, scopes);
      if (abort.signal.aborted || this.loginAborts[acc] !== abort) return;
      this.ctx.state.patch(key, {
        status: 'connecting',
        error: undefined,
        deviceCode: { userCode: start.userCode, verificationUri: start.verificationUri, expiresAt: Date.now() + start.expiresIn * 1000 },
      });
      this.ctx.openExternal(start.verificationUri);
      const token: OAuthToken = await pollDeviceCode(clientId, scopes, start, abort.signal);
      if (abort.signal.aborted || this.loginAborts[acc] !== abort) return;
      this.ctx.secrets.set(acc === 'broadcaster' ? 'twitch' : 'twitchBot', token);
      this.ctx.state.patch(key, { deviceCode: undefined });
      await this.startAccount(acc);
      this.ctx.toast('success', 'toast.twitchConnected', { name: this.ctx.state.current[key].account?.displayName ?? '' });
    } catch (err) {
      if (this.loginAborts[acc] !== abort) return;
      const aborted = err instanceof TwitchAuthError && err.message === 'aborted';
      this.ctx.state.patch(key, { status: 'disconnected', deviceCode: undefined, error: aborted ? undefined : errorMessage(err) });
      if (!aborted) this.ctx.toast('error', 'toast.twitchLoginFailed', { error: errorMessage(err) });
    } finally {
      if (this.loginAborts[acc] === abort) delete this.loginAborts[acc];
    }
  }

  cancelLogin(acc: Account): void {
    this.loginAborts[acc]?.abort();
  }

  async logout(acc: Account): Promise<void> {
    const t = this.tokens[acc].token;
    this.ctx.secrets.set(acc === 'broadcaster' ? 'twitch' : 'twitchBot', undefined);
    this.onLoggedOut(acc);
    if (t) await revokeToken(twitchClientId(this.ctx.settings.get('twitch').clientId), t.accessToken);
  }

  private onLoggedOut(acc: Account, reason?: string): void {
    this.accountGeneration[acc]++;
    this.loginAborts[acc]?.abort();
    delete this.loginAborts[acc];
    if (this.retryTimers[acc]) clearTimeout(this.retryTimers[acc]);
    if (acc === 'broadcaster') this.stop();
    this.ctx.state.replace(this.stateKey(acc), { status: 'disconnected', error: reason });
    if (reason) this.ctx.toast('error', 'toast.twitchSessionExpired');
  }

  get broadcasterId(): string | undefined {
    return this.ctx.state.current.twitch.account?.userId;
  }

  private get botId(): string | undefined {
    return this.ctx.state.current.twitchBot.account?.userId;
  }

  // ---------- EventSub ----------

  private async subscribeAll(sessionId: string): Promise<void> {
    const id = this.broadcasterId;
    if (!id) throw new Error('no broadcaster');
    const generation = this.accountGeneration.broadcaster;
    const chat = { broadcaster_user_id: id, user_id: id };
    const b = { broadcaster_user_id: id };
    const subs: [string, string, Record<string, string>][] = [
      ['channel.chat.message', '1', chat],
      ['channel.chat.message_delete', '1', chat],
      ['channel.chat.clear', '1', chat],
      ['channel.chat.clear_user_messages', '1', chat],
      ['channel.follow', '2', { broadcaster_user_id: id, moderator_user_id: id }],
      ['channel.subscribe', '1', b],
      ['channel.subscription.gift', '1', b],
      ['channel.subscription.message', '1', b],
      ['channel.cheer', '1', b],
      ['channel.raid', '1', { to_broadcaster_user_id: id }],
      ['channel.channel_points_custom_reward_redemption.add', '1', b],
      ['stream.online', '1', b],
      ['stream.offline', '1', b],
      ['channel.update', '2', b],
    ];
    const results = await Promise.allSettled(
      subs.map(([type, version, condition]) =>
        this.helix.broadcaster.post('/eventsub/subscriptions', { type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
      ),
    );
    if (generation !== this.accountGeneration.broadcaster || id !== this.broadcasterId) return;
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${subs[i][0]}: ${errorMessage(r.reason)}` : null)).filter(Boolean);
    if (failed.length) console.warn('[twitch] some EventSub subscriptions failed:\n' + failed.join('\n'));
    const subscriptionErrors: Record<string, string> = {};
    results.forEach((result, i) => { if (result.status === 'rejected') subscriptionErrors[subs[i][0]] = errorMessage(result.reason); });
    this.ctx.state.patch('twitch', { subscriptionErrors });
    // Chat is the core feature; without it the connection is useless.
    if (results[0].status === 'rejected') throw (results[0] as PromiseRejectedResult).reason;
    this.ctx.state.patch('twitch', { status: 'connected', error: undefined });
  }

  private onNotification(type: string, e: any): void {
    const { bus } = this.ctx;
    switch (type) {
      case 'channel.chat.message': {
        const msg = normalizeChatMessage(
          e,
          (set, v) => this.badges.get(`${set}/${v}`),
          (w) => this.emotes.get(w),
          this.botId && this.botId !== this.broadcasterId ? [this.botId] : [],
        );
        if (this.isOwnEcho(msg)) msg.fromSelf = true;
        bus.emit('chat:message', msg);
        return;
      }
      case 'channel.chat.message_delete':
        bus.emit('chat:delete', { id: e.message_id });
        return;
      case 'channel.chat.clear_user_messages':
        bus.emit('chat:clearUser', { userId: e.target_user_id });
        return;
      case 'channel.chat.clear':
        bus.emit('chat:clear', {});
        return;
      case 'stream.online':
        this.patchStream({ live: true, startedAt: e.started_at ? Date.parse(e.started_at) : Date.now() });
        void this.refreshStreamInfo().catch(() => undefined);
        return;
      case 'stream.offline':
        this.patchStream({ live: false, startedAt: null, viewers: 0 });
        return;
      case 'channel.update':
        this.patchStream({ title: e.title, categoryId: e.category_id, categoryName: e.category_name });
        return;
    }
    const event = normalizeStreamEvent(type, e, this.ctx.settings.get('language') === 'ru' ? 'Аноним' : 'Anonymous');
    if (event) bus.emit('event', event);
  }

  private isOwnEcho(msg: ChatMessage): boolean {
    for (const [id, at] of this.sentIds) if (Date.now() - at > 30_000) this.sentIds.delete(id);
    if (this.sentIds.delete(msg.id)) {
      const pending = this.pendingSent.findIndex((p) => p.text === msg.text);
      if (pending !== -1) this.pendingSent.splice(pending, 1);
      return true;
    }
    if (msg.userId !== this.broadcasterId) return false;
    const now = Date.now();
    this.pendingSent = this.pendingSent.filter((p) => now - p.at < 10_000);
    const i = this.pendingSent.findIndex((p) => p.text === msg.text);
    if (i === -1) return false;
    this.pendingSent.splice(i, 1);
    return true;
  }

  // ---------- stream info ----------

  private patchStream(patch: Partial<StreamInfo>): void {
    this.ctx.state.patch('stream', patch);
    this.ctx.bus.emit('stream:update', this.ctx.state.current.stream);
  }

  async refreshStreamInfo(): Promise<void> {
    const id = this.broadcasterId;
    if (!id) return;
    const generation = this.accountGeneration.broadcaster;
    const [channels, streams] = await Promise.all([
      this.helix.broadcaster.get('/channels', { broadcaster_id: id }),
      this.helix.broadcaster.get('/streams', { user_id: id }),
    ]);
    if (generation !== this.accountGeneration.broadcaster || id !== this.broadcasterId) return;
    const c = channels.data?.[0];
    const s = streams.data?.[0];
    this.patchStream({
      title: c?.title ?? '',
      categoryId: c?.game_id ?? '',
      categoryName: c?.game_name ?? '',
      tags: c?.tags ?? [],
      live: !!s,
      viewers: s?.viewer_count ?? 0,
      startedAt: s?.started_at ? Date.parse(s.started_at) : null,
    });
  }

  async updateStream(patch: { title?: string; categoryId?: string; tags?: string[] }): Promise<void> {
    const id = this.requireBroadcaster();
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.categoryId !== undefined) body.game_id = patch.categoryId;
    if (patch.tags !== undefined) body.tags = patch.tags;
    await this.helix.broadcaster.patch('/channels', body, { broadcaster_id: id });
    await this.refreshStreamInfo();
  }

  async searchCategories(query: string): Promise<Category[]> {
    if (!query.trim() || !this.broadcasterId) return [];
    const res = await this.helix.broadcaster.get('/search/categories', { query, first: 12 });
    return (res.data ?? []).map((c: any) => ({ id: c.id, name: c.name, boxArtUrl: c.box_art_url }));
  }

  async listRewards(): Promise<{ id: string; title: string; inputRequired: boolean; enabled: boolean }[]> {
    const id = this.requireBroadcaster();
    const res = await this.helix.broadcaster.get('/channel_points/custom_rewards', { broadcaster_id: id });
    return (res.data ?? []).map((r: any) => ({ id: r.id, title: r.title, inputRequired: !!r.is_user_input_required, enabled: !!r.is_enabled }));
  }

  /** Exact-name lookup used by the !game command. Falls back to the first search hit. */
  async findCategory(name: string): Promise<Category | null> {
    const exact = await this.helix.broadcaster.get('/games', { name }).catch(() => null);
    const g = exact?.data?.[0];
    if (g) return { id: g.id, name: g.name };
    const found = await this.searchCategories(name);
    return found[0] ?? null;
  }

  // ---------- ChatPlatform ----------

  isChatReady(): boolean {
    return !!this.broadcasterId && this.eventsubConnected;
  }

  private requireBroadcaster(): string {
    const id = this.broadcasterId;
    if (!id) throw new Error('Twitch is not connected');
    return id;
  }

  async sendMessage(text: string, replyTo?: string, opts: { asBroadcaster?: boolean } = {}): Promise<void> {
    const broadcasterId = this.requireBroadcaster();
    if (!opts.asBroadcaster && this.tokens.bot.token && (!this.botId || this.ctx.state.current.twitchBot.status !== 'connected')) {
      throw new Error('The bot account is disconnected. Reconnect it in Connections.');
    }
    const useBot = !opts.asBroadcaster && !!this.botId && this.botId !== broadcasterId && !!this.tokens.bot.token;
    const markSelf = !opts.asBroadcaster;
    const message = text.slice(0, 500);
    const pending = { text: message, at: Date.now() };
    this.pendingSent = this.pendingSent.filter((p) => Date.now() - p.at < 10_000).slice(-499);
    if (markSelf && !useBot) this.pendingSent.push(pending);
    try {
      const res = await (useBot ? this.helix.bot : this.helix.broadcaster).post('/chat/messages', {
        broadcaster_id: broadcasterId,
        sender_id: useBot ? this.botId : broadcasterId,
        message,
        ...(replyTo ? { reply_parent_message_id: replyTo } : {}),
      });
      const r = res?.data?.[0];
      if (r && !r.is_sent) throw new Error(r.drop_reason?.message ?? 'Twitch rejected the chat message');
      if (r?.message_id && markSelf) {
        this.sentIds.set(r.message_id, Date.now());
        if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.keys().next().value!);
      }
    } catch (error) {
      this.pendingSent = this.pendingSent.filter((p) => p !== pending);
      throw error;
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    const id = this.requireBroadcaster();
    await this.helix.broadcaster.delete('/moderation/chat', { broadcaster_id: id, moderator_id: id, message_id: messageId });
  }

  async timeout(userId: string, seconds: number, reason = ''): Promise<void> {
    const id = this.requireBroadcaster();
    await this.helix.broadcaster.post(
      '/moderation/bans',
      { data: { user_id: userId, duration: Math.max(1, Math.min(1_209_600, Math.round(seconds))), reason } },
      { broadcaster_id: id, moderator_id: id },
    );
  }

  async ban(userId: string, reason = ''): Promise<void> {
    const id = this.requireBroadcaster();
    await this.helix.broadcaster.post('/moderation/bans', { data: { user_id: userId, reason } }, { broadcaster_id: id, moderator_id: id });
  }

  async getFollowedAt(userId: string): Promise<number | null> {
    const id = this.requireBroadcaster();
    const res = await this.helix.broadcaster.get('/channels/followers', { broadcaster_id: id, user_id: userId });
    const at = res.data?.[0]?.followed_at;
    return at ? Date.parse(at) : null;
  }

  async shoutout(login: string): Promise<{ displayName: string; category: string } | null> {
    const id = this.requireBroadcaster();
    const users = await this.helix.broadcaster.get('/users', { login: login.replace(/^@/, '').toLowerCase() });
    const u = users.data?.[0];
    if (!u) return null;
    const ch = await this.helix.broadcaster.get('/channels', { broadcaster_id: u.id });
    // The native /shoutout only works while live and has strict cooldowns; the chat message is the main part.
    await this.helix.broadcaster
      .post('/chat/shoutouts', undefined, { from_broadcaster_id: id, to_broadcaster_id: u.id, moderator_id: id })
      .catch(() => undefined);
    return { displayName: u.display_name, category: ch.data?.[0]?.game_name ?? '' };
  }
}
