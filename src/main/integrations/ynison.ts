import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

/*
 * Ynison is the Yandex Music "play on device" service: every running Yandex Music app or site
 * tab keeps one shared player state there. StreamHelper joins as a silent remote control
 * (a shadow device that can't play itself) and replaces the queue to start a track on the
 * device that is playing. The message format mirrors the official web player.
 */

const HOST = 'ynison.music.yandex.ru';
const REDIRECTOR = `wss://${HOST}/redirector.YnisonRedirectService/GetRedirectToYnison`;
const HUB_PATH = '/ynison_state.YnisonStateService/PutYnisonState';
const ORIGIN = 'https://music.yandex.ru';
const RECONNECT_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export interface YnisonVersion { device_id: string; version: number; timestamp_ms: number }
export interface YnisonPlayable {
  playable_id: string;
  playable_type: string;
  album_id_optional: string | null;
  from: string;
  title: string;
  cover_url_optional: string | null;
  navigation_id_optional?: null;
  playback_action_id_optional?: null;
}
export interface YnisonQueue {
  current_playable_index: number;
  entity_id: string;
  entity_type: string;
  playable_list: YnisonPlayable[];
  options: { repeat_mode: string };
  entity_context: string;
  version: YnisonVersion;
  from_optional: string;
  shuffle_optional?: unknown;
  initial_entity_optional?: unknown;
  adding_options_optional?: unknown;
  queue?: unknown;
}
export interface YnisonStatus { duration_ms: number; paused: boolean; playback_speed: number; progress_ms: number; version: YnisonVersion }
export interface YnisonPlayerState { player_queue: YnisonQueue; status: YnisonStatus; player_queue_inject_optional?: unknown }
export interface YnisonDevice {
  info: { device_id: string; title?: string; type?: string; app_name?: string };
  is_shadow?: boolean;
  capabilities?: { can_be_player?: boolean };
}
export interface YnisonState { player_state: YnisonPlayerState; devices: YnisonDevice[]; active_device_id_optional?: string | null }

export interface YnisonTrack { trackId: string; albumId?: string; title?: string; cover?: string; durationMs?: number }

/** What a socket needs to offer; tests pass a fake. */
export interface YnisonSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}
export type SocketFactory = (url: string, protocols: string[]) => YnisonSocket;

const defaultFactory: SocketFactory = (url, protocols) => new WebSocket(url, protocols, { headers: { Origin: ORIGIN } }) as unknown as YnisonSocket;

/** Version stamps tell Ynison which change is newer; the web player uses random 63-bit numbers. */
const version = (deviceId: string): YnisonVersion => ({ device_id: deviceId, version: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER), timestamp_ms: 0 });

const rid = (): string => {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};

const protocols = (headers: Record<string, string>): string[] => ['Bearer', 'v2', encodeURIComponent(JSON.stringify(headers))];

export function playableFor(track: YnisonTrack): YnisonPlayable {
  return {
    playable_id: track.trackId,
    playable_type: 'TRACK',
    album_id_optional: track.albumId ?? null,
    from: 'streamhelper-song-request',
    title: track.title ?? '',
    cover_url_optional: track.cover ?? null,
    navigation_id_optional: null,
    playback_action_id_optional: null,
  };
}

/** The playable the shared player is on right now. */
export function currentPlayable(state: YnisonState | null): YnisonPlayable | null {
  const queue = state?.player_state?.player_queue;
  return queue?.playable_list?.[queue.current_playable_index] ?? null;
}

/** A real Yandex Music app or site tab (not a remote control like us). */
export function playerDevices(state: YnisonState | null, ownId: string): YnisonDevice[] {
  return (state?.devices ?? []).filter((device) => device.info?.device_id !== ownId && !device.is_shadow && device.capabilities?.can_be_player !== false);
}

export class YnisonClient {
  private socket: YnisonSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = true;
  private sessionId = String(Math.floor(Math.random() * 1e18)).padStart(18, '1').slice(0, 18);
  state: YnisonState | null = null;
  /** When the latest state arrived, to estimate the playing position between updates. */
  stateAt = 0;

  constructor(
    private token: string,
    readonly deviceId: string,
    private events: {
      onState?: (state: YnisonState) => void;
      onStatus?: (status: 'connecting' | 'connected' | 'error', error?: string) => void;
    } = {},
    private factory: SocketFactory = defaultFactory,
  ) {}

  get connected(): boolean { return !!this.socket && this.socket.readyState === WebSocket.OPEN && !!this.state; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.openRedirector();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drop();
    this.state = null;
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* already closed */ }
  }

  private deviceHeaders(): Record<string, string> {
    return {
      'Ynison-Device-Id': this.deviceId,
      'Ynison-Device-Info': JSON.stringify({ app_name: 'StreamHelper', app_version: '1', type: 1 }),
      authorization: `OAuth ${this.token}`,
    };
  }

  private retry(error?: string): void {
    this.drop();
    if (this.stopped) return;
    this.events.onStatus?.(error ? 'error' : 'connecting', error);
    const delay = RECONNECT_MS[Math.min(this.attempt++, RECONNECT_MS.length - 1)];
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this.openRedirector(); }, delay);
  }

  private openRedirector(): void {
    this.events.onStatus?.('connecting');
    let socket: YnisonSocket;
    try {
      socket = this.factory(REDIRECTOR, protocols({ ...this.deviceHeaders(), 'Ynison-Session-Id': this.sessionId }));
    } catch (error) {
      return this.retry(String((error as Error).message ?? error));
    }
    this.socket = socket;
    let answered = false;
    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      answered = true;
      let reply: { host?: string; redirect_ticket?: string; session_id?: string; error?: { message?: string; details?: unknown } };
      try { reply = JSON.parse(String(data)); } catch { return this.retry('Ynison: bad redirector answer'); }
      if (reply.error || !reply.host || !reply.redirect_ticket) return this.retry(errorText(reply.error));
      this.socket = null;
      try { socket.close(); } catch { /* done with it */ }
      this.openHub(reply.host, reply.redirect_ticket, reply.session_id ?? this.sessionId);
    });
    socket.on('error', (error) => { if (this.socket === socket) this.retry(error.message); });
    socket.on('close', (code) => { if (this.socket === socket && !answered) this.retry(code === 1006 ? undefined : `Ynison closed (${code})`); });
  }

  private openHub(host: string, ticket: string, sessionId: string): void {
    if (this.stopped) return;
    const socket = this.factory(`wss://${host}${HUB_PATH}`, protocols({ ...this.deviceHeaders(), 'Ynison-Redirect-Ticket': ticket, 'Ynison-Session-Id': sessionId }));
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.sendRaw({ update_full_state: this.fullState(), rid: rid(), player_action_timestamp_ms: 0, activity_interception_type: 'DO_NOT_INTERCEPT_BY_DEFAULT' });
    });
    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      let message: (Partial<YnisonState> & { error?: { message?: string } }) | null = null;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (!message) return;
      if (message.error) return this.retry(errorText(message.error));
      if (!message.player_state) return;
      this.attempt = 0;
      const first = !this.state;
      this.state = { player_state: message.player_state, devices: message.devices ?? this.state?.devices ?? [], active_device_id_optional: message.active_device_id_optional ?? null };
      this.stateAt = Date.now();
      if (first) this.events.onStatus?.('connected');
      this.events.onState?.(this.state);
    });
    socket.on('error', (error) => { if (this.socket === socket) this.retry(error.message); });
    socket.on('close', () => { if (this.socket === socket) { this.state = null; this.retry(); } });
  }

  /** We join as a shadow remote: never becomes the active player, never plays sound itself. */
  private fullState(): unknown {
    const v = version(this.deviceId);
    return {
      player_state: {
        player_queue: {
          current_playable_index: -1, entity_id: '', entity_type: 'VARIOUS', playable_list: [], options: { repeat_mode: 'NONE' },
          shuffle_optional: null, entity_context: 'BASED_ON_ENTITY_BY_DEFAULT', version: v, from_optional: '', initial_entity_optional: null, adding_options_optional: null, queue: null,
        },
        status: { duration_ms: 0, paused: true, playback_speed: 1, progress_ms: 0, version: v },
        player_queue_inject_optional: null,
      },
      device: {
        volume: 0,
        capabilities: { can_be_player: false, can_be_remote_controller: true, volume_granularity: 20 },
        info: { app_name: 'StreamHelper', app_version: '1', title: 'StreamHelper', device_id: this.deviceId, type: 'WEB' },
        volume_info: { volume: 0, version: null },
        is_shadow: true,
      },
      is_currently_active: false,
      sync_state_from_eov_optional: null,
    };
  }

  private sendRaw(message: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private send(body: object): boolean {
    return this.sendRaw({ ...body, rid: rid(), player_action_timestamp_ms: Date.now(), activity_interception_type: 'DO_NOT_INTERCEPT_BY_DEFAULT' });
  }

  /** Replace the queue with these tracks and start the first one on the playing device. */
  playTracks(tracks: YnisonTrack[], options: { paused?: boolean; progressMs?: number } = {}): boolean {
    if (!tracks.length) return false;
    return this.setPlayerState({
      player_queue: {
        current_playable_index: 0, entity_id: '', entity_type: 'VARIOUS', playable_list: tracks.map(playableFor), options: { repeat_mode: 'NONE' },
        shuffle_optional: null, entity_context: 'BASED_ON_ENTITY_BY_DEFAULT', version: version(this.deviceId), from_optional: '', initial_entity_optional: null, adding_options_optional: null, queue: null,
      },
      status: { duration_ms: tracks[0].durationMs ?? 0, paused: !!options.paused, playback_speed: 1, progress_ms: options.progressMs ?? 0, version: version(this.deviceId) },
      player_queue_inject_optional: null,
    });
  }

  /** Put a saved player state back (the streamer's own music after the requests). */
  setPlayerState(state: YnisonPlayerState): boolean {
    const ok = this.send({
      update_player_state: {
        player_state: {
          ...state,
          player_queue: { ...state.player_queue, version: version(this.deviceId) },
          status: { ...state.status, version: version(this.deviceId) },
        },
      },
    });
    return ok;
  }

  /** Where the playing track is now: the last report plus the time since, unless paused. */
  progressMs(): number {
    const status = this.state?.player_state.status;
    if (!status) return 0;
    const elapsed = status.paused ? 0 : (Date.now() - this.stateAt) * (status.playback_speed || 1);
    return Math.max(0, Math.min(Number(status.duration_ms) || Infinity, Number(status.progress_ms) + elapsed));
  }

  setPaused(paused: boolean): boolean {
    const status = this.state?.player_state.status;
    if (!status) return false;
    return this.send({ update_playing_status: { playing_status: { ...status, progress_ms: Math.round(this.progressMs()), paused, version: version(this.deviceId) } } });
  }

  /** Volume of the playing device, 0–1. */
  setVolume(volume: number): boolean {
    const device = this.state?.active_device_id_optional;
    if (!device) return false;
    return this.send({ update_volume_info: { device_id: device, volume_info: { volume: Math.max(0, Math.min(1, volume)), version: version(this.deviceId) } } });
  }
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return 'Ynison error';
  const e = error as { message?: unknown; details?: unknown; grpc_code?: unknown; http_code?: unknown };
  const code = Number(e.http_code ?? e.grpc_code);
  if (code === 401 || code === 16 || /unauth|token/i.test(String(e.message ?? ''))) return 'unauthorized';
  return String(e.message ?? 'Ynison error').slice(0, 200);
}
