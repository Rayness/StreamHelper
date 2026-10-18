import { randomBytes } from 'node:crypto';
import type { AppContext } from '../core/context';
import type { RemotePlayer, RemotePlayerEvent } from '../features/songRequests';
import { currentPlayable, playerDevices, YnisonClient, type SocketFactory, type YnisonPlayerState, type YnisonState, type YnisonTrack } from './ynison';

/** The public client id of the Yandex Music apps: its token is what the Music API and Ynison accept. */
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
export const YANDEX_OAUTH_URL = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${CLIENT_ID}`;

/** How long the playing device may take to pick a request up. */
const START_TIMEOUT_MS = 12_000;
/** Ynison reports changes, not ticks: past the expected end with no news, the track is over. */
const END_GRACE_MS = 4_000;

/** `access_token` from the page Yandex redirects to after login (it is in the URL fragment). */
export function tokenFromRedirect(url: string): string | null {
  try {
    const parsed = new URL(url);
    const params = new URLSearchParams(parsed.hash.replace(/^#/, '') || parsed.search);
    const token = params.get('access_token');
    return token && /^[\w.-]{20,}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

interface Account { uid: string; login: string; displayName: string; hasPlus: boolean }

async function fetchAccount(token: string): Promise<Account | 'invalid' | null> {
  try {
    const res = await fetch('https://api.music.yandex.net/account/status', { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (!res.ok) return null;
    const json = await res.json() as { result?: { account?: { uid?: unknown; login?: unknown; displayName?: unknown; fullName?: unknown }; plus?: { hasPlus?: unknown } } };
    const account = json.result?.account;
    if (!account?.uid) return 'invalid';
    const login = typeof account.login === 'string' ? account.login : '';
    return {
      uid: String(account.uid),
      login,
      displayName: String(account.displayName || account.fullName || login || account.uid),
      hasPlus: json.result?.plus?.hasPlus === true,
    };
  } catch {
    return null;
  }
}

/**
 * The streamer's Yandex Music account: plays song requests in their Yandex Music app or site
 * through Ynison, notices when a track ends and gives their own music back afterwards.
 */
export class YandexMusicService implements RemotePlayer {
  private client: YnisonClient | null = null;
  private listeners = new Set<(event: RemotePlayerEvent) => void>();
  /** The request we started and whether the device picked it up. */
  private expected: { trackId: string; confirmed: boolean; startedAt: number } | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  /** The streamer's own queue before the first request took the player over. */
  private saved: { state: YnisonPlayerState; playing: boolean } | null = null;
  /** The playing device's own volume, put back with the streamer's music. */
  private savedVolume: number | null = null;
  /** Requests took the player over and it was not handed back yet: the snapshot is taken once per run. */
  private running = false;
  private loginPending: Promise<void> | null = null;
  /** Volume slider drags send dozens of changes a second: only the last one in a moment goes out. */
  private volumeTimer: NodeJS.Timeout | null = null;
  private pendingVolume: number | null = null;

  constructor(private ctx: AppContext, private factory?: SocketFactory, private openLogin?: (url: string) => Promise<string | null>) {
    ctx.bus.on('settings:changed', (key) => { if (key === 'songRequests') this.applySetting(); });
  }

  private get enabled(): boolean { return this.ctx.settings.get('songRequests').yandexPlayback !== false; }

  get ready(): boolean { return this.enabled && !!this.client?.connected; }

  onEvent(listener: (event: RemotePlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RemotePlayerEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.warn('[yandex] listener failed', error); }
    }
  }

  start(): void {
    const saved = this.ctx.secrets.get('yandexMusic');
    if (!saved?.accessToken) return void this.ctx.state.replace('yandexMusic', { status: 'disconnected' });
    this.ctx.state.patch('yandexMusic', { account: { userId: saved.uid ?? '', login: saved.login ?? '', displayName: saved.displayName ?? saved.login ?? '' } });
    this.applySetting();
  }

  stop(): void {
    this.clearTimers();
    if (this.volumeTimer) clearTimeout(this.volumeTimer);
    this.volumeTimer = null;
    this.pendingVolume = null;
    this.client?.stop();
    this.client = null;
  }

  private applySetting(): void {
    const saved = this.ctx.secrets.get('yandexMusic');
    if (!saved?.accessToken || !this.enabled) {
      if (this.client) {
        this.release(this.ctx.settings.get('songRequests').resumeWindowsMusic);
        this.stop();
      }
      if (saved?.accessToken) this.ctx.state.patch('yandexMusic', { status: 'disconnected', device: null, error: undefined });
      return;
    }
    if (this.client) return;
    this.client = new YnisonClient(saved.accessToken, saved.deviceId, {
      onStatus: (status, error) => {
        if (error === 'unauthorized') {
          this.stop();
          this.ctx.state.patch('yandexMusic', { status: 'error', error: this.ru ? 'Вход в Яндекс устарел — войдите снова.' : 'The Yandex login expired, sign in again.' });
          return;
        }
        this.ctx.state.patch('yandexMusic', { status, error: status === 'error' ? error : undefined });
      },
      onState: (state) => this.onState(state),
    }, this.factory);
    this.client.start();
  }

  private get ru(): boolean { return this.ctx.settings.get('language') === 'ru'; }

  /** Sign in through Yandex in a separate window; the token never touches settings.json. */
  login(): Promise<void> {
    // A second click must not open a second window.
    this.loginPending ??= (async () => {
      if (!this.openLogin) throw new Error('Login window unavailable');
      const token = await this.openLogin(YANDEX_OAUTH_URL);
      if (!token) throw new Error(this.ru ? 'Вход в Яндекс отменён.' : 'Yandex sign-in was cancelled.');
      await this.setToken(token);
    })().finally(() => { this.loginPending = null; });
    return this.loginPending;
  }

  async setToken(token: string): Promise<void> {
    const clean = token.trim().replace(/^OAuth\s+/i, '');
    if (!/^[\w.-]{20,}$/.test(clean)) throw new Error(this.ru ? 'Это не похоже на токен Яндекс Музыки.' : 'This does not look like a Yandex Music token.');
    const account = await fetchAccount(clean);
    if (account === 'invalid') throw new Error(this.ru ? 'Яндекс не принял токен. Войдите ещё раз.' : 'Yandex rejected the token. Sign in again.');
    if (!account) throw new Error(this.ru ? 'Не удалось связаться с Яндекс Музыкой. Проверьте интернет.' : 'Could not reach Yandex Music. Check the connection.');
    this.release(this.ctx.settings.get('songRequests').resumeWindowsMusic);
    this.stop();
    const previous = this.ctx.secrets.get('yandexMusic');
    this.ctx.secrets.set('yandexMusic', { accessToken: clean, deviceId: previous?.deviceId ?? randomBytes(16).toString('hex'), uid: account.uid, login: account.login, displayName: account.displayName });
    this.ctx.state.replace('yandexMusic', { status: 'connecting', account: { userId: account.uid, login: account.login, displayName: account.displayName }, hasPlus: account.hasPlus, device: null });
    if (this.ctx.settings.get('songRequests').yandexPlayback === false) this.ctx.settings.set('songRequests', { ...this.ctx.settings.get('songRequests'), yandexPlayback: true });
    this.applySetting();
  }

  logout(): void {
    const playing = this.expected;
    this.release(this.ctx.settings.get('songRequests').resumeWindowsMusic);
    this.stop();
    this.ctx.secrets.set('yandexMusic', undefined);
    this.ctx.state.replace('yandexMusic', { status: 'disconnected' });
    this.saved = null;
    this.running = false;
    this.expected = null;
    if (playing) this.emit({ type: 'failed', trackId: playing.trackId, error: this.ru ? 'Яндекс Музыка отключена.' : 'Yandex Music was disconnected.' });
  }

  private clearTimers(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.startTimer = null;
    this.endTimer = null;
  }

  private deviceTitle(state: YnisonState): string | null {
    const own = this.client?.deviceId ?? '';
    const devices = playerDevices(state, own);
    const active = devices.find((device) => device.info.device_id === state.active_device_id_optional);
    return (active ?? devices[0])?.info.title ?? null;
  }

  private onState(state: YnisonState): void {
    const device = this.deviceTitle(state);
    if (this.ctx.state.current.yandexMusic.device !== device) this.ctx.state.patch('yandexMusic', { device });
    const expected = this.expected;
    if (!expected) return;
    const playable = currentPlayable(state);
    const status = state.player_state.status;
    if (playable?.playable_id !== expected.trackId) {
      // The device moved on: autoplay after our single-track queue, or the streamer chose something.
      if (expected.confirmed) this.finish(expected.trackId);
      return;
    }
    if (!expected.confirmed && !status.paused && state.active_device_id_optional && state.active_device_id_optional !== this.client?.deviceId) {
      expected.confirmed = true;
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    const duration = Number(status.duration_ms) || 0;
    const progress = Number(status.progress_ms) || 0;
    if (expected.confirmed && duration > 0 && progress >= duration - 1500 && status.paused) return this.finish(expected.trackId);
    if (expected.confirmed && duration > 0 && !status.paused) {
      const left = (duration - progress) / (status.playback_speed || 1);
      this.endTimer = setTimeout(() => this.finish(expected.trackId), Math.max(0, left) + END_GRACE_MS);
    }
  }

  private finish(trackId: string): void {
    if (this.expected?.trackId !== trackId) return;
    this.expected = null;
    this.clearTimers();
    this.emit({ type: 'ended', trackId });
  }

  async play(track: YnisonTrack & { volume?: number }): Promise<void> {
    const client = this.client;
    if (!this.ready || !client?.state) throw new Error(this.ru ? 'Яндекс Музыка не подключена.' : 'Yandex Music is not connected.');
    if (!playerDevices(client.state, client.deviceId).length) {
      throw new Error(this.ru ? 'Откройте приложение или сайт Яндекс Музыки под тем же аккаунтом — включать трек негде.' : 'Open the Yandex Music app or site with the same account — there is nothing to play on.');
    }
    if (!this.running) {
      this.running = true;
      const playable = currentPlayable(client.state);
      if (playable && playable.playable_type === 'TRACK') this.saved = { state: structuredClone(client.state.player_state), playing: !client.state.player_state.status.paused };
      if (this.saved) this.saved.state.status = { ...this.saved.state.status, progress_ms: Math.round(client.progressMs()) };
      const device = client.state.devices.find((item) => item.info.device_id === client.state?.active_device_id_optional) as { volume_info?: { volume?: unknown } } | undefined;
      const volume = Number(device?.volume_info?.volume);
      this.savedVolume = Number.isFinite(volume) ? volume : null;
    }
    this.clearTimers();
    this.expected = { trackId: track.trackId, confirmed: false, startedAt: Date.now() };
    if (!client.playTracks([track])) {
      this.expected = null;
      throw new Error(this.ru ? 'Нет связи с Яндекс Музыкой.' : 'No connection to Yandex Music.');
    }
    if (track.volume !== undefined) this.setVolume(track.volume);
    else this.applyVolume();
    this.startTimer = setTimeout(() => {
      if (!this.expected || this.expected.trackId !== track.trackId || this.expected.confirmed) return;
      this.expected = null;
      this.clearTimers();
      this.emit({ type: 'failed', trackId: track.trackId, error: this.ru
        ? 'Яндекс Музыка не включила трек. Откройте приложение или сайт Яндекс Музыки и запустите любой трек, чтобы оно стало активным устройством.'
        : 'Yandex Music did not start the track. Open the Yandex Music app or site and play any track so it becomes the active device.' });
    }, START_TIMEOUT_MS);
  }

  pause(paused: boolean): void {
    if (!this.client) return;
    this.client.setPaused(paused);
    if (paused && this.endTimer) { clearTimeout(this.endTimer); this.endTimer = null; }
  }

  /** The requests are over (or the player goes back to YouTube): stop ours, give the streamer's music back. */
  release(restore: boolean): void {
    const client = this.client;
    const saved = this.saved;
    const ours = this.expected || (client?.state && currentPlayable(client.state)?.from === 'streamhelper-song-request');
    this.expected = null;
    this.clearTimers();
    this.saved = null;
    this.running = false;
    const volume = this.savedVolume;
    this.savedVolume = null;
    if (!client) return;
    if (volume !== null && ours) client.setVolume(volume);
    if (restore && saved) client.setPlayerState({ ...saved.state, status: { ...saved.state.status, paused: !saved.playing } });
    else if (ours) client.setPaused(true);
  }

  /** Stop our track without giving the queue back yet (a YouTube request plays next). */
  hold(): void {
    if (!this.expected && !(this.client?.state && currentPlayable(this.client.state)?.from === 'streamhelper-song-request')) return;
    this.expected = null;
    this.clearTimers();
    this.client?.setPaused(true);
  }

  setVolume(percent: number): void {
    if (!Number.isFinite(percent)) return;
    this.pendingVolume = Math.max(0, Math.min(100, percent)) / 100;
    if (this.volumeTimer) return;
    this.client?.setVolume(this.pendingVolume);
    this.pendingVolume = null;
    this.volumeTimer = setTimeout(() => {
      this.volumeTimer = null;
      if (this.pendingVolume !== null) { this.client?.setVolume(this.pendingVolume); this.pendingVolume = null; }
    }, 200);
  }

  private applyVolume(): void {
    const volume = this.ctx.settings.get('songRequests').volume;
    if (Number.isFinite(volume)) this.setVolume(volume);
  }
}
