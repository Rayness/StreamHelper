import { randomBytes } from 'node:crypto';
import type { ChatMessage, MelodySettings, MelodyState, MelodyTrack, OverlayMessage, SongRequest } from '@shared/types';
import { uid } from '@shared/defaults';
import type { AppContext } from '../core/context';
import { normalizeText, type StageDeps } from './stage';
import { oembedLookup, youtubeVideoId, type VideoLookup } from './songRequests';
import { shuffled } from './curses';
import { AUTOPLAY_BLOCKED, youtubeErrorText } from './duel';

/**
 * Upload noise outside brackets: "Song Official Video", "Song 4K". Only whole phrases, so a song
 * called "Video Games" keeps its name. `\b` is ASCII-only in JS, hence the letter lookarounds.
 */
const TITLE_NOISE = /(?<![\p{L}\p{N}])(official (music )?video|official audio|official clip|lyrics? video|music video|lyrics|visualizer|премьера клипа|премьера|официальный клип|клип|4k|hd|hq|m\/?v)(?![\p{L}\p{N}])/giu;

/** Artist and song from a YouTube title like "Artist - Song (Official Video)". */
export function splitTitle(title: string): { artist: string; song: string } {
  const clean = title
    .replace(/[([{【「].*?[)\]}】」]/gu, ' ')
    .replace(/\s+ft\.?\s.*$|\s+feat\.?\s.*$/iu, '')
    .replace(TITLE_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = clean.split(/\s+[-–—|]\s+|\s+[-–—]\s*|\s*[-–—]\s+/u).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], song: parts.slice(1).join(' ').replace(/["«»“”]/g, '').trim() };
  const quoted = /["«“](.+?)["»”]/u.exec(title);
  if (quoted) return { artist: clean.replace(quoted[0], '').trim(), song: quoted[1].trim() };
  return { artist: '', song: clean.replace(/["«»“”]/g, '').trim() };
}

/** Edit distance, for typos in answers. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Does a chat line name the song? Exact, contained ("это же bohemian rhapsody!") or with a small typo. */
export function melodyMatch(guess: string, answers: readonly string[]): boolean {
  const g = normalizeText(guess);
  if (!g) return false;
  for (const raw of answers) {
    const a = normalizeText(raw);
    if (!a) continue;
    if (g === a) return true;
    if (a.length >= 4 && ` ${g} `.includes(` ${a} `)) return true;
    if (a.length >= 5) {
      const allowed = a.length >= 12 ? 3 : a.length >= 8 ? 2 : 1;
      if (Math.abs(g.length - a.length) <= allowed && levenshtein(g, a) <= allowed) return true;
    }
  }
  return false;
}

/** "Bohemian Rhapsody" → "B_______ R_______" (with `open` letters per word shown). */
export function maskAnswer(answer: string, open: number): string {
  return answer
    .split(/(\s+)/)
    .map((word) => {
      if (/^\s+$/.test(word)) return word;
      let shown = 0;
      return [...word].map((ch) => (/[\p{L}\p{N}]/u.test(ch) ? (shown++ < open ? ch : '_') : ch)).join('');
    })
    .join('');
}

/** Saved without a title: the video id stands in for the answer, nobody could guess it. */
export function isUnnamed(t: MelodyTrack): boolean {
  return t.title === t.videoId || (t.answers.length === 1 && t.answers[0] === t.videoId);
}

export function trackFromTitle(videoId: string, title: string): MelodyTrack {
  const { artist, song } = splitTitle(title);
  return { id: uid('mel_'), videoId, title, answers: song ? [song] : [title], artist };
}

/** Starts somewhere in the middle: intros are too easy to recognize… or too hard. */
const START_MIN = 0.22;
const START_MAX = 0.6;

/**
 * "Guess the melody": the overlay plays a few seconds of a hidden YouTube video, the first viewer
 * to name the song scores. A longer snippet and opened letters help when nobody gets it.
 */
export class MelodyService {
  private order: MelodyTrack[] = [];
  private current: MelodyTrack | null = null;
  private timers: NodeJS.Timeout[] = [];
  private points = new Map<string, number>();

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private lookup: VideoLookup = oembedLookup,
    private rand: () => number = Math.random,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => { if (key === 'melody' || key === 'language') this.push(); });
    // Tracks saved while YouTube didn't answer have the video id as their "answer": name them now.
    setTimeout(() => void this.nameTracks(), 3000);
  }

  /** Look up titles of tracks that were saved without one (YouTube was slow or offline then). */
  async nameTracks(): Promise<number> {
    const unnamed = this.cfg.playlist.filter(isUnnamed);
    if (!unnamed.length) return 0;
    const titles = new Map<string, string>();
    for (const t of unnamed) {
      const check = await this.lookup(t.videoId).catch(() => null);
      if (check?.ok && check.title) titles.set(t.videoId, check.title);
    }
    if (!titles.size) return 0;
    this.ctx.settings.set('melody', { ...this.cfg, playlist: this.cfg.playlist.map((t) => {
      const title = isUnnamed(t) ? titles.get(t.videoId) : undefined;
      return title ? { ...trackFromTitle(t.videoId, title), id: t.id } : t;
    }) });
    return titles.size;
  }

  private get cfg(): MelodySettings {
    return this.ctx.settings.get('melody');
  }

  private get state(): MelodyState {
    return this.ctx.state.current.melody;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  overlayMessage(): OverlayMessage {
    return { type: 'melody', melody: this.state, style: this.cfg, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  /** Add YouTube links; titles come from YouTube, answers are guessed from them and can be edited. */
  async add(urls: string[]): Promise<number> {
    const known = new Set(this.cfg.playlist.map((t) => t.videoId));
    const ids = [...new Set(urls.map((u) => youtubeVideoId(u.trim())).filter((id): id is string => !!id && !known.has(id)))].slice(0, 100);
    const tracks: MelodyTrack[] = [];
    for (let i = 0; i < ids.length; i += 6) {
      const batch = await Promise.all(ids.slice(i, i + 6).map(async (id) => {
        const check = await this.lookup(id);
        if (check && !check.ok) return null;
        return trackFromTitle(id, check?.title ?? id);
      }));
      tracks.push(...batch.filter((t): t is MelodyTrack => !!t));
    }
    if (tracks.length) this.ctx.settings.set('melody', { ...this.cfg, playlist: [...this.cfg.playlist, ...tracks] });
    return tracks.length;
  }

  /** Songs viewers requested make a ready playlist. */
  async addFromSongs(requests: SongRequest[]): Promise<number> {
    const known = new Set(this.cfg.playlist.map((t) => t.videoId));
    const tracks = requests.filter((r) => !known.has(r.videoId) && known.add(r.videoId)).map((r) => trackFromTitle(r.videoId, r.title ?? r.videoId));
    if (tracks.length) this.ctx.settings.set('melody', { ...this.cfg, playlist: [...this.cfg.playlist, ...tracks] });
    if (tracks.some(isUnnamed)) await this.nameTracks();
    return tracks.length;
  }

  async start(): Promise<void> {
    if (this.state.status === 'playing' || this.state.status === 'reveal') throw new Error(this.ru ? 'Игра уже идёт' : 'The game is already running');
    if (!(this.ctx.state.current.overlayKinds.melody ?? 0)) throw new Error(this.ru ? 'Оверлей «Угадай мелодию» не открыт: добавьте его в OBS — он проигрывает музыку' : 'The Guess the melody overlay is not open: add it to OBS — it plays the music');
    await this.nameTracks();
    if (this.cfg.playlist.some(isUnnamed)) throw new Error(this.ru ? 'У некоторых треков нет названия (YouTube не ответил). Впишите ответы вручную в плейлисте.' : 'Some tracks have no title (YouTube did not answer). Type their answers in the playlist.');
    const list = this.cfg.playlist.filter((t) => t.videoId && t.answers.some((a) => a.trim()));
    if (!list.length) throw new Error(this.ru ? 'Добавьте треки в плейлист' : 'Add tracks to the playlist');
    this.order = shuffled(list, this.rand).slice(0, Math.max(1, Math.min(50, this.cfg.rounds)));
    this.points.clear();
    this.ctx.state.replace('melody', { ...this.state, round: 0, rounds: this.order.length, leaderboard: [], winner: null, answer: null, error: null });
    if (this.cfg.announce) void this.deps.say(this.ru ? `🎶 Угадай мелодию! ${this.order.length} раундов — пишите название песни в чат.` : `🎶 Guess the melody! ${this.order.length} rounds — type the song name in chat.`);
    this.nextRound();
  }

  private nextRound(): void {
    this.clearTimers();
    const round = this.state.round + 1;
    const track = this.order[round - 1];
    if (!track) return this.finish();
    this.current = track;
    const fraction = START_MIN + this.rand() * (START_MAX - START_MIN);
    const endsAt = Date.now() + Math.max(10, this.cfg.roundSec) * 1000;
    this.ctx.state.replace('melody', {
      ...this.state, status: 'playing', round, endsAt, playId: randomBytes(6).toString('hex'), videoId: track.videoId,
      startFraction: Math.round(fraction * 1000) / 1000, snippetSec: Math.max(3, this.cfg.snippetSec), hint: maskAnswer(track.answers[0], 0), answer: null, winner: null,
    });
    this.push();
    const hintAfter = this.cfg.hintAfterSec;
    if (hintAfter > 0 && hintAfter < this.cfg.roundSec) {
      this.timers.push(setTimeout(() => this.hint(), hintAfter * 1000));
    }
    this.timers.push(setTimeout(() => this.reveal(null), endsAt - Date.now()));
  }

  /** Same place, twice as long, and the first letters open. */
  private hint(): void {
    if (this.state.status !== 'playing' || !this.current) return;
    this.ctx.state.replace('melody', { ...this.state, playId: randomBytes(6).toString('hex'), snippetSec: Math.max(3, this.cfg.snippetSec) * 2, hint: maskAnswer(this.current.answers[0], 1) });
    this.push();
  }

  private onChat(m: ChatMessage): void {
    if (this.state.status !== 'playing' || !this.current || m.fromSelf || m.roles.broadcaster) return;
    const answers = [...this.current.answers, ...(this.cfg.acceptArtist && this.current.artist ? [this.current.artist] : [])];
    if (!melodyMatch(m.text, answers)) return;
    const points = (this.points.get(m.userName) ?? 0) + 1;
    this.points.set(m.userName, points);
    this.reveal(m.userName);
  }

  /** The overlay could not play this track: say why and move on instead of a silent round. */
  playerError(videoId: string, code: number): void {
    if (this.state.status !== 'playing' || this.state.videoId !== videoId || !this.current) return;
    const error = code === AUTOPLAY_BLOCKED ? youtubeErrorText(code, this.ru) : `«${this.current.title}»: ${youtubeErrorText(code, this.ru)}`;
    this.ctx.state.replace('melody', { ...this.state, error });
    this.ctx.toast('error', 'toast.actionError', { error });
    // Sound blocked by the browser: the round goes on once someone clicks the overlay.
    if (code !== AUTOPLAY_BLOCKED) this.reveal(null, false);
  }

  skip(): void {
    if (this.state.status === 'playing') this.reveal(null);
    else if (this.state.status === 'reveal') this.nextRound();
  }

  private reveal(winner: string | null, announce = true): void {
    const track = this.current;
    if (!track || this.state.status !== 'playing') return;
    this.clearTimers();
    const endsAt = Date.now() + Math.max(3, this.cfg.revealSec) * 1000;
    this.ctx.state.replace('melody', { ...this.state, status: 'reveal', endsAt, winner, answer: { title: track.title, videoId: track.videoId }, hint: track.answers[0], leaderboard: this.leaderboard() });
    this.push();
    if (this.cfg.announce && announce) {
      void this.deps.say(winner
        ? (this.ru ? `✅ ${winner} угадал(а): «${track.title}»` : `✅ ${winner} got it: "${track.title}"`)
        : (this.ru ? `⏱ Никто не угадал. Это была «${track.title}»` : `⏱ Nobody got it. It was "${track.title}"`));
    }
    this.timers.push(setTimeout(() => this.nextRound(), endsAt - Date.now()));
  }

  private finish(): void {
    this.clearTimers();
    this.current = null;
    const leaderboard = this.leaderboard();
    this.ctx.state.replace('melody', { ...this.state, status: 'finished', endsAt: null, playId: null, videoId: null, leaderboard });
    this.push();
    if (this.cfg.announce) {
      const top = leaderboard[0];
      void this.deps.say(top
        ? (this.ru ? `🏆 Игра окончена! Лучший слух у ${top.userName} — ${top.points} очк.` : `🏆 Game over! Best ears: ${top.userName} with ${top.points}.`)
        : (this.ru ? 'Игра окончена — в этот раз мелодии победили 🎵' : 'Game over — the melodies won this time 🎵'));
    }
  }

  stop(): void {
    this.clearTimers();
    this.current = null;
    this.ctx.state.replace('melody', { ...this.state, status: 'idle', endsAt: null, playId: null, videoId: null, answer: null, winner: null, hint: '' });
    this.push();
  }

  private leaderboard(): MelodyState['leaderboard'] {
    return [...this.points].map(([userName, points]) => ({ userName, points })).sort((a, b) => b.points - a.points).slice(0, 10);
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private push(): void {
    this.deps.broadcast('melody', this.overlayMessage());
  }

  dispose(): void {
    this.clearTimers();
  }
}
