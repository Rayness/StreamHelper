import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MusicSourceKind, MusicSourcePreference, MusicTrack } from '@shared/types';
import type { AppContext } from '../core/context';
import type * as WinRt from '../winrt/generated';
import { BrowserMusicBridge, browserHostForSession, classifyMusicSession, mediaHost, type MediaSource } from './browserMusic';

type MediaSession = WinRt.GlobalSystemMediaTransportControlsSession;
type MediaProperties = WinRt.GlobalSystemMediaTransportControlsSessionMediaProperties;
type Bindings = typeof WinRt;

interface Candidate extends MediaSource {
  session: MediaSession;
  properties: MediaProperties;
  appId: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
}

const SOURCE_PRIORITY: Record<MusicSourceKind, number> = { spotify: 5, yandex: 4, youtubeMusic: 3, youtube: 2, browser: 2, other: 1 };
const POLL_MS = 3_000;
const RESYNC_MS = 15_000;
const IDLE_POLL_MS = 15_000;

/** Active playback wins; within that group auto mode prefers Spotify and Yandex Music. */
export function chooseMusicCandidate<T extends { kind: MusicSourceKind; playing: boolean; browser?: boolean }>(
  candidates: readonly T[],
  source: MusicSourcePreference,
): T | null {
  const matches = source === 'auto' || source === 'any' ? candidates : candidates.filter((item) => item.kind === source || (source === 'browser' && item.browser));
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
  private browserHosts = new Map<string, string>();
  private paused: { token: string; key: string } | null = null;
  private windowsWork: Promise<unknown> = Promise.resolve();
  private unsubscribe: () => void;
  readonly browserBridge = new BrowserMusicBridge(() => this.ctx.secrets.get('browserMusicToken'), () => {
    this.ctx.state.patch('music', { browserConnected: this.browserBridge.snapshot().connected });
    if (this.manager) void this.refresh();
  });

  /** The generated WinRT bindings share a stack of lifetime scopes. Keep async scopes from overlapping. */
  private runWindows<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.windowsWork.then(operation);
    this.windowsWork = result.catch(() => {});
    return result;
  }

  /** Pause the active Windows media session and remember the specific track for later resumption. */
  async pauseCurrent(except?: MusicSourceKind): Promise<string | null> {
    return this.runWindows(async () => {
      if (!this.manager || this.stopped) return null;
      const scope = this.bindings?.createProjectedLifetimeScope();
      try {
        const playing = (await this.candidates()).filter((item) => item.playing && item.kind !== except);
        const preferred = this.ctx.settings.get('musicOverlay').source;
        const target = chooseMusicCandidate(playing, preferred) ?? chooseMusicCandidate(playing, 'auto');
        if (!target || !await target.session.tryPauseAsync()) return null;
        const token = randomUUID();
        this.paused = { token, key: this.sessionKey(target) };
        return token;
      } catch (error) {
        console.warn('[music] pause failed', error);
        return null;
      } finally {
        scope?.dispose();
      }
    });
  }

  async resumeSource(token: string): Promise<void> {
    return this.runWindows(async () => {
      if (this.paused?.token !== token) return;
      const { key } = this.paused;
      this.paused = null;
      if (!this.manager || this.stopped) return;
      const scope = this.bindings?.createProjectedLifetimeScope();
      try {
        const matches = (await this.candidates()).filter((item) => this.sessionKey(item) === key);
        if (matches.length === 1 && !matches[0].playing) await matches[0].session.tryPlayAsync();
      } finally {
        scope?.dispose();
      }
    });
  }

  async control(source: MusicSourceKind, action: 'play' | 'pause' | 'next'): Promise<void> {
    await this.runWindows(async () => {
      if (!this.manager || this.stopped) throw new Error('Windows media sessions are unavailable');
      const scope = this.bindings?.createProjectedLifetimeScope();
      try {
        const candidates = await this.candidates();
        const exact = candidates.filter((item) => item.kind === source);
        const session = chooseMusicCandidate(exact.length ? exact : candidates, source)?.session;
        if (!session) throw new Error(`No ${source} media session found`);
        const ok = action === 'play' ? await session.tryPlayAsync() : action === 'pause' ? await session.tryPauseAsync() : await session.trySkipNextAsync();
        if (!ok) throw new Error(`The ${source} player rejected ${action}`);
      } finally {
        scope?.dispose();
      }
    });
    void this.refresh();
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
    void this.runWindows(async () => this.releaseManager());
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

  private sessionKey(item: Candidate): string {
    return `${item.appId}\0${item.title}\0${item.artist}\0${item.album}`;
  }

  private async candidates(): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const session of this.manager?.getSessions() ?? []) {
      try {
        const appId = session.sourceAppUserModelId;
        const properties = await session.tryGetMediaPropertiesAsync();
        const title = properties?.title?.trim() || '';
        const artist = properties?.artist?.trim() || '';
        const album = properties?.albumTitle?.trim() || '';
        const subtitle = properties?.subtitle?.trim() || '';
        const playing = session.getPlaybackInfo().playbackStatus === this.bindings?.GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        candidates.push({ session, properties, appId, title, artist, album, playing, ...classifyMusicSession(appId, { title, artist, album, subtitle }) });
      } catch { /* One player may disappear during enumeration. */ }
    }
    const { connected, tabs } = this.browserBridge.snapshot();
    if (!connected) this.browserHosts.clear();
    const singleSession = candidates.filter((item) => item.browser && item.playing).length === 1;
    const hosts = new Map<string, string>();
    for (const item of candidates) {
      if (!item.browser) continue;
      const key = this.sessionKey(item);
      const host = item.playing
        ? browserHostForSession(item.title, tabs, singleSession && item.kind === 'browser' && !item.site)
        : this.browserHosts.get(key);
      if (host) {
        hosts.set(key, host);
        Object.assign(item, classifyMusicSession(item.appId, {}, host));
      }
    }
    this.browserHosts = hosts;
    return candidates;
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      await this.runWindows(() => this.refreshMedia());
    } finally {
      this.busy = false;
    }
  }

  private async refreshMedia(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.manager) await this.connect();
      if (this.stopped || !this.manager || !this.bindings) return;
      const scope = this.bindings.createProjectedLifetimeScope();
      try {
        const candidates = (await this.candidates()).filter((item) => item.title);
        const sources = [...new Set(candidates.map((item) => item.kind))];
        const selected = chooseMusicCandidate(candidates, this.ctx.settings.get('musicOverlay').source);
        let track: MusicTrack | null = null;
        if (selected) {
          const artworkKey = this.sessionKey(selected);
          if (artworkKey !== this.lastArtworkKey || (!this.lastArtwork && Date.now() - this.lastArtworkAttemptAt >= 60_000)) {
            this.lastArtwork = await artworkDataUrl(this.bindings, selected.properties);
            this.lastArtworkKey = artworkKey;
            this.lastArtworkAttemptAt = Date.now();
          }
          track = {
            source: selected.kind,
            site: selected.site,
            title: selected.title,
            artist: selected.browser && mediaHost(selected.artist) ? '' : selected.artist,
            album: selected.album,
            artwork: this.lastArtwork,
            playing: selected.playing,
            ...timeline(selected.session),
            observedAt: Date.now(),
          };
        }
        this.publish(track, sources, 'ready', selected?.appId ?? '');
      } finally {
        scope.dispose();
      }
    } catch (error) {
      if (this.ctx.state.current.music.status !== 'unavailable') console.warn('[music] Windows media sessions unavailable', error);
      this.releaseManager();
      this.publish(null, [], 'unavailable');
    }
  }

  private publish(track: MusicTrack | null, sources: MusicSourceKind[], status: 'ready' | 'unavailable' = 'ready', appId = ''): void {
    if (this.stopped) return;
    const previous = this.ctx.state.current.music;
    const fingerprint = track ? `${appId}\0${track.source}\0${track.site ?? ''}\0${track.title}\0${track.artist}\0${track.album}\0${track.playing}\0${!!track.artwork}` : '';
    const now = Date.now();
    const changed = fingerprint !== this.lastFingerprint || status !== previous.status;
    const resync = !!track?.playing && now - this.lastPublishAt >= RESYNC_MS;
    const sourcesChanged = sources.join('|') !== previous.sources.join('|');
    const browserConnected = this.browserBridge.snapshot().connected;
    if (!changed && !resync && !sourcesChanged && browserConnected === !!previous.browserConnected) return;
    this.lastFingerprint = fingerprint;
    this.lastPublishAt = now;
    this.ctx.state.replace('music', { status, track, sources, browserConnected });
    this.ctx.bus.emit('music:changed', track);
  }
}
