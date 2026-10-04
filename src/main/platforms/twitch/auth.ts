import type { OAuthToken } from '../../core/secrets';

const ID_BASE = 'https://id.twitch.tv/oauth2';

export const BROADCASTER_SCOPES = [
  'user:read:chat',
  'user:write:chat',
  'moderator:read:followers',
  'moderator:manage:banned_users',
  'moderator:manage:chat_messages',
  'moderator:manage:shoutouts',
  'channel:read:subscriptions',
  'channel:read:redemptions',
  'channel:manage:broadcast',
  'bits:read',
];

export const BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];

export class TwitchAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
}

function toToken(res: TokenResponse, scopes: string[]): OAuthToken {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: res.expires_in ? Date.now() + res.expires_in * 1000 : undefined,
    scopes: res.scope ?? scopes,
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Step 1 of the Device Code Grant Flow: ask Twitch for a code the user enters in the browser. */
export async function startDeviceCode(clientId: string, scopes: string[]): Promise<DeviceCodeStart> {
  const { status, json } = await postForm(`${ID_BASE}/device`, { client_id: clientId, scopes: scopes.join(' ') });
  if (status !== 200) throw new TwitchAuthError(json?.message ?? `device code request failed (${status})`, status);
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    expiresIn: json.expires_in,
    interval: json.interval ?? 5,
  };
}

/** Step 2: poll until the user approves (or the code expires / the caller aborts). */
export async function pollDeviceCode(
  clientId: string,
  scopes: string[],
  start: DeviceCodeStart,
  signal: AbortSignal,
): Promise<OAuthToken> {
  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = start.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval, signal);
    const { status, json } = await postForm(`${ID_BASE}/token`, {
      client_id: clientId,
      scopes: scopes.join(' '),
      device_code: start.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (status === 200) return toToken(json, scopes);
    const msg: string = json?.message ?? '';
    if (msg === 'authorization_pending') continue;
    if (msg === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new TwitchAuthError(msg || `token polling failed (${status})`, status);
  }
  throw new TwitchAuthError('expired_token');
}

/** Public clients refresh without a secret. Twitch rotates the refresh token on every use. */
export async function refreshToken(clientId: string, token: OAuthToken): Promise<OAuthToken> {
  if (!token.refreshToken) throw new TwitchAuthError('no refresh token', 401);
  const { status, json } = await postForm(`${ID_BASE}/token`, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
  });
  if (status !== 200) throw new TwitchAuthError(json?.message ?? `refresh failed (${status})`, status);
  return { ...toToken(json, token.scopes), userId: token.userId, login: token.login };
}

export interface ValidateResult {
  clientId: string;
  login: string;
  userId: string;
  scopes: string[];
  expiresIn: number;
}

/** Returns null when the token is invalid (401). Twitch requires validating tokens hourly. */
export async function validateToken(accessToken: string): Promise<ValidateResult | null> {
  const res = await fetch(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) return null;
  if (!res.ok) throw new TwitchAuthError(`validate failed (${res.status})`, res.status);
  const json: any = await res.json();
  return { clientId: json.client_id, login: json.login, userId: json.user_id, scopes: json.scopes ?? [], expiresIn: json.expires_in };
}

export async function revokeToken(clientId: string, accessToken: string): Promise<void> {
  await postForm(`${ID_BASE}/revoke`, { client_id: clientId, token: accessToken }).catch(() => undefined);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new TwitchAuthError('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new TwitchAuthError('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Keeps one account's token fresh. Concurrent callers share a single in-flight refresh,
 * which matters because Twitch invalidates the old refresh token on use.
 */
export class TokenManager {
  private refreshing: Promise<OAuthToken> | null = null;

  constructor(
    private clientId: () => string,
    private load: () => OAuthToken | undefined,
    private save: (t: OAuthToken | undefined) => void,
  ) {}

  get token(): OAuthToken | undefined {
    return this.load();
  }

  async getAccessToken(): Promise<string> {
    const t = this.load();
    if (!t) throw new TwitchAuthError('not logged in', 401);
    if (t.expiresAt && t.expiresAt - Date.now() < 5 * 60_000) return (await this.refresh()).accessToken;
    return t.accessToken;
  }

  refresh(): Promise<OAuthToken> {
    if (!this.refreshing) {
      const current = this.load();
      this.refreshing = (async () => {
        if (!current) throw new TwitchAuthError('not logged in', 401);
        try {
          const next = await refreshToken(this.clientId(), current);
          const latest = this.load();
          if (!latest || latest.accessToken !== current.accessToken || latest.refreshToken !== current.refreshToken) {
            throw new TwitchAuthError('account changed during token refresh', 401);
          }
          this.save(next);
          return next;
        } catch (err) {
          const latest = this.load();
          if (latest?.accessToken === current.accessToken && latest?.refreshToken === current.refreshToken &&
            err instanceof TwitchAuthError && (err.status === 400 || err.status === 401)) this.save(undefined);
          throw err;
        }
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }
}
