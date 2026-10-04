import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthToken } from '../src/main/core/secrets';
import { TokenManager } from '../src/main/platforms/twitch/auth';

afterEach(() => vi.unstubAllGlobals());

describe('Twitch token refresh ownership', () => {
  it.each(['logout', 'new account'])('cannot restore the old token after %s during refresh', async (action) => {
    let token: OAuthToken | undefined = { accessToken: 'old', refreshToken: 'old-refresh', scopes: [] };
    let complete!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { complete = resolve; }));
    const save = vi.fn((next: OAuthToken | undefined) => { token = next; });
    const manager = new TokenManager(() => 'client', () => token, save);
    const refresh = manager.refresh();
    token = action === 'logout' ? undefined : { accessToken: 'another', refreshToken: 'another-refresh', scopes: [] };
    complete(new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 })));
    await expect(refresh).rejects.toThrow('account changed');
    expect(save).not.toHaveBeenCalled();
    expect(token?.accessToken).toBe(action === 'logout' ? undefined : 'another');
  });

  it('does not delete a new account when an old refresh is rejected', async () => {
    let token: OAuthToken | undefined = { accessToken: 'old', refreshToken: 'old-refresh', scopes: [] };
    let complete!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { complete = resolve; }));
    const manager = new TokenManager(() => 'client', () => token, (next) => { token = next; });
    const refresh = manager.refresh();
    token = { accessToken: 'another', refreshToken: 'another-refresh', scopes: [] };
    complete(new Response(JSON.stringify({ message:'Invalid refresh token' }), { status:400 }));
    await expect(refresh).rejects.toThrow();
    expect(token?.accessToken).toBe('another');
  });
});
