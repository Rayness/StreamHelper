import { renderTemplate } from '@shared/template';
import type { KawakiNowWatching, KawakiPartner } from '@shared/types';
import { errorMessage, type AppContext } from '../../core/context';
import type { KawakiSession } from '../../core/secrets';
import { resolveStreamVar } from '../../features/vars';
import { KawakiApi, KawakiError, type KawakiTokens, type KawakiUser, type NowWatchingDto, type WatchListItemDto } from './api';

const POLL_MS = 20_000;
const DEVICE_POLL_MS = 3_000;
const PARTNER_REFRESH_MS = 30 * 60_000;
/** Refresh the access token this long before it expires. */
const REFRESH_SKEW_MS = 60_000;
/** Don't rename the stream more often than this, even if the episode flips quickly. */
const TITLE_MIN_INTERVAL_MS = 30_000;

export interface KawakiDeps {
  updateTitle(title: string): Promise<void>;
  canUpdateTitle(): boolean;
}

export function fromNowWatching(dto: NowWatchingDto, api: KawakiApi): KawakiNowWatching {
  return {
    animeId: dto.anime.id,
    externalId: dto.anime.externalId,
    title: dto.anime.title,
    titleEn: dto.anime.titleEn,
    posterUrl: dto.anime.posterUrl,
    episode: dto.episode?.number ?? null,
    episodesTotal: dto.anime.episodeCount,
    progressSec: dto.progress,
    durationSec: dto.duration,
    url: api.animeUrl(dto.anime.externalId),
    source: 'live',
  };
}

/** Fallback while /me/now-watching isn't deployed: the most recently touched "Watching" title. */
export function fromWatchList(item: WatchListItemDto, api: KawakiApi): KawakiNowWatching {
  const total = item.anime.episodeCount;
  const next = (item.episodesWatched ?? 0) + 1;
  return {
    animeId: item.anime.id,
    externalId: item.anime.externalId,
    title: item.anime.title,
    titleEn: item.anime.titleEn,
    posterUrl: item.anime.posterUrl,
    episode: total && next > total ? total : next,
    episodesTotal: total,
    progressSec: null,
    durationSec: null,
    url: api.animeUrl(item.anime.externalId),
    source: 'list',
  };
}

export function sameWatch(a: KawakiNowWatching | null, b: KawakiNowWatching | null): boolean {
  return a?.animeId === b?.animeId && a?.episode === b?.episode;
}

/**
 * Kawaki account: device-flow login (the same one the TV app and Quiz Creator use),
 * "now watching" polling, partner live page, and optional stream title updates.
 */
export class KawakiService {
  readonly api: KawakiApi;
  private pollTimer: NodeJS.Timeout | null = null;
  private deviceTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<string> | null = null;
  private partnerCheckedAt = 0;
  /** Missing endpoint on an older Kawaki: stop asking for it, use the watch list. */
  private nowWatchingMissing = false;
  private lastTitledWatch: KawakiNowWatching | null = null;
  private lastTitleAt = 0;
  private retitleTimer: NodeJS.Timeout | null = null;
  private refreshingNow = false;

  constructor(
    private ctx: AppContext,
    private deps: KawakiDeps,
    api?: KawakiApi,
  ) {
    this.api = api ?? new KawakiApi(() => ctx.settings.get('kawaki').baseUrl);
    ctx.bus.on('settings:changed', (key) => {
      if (key !== 'kawaki') return;
      // A new template should apply right away.
      this.lastTitledWatch = null;
      void this.maybeRetitle();
    });
  }

  get connected(): boolean {
    return this.ctx.state.current.kawaki.status === 'connected';
  }

  get now(): KawakiNowWatching | null {
    return this.ctx.state.current.kawaki.nowWatching;
  }

  async start(): Promise<void> {
    const session = this.ctx.secrets.get('kawaki');
    if (!session) return;
    this.setAccount(session);
    this.ctx.state.patch('kawaki', { status: 'connecting', error: undefined });
    try {
      await this.token();
      this.ctx.state.patch('kawaki', { status: 'connected' });
      this.startPolling();
    } catch (err) {
      this.handleAuthError(err);
    }
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    if (this.retitleTimer) clearTimeout(this.retitleTimer);
    this.pollTimer = null;
    this.deviceTimer = null;
    this.retitleTimer = null;
  }

  // ---------- login ----------

  async login(): Promise<void> {
    this.cancelLogin();
    this.ctx.state.patch('kawaki', { status: 'connecting', error: undefined });
    try {
      const start = await this.api.deviceStart();
      const verificationUri = `${this.api.site}/link?code=${encodeURIComponent(start.userCode)}`;
      this.ctx.state.patch('kawaki', { deviceCode: { userCode: start.userCode, verificationUri, expiresAt: start.expiresAt } });
      this.ctx.openExternal(verificationUri);
      const poll = async () => {
        this.deviceTimer = null;
        if (Date.now() > start.expiresAt) return this.loginFailed('expired');
        try {
          const res = await this.api.devicePoll(start.deviceCode);
          if (res.status === 'approved') return this.completeLogin(res.tokens, res.user);
          if (res.status === 'expired') return this.loginFailed('expired');
        } catch (err) {
          // Rate limits and blips: keep polling until the code expires.
          if (!(err instanceof KawakiError) || err.status === 0 || err.status === 429) console.warn('[kawaki] poll', errorMessage(err));
          else return this.loginFailed(errorMessage(err));
        }
        this.deviceTimer = setTimeout(() => void poll(), DEVICE_POLL_MS);
      };
      this.deviceTimer = setTimeout(() => void poll(), DEVICE_POLL_MS);
    } catch (err) {
      this.loginFailed(errorMessage(err));
    }
  }

  cancelLogin(): void {
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    this.deviceTimer = null;
    const st = this.ctx.state.current.kawaki;
    if (st.deviceCode) this.ctx.state.patch('kawaki', { deviceCode: undefined, status: st.account ? st.status : 'disconnected' });
  }

  private loginFailed(error: string): void {
    this.ctx.state.patch('kawaki', { status: 'error', error, deviceCode: undefined });
    this.ctx.toast('error', 'toast.kawakiLoginFailed', { error });
  }

  private async completeLogin(tokens: KawakiTokens, user: KawakiUser): Promise<void> {
    const session = this.sessionFrom(tokens, user);
    this.ctx.secrets.set('kawaki', session);
    this.setAccount(session);
    this.ctx.state.patch('kawaki', { status: 'connected', error: undefined, deviceCode: undefined });
    this.ctx.toast('success', 'toast.kawakiConnected', { name: user.username });
    this.partnerCheckedAt = 0;
    this.nowWatchingMissing = false;
    this.startPolling();
  }

  async logout(): Promise<void> {
    this.stop();
    const session = this.ctx.secrets.get('kawaki');
    this.ctx.secrets.set('kawaki', undefined);
    this.ctx.state.replace('kawaki', { status: 'disconnected', nowWatching: null, partner: null });
    this.ctx.bus.emit('kawaki:now', null);
    if (session) await this.api.logout(session.refreshToken).catch(() => undefined);
  }

  private sessionFrom(tokens: KawakiTokens, user: Pick<KawakiUser, 'id' | 'username' | 'avatarUrl'>): KawakiSession {
    return {
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessTokenExpiresAt,
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: tokens.refreshTokenExpiresAt,
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl ?? undefined,
    };
  }

  private setAccount(s: KawakiSession): void {
    this.ctx.state.patch('kawaki', { account: { userId: s.userId, login: s.username, displayName: s.username, avatarUrl: s.avatarUrl } });
  }

  /** A valid access token. Refreshes are single-flight: a rotated refresh token can only be used once. */
  async token(): Promise<string> {
    const s = this.ctx.secrets.get('kawaki');
    if (!s) throw new KawakiError('UNAUTHORIZED', 'Not logged in to Kawaki', 401);
    if (s.accessExpiresAt - REFRESH_SKEW_MS > Date.now()) return s.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.api
        .refresh(s.refreshToken)
        .then(({ tokens }) => {
          this.ctx.secrets.set('kawaki', this.sessionFrom(tokens, { id: s.userId, username: s.username, avatarUrl: s.avatarUrl }));
          return tokens.accessToken;
        })
        .finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  /** Call with a token; on 401 refresh once and retry (the access token may have been revoked early). */
  async authed<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.token());
    } catch (err) {
      if (!(err instanceof KawakiError) || err.status !== 401 || err.code === 'INVALID_REFRESH_TOKEN') throw err;
      const s = this.ctx.secrets.get('kawaki');
      if (s) this.ctx.secrets.set('kawaki', { ...s, accessExpiresAt: 0 });
      return fn(await this.token());
    }
  }

  private handleAuthError(err: unknown): void {
    const invalid = err instanceof KawakiError && (err.code === 'INVALID_REFRESH_TOKEN' || err.code === 'BANNED');
    if (invalid) {
      this.stop();
      this.ctx.secrets.set('kawaki', undefined);
      this.ctx.state.replace('kawaki', { status: 'error', error: errorMessage(err), nowWatching: null, partner: null });
      this.ctx.toast('error', 'toast.kawakiSessionExpired');
      return;
    }
    // Network trouble: keep the session, show the error, keep polling.
    this.ctx.state.patch('kawaki', { status: 'error', error: errorMessage(err) });
    this.startPolling();
  }

  // ---------- now watching ----------

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.ctx.secrets.get('kawaki') || this.refreshingNow) return;
    this.refreshingNow = true;
    try {
      const next = await this.authed((t) => this.fetchNowWatching(t));
      if (!this.ctx.secrets.get('kawaki')) return;
      if (this.ctx.state.current.kawaki.status !== 'connected') this.ctx.state.patch('kawaki', { status: 'connected', error: undefined });
      this.setNow(next);
      if (Date.now() - this.partnerCheckedAt > PARTNER_REFRESH_MS) void this.refreshPartner();
    } catch (err) {
      if (err instanceof KawakiError && (err.code === 'INVALID_REFRESH_TOKEN' || err.code === 'BANNED')) return this.handleAuthError(err);
      console.warn('[kawaki] refresh', errorMessage(err));
      this.ctx.state.patch('kawaki', { status: 'error', error: errorMessage(err) });
    } finally {
      this.refreshingNow = false;
    }
  }

  private async fetchNowWatching(token: string): Promise<KawakiNowWatching | null> {
    if (!this.nowWatchingMissing) {
      try {
        const { nowWatching } = await this.api.nowWatching(token);
        if (nowWatching) return fromNowWatching(nowWatching, this.api);
        return this.ctx.settings.get('kawaki').keepLast ? this.now : null;
      } catch (err) {
        if (!(err instanceof KawakiError) || err.status !== 404) throw err;
        this.nowWatchingMissing = true;
      }
    }
    const { items } = await this.api.watching(token);
    return items[0] ? fromWatchList(items[0], this.api) : null;
  }

  private setNow(next: KawakiNowWatching | null): void {
    const prev = this.now;
    const changed = !sameWatch(prev, next) || prev?.progressSec !== next?.progressSec;
    if (!changed) return;
    this.ctx.state.patch('kawaki', { nowWatching: next });
    this.ctx.bus.emit('kawaki:now', next);
    if (!sameWatch(prev, next)) void this.maybeRetitle();
  }

  private async refreshPartner(): Promise<void> {
    this.partnerCheckedAt = Date.now();
    const me = this.ctx.secrets.get('kawaki')?.username.toLowerCase();
    try {
      const { partners } = await this.api.partners();
      const p = partners.find((x) => x.username?.toLowerCase() === me);
      const partner: KawakiPartner | null = p ? { slug: p.slug, displayName: p.displayName, liveUrl: `${this.api.site}/live/${p.slug}` } : null;
      this.ctx.state.patch('kawaki', { partner });
    } catch (err) {
      console.warn('[kawaki] partners', errorMessage(err));
    }
  }

  /** Put the anime into the stream title — only for what's really playing, never for the list fallback. */
  private async maybeRetitle(): Promise<void> {
    const cfg = this.ctx.settings.get('kawaki');
    const now = this.now;
    if (!cfg.autoTitle || !cfg.titleTemplate.trim() || !now || now.source !== 'live') return;
    if (!this.deps.canUpdateTitle() || sameWatch(this.lastTitledWatch, now)) return;
    if (Date.now() - this.lastTitleAt < TITLE_MIN_INTERVAL_MS) {
      if (!this.retitleTimer) this.retitleTimer = setTimeout(() => {
        this.retitleTimer = null;
        void this.maybeRetitle();
      }, TITLE_MIN_INTERVAL_MS - (Date.now() - this.lastTitleAt));
      return;
    }
    const s = this.ctx.settings.all;
    const title = renderTemplate(cfg.titleTemplate, (name, arg) => resolveStreamVar(name, arg, s, this.ctx.state.current)).slice(0, 140);
    if (title === this.ctx.state.current.stream.title) {
      this.lastTitledWatch = now;
      return;
    }
    try {
      this.lastTitleAt = Date.now();
      await this.deps.updateTitle(title);
      this.lastTitledWatch = now;
    } catch (err) {
      console.warn('[kawaki] retitle', errorMessage(err));
    }
  }
}
