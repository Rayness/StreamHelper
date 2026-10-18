import { randomBytes } from 'node:crypto';
import type { ChatMessage, OverlayMessage, SongJam, SongRequest, SongRequestSettings, SongTrack, StreamEvent, StreamEventOf } from '@shared/types';
import type { AppContext } from '../core/context';
import type { MusicService } from './music';
import { hasPermission } from '../bot/permissions';
import { parseCommand } from '../bot/variables';
import { donationAmount } from '@shared/events';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Accept only individual YouTube videos, never arbitrary viewer-supplied URLs in the OBS player. */
export function youtubeVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    let id = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
      const parts = url.pathname.split('/').filter(Boolean);
      id = parts[0] === 'watch' ? (url.searchParams.get('v') ?? '') : ['shorts', 'live', 'embed'].includes(parts[0]) ? (parts[1] ?? '') : '';
    }
    return VIDEO_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

const LIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
/** Watch later, likes and "My Mix" belong to the signed-in account; the OBS player cannot open them. */
const PERSONAL_LIST = /^(WL|LL|LM|RDMM|RDTMAK)/;

/** A YouTube mix ("jam") or playlist link: the `list=` id and, when present, the video it starts from. */
export function youtubePlaylist(input: string): { listId: string; videoId?: string } | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!['youtu.be', 'www.youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname.toLowerCase())) return null;
    const listId = url.searchParams.get('list') ?? '';
    if (!LIST_ID.test(listId)) return null;
    // A mix built from one video carries that video in its id: RD + videoId.
    const videoId = youtubeVideoId(input) ?? (/^RD[A-Za-z0-9_-]{11}$/.test(listId) ? listId.slice(2) : null);
    return { listId, ...(videoId ? { videoId } : {}) };
  } catch {
    return null;
  }
}

/** Result of asking YouTube about a video before it is queued. */
export type VideoCheck = { ok: true; title?: string } | { ok: false; reason: 'notFound' | 'embedBlocked' };
export type VideoLookup = (videoId: string) => Promise<VideoCheck | null>;

/**
 * YouTube oEmbed needs no API key: 200 = embeddable (with title), 401/403 = the owner blocked
 * embedding (it would fail in OBS), 400/404 = removed, private or wrong. `null` = could not check;
 * the request is then accepted and the player reports problems later.
 */
export const oembedLookup: VideoLookup = async (videoId) => {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = await res.json().catch(() => null) as { title?: unknown } | null;
      return { ok: true, title: typeof json?.title === 'string' ? json.title.slice(0, 200) : undefined };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'embedBlocked' };
    if (res.status === 400 || res.status === 404) return { ok: false, reason: 'notFound' };
    return null;
  } catch {
    return null;
  }
};

/** oEmbed knows public playlists too; auto-generated mixes are not checked. */
export const oembedPlaylistLookup: VideoLookup = async (listId) => {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/playlist?list=${listId}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = await res.json().catch(() => null) as { title?: unknown } | null;
      return { ok: true, title: typeof json?.title === 'string' ? json.title.slice(0, 200) : undefined };
    }
    if ([400, 401, 403, 404].includes(res.status)) return { ok: false, reason: 'notFound' };
    return null;
  } catch {
    return null;
  }
};

/** Channel-points bookkeeping; only works for rewards created by this app. */
export interface RedemptionSettler { settle(rewardId: string, redemptionId: string, status: 'FULFILLED' | 'CANCELED'): Promise<void> }

type Rejection = 'userLimit' | 'tooLong' | 'live' | 'fewViews' | 'bannedWord' | 'noLink' |'noLinkOrQuery' | 'unsupportedLink' | 'noResults' | 'searchFailed' | 'yandexFailed' | 'full' | 'duplicate' | 'notFound' | 'embedBlocked' | 'playback' | 'userBanned' | 'videoBanned' | 'nothingPlaying';

const userKey = (name: string): string => name.trim().replace(/^@/, '').toLowerCase();

const urlsInText = (text: string): string[] => (text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map((raw) => raw.replace(/[),.!?;]+$/, ''));

export function youtubeUrlInText(text: string): string | null {
  return urlsInText(text).find((url) => youtubeVideoId(url)) ?? null;
}

const YANDEX_HOST = /^music\.yandex\.(ru|com|by|kz|uz|com\.tr)$/;

/** A Yandex Music track link: music.yandex.ru/album/1/track/2 or music.yandex.ru/track/2. */
export function yandexTrackId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!YANDEX_HOST.test(url.hostname.toLowerCase().replace(/^(www|next)\./, ''))) return null;
    return url.pathname.match(/\/track\/(\d{1,12})(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export type MusicLink = { kind: 'youtube'; url: string; videoId: string } | { kind: 'yandex'; url: string; trackId: string };

/** The first link the player can use: YouTube / YouTube Music video or a Yandex Music track. */
export function musicLinkInText(text: string): MusicLink | null {
  for (const url of urlsInText(text)) {
    const videoId = youtubeVideoId(url);
    if (videoId) return { kind: 'youtube', url, videoId };
    const trackId = yandexTrackId(url);
    if (trackId) return { kind: 'yandex', url, trackId };
  }
  return null;
}

/** A Yandex Music track as the Music API describes it. `title` is "Artist - Title (version)". */
export interface YandexTrack { trackId: string; albumId?: string; title: string; durationMs?: number; cover?: string; available: boolean }
/** One track by id; `null` = Yandex could not be asked or does not know it. */
export type YandexTrackInfo = (trackId: string) => Promise<YandexTrack | null>;
/** Track search; `null` = Yandex could not be asked. */
export type YandexSearch = (query: string) => Promise<YandexTrack[] | null>;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

type RawYandexTrack = { id?: unknown; title?: unknown; version?: unknown; available?: unknown; durationMs?: unknown; coverUri?: unknown; artists?: { name?: unknown }[]; albums?: { id?: unknown }[] };

export function parseYandexTrack(raw: RawYandexTrack | undefined): YandexTrack | null {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim() || !/^\d{1,12}$/.test(String(raw.id ?? ''))) return null;
  const artists = (raw.artists ?? []).map((a) => a.name).filter((name): name is string => typeof name === 'string' && !!name.trim());
  const version = typeof raw.version === 'string' && raw.version.trim() ? ` (${raw.version.trim()})` : '';
  const albumId = raw.albums?.[0]?.id;
  const duration = Number(raw.durationMs);
  return {
    trackId: String(raw.id),
    ...(albumId !== undefined && /^\d+$/.test(String(albumId)) ? { albumId: String(albumId) } : {}),
    title: `${artists.length ? `${artists.slice(0, 3).join(', ')} - ` : ''}${raw.title.trim()}${version}`.slice(0, 200),
    ...(duration > 0 ? { durationMs: duration } : {}),
    ...(typeof raw.coverUri === 'string' && raw.coverUri ? { cover: `https://${raw.coverUri.replace('%%', '200x200')}` } : {}),
    available: raw.available !== false,
  };
}

export const yandexTrackInfo: YandexTrackInfo = async (trackId) => {
  try {
    const res = await fetch(`https://api.music.yandex.net/tracks/${trackId}`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const json = await res.json().catch(() => null) as { result?: RawYandexTrack[] } | null;
      const track = parseYandexTrack(json?.result?.[0]);
      if (track) return track;
    }
  } catch { /* try the public page */ }
  try {
    const res = await fetch(`https://music.yandex.ru/track/${trackId}`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const html = await res.text();
    const raw = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ?? html.match(/<title>([^<]+)<\/title>/i)?.[1];
    const title = raw?.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/\s*[.|—–-]?\s*(слушать|listen|яндекс[ .]?музык|yandex[ .]?music).*$/i, '').trim();
    // A captcha page has a generic title only.
    return title && !/^(яндекс|yandex|ой|oops)/i.test(title) ? { trackId, title: title.slice(0, 200), available: true } : null;
  } catch {
    return null;
  }
};

export const yandexSearch: YandexSearch = async (query) => {
  try {
    const res = await fetch(`https://api.music.yandex.net/search?text=${encodeURIComponent(query)}&type=track&page=0&nocorrect=false`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null) as { result?: { tracks?: { results?: RawYandexTrack[] } } } | null;
    if (!json) return null;
    return (json.result?.tracks?.results ?? []).slice(0, 10).map(parseYandexTrack).filter((track): track is YandexTrack => !!track);
  } catch {
    return null;
  }
};

/** What the song queue needs from the Yandex Music remote (Ynison): play, pause, hand the player back. */
export type RemotePlayerEvent = { type: 'ended'; trackId: string } | { type: 'failed'; trackId: string; error: string };
export interface RemotePlayer {
  readonly ready: boolean;
  play(track: { trackId: string; albumId?: string; title?: string; cover?: string; durationMs?: number; volume?: number }): Promise<void>;
  pause(paused: boolean): void;
  /** Requests are over: stop ours and (with `restore`) give the streamer's own music back. */
  release(restore: boolean): void;
  /** Stop ours for now; a YouTube request plays next. */
  hold(): void;
  setVolume(percent: number): void;
  onEvent(listener: (event: RemotePlayerEvent) => void): () => void;
}

export const isRemote = (item: Pick<SongRequest, 'provider'> | null | undefined): boolean => item?.provider === 'yandex';

/** Folder inside the media directory with songs added from the computer. */
export const LOCAL_SONGS_DIR = 'songs';
export const localSongUrl = (file: string): string => `/media/${LOCAL_SONGS_DIR}/${encodeURIComponent(file)}`;

/** The favourite a queued or playing item becomes. */
export function trackOf(item: SongRequest): SongTrack {
  if (item.provider === 'local') return { videoId: item.videoId, kind: 'local', file: item.videoId.slice('local:'.length), ...(item.title ? { title: item.title } : {}) };
  if (item.provider === 'yandex') {
    return { videoId: item.videoId, kind: 'yandex', ...(item.title ? { title: item.title } : {}), ...(item.cover ? { cover: item.cover } : {}),
      ...(item.yandexAlbumId ? { albumId: item.yandexAlbumId } : {}), ...(item.durationMs ? { durationMs: item.durationMs } : {}) };
  }
  return { videoId: item.videoId, ...(item.title ? { title: item.title } : {}) };
}

export interface SearchHit { videoId: string; title: string }
/** YouTube search for "artist - song". `null` = YouTube could not be asked. */
export type SongSearch = (query: string) => Promise<SearchHit[] | null>;

/** Videos in YouTube's search response; live streams and very long videos are no song requests. */
export function searchHits(data: unknown): SearchHit[] {
  const hits: SearchHit[] = [];
  const seconds = (text: string): number => text.split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 40 || hits.length >= 10) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const video = (node as { videoRenderer?: { videoId?: unknown; title?: { runs?: { text?: unknown }[]; simpleText?: unknown }; lengthText?: { simpleText?: unknown } } }).videoRenderer;
    if (video && typeof video.videoId === 'string' && VIDEO_ID.test(video.videoId)) {
      const length = typeof video.lengthText?.simpleText === 'string' ? seconds(video.lengthText.simpleText) : 0;
      const title = (video.title?.runs ?? []).map((run) => run.text).filter((t) => typeof t === 'string').join('') || (typeof video.title?.simpleText === 'string' ? video.title.simpleText : '');
      if (length > 0 && length <= 20 * 60 && !hits.some((hit) => hit.videoId === video.videoId)) hits.push({ videoId: video.videoId, title: title.slice(0, 200) });
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(data, 0);
  return hits;
}

/** No API key: the same search the YouTube website does, with the results page as a fallback. */
export const youtubeSearch: SongSearch = async (query) => {
  const headers = { ...BROWSER_HEADERS, Cookie: 'CONSENT=YES+cb; SOCS=CAI' };
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ru', gl: 'RU' } }, query, params: 'EgIQAQ==' }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const hits = searchHits(await res.json());
      if (hits.length) return hits;
    }
  } catch { /* try the results page */ }
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=ru`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const start = html.search(/ytInitialData\s*=\s*\{/);
    if (start < 0) return null;
    const from = html.indexOf('{', start);
    const end = html.indexOf('};</script>', from);
    if (end < 0) return null;
    return searchHits(JSON.parse(html.slice(from, end + 1)));
  } catch {
    return null;
  }
};

/** Length and popularity of a video, for the request limits. `null` = YouTube could not be asked. */
export interface VideoDetails { seconds: number; views: number; live: boolean; title?: string }
export type DetailsLookup = (videoId: string) => Promise<VideoDetails | null>;

/** The player data the YouTube website loads; the watch page is the fallback. */
export const youtubeDetails: DetailsLookup = async (videoId) => {
  const parse = (d: { lengthSeconds?: unknown; viewCount?: unknown; isLive?: unknown; isLiveContent?: unknown; title?: unknown } | undefined): VideoDetails | null => {
    if (!d || d.lengthSeconds === undefined) return null;
    const seconds = Number(d.lengthSeconds) || 0;
    // A 24/7 stream reports its whole uptime as the length; a past stream (VOD) has a normal one.
    return { seconds, views: Number(d.viewCount) || 0, live: d.isLive === true || (d.isLiveContent === true && (seconds === 0 || seconds > 12 * 3600)), ...(typeof d.title === 'string' ? { title: d.title.slice(0, 200) } : {}) };
  };
  const headers = { ...BROWSER_HEADERS, Cookie: 'CONSENT=YES+cb; SOCS=CAI' };
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ru', gl: 'RU' } }, videoId }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const details = parse((await res.json().catch(() => null) as { videoDetails?: Parameters<typeof parse>[0] } | null)?.videoDetails);
      if (details) return details;
    }
  } catch { /* try the watch page */ }
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=ru`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const length = html.match(/"lengthSeconds":"(\d+)"/)?.[1];
    if (length === undefined) return null;
    return parse({ lengthSeconds: length, viewCount: html.match(/"viewCount":"(\d+)"/)?.[1], isLive: /"isLive":true/.test(html) });
  } catch {
    return null;
  }
};

/** The streamer's request limits; older settings files may not have them yet. */
export function songLimits(cfg: Partial<SongRequestSettings>): { perUser: number; maxMinutes: number; minViews: number; words: string[] } {
  const count = (value: unknown, fallback: number): number => Math.max(0, Math.floor(Number(value ?? fallback)) || 0);
  return {
    perUser: count(cfg.maxPerUser, 3),
    maxMinutes: count(cfg.maxDurationMin, 10),
    minViews: count(cfg.minViews, 0),
    words: (cfg.bannedWords ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean),
  };
}

type Found = { url: string; videoId: string; title?: string; yandex?: YandexTrack };

const MAX_CHAT_LOOKUPS = 4;
/** A background track shorter than this is treated as broken, not as finished. */
const MIN_BACKGROUND_MS = 3_000;
const FAILED_CHAT_PAUSE_MS = 3_000;
type Extra = Pick<SongRequest, 'title' | 'redemption' | 'provider' | 'yandexTrackId' | 'yandexAlbumId' | 'cover' | 'durationMs'>;

const yandexUrl = (track: Pick<YandexTrack, 'trackId' | 'albumId'>): string => track.albumId ? `https://music.yandex.ru/album/${track.albumId}/track/${track.trackId}` : `https://music.yandex.ru/track/${track.trackId}`;

/** Queue fields of a Yandex Music track that plays in the streamer's Yandex Music app. */
function yandexExtra(track: YandexTrack): Extra {
  return { provider: 'yandex', yandexTrackId: track.trackId, ...(track.albumId ? { yandexAlbumId: track.albumId } : {}), ...(track.cover ? { cover: track.cover } : {}), ...(track.durationMs ? { durationMs: track.durationMs } : {}) };
}

/** Persistent queue for requests from channel points, donations and the streamer's own controls. */
export class SongRequestService {
  private current: SongRequest | null = null;
  private paused = false;
  private nonce: string | null = null;
  private resumeId: string | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private starting = false;
  private autoBlocked = false;
  private generation = 0;
  private chatCooldowns = new Map<string, number>();
  /** Chat requests being looked up: one per viewer, a few at a time, so `!sr` spam can't flood the network. */
  private chatPending = new Set<string>();
  /** Background playlist track playing while no request is; shaped like a request for the overlay. */
  private background: SongRequest | null = null;
  private bgNonce: string | null = null;
  private bgLast: string | null = null;
  private bgFailed = new Set<string>();
  private bgBlocked = false;
  /** The Yandex Music app played a request in this run: it gets the streamer's music back at the end. */
  private remoteUsed = false;
  private remoteVolume: number | null = null;
  /** Favourite the streamer asked to hear right now. */
  private bgForce: string | null = null;

  constructor(
    private ctx: AppContext,
    private music: MusicService,
    private broadcast: (message: OverlayMessage) => void,
    private reply?: (text: string, replyTo?: string) => Promise<void>,
    private options: { lookup?: VideoLookup; playlistLookup?: VideoLookup; rewards?: RedemptionSettler; search?: SongSearch; yandexTrack?: YandexTrackInfo; yandexSearch?: YandexSearch; details?: DetailsLookup; remote?: RemotePlayer } = {},
  ) {
    ctx.bus.on('event', (event) => this.onEvent(event));
    options.remote?.onEvent((event) => void this.onRemote(event));
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'songQueue') this.sync();
      if (key === 'songRequests') void this.onSettingsChanged();
    });
    this.sync();
  }

  get overlayMessage(): OverlayMessage {
    // The overlay has no use for the ban lists or the playlist.
    const config = { ...this.ctx.settings.get('songRequests'), bannedUsers: [], bannedVideos: [], bannedWords: [], backgroundTracks: [], jams: [] };
    return { type: 'song', request: this.current ?? this.background, background: !this.current && !!this.background, nonce: this.current ? this.nonce : this.bgNonce, paused: this.paused, config, queue: this.ctx.settings.get('songQueue'), lang: this.ctx.settings.get('language') };
  }

  setPlayerConnected(connected: boolean): void {
    if (this.ctx.state.current.songRequests.playerConnected === connected) return;
    this.ctx.state.patch('songRequests', { playerConnected: connected });
    if (!connected && isRemote(this.current)) {
      // The request plays in the Yandex Music app, not in OBS: only the background music stops.
      if (!isRemote(this.background)) this.stopBackground();
      this.sync();
    } else if (!connected) {
      this.generation++;
      this.current = null;
      this.paused = false;
      this.nonce = null;
      if (!isRemote(this.background)) this.stopBackground();
      this.sync();
      void this.resumeMusic();
    }
    if (connected) {
      this.bgBlocked = false;
      this.bgFailed.clear();
      void this.maybeStart();
    }
  }

  private get ru(): boolean { return this.ctx.settings.get('language') === 'ru'; }

  private reason(code: Rejection): string {
    const ru = this.ru;
    const limits = songLimits(this.ctx.settings.get('songRequests'));
    switch (code) {
      case 'userLimit': return ru ? `у вас уже ${limits.perUser} ${limits.perUser === 1 ? 'трек' : limits.perUser < 5 ? 'трека' : 'треков'} в очереди — дождитесь, пока они сыграют.` : `you already have ${limits.perUser} track${limits.perUser === 1 ? '' : 's'} in the queue, wait until they play.`;
      case 'tooLong': return ru ? `трек длиннее ${limits.maxMinutes} мин. — такие заказы не принимаются.` : `the track is longer than ${limits.maxMinutes} min.`;
      case 'live': return ru ? 'прямые трансляции заказывать нельзя.' : 'live streams cannot be requested.';
      case 'fewViews': return ru ? `у видео меньше ${limits.minViews.toLocaleString('ru-RU')} просмотров — возьмите официальную или популярную загрузку.` : `the video has fewer than ${limits.minViews.toLocaleString('en-US')} views; use an official or popular upload.`;
      case 'bannedWord': return ru ? 'название трека содержит запрещённое на канале слово.' : 'the track title contains a word banned on this channel.';
      case 'noLink': return ru ? 'в заказе нет ссылки на трек YouTube, YouTube Music или Яндекс Музыки.' : 'the request has no YouTube, YouTube Music or Yandex Music track link.';
      case 'noLinkOrQuery': return ru ? 'пришлите ссылку на трек (YouTube, YouTube Music, Яндекс Музыка) или напишите исполнителя и название.' : 'send a track link (YouTube, YouTube Music, Yandex Music) or write the artist and title.';
      case 'unsupportedLink': return ru ? 'такую ссылку не воспроизвести. Подходят треки YouTube, YouTube Music и Яндекс Музыки — или просто напишите исполнителя и название.' : 'this link cannot be played. Use a YouTube, YouTube Music or Yandex Music track, or just write the artist and title.';
      case 'noResults': return ru ? 'ничего не нашлось на YouTube. Уточните исполнителя и название или пришлите ссылку.' : 'nothing found on YouTube. Check the artist and title or send a link.';
      case 'searchFailed': return ru ? 'поиск YouTube сейчас недоступен, пришлите ссылку на трек.' : 'YouTube search is unavailable right now, send a track link.';
      case 'yandexFailed': return ru ? 'не удалось открыть трек Яндекс Музыки. Напишите исполнителя и название.' : 'could not read the Yandex Music track. Write the artist and title instead.';
      case 'full': return ru ? 'очередь заказов заполнена, попробуйте позже.' : 'the song queue is full, try again later.';
      case 'duplicate': return ru ? 'это видео уже есть в очереди.' : 'this video is already queued.';
      case 'notFound': return ru ? 'видео не найдено (удалено, приватное или неверная ссылка).' : 'video not found (removed, private or a wrong link).';
      case 'embedBlocked': return ru ? 'автор запретил воспроизводить это видео вне YouTube. Попробуйте другую загрузку песни.' : 'the owner blocked playing this video outside YouTube. Try another upload of the song.';
      case 'playback': return ru ? 'YouTube не дал воспроизвести это видео.' : 'YouTube refused to play this video.';
      case 'userBanned': return ru ? 'вам закрыт доступ к заказу музыки.' : 'you are banned from song requests.';
      case 'videoBanned': return ru ? 'это видео запрещено на канале.' : 'this video is banned on this channel.';
      case 'nothingPlaying': return ru ? 'сейчас ничего не играет — пропускать нечего.' : 'nothing is playing, so there is nothing to skip.';
    }
  }

  private say(text: string, replyTo?: string): void {
    // Answers to a chat command always go out; redemption notices follow the setting.
    if (!this.reply || (!replyTo && !this.ctx.settings.get('songRequests').replyInChat)) return;
    void this.reply(text, replyTo).catch(() => undefined); // chat may be offline; the request itself is unaffected
  }

  /** Resolves `true` only when Twitch accepted the new status. */
  private async settle(request: Pick<SongRequest, 'redemption'> | null | undefined, status: 'FULFILLED' | 'CANCELED'): Promise<boolean> {
    const r = request?.redemption;
    if (!r || !this.options.rewards) return false;
    if (status === 'CANCELED' && !this.ctx.settings.get('songRequests').refundRejected) return false;
    try {
      await this.options.rewards.settle(r.rewardId, r.id, status);
      return true;
    } catch {
      // Fails for rewards not created by this app; that is expected and harmless.
      return false;
    }
  }

  private reject(userName: string, code: Rejection, redemption?: SongRequest['redemption'], replyTo?: string): string {
    const reason = this.reason(code);
    this.ctx.state.patch('songRequests', { lastRejected: { userName, reason, at: Date.now() } });
    // Promise the refund in chat only after Twitch confirmed it: rewards made outside this app can't be refunded.
    void this.settle({ redemption }, 'CANCELED').then((refunded) => {
      this.say(`@${userName}, ${reason}${refunded ? (this.ru ? ' Баллы возвращены.' : ' Points refunded.') : ''}`, replyTo);
    });
    return reason;
  }

  private isBanned(...names: (string | undefined)[]): boolean {
    const banned = this.ctx.settings.get('songRequests').bannedUsers ?? [];
    return names.some((name) => !!name && banned.includes(userKey(name)));
  }

  private precheck(videoId: string): Rejection | null {
    const queue = this.ctx.settings.get('songQueue');
    if ((this.ctx.settings.get('songRequests').bannedVideos ?? []).some((item) => item.videoId === videoId)) return 'videoBanned';
    if (queue.some((item) => item.videoId === videoId)) return 'duplicate';
    if (queue.length >= Math.max(1, this.ctx.settings.get('songRequests').maxQueue)) return 'full';
    return null;
  }

  /** Searching by "artist - title" can be switched off; links always work. */
  private get searchEnabled(): boolean { return this.ctx.settings.get('songRequests').allowSearch !== false; }

  /** The video to play for a link check: queue limits, bans, and whether YouTube lets OBS embed it. */
  private hasBannedWord(text: string | undefined): boolean {
    const lower = (text ?? '').toLowerCase();
    return !!lower && songLimits(this.ctx.settings.get('songRequests')).words.some((word) => lower.includes(word));
  }

  /**
   * Viewers' requests also follow the streamer's limits: length, views and banned words.
   * When YouTube can't tell the length or views the request is accepted; the player still stops at the limit.
   */
  private async checkVideo(videoId: string, url: string, viewer: boolean, title?: string): Promise<Found | Rejection> {
    const early = this.precheck(videoId);
    if (early) return early;
    const check = await (this.options.lookup ?? oembedLookup)(videoId);
    if (check && !check.ok) return check.reason;
    let name = check?.title ?? title;
    if (viewer) {
      const limits = songLimits(this.ctx.settings.get('songRequests'));
      if (this.hasBannedWord(name)) return 'bannedWord';
      const details = await (this.options.details ?? youtubeDetails)(videoId);
      if (details) {
        name ??= details.title;
        if (this.hasBannedWord(details.title)) return 'bannedWord';
        if (details.live) return 'live';
        if (limits.maxMinutes && details.seconds > limits.maxMinutes * 60) return 'tooLong';
        if (limits.minViews && details.views < limits.minViews) return 'fewViews';
      }
    }
    return { url, videoId, ...(name ? { title: name } : {}) };
  }

  /** The first search result that plays in OBS and fits the limits; other uploads of the song cover the rest. */
  private async searchVideo(query: string, viewer: boolean): Promise<Found | Rejection> {
    const hits = await (this.options.search ?? youtubeSearch)(query);
    if (!hits) return 'searchFailed';
    let result: Rejection = 'noResults';
    for (const hit of hits.slice(0, 5)) {
      const found = await this.checkVideo(hit.videoId, `https://www.youtube.com/watch?v=${hit.videoId}`, viewer, hit.title || undefined);
      if (typeof found !== 'string') return found;
      // Banned, queued already or a full queue: the viewer meant this song, don't sneak in another upload.
      if (!['embedBlocked', 'notFound', 'tooLong', 'fewViews', 'live'].includes(found)) return found;
      result = found;
    }
    return result;
  }

  /** Yandex Music tracks play in the streamer's Yandex Music app when it is connected; otherwise via YouTube. */
  private get yandexPlays(): boolean { return this.ctx.settings.get('songRequests').yandexPlayback !== false && !!this.options.remote?.ready; }

  /** A Yandex Music track for the streamer's Yandex Music app: same queue rules and limits as a video. */
  private checkYandex(track: YandexTrack, viewer: boolean): Found | Rejection {
    const videoId = `ym:${track.trackId}`;
    const early = this.precheck(videoId);
    if (early) return early;
    if (viewer) {
      const limits = songLimits(this.ctx.settings.get('songRequests'));
      if (this.hasBannedWord(track.title)) return 'bannedWord';
      if (limits.maxMinutes && (track.durationMs ?? 0) > limits.maxMinutes * 60_000) return 'tooLong';
    }
    return { url: yandexUrl(track), videoId, title: track.title, yandex: track };
  }

  /** "Artist - title" in Yandex Music first; YouTube covers what Yandex does not have. */
  private async searchYandex(query: string, viewer: boolean): Promise<Found | Rejection | null> {
    const tracks = await (this.options.yandexSearch ?? yandexSearch)(query);
    const playable = (tracks ?? []).filter((track) => track.available);
    if (!playable.length) return null;
    let result: Rejection | null = null;
    for (const track of playable.slice(0, 5)) {
      const found = this.checkYandex(track, viewer);
      if (typeof found !== 'string') return found;
      if (found !== 'tooLong') return found;
      result = found;
    }
    return result;
  }

  /**
   * A YouTube / YouTube Music link plays in OBS. A Yandex Music link and "artist - title" play in the
   * streamer's Yandex Music app when it is connected, otherwise they are found on YouTube.
   */
  private async resolve(text: string, allowSearch: boolean, viewer: boolean): Promise<Found | Rejection> {
    const link = musicLinkInText(text);
    if (link?.kind === 'youtube') return this.checkVideo(link.videoId, link.url, viewer);
    if (link?.kind === 'yandex') {
      const track = await (this.options.yandexTrack ?? yandexTrackInfo)(link.trackId);
      if (!track) return 'yandexFailed';
      if (viewer && this.hasBannedWord(track.title)) return 'bannedWord';
      if (this.yandexPlays && track.available) return this.checkYandex(track, viewer);
      return this.searchVideo(track.title, viewer);
    }
    if (urlsInText(text).length) return allowSearch ? 'unsupportedLink' : 'noLink';
    const query = text.replace(/\s+/g, ' ').trim().slice(0, 150);
    if (!allowSearch) return 'noLink';
    if (viewer && this.hasBannedWord(query)) return 'bannedWord';
    if (query.length < 2) return 'noLinkOrQuery';
    if (this.yandexPlays) {
      const found = await this.searchYandex(query, viewer);
      if (found) return found;
    }
    return this.searchVideo(query, viewer);
  }

  /** Requests this viewer already has waiting or playing. */
  private queuedBy(userName: string, userLogin?: string): number {
    const keys = new Set([userKey(userName), userLogin ? userKey(userLogin) : ''].filter(Boolean));
    return this.ctx.settings.get('songQueue').filter((item) => item.source !== 'manual' && keys.has(userKey(item.userName))).length;
  }

  /**
   * One entry point for every viewer request: finds the video (link or search), asks YouTube whether
   * it exists and may be embedded, queues it and tells the viewer. Rejected redemptions are refunded.
   */
  async request(text: string, userName: string, source: SongRequest['source'], id: string, redemption?: SongRequest['redemption'], replyTo?: string, userLogin?: string): Promise<{ ok: true; position: number } | { ok: false; reason: string }> {
    if (this.isBanned(userName, userLogin)) return { ok: false, reason: this.reject(userName, 'userBanned', redemption, replyTo) };
    const perUser = songLimits(this.ctx.settings.get('songRequests')).perUser;
    if (perUser && this.queuedBy(userName, userLogin) >= perUser) return { ok: false, reason: this.reject(userName, 'userLimit', redemption, replyTo) };
    const found = await this.resolve(text, this.searchEnabled, true);
    if (typeof found === 'string') return { ok: false, reason: this.reject(userName, found, redemption, replyTo) };
    // Two requests from one viewer can be looked up at the same time.
    if (perUser && this.queuedBy(userName, userLogin) >= perUser) return { ok: false, reason: this.reject(userName, 'userLimit', redemption, replyTo) };
    try {
      this.add(found.url, userName, source, id, { title: found.title, redemption, ...(found.yandex ? yandexExtra(found.yandex) : {}) });
    } catch {
      // The queue changed while YouTube was answering.
      return { ok: false, reason: this.reject(userName, this.precheck(found.videoId) ?? 'full', redemption, replyTo) };
    }
    const position = this.ctx.settings.get('songQueue').findIndex((item) => item.id === id) + 1;
    const title = found.title ? `«${found.title}»` : (this.ru ? 'трек' : 'your song');
    this.say(this.ru ? `@${userName}, ${title} в очереди: №${position}.` : `@${userName}, ${title} is queued at #${position}.`, replyTo);
    return { ok: true, position };
  }

  /** The streamer's own "Add" button: a link or "artist - title", errors go back to the UI. */
  async addManual(input: string): Promise<void> {
    // The streamer is not bound by the viewers' limits.
    const found = await this.resolve(input, true, false);
    if (typeof found === 'string') throw new Error(found === 'noLinkOrQuery'
      ? (this.ru ? 'Вставьте ссылку на трек или напишите исполнителя и название.' : 'Paste a track link or write the artist and title.')
      : this.reason(found));
    this.add(found.url, this.ru ? 'Стример' : 'Streamer', 'manual', undefined, { title: found.title, ...(found.yandex ? yandexExtra(found.yandex) : {}) });
  }

  add(url: string, userName = 'Streamer', source: SongRequest['source'] = 'manual', id = randomBytes(10).toString('hex'), extra: Extra = {}): void {
    const remote = extra.provider === 'yandex' && !!extra.yandexTrackId;
    const videoId = remote ? `ym:${extra.yandexTrackId}` : youtubeVideoId(url);
    if (!videoId) throw new Error('Send a single YouTube video link');
    const queue = this.ctx.settings.get('songQueue');
    if (queue.length >= Math.max(1, this.ctx.settings.get('songRequests').maxQueue)) throw new Error('Song request queue is full');
    if (queue.some((item) => item.videoId === videoId)) throw new Error('This video is already in the queue');
    const request: SongRequest = {
      id, videoId, url: remote ? yandexUrl({ trackId: extra.yandexTrackId!, albumId: extra.yandexAlbumId }) : `https://www.youtube.com/watch?v=${videoId}`, userName, source, requestedAt: Date.now(),
      ...(extra.title ? { title: extra.title } : {}), ...(extra.redemption ? { redemption: extra.redemption } : {}),
      ...(remote ? { provider: 'yandex' as const, yandexTrackId: extra.yandexTrackId, ...(extra.yandexAlbumId ? { yandexAlbumId: extra.yandexAlbumId } : {}), ...(extra.cover ? { cover: extra.cover } : {}), ...(extra.durationMs ? { durationMs: extra.durationMs } : {}) } : {}),
    };
    this.ctx.settings.set('songQueue', [...queue, request]);
    void this.maybeStart();
  }

  /** YouTube plays in the OBS source (with video on); a Yandex Music track needs the connected Yandex Music app. */
  private canStart(item: SongRequest | undefined): boolean {
    if (!item) return false;
    if (isRemote(item)) return !!this.options.remote?.ready && this.ctx.settings.get('songRequests').yandexPlayback !== false;
    return this.ctx.settings.get('songRequests').videoLayout !== 'queue' && this.ctx.state.current.songRequests.playerConnected;
  }

  async play(id?: string): Promise<void> {
    const queued = this.ctx.settings.get('songQueue');
    const head = id ? queued.find((item) => item.id === id) : queued[0];
    if (head && !this.canStart(head)) {
      if (isRemote(head)) throw new Error(this.ru ? 'Яндекс Музыка не подключена: войдите в аккаунт и откройте приложение или сайт Яндекс Музыки.' : 'Yandex Music is not connected: sign in and open the Yandex Music app or site.');
      if (this.ctx.settings.get('songRequests').videoLayout === 'queue') throw new Error('Queue-only mode does not play YouTube videos');
      throw new Error('Add the Song Request browser source to OBS first');
    }
    if (this.starting) return;
    this.starting = true;
    this.autoBlocked = false;
    this.bgBlocked = false;
    const generation = this.generation;
    try {
      let queue = this.ctx.settings.get('songQueue');
      if (id) {
        const index = queue.findIndex((item) => item.id === id);
        if (index < 0) throw new Error('Song not found');
        queue = [queue[index], ...queue.filter((item) => item.id !== id)];
        this.ctx.settings.set('songQueue', queue);
      }
      if (!queue.length) return;
      if (!this.resumeId && this.ctx.settings.get('songRequests').pauseWindowsMusic) {
        // Yandex Music plays the request itself and gets its own queue back afterwards: don't pause it.
        this.resumeId = await this.music.pauseCurrent(isRemote(queue[0]) ? 'yandex' : undefined);
      }
      // The streamer can remove/reorder requests while the Windows player is pausing.
      queue = this.ctx.settings.get('songQueue');
      if (generation !== this.generation || !this.canStart(queue[0])) {
        await this.resumeMusic();
        return;
      }
      const next = queue[0];
      if (isRemote(next)) {
        try {
          this.remoteUsed = true;
          this.remoteVolume = this.ctx.settings.get('songRequests').volume;
          await this.options.remote!.play({ trackId: next.yandexTrackId!, albumId: next.yandexAlbumId, title: next.title, cover: next.cover?.replace(/^https:\/\//, '').replace('200x200', '%%'), durationMs: next.durationMs, volume: this.remoteVolume });
        } catch (error) {
          // Nothing to play on (app closed) or no connection: keep the request for a retry.
          this.autoBlocked = true;
          this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error).slice(0, 240) });
          await this.resumeMusic();
          return;
        }
      } else if (this.remoteUsed) this.options.remote?.hold();
      this.current = next;
      this.stopBackground();
      this.paused = false;
      this.nonce = randomBytes(20).toString('hex');
      this.ctx.state.patch('songRequests', { lastError: null });
      this.sync();
      this.broadcast(this.overlayMessage);
    } finally {
      this.starting = false;
      if (generation !== this.generation) void this.maybeStart();
    }
  }

  async skip(): Promise<void> {
    if (!this.current) {
      // Skipping a background track just moves on to the next one.
      if (this.stopBackground()) {
        this.bgBlocked = false;
        this.nextBackground();
      }
      return;
    }
    void this.settle(this.current, 'FULFILLED');
    await this.dropCurrent();
  }

  /** Pause or resume the playing video in OBS without losing its place. */
  pause(paused: boolean): void {
    if ((!this.current && !this.background) || this.paused === paused) return;
    this.paused = paused;
    if (isRemote(this.current ?? this.background)) this.options.remote?.pause(paused);
    this.sync();
    this.broadcast(this.overlayMessage);
  }

  /** Reorder the upcoming requests; the playing one stays where it is. */
  move(id: string, index: number): void {
    const queue = this.ctx.settings.get('songQueue');
    const playing = queue.filter((item) => item.id === this.current?.id);
    const upcoming = queue.filter((item) => item.id !== this.current?.id);
    const from = upcoming.findIndex((item) => item.id === id);
    if (from < 0) return;
    const [item] = upcoming.splice(from, 1);
    upcoming.splice(Math.max(0, Math.min(upcoming.length, Math.round(index))), 0, item);
    this.ctx.settings.set('songQueue', [...playing, ...upcoming]);
    this.broadcast(this.overlayMessage);
  }

  /** The Yandex Music app finished our track, or could not start it. */
  private async onRemote(event: RemotePlayerEvent): Promise<void> {
    try {
      await this.handleRemote(event);
    } catch (error) {
      this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error).slice(0, 240) });
    }
  }

  private async handleRemote(event: RemotePlayerEvent): Promise<void> {
    const background = this.background;
    if (!this.current && background && isRemote(background) && background.yandexTrackId === event.trackId) {
      this.stopBackground();
      const instant = event.type === 'ended' && Date.now() - background.requestedAt < MIN_BACKGROUND_MS;
      if (event.type === 'failed' || instant) {
        this.bgFailed.add(background.videoId);
        this.ctx.state.patch('songRequests', { lastError: (event.type === 'failed' ? event.error : `${background.title ?? background.url}: ended at once`).slice(0, 240) });
      }
      this.nextBackground();
      return;
    }
    const current = this.current;
    if (!current || !isRemote(current) || current.yandexTrackId !== event.trackId) return;
    if (event.type === 'ended') {
      void this.settle(current, 'FULFILLED');
      await this.dropCurrent();
      return;
    }
    // Not this track's fault (no active device): keep it, like a YouTube player problem.
    this.autoBlocked = true;
    this.ctx.state.patch('songRequests', { lastError: event.error.slice(0, 240) });
    this.current = null;
    this.nonce = null;
    this.paused = false;
    this.sync();
    this.broadcast(this.overlayMessage);
    await this.resumeMusic();
  }

  /** Remove the playing request and move on to the next one (or give Windows music back). */
  private async dropCurrent(): Promise<void> {
    if (!this.current) return;
    this.paused = false;
    this.ctx.settings.set('songQueue', this.ctx.settings.get('songQueue').filter((item) => item.id !== this.current?.id));
    this.current = null;
    this.nonce = null;
    this.sync();
    this.broadcast(this.overlayMessage);
    const next = this.ctx.settings.get('songQueue')[0];
    if (next && this.ctx.settings.get('songRequests').autoPlay && this.canStart(next)) {
      await this.play().catch((error) => this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error) }));
      this.startBackground();
    } else {
      this.startBackground();
      await this.resumeMusic();
    }
  }

  private activeJam(): SongJam | undefined {
    const cfg = this.ctx.settings.get('songRequests');
    return cfg.backgroundJamId ? (cfg.jams ?? []).find((jam) => jam.id === cfg.backgroundJamId) : undefined;
  }

  private stopBackground(): boolean {
    if (!this.background) return false;
    this.background = null;
    this.bgNonce = null;
    return true;
  }

  /** YouTube and local files play in the OBS source; Yandex Music favourites in the connected Yandex Music app. */
  private trackReady(track: SongTrack): boolean {
    if (track.kind === 'yandex') return !!this.options.remote?.ready && this.ctx.settings.get('songRequests').yandexPlayback !== false;
    return this.ctx.settings.get('songRequests').videoLayout !== 'queue' && this.ctx.state.current.songRequests.playerConnected;
  }

  private backgroundItem(track: SongTrack): SongRequest {
    const base = { id: `bg_${randomBytes(6).toString('hex')}`, videoId: track.videoId, userName: '', source: 'manual' as const, requestedAt: Date.now(), ...(track.title ? { title: track.title } : {}) };
    if (track.kind === 'local') return { ...base, provider: 'local', url: localSongUrl(track.file ?? track.videoId.slice('local:'.length)) };
    if (track.kind === 'yandex') {
      const trackId = track.videoId.slice(3);
      return { ...base, provider: 'yandex', yandexTrackId: trackId, url: yandexUrl({ trackId, albumId: track.albumId }),
        ...(track.albumId ? { yandexAlbumId: track.albumId } : {}), ...(track.cover ? { cover: track.cover } : {}), ...(track.durationMs ? { durationMs: track.durationMs } : {}) };
    }
    return { ...base, url: `https://www.youtube.com/watch?v=${track.videoId}` };
  }

  /** Nothing plays any more: the Yandex Music app gets the streamer's own music back. */
  private releaseIdleRemote(): void {
    if (this.remoteUsed && !this.current && !this.background && !this.starting) {
      this.remoteUsed = false;
      this.options.remote?.release(this.ctx.settings.get('songRequests').resumeWindowsMusic);
    }
  }

  /** Fill the silence with the streamer's favourites; any request takes the player over. */
  private startBackground(): void {
    const cfg = this.ctx.settings.get('songRequests');
    if (this.current || this.starting || this.background) return;
    if (this.bgBlocked || this.autoBlocked || !cfg.backgroundEnabled) return this.releaseIdleRemote();
    const jam = this.activeJam();
    if (jam) {
      // The overlay walks the mix itself and remembers where a request interrupted it.
      if (this.bgFailed.has(jam.listId) || cfg.videoLayout === 'queue' || !this.ctx.state.current.songRequests.playerConnected) return this.releaseIdleRemote();
      const url = jam.videoId ? `https://www.youtube.com/watch?v=${jam.videoId}&list=${jam.listId}` : `https://www.youtube.com/playlist?list=${jam.listId}`;
      this.background = { id: `bg_${randomBytes(6).toString('hex')}`, videoId: jam.videoId ?? '', playlistId: jam.listId, url, userName: '', source: 'manual', requestedAt: Date.now(), title: jam.name };
    } else {
      const tracks = (cfg.backgroundTracks ?? []).filter((track) => !this.bgFailed.has(track.videoId) && this.trackReady(track));
      if (!tracks.length) return this.releaseIdleRemote();
      let next = tracks[(tracks.findIndex((track) => track.videoId === this.bgLast) + 1) % tracks.length];
      if (cfg.backgroundShuffle && tracks.length > 1) {
        const pool = tracks.filter((track) => track.videoId !== this.bgLast);
        next = pool[Math.floor(Math.random() * pool.length)];
      }
      const forced = this.bgForce ? tracks.find((track) => track.videoId === this.bgForce) : undefined;
      this.bgForce = null;
      if (forced) next = forced;
      this.bgLast = next.videoId;
      this.background = this.backgroundItem(next);
    }
    const item = this.background;
    if (isRemote(item)) {
      this.remoteUsed = true;
      const volume = cfg.backgroundVolume ?? 40;
      this.remoteVolume = volume;
      this.options.remote!.play({ trackId: item.yandexTrackId!, albumId: item.yandexAlbumId, title: item.title, cover: item.cover?.replace(/^https:\/\//, '').replace('200x200', '%%'), durationMs: item.durationMs, volume })
        .catch((error) => void this.onRemote({ type: 'failed', trackId: item.yandexTrackId!, error: String((error as Error).message ?? error) }));
    } else if (this.remoteUsed) this.options.remote?.hold();
    this.bgNonce = randomBytes(20).toString('hex');
    this.paused = false;
    this.sync();
    this.broadcast(this.overlayMessage);
  }

  /** After a background track ended or was dropped: play another one or clear the player. */
  private nextBackground(): void {
    this.paused = false;
    this.startBackground();
    if (!this.background) {
      this.sync();
      this.broadcast(this.overlayMessage);
      this.releaseIdleRemote();
    }
  }

  /** Take a viewer's request out of the queue (or off the air) and give the points back. */
  private evict(item: SongRequest): void {
    if (this.current?.id !== item.id) return this.remove(item.id);
    void this.settle(item, 'CANCELED');
    void this.dropCurrent();
  }

  /** Refuse this viewer's future requests and skips; what they already queued is removed. */
  banUser(userName: string): void {
    const name = userKey(userName);
    if (!name) return;
    const cfg = this.ctx.settings.get('songRequests');
    const banned = cfg.bannedUsers ?? [];
    if (!banned.includes(name)) this.ctx.settings.set('songRequests', { ...cfg, bannedUsers: [...banned, name] });
    for (const item of this.ctx.settings.get('songQueue')) {
      if (item.source !== 'manual' && userKey(item.userName) === name) this.evict(item);
    }
  }

  /** Ban a video by link or id; it also leaves the queue. */
  async banVideo(input: string): Promise<void> {
    const text = input.trim();
    const yandexId = /^ym:\d{1,12}$/.test(text) ? text.slice(3) : yandexTrackId(text);
    const videoId = yandexId ? `ym:${yandexId}` : VIDEO_ID.test(text) ? text : youtubeVideoId(text);
    if (!videoId) throw new Error(this.ru ? 'Вставьте ссылку на видео YouTube или трек Яндекс Музыки.' : 'Paste a YouTube video or Yandex Music track link.');
    const queued = this.ctx.settings.get('songQueue').filter((item) => item.videoId === videoId);
    if (!(this.ctx.settings.get('songRequests').bannedVideos ?? []).some((item) => item.videoId === videoId)) {
      let title = queued.find((item) => item.title)?.title;
      if (!title && yandexId) title = (await (this.options.yandexTrack ?? yandexTrackInfo)(yandexId))?.title;
      else if (!title) {
        const check = await (this.options.lookup ?? oembedLookup)(videoId);
        if (check?.ok) title = check.title;
      }
      const cfg = this.ctx.settings.get('songRequests');
      const banned = cfg.bannedVideos ?? [];
      if (!banned.some((item) => item.videoId === videoId)) this.ctx.settings.set('songRequests', { ...cfg, bannedVideos: [...banned, { videoId, ...(title ? { title } : {}) }] });
    }
    for (const item of this.ctx.settings.get('songQueue')) {
      if (item.videoId === videoId) this.evict(item);
    }
  }

  private saveFavorites(update: (tracks: SongTrack[]) => SongTrack[]): void {
    const cfg = this.ctx.settings.get('songRequests');
    this.ctx.settings.set('songRequests', { ...cfg, backgroundTracks: update(cfg.backgroundTracks ?? []) });
  }

  private isFavorite(videoId: string): boolean {
    return (this.ctx.settings.get('songRequests').backgroundTracks ?? []).some((track) => track.videoId === videoId);
  }

  /** The heart next to a request or the playing track: add it to the favourites or take it out. */
  toggleFavorite(id: string): boolean {
    const item = [this.current, this.background, ...this.ctx.settings.get('songQueue')].find((entry) => entry?.id === id);
    if (!item || item.playlistId || !item.videoId) throw new Error(this.ru ? 'Этот трек нельзя добавить в избранное.' : 'This track cannot be added to favourites.');
    if (this.isFavorite(item.videoId)) {
      this.saveFavorites((tracks) => tracks.filter((track) => track.videoId !== item.videoId));
      return false;
    }
    this.saveFavorites((tracks) => [...tracks, trackOf(item)]);
    return true;
  }

  /** Take a favourite out; the caller deletes the file of a local song. */
  removeFavorite(videoId: string): SongTrack | null {
    const track = (this.ctx.settings.get('songRequests').backgroundTracks ?? []).find((item) => item.videoId === videoId) ?? null;
    if (track) this.saveFavorites((tracks) => tracks.filter((item) => item.videoId !== videoId));
    return track;
  }

  /** Songs copied from the computer into the app. */
  addLocal(files: { file: string; title: string }[]): number {
    const fresh = files.filter((item, i) => !this.isFavorite(`local:${item.file}`) && files.findIndex((other) => other.file === item.file) === i);
    if (fresh.length) this.saveFavorites((tracks) => [...tracks, ...fresh.map((item) => ({ videoId: `local:${item.file}`, kind: 'local' as const, file: item.file, title: item.title.slice(0, 200) }))]);
    return fresh.length;
  }

  /** Hear this favourite now: background music switches to it (and turns on if it was off). */
  playFavorite(videoId: string): void {
    const track = (this.ctx.settings.get('songRequests').backgroundTracks ?? []).find((item) => item.videoId === videoId);
    if (!track) throw new Error(this.ru ? 'Трека нет в избранном.' : 'This track is not in the favourites.');
    if (this.current) throw new Error(this.ru ? 'Сейчас играет заказ — избранное включится после очереди.' : 'A request is playing; favourites play after the queue.');
    if (!this.trackReady(track)) {
      throw new Error(track.kind === 'yandex'
        ? (this.ru ? 'Яндекс Музыка не подключена.' : 'Yandex Music is not connected.')
        : (this.ru ? 'Добавьте источник «Заказ музыки» в OBS и включите показ видео.' : 'Add the Song Request source to OBS and turn video on.'));
    }
    this.bgForce = videoId;
    this.bgFailed.delete(videoId);
    this.bgBlocked = false;
    const cfg = this.ctx.settings.get('songRequests');
    this.stopBackground();
    if (!cfg.backgroundEnabled || cfg.backgroundJamId) this.ctx.settings.set('songRequests', { ...cfg, backgroundEnabled: true, backgroundJamId: '' });
    else this.nextBackground();
  }

  /** Add a YouTube video or Yandex Music track to the favourites, with the same checks as a request. */
  async addBackground(url: string): Promise<void> {
    const yandexId = yandexTrackId(url.trim());
    if (yandexId) {
      if (this.isFavorite(`ym:${yandexId}`)) throw new Error(this.ru ? 'Этот трек уже в избранном.' : 'This track is already in the favourites.');
      const track = await (this.options.yandexTrack ?? yandexTrackInfo)(yandexId);
      if (!track) throw new Error(this.reason('yandexFailed'));
      if (this.isFavorite(`ym:${yandexId}`)) return;
      this.saveFavorites((tracks) => [...tracks, { videoId: `ym:${yandexId}`, kind: 'yandex', title: track.title, ...(track.cover ? { cover: track.cover } : {}), ...(track.albumId ? { albumId: track.albumId } : {}), ...(track.durationMs ? { durationMs: track.durationMs } : {}) }]);
      return;
    }
    const videoId = youtubeVideoId(url.trim());
    if (!videoId) throw new Error(this.ru ? 'Вставьте ссылку на видео YouTube или трек Яндекс Музыки.' : 'Paste a YouTube video or Yandex Music track link.');
    const exists = (): boolean => this.isFavorite(videoId);
    if (exists()) throw new Error(this.ru ? 'Это видео уже в избранном.' : 'This video is already in the favourites.');
    const check = await (this.options.lookup ?? oembedLookup)(videoId);
    if (check && !check.ok) throw new Error(this.reason(check.reason));
    if (exists()) return;
    const cfg = this.ctx.settings.get('songRequests');
    this.ctx.settings.set('songRequests', { ...cfg, backgroundTracks: [...(cfg.backgroundTracks ?? []), { videoId, ...(check?.title ? { title: check.title } : {}) }] });
  }

  /** Add a YouTube mix or public playlist the streamer can switch the background music to. */
  async addJam(url: string, name = ''): Promise<void> {
    const parsed = youtubePlaylist(url);
    if (!parsed) throw new Error(this.ru ? 'Вставьте ссылку на джем или плейлист YouTube — в ней должно быть «list=…».' : 'Paste a YouTube mix or playlist link — it must contain “list=…”.');
    if (PERSONAL_LIST.test(parsed.listId)) throw new Error(this.ru ? 'Это личный джем или плейлист вашего аккаунта — плеер в OBS его не откроет. Возьмите джем по треку или публичный плейлист.' : 'This mix or playlist belongs to your account and the OBS player cannot open it. Use a mix built from a track or a public playlist.');
    const exists = (): boolean => (this.ctx.settings.get('songRequests').jams ?? []).some((jam) => jam.listId === parsed.listId);
    if (exists()) throw new Error(this.ru ? 'Этот джем уже добавлен.' : 'This jam is already added.');
    let title: string | undefined;
    if (!parsed.listId.startsWith('RD')) {
      const check = await (this.options.playlistLookup ?? oembedPlaylistLookup)(parsed.listId);
      if (check && !check.ok) throw new Error(this.ru ? 'Плейлист не найден или закрыт. Сделайте его открытым или доступным по ссылке.' : 'Playlist not found or private. Make it public or unlisted.');
      title = check?.title;
    }
    if (exists()) return;
    const cfg = this.ctx.settings.get('songRequests');
    const jams = cfg.jams ?? [];
    const jam: SongJam = { id: randomBytes(6).toString('hex'), name: (name.trim() || title || `${this.ru ? 'Джем' : 'Jam'} ${jams.length + 1}`).slice(0, 60), ...parsed };
    this.ctx.settings.set('songRequests', { ...cfg, jams: [...jams, jam] });
  }

  remove(id: string): void {
    if (this.current?.id === id) {
      void this.skip();
      return;
    }
    // Removed by the streamer before it played: the viewer gets the points back.
    void this.settle(this.ctx.settings.get('songQueue').find((item) => item.id === id), 'CANCELED');
    this.ctx.settings.set('songQueue', this.ctx.settings.get('songQueue').filter((item) => item.id !== id));
  }

  /**
   * `kind: 'video'` means this particular video cannot play (removed, embedding blocked):
   * drop it, refund and continue with the next request so the stream is not stuck.
   * Anything else is a player problem (no YouTube access, OBS source) and keeps the request.
   */
  async playerFinished(id: string, nonce: string, error = '', kind: 'video' | 'player' = 'player'): Promise<boolean> {
    if (!this.current && this.background && id === this.background.id && nonce === this.bgNonce) {
      const track = this.background;
      this.stopBackground();
      // A broken file or video that "ends" at once would otherwise restart in a tight loop.
      if (!error && !track.playlistId && Date.now() - track.requestedAt < MIN_BACKGROUND_MS) {
        error = this.ru ? 'трек закончился сразу после начала — пропущен.' : 'the track ended right after it started, skipped.';
        kind = 'video';
      }
      if (error && kind === 'video') {
        // This playlist entry can't play here; leave it out until the player reconnects.
        this.bgFailed.add(track.playlistId ?? track.videoId);
        this.ctx.state.patch('songRequests', { lastError: `${track.title ?? track.url}: ${error.slice(0, 160)}` });
      } else if (error) {
        this.bgBlocked = true;
        this.ctx.state.patch('songRequests', { lastError: error.slice(0, 200) });
      }
      this.nextBackground();
      return true;
    }
    if (!this.current || id !== this.current.id || nonce !== this.nonce) return false;
    if (error && kind === 'video') {
      const failed = this.current;
      this.reject(failed.userName, 'playback', failed.redemption);
      this.ctx.state.patch('songRequests', { lastError: `${failed.title ?? failed.url}: ${error.slice(0, 160)}` });
      await this.dropCurrent();
      return true;
    }
    if (error) {
      // A blocked embed/network failure must never consume a paid request or drain the queue.
      this.autoBlocked = true;
      this.ctx.state.patch('songRequests', { lastError: error.slice(0, 200) });
      this.current = null;
      this.nonce = null;
      this.sync();
      this.broadcast(this.overlayMessage);
      await this.resumeMusic();
      return true;
    }
    void this.settle(this.current, 'FULFILLED');
    await this.dropCurrent();
    return true;
  }

  private sync(): void {
    this.ctx.state.patch('songRequests', {
      current: this.current,
      background: !this.current && this.background ? { ...(this.background.playlistId ? { videoId: this.background.videoId, ...(this.background.title ? { title: this.background.title } : {}) } : trackOf(this.background)) } : null,
      paused: this.paused,
      queue: this.ctx.settings.get('songQueue').filter((item) => item.id !== this.current?.id),
    });
  }

  private async resumeMusic(): Promise<void> {
    if (this.remoteUsed && !isRemote(this.current) && !isRemote(this.background)) {
      this.remoteUsed = false;
      this.options.remote?.release(this.ctx.settings.get('songRequests').resumeWindowsMusic);
    }
    const id = this.resumeId;
    this.resumeId = null;
    if (id && this.ctx.settings.get('songRequests').resumeWindowsMusic) {
      try { await this.music.resumeSource(id); }
      catch (error) { this.ctx.state.patch('songRequests', { lastError: String(error) }); }
    }
  }

  async handleChat(message: ChatMessage): Promise<boolean> {
    const cfg = this.ctx.settings.get('songRequests');
    if (!cfg.enabled || !cfg.chatEnabled || message.fromSelf || message.platform !== 'twitch') return false;
    const parsed = parseCommand(message.text, this.ctx.settings.get('bot').prefix);
    const command = cfg.chatCommand.trim().replace(/^[!\/]+/, '').toLowerCase();
    if (!parsed || !command || ![command, ...(command === 'sr' ? ['songrequest'] : [])].includes(parsed.name)) return false;
    const ru = this.ctx.settings.get('language') === 'ru';
    let response: string;
    if (!hasPermission(message.roles, cfg.chatPermission)) response = ru ? 'У вас нет доступа к заказу музыки.' : 'You cannot request songs.';
    else if ((this.chatCooldowns.get(message.userId) ?? 0) > Date.now() || this.chatPending.has(message.userId)) return true;
    else if (this.chatPending.size >= MAX_CHAT_LOOKUPS) response = ru ? 'Сейчас ищу другие заказы — повторите через пару секунд.' : 'Busy with other requests, try again in a few seconds.';
    else {
      this.chatPending.add(message.userId);
      try {
        // Replies (queued / rejected) are sent by `request` itself.
        const result = await this.request(parsed.args.join(' '), message.userName, 'chat', `chat_${message.id}`, undefined, message.id, message.userLogin);
        // A failed try gets a short pause too, so a typo can be fixed but not spammed.
        const pause = result.ok ? Math.max(0, cfg.chatCooldownSec) * 1000 : FAILED_CHAT_PAUSE_MS;
        this.chatCooldowns.delete(message.userId);
        this.chatCooldowns.set(message.userId, Date.now() + pause);
        if (this.chatCooldowns.size > 1000) this.chatCooldowns.delete(this.chatCooldowns.keys().next().value!);
      } finally {
        this.chatPending.delete(message.userId);
      }
      return true;
    }
    await this.reply?.(response, message.id).catch(() => undefined);
    return true;
  }

  private async maybeStart(): Promise<void> {
    const blocked = this.current || this.starting || this.autoBlocked || !this.ctx.settings.get('songRequests').autoPlay || !this.canStart(this.ctx.settings.get('songQueue')[0]);
    if (!blocked) {
      try { await this.play(); } catch (error) { this.ctx.state.patch('songRequests', { lastError: String(error) }); }
    }
    this.startBackground();
  }

  private async onSettingsChanged(): Promise<void> {
    const cfg = this.ctx.settings.get('songRequests');
    const jam = this.activeJam();
    const stale = jam ? this.background?.playlistId !== jam.listId
      : !!this.background?.playlistId || !(cfg.backgroundTracks ?? []).some((track) => track.videoId === this.background?.videoId);
    const remoteBg = isRemote(this.background);
    // Background music was switched off, another jam was chosen or the playing entry was removed.
    if (this.background && (!cfg.backgroundEnabled || (cfg.videoLayout === 'queue' && !remoteBg) || (remoteBg && cfg.yandexPlayback === false) || stale)) {
      this.stopBackground();
      this.paused = false;
      this.sync();
      this.broadcast(this.overlayMessage);
      this.releaseIdleRemote();
    }
    const remoteLevel = isRemote(this.current) ? cfg.volume : !this.current && isRemote(this.background) ? cfg.backgroundVolume ?? 40 : null;
    if (remoteLevel !== null && remoteLevel !== this.remoteVolume) {
      this.remoteVolume = remoteLevel;
      this.options.remote?.setVolume(remoteLevel);
    }
    if (isRemote(this.current) && cfg.yandexPlayback === false) {
      // Yandex playback switched off mid-track: the request stays queued.
      this.current = null;
      this.nonce = null;
      this.sync();
      this.broadcast(this.overlayMessage);
      await this.resumeMusic();
    }
    if (this.ctx.settings.get('songRequests').videoLayout === 'queue' && this.current && !isRemote(this.current)) {
      this.current = null;
      this.nonce = null;
      this.sync();
      this.broadcast(this.overlayMessage);
      if (this.resumeId) {
        const id = this.resumeId;
        this.resumeId = null;
        if (this.ctx.settings.get('songRequests').resumeWindowsMusic) await this.music.resumeSource(id);
      }
    } else void this.maybeStart();
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 500) this.seen.delete(this.seenOrder.shift()!);
  }

  /** A viewer paid channel points to skip whatever is playing. */
  private async viewerSkip(event: StreamEventOf<'redemption'>): Promise<void> {
    const redemption = event.rewardId ? { id: event.id, rewardId: event.rewardId } : undefined;
    const playing = this.current ?? this.background;
    if (this.isBanned(event.userName, event.userLogin)) return void this.reject(event.userName, 'userBanned', redemption);
    if (!playing) return void this.reject(event.userName, 'nothingPlaying', redemption);
    await this.skip();
    void this.settle({ redemption }, 'FULFILLED');
    const title = playing.title ? ` «${playing.title}»` : '';
    this.say(this.ru ? `@${event.userName} пропускает трек${title}.` : `@${event.userName} skipped the track${title}.`);
  }

  private onEvent(event: StreamEvent): void {
    const settings = this.ctx.settings.get('songRequests');
    if (!settings.enabled || event.source === 'test' || this.seen.has(event.id)) return;
    const isReward = (id: string | undefined, title: string | undefined): boolean => event.type === 'redemption' && !!(id ? event.rewardId === id :
      title?.trim() && event.rewardTitle.trim().toLowerCase() === title.trim().toLowerCase());
    if (event.type === 'redemption' && isReward(settings.skipRewardId, settings.skipRewardTitle)) {
      this.markSeen(event.id);
      void this.viewerSkip(event).catch((error) => {
        this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error) });
      });
      return;
    }
    let text = '';
    let source: SongRequest['source'];
    if (event.type === 'redemption' && isReward(settings.rewardId, settings.rewardTitle)) {
      text = event.input;
      source = 'redemption';
    } else if (event.type === 'donation') {
      const amount = donationAmount(event, this.ctx.settings.get('currency'));
      if (amount === null || !Number.isFinite(amount) || amount < settings.minDonation) return;
      text = event.message;
      source = 'donation';
    } else return;
    this.markSeen(event.id);
    // A donation message is free text: only a track link in it is a request.
    if (source !== 'redemption' && !musicLinkInText(text)) return;
    if (!text.trim()) this.ctx.state.patch('songRequests', { lastError: this.ru ? 'Заказ пустой: ни ссылки, ни названия. Включите обязательный ввод текста в награде Twitch.' : 'Empty request: no link and no song name. Require text input on the Twitch reward.' });
    const redemption = event.type === 'redemption' && event.rewardId ? { id: event.id, rewardId: event.rewardId } : undefined;
    void this.request(text, event.userName, source, event.id, redemption, undefined, event.userLogin).catch((error) => {
      this.ctx.state.patch('songRequests', { lastError: String((error as Error).message ?? error) });
    });
  }
}
