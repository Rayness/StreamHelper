import { TokenManager, TwitchAuthError } from './auth';

const HELIX = 'https://api.twitch.tv/helix';

export class HelixError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

function buildUrl(path: string, query?: Query): string {
  const url = new URL(HELIX + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export class HelixClient {
  constructor(
    private clientId: () => string,
    private tokens: TokenManager,
  ) {}

  async request<T = any>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const send = async (accessToken: string) =>
      fetch(buildUrl(path, opts.query), {
        method,
        headers: {
          'Client-Id': this.clientId(),
          Authorization: `Bearer ${accessToken}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

    let res = await send(await this.tokens.getAccessToken());
    if (res.status === 401) {
      try {
        res = await send((await this.tokens.refresh()).accessToken);
      } catch (err) {
        if (err instanceof TwitchAuthError) throw new HelixError('unauthorized', 401);
        throw err;
      }
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new HelixError(json?.message ?? `${method} ${path} failed (${res.status})`, res.status);
    return json as T;
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }
  post<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>('POST', path, { body, query });
  }
  patch<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>('PATCH', path, { body, query });
  }
  delete<T = any>(path: string, query?: Query) {
    return this.request<T>('DELETE', path, { query });
  }
}
