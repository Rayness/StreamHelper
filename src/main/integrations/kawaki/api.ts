/**
 * Kawaki API v1 client (https://kawaki.ru/api/v1). Every response is an envelope:
 * `{ ok: true, data }` or `{ ok: false, error: { code, message } }`, and `message` is safe to show.
 */

export class KawakiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'KawakiError';
  }
}

export interface KawakiTokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  sessionId: string;
}

export interface KawakiUser {
  id: string;
  username: string;
  avatarUrl?: string | null;
}

export type DevicePoll = { status: 'pending' } | { status: 'expired' } | { status: 'approved'; tokens: KawakiTokens; user: KawakiUser };

/** GET /me/now-watching (added for StreamHelper). */
export interface NowWatchingDto {
  anime: { id: string; externalId: number; title: string; titleEn: string | null; posterUrl: string | null; episodeCount: number | null };
  episode: { id: string; number: number } | null;
  progress: number | null;
  duration: number | null;
  updatedAt: string;
}

export interface WatchListItemDto {
  episodesWatched?: number;
  anime: { id: string; externalId: number; title: string; titleEn: string | null; posterUrl: string | null; episodeCount: number | null };
}

export interface PartnerDto {
  slug: string;
  displayName: string;
  username: string | null;
  streaming?: boolean;
}

export interface CatalogItemDto {
  id: string;
  externalId: number;
  title: string;
  titleEn?: string | null;
  titleJp?: string | null;
  posterUrl?: string | null;
}

export interface QuizTitleDto {
  id: string;
  titles: { ru: string; en: string | null; jp: string | null; romaji: string | null };
  poster: string | null;
}

export interface QuizFrameDto {
  url: string;
  episodeNumber: number | null;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export type Fetch = typeof fetch;

export class KawakiApi {
  constructor(
    private baseUrl: () => string,
    private fetchImpl: Fetch = fetch,
  ) {}

  get site(): string {
    return this.baseUrl().replace(/\/+$/, '');
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.site}/api/v1${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new KawakiError('NETWORK', 'Kawaki is unreachable', 0);
    }
    const env = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!env) throw new KawakiError(res.status === 404 ? 'NOT_FOUND' : 'BAD_RESPONSE', `HTTP ${res.status}`, res.status);
    if (!env.ok) throw new KawakiError(env.error.code, env.error.message, res.status);
    return env.data;
  }

  deviceStart() {
    return this.request<{ userCode: string; deviceCode: string; expiresAt: number }>('/auth/device/start', {
      method: 'POST',
      body: { platform: 'DESKTOP', deviceName: 'StreamHelper' },
    });
  }

  devicePoll(deviceCode: string) {
    return this.request<DevicePoll>('/auth/device/poll', { method: 'POST', body: { deviceCode, platform: 'DESKTOP', deviceName: 'StreamHelper' } });
  }

  refresh(refreshToken: string) {
    return this.request<{ tokens: KawakiTokens }>('/auth/refresh', { method: 'POST', body: { refreshToken } });
  }

  logout(refreshToken: string) {
    return this.request<unknown>('/auth/logout', { method: 'POST', body: { refreshToken } });
  }

  me(token: string) {
    return this.request<{ user: KawakiUser }>('/me', { token });
  }

  nowWatching(token: string) {
    return this.request<{ nowWatching: NowWatchingDto | null }>('/me/now-watching', { token });
  }

  watching(token: string) {
    return this.request<{ items: WatchListItemDto[] }>('/me/watchlist?status=WATCHING&page=1', { token });
  }

  partners() {
    return this.request<{ partners: PartnerDto[] }>('/partners');
  }

  catalog(page: number, sort = 'score') {
    return this.request<{ items: CatalogItemDto[]; totalPages: number }>(`/catalog?sort=${sort}&page=${page}`);
  }

  quizTitle(token: string, id: string) {
    return this.request<QuizTitleDto>(`/quiz/titles/${encodeURIComponent(id)}`, { token });
  }

  quizFrames(token: string, animeId: string) {
    return this.request<{ items: QuizFrameDto[]; hasMore: boolean }>(`/quiz/assets/frames?animeId=${encodeURIComponent(animeId)}`, { token });
  }

  animeUrl(externalId: number): string {
    return `${this.site}/anime/${externalId}`;
  }
}
