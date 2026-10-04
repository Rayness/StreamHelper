import { app } from 'electron';
import { join } from 'node:path';
import type { MusicSourceKind, MusicSourcePreference, MusicTrack } from '@shared/types';
import type { AppContext } from '../core/context';
import type * as WinRt from '../winrt/generated';

type MediaSession = WinRt.GlobalSystemMediaTransportControlsSession;
type MediaProperties = WinRt.GlobalSystemMediaTransportControlsSessionMediaProperties;
type Bindings = typeof WinRt;

interface Candidate {
  session: MediaSession;
  properties: MediaProperties;
  kind: MusicSourceKind;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
}

const SOURCE_PRIORITY: Record<MusicSourceKind, number> = { spotify: 4, yandex: 3, browser: 2, other: 1 };
const POLL_MS = 3_000;
const RESYNC_MS = 15_000;
const IDLE_POLL_MS = 15_000;

/** Classify the source ID published by Windows; browser tabs do not expose their URL. */
export function musicSourceKind(appId: string): MusicSourceKind {
  const id = appId.toLowerCase();
  if (id.includes('spotify')) return 'spotify';
  if (/yandex.*music|music.*yandex|music\.yandex/.test(id)) return 'yandex';
  if (/chrome|msedge|firefox|browser|opera|vivaldi|brave/.test(id)) return 'browser';
  return 'other';
}

/** Active playback wins; within that group auto mode prefers Spotify and Yandex Music. */
export function chooseMusicCandidate<T extends { kind: MusicSourceKind; playing: boolean }>(
  candidates: readonly T[],
  source: MusicSourcePreference,
): T | null {
  const matches = source === 'auto' || source === 'any' ? candidates : candidates.filter((item) => item.kind === source);
  return [...matches].sort((a, b) =>
    Number(b.playing) - Number(a.playing) ||
    (source === 'auto' ? SOURCE_PRIORITY[b.kind] - SOURCE_PRIORITY[a.kind] : 0),
  )[0] ?? null;
}

function timeline(session: MediaSession): Pick<MusicTrack, 'positionMs' | 'durationMs'> {
  try {
    const info = session.getTimelineProperties();
    const start = Number(info.startTime.duration) / 10_000;
    const end = Number(info.endTime.duration) / 10_000;
    const position = Number(info.position.duration) / 10_000;
    const durationMs = end > start && end - start < 86_400_000 ? Math.round(end - start) : null;
    const positionMs = durationMs === null ? null : Math.max(0, Math.min(durationMs, Math.round(position - start)));
    return { positionMs, durationMs };
  } catch {
    return { positionMs: null, durationMs: null };
  }
}

function imageType(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** Reads a bounded local Windows thumbnail; no Spotify/Yandex credentials or API calls. */
async function artworkDataUrl(bindings: Bindings, properties: MediaProperties): Promise<string | null> {
  let reader: WinRt.DataReader | null = null;
  try {
    const thumbnail = properties.thumbnail;
    if (!thumbnail) return null;
    const stream = await thumbnail.openReadAsync();
    reader = bindings.DataReader.createDataReader(stream as unknown as WinRt.IInputStream);
    const count = await reader.loadAsync(1_000_001);
    if (count < 1 || count > 1_000_000) return null;
    const bytes = reader.readBytes(new Uint8Array(count));
    const mime = imageType(bytes);
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  } catch {
    return null;
  } finally {
    try { reader?.close(); } catch { /* Session may have closed concurrently. */ }
  }
}

/** Polls Windows' global media sessions and supplies the overlay with a current track. */
export class MusicService {
  private bindings: Bindings | null = null;
  private manager: WinRt.GlobalSystemMediaTransportControlsSessionManager | null = null;
  private timer: NodeJS.Timeout | null = null;
  private initialized = false;
  private busy = false;
  private stopped = false;
  private lastFingerprint = '';
  private lastArtworkKey = '';
  private lastArtwork: string | null = null;
  private lastArtworkAttemptAt = 0;
  private lastPublishAt = 0;
  private unsubscribe: () => void;

  /** Pause the active Windows media session and return its app ID for later resumption. */
  async pauseCurrent(): Promise<string | null> {
    if (!this.manager) return null;
    const scope = this.bindings?.createProjectedLifetimeScope();
    try {
      const preferred = this.ctx.state.current.music.track?.source;
      const sessions = Array.from(this.manager.getSessions() ?? []);
      const playing = sessions.filter((session) =>
        session.getPlaybackInfo().playbackStatus === this.bindings?.GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing);
      const session = playing.find((item) => musicSourceKind(item.sourceAppUserModelId) === preferred) ?? playing[0];
      return session && await session.tryPauseAsync() ? session.sourceAppUserModelId : null;
    } catch (error) {
      console.warn('[music] pause failed', error);
      return null;
    } finally {
      scope?.dispose();
    }
  }

  async resumeSource(appId: string): Promise<void> {
    if (!this.manager) return;
    const scope = this.bindings?.createProjectedLifetimeScope();
    try {
      const session = Array.from(this.manager.getSessions() ?? []).find((item) => item.sourceAppUserModelId === appId);
      await session?.tryPlayAsync();
    } finally {
      scope?.dispose();
    }
  }

  async control(source: MusicSourceKind, action: 'play' | 'pause' | 'next'): Promise<void> {
    if (!this.manager) throw new Error('Windows media sessions are unavailable');
    const scope = this.bindings?.createProjectedLifetimeScope();
    try {
      const session = Array.from(this.manager.getSessions() ?? []).find((item) => musicSourceKind(item.sourceAppUserModelId) === source);
      if (!session) throw new Error(`No ${source} media session found`);
      const ok = action === 'play' ? await session.tryPlayAsync() : action === 'pause' ? await session.tryPauseAsync() : await session.trySkipNextAsync();
      if (!ok) throw new Error(`The ${source} player rejected ${action}`);
      void this.refresh();
    } finally {
      scope?.dispose();
    }
  }

  constructor(private ctx: AppContext, private bindingsRoot = app.getAppPath()) {
    this.unsubscribe = ctx.bus.on('settings:changed', (key) => {
      if (key === 'musicOverlay') void this.refresh();
    });
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.refresh();
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe();
    this.releaseManager();
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    const active = this.ctx.isUiVisible?.() || this.ctx.state.current.overlayKinds.music || this.ctx.state.current.songRequests.current;
    const delay = this.ctx.state.current.music.status === 'unavailable' ? 60_000 : active ? POLL_MS : IDLE_POLL_MS;
    this.timer = setTimeout(async () => { await this.refresh(); this.schedulePoll(); }, delay);
  }

  private releaseManager(): void {
    if (this.manager && this.bindings) {
      try { this.bindings.releaseProjected(this.manager); } catch { /* already released */ }
    }
    this.manager = null;
  }

  private async connect(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Windows media sessions are available only on Windows');
    if (!this.bindings) {
      const { roInitialize } = require('@microsoft/dynwinrt') as typeof import('@microsoft/dynwinrt');
      if (!this.initialized) {
        roInitialize(1);
        this.initialized = true;
      }
      this.bindings = require(join(this.bindingsRoot, 'src', 'main', 'winrt', 'generated')) as Bindings;
    }
    const manager = await this.bindings.GlobalSystemMediaTransportControlsSessionManager.requestAsync();
    if (this.stopped) { this.bindings.releaseProjected(manager); return; }
    this.manager = manager;
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      if (!this.manager) await this.connect();
      if (this.stopped || !this.manager || !this.bindings) return;
      const scope = this.bindings.createProjectedLifetimeScope();
      try {
        const sessions = this.manager.getSessions();
        const candidates: Candidate[] = [];
        for (const session of sessions ?? []) {
          try {
            const properties = await session.tryGetMediaPropertiesAsync();
            const title = properties?.title?.trim();
            if (!title) continue;
            candidates.push({
              session,
              properties,
              kind: musicSourceKind(session.sourceAppUserModelId),
              title,
              artist: properties.artist?.trim() || '',
              album: properties.albumTitle?.trim() || '',
              playing: session.getPlaybackInfo().playbackStatus === this.bindings.GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing,
            });
          } catch { /* One player may disappear during enumeration. */ }
        }
        const sources = [...new Set(candidates.map((item) => item.kind))];
        const selected = chooseMusicCandidate(candidates, this.ctx.settings.get('musicOverlay').source);
        let track: MusicTrack | null = null;
        if (selected) {
          const artworkKey = `${selected.session.sourceAppUserModelId}\0${selected.title}\0${selected.artist}\0${selected.album}`;
          if (artworkKey !== this.lastArtworkKey || (!this.lastArtwork && Date.now() - this.lastArtworkAttemptAt >= 60_000)) {
            this.lastArtwork = await artworkDataUrl(this.bindings, selected.properties);
            this.lastArtworkKey = artworkKey;
            this.lastArtworkAttemptAt = Date.now();
          }
          track = {
            source: selected.kind,
            title: selected.title,
            artist: selected.artist,
            album: selected.album,
            artwork: this.lastArtwork,
            playing: selected.playing,
            ...timeline(selected.session),
            observedAt: Date.now(),
          };
        }
        this.publish(track, sources, 'ready', selected?.session.sourceAppUserModelId ?? '');
      } finally {
        scope.dispose();
      }
    } catch (error) {
      if (this.ctx.state.current.music.status !== 'unavailable') console.warn('[music] Windows media sessions unavailable', error);
      this.releaseManager();
      this.publish(null, [], 'unavailable');
    } finally {
      this.busy = false;
    }
  }

  private publish(track: MusicTrack | null, sources: MusicSourceKind[], status: 'ready' | 'unavailable' = 'ready', appId = ''): void {
    if (this.stopped) return;
    const previous = this.ctx.state.current.music;
    const fingerprint = track ? `${appId}\0${track.source}\0${track.title}\0${track.artist}\0${track.album}\0${track.playing}\0${!!track.artwork}` : '';
    const now = Date.now();
    const changed = fingerprint !== this.lastFingerprint || status !== previous.status;
    const resync = !!track?.playing && now - this.lastPublishAt >= RESYNC_MS;
    const sourcesChanged = sources.join('|') !== previous.sources.join('|');
    if (!changed && !resync && !sourcesChanged) return;
    this.lastFingerprint = fingerprint;
    this.lastPublishAt = now;
    this.ctx.state.replace('music', { status, track, sources });
    this.ctx.bus.emit('music:changed', track);
  }
}
