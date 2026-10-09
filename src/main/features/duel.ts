import type { ChatMessage, DuelSettings, DuelSide, DuelState, OverlayMessage, SongRequest } from '@shared/types';
import type { AppContext } from '../core/context';
import type { StageDeps } from './stage';

/** What the duel needs from the song request queue. */
export interface DuelSongs {
  upcoming(): SongRequest[];
  hasCurrent(): boolean;
  isPaused(): boolean;
  pause(paused: boolean): void;
  move(id: string, index: number): void;
  play(id: string): Promise<void>;
  remove(id: string): void;
}

/** "1" / "2", or "a" / "b" (Latin or Cyrillic). */
export function parseDuelVote(text: string): 'a' | 'b' | null {
  const t = text.trim().toLowerCase();
  if (t === '1' || t === 'a' || t === 'а') return 'a';
  if (t === '2' || t === 'b' || t === 'б') return 'b';
  return null;
}

const RESULT_MS = 12_000;

/** Reported by our overlays (not YouTube): the browser refused to play sound without a click. */
export const AUTOPLAY_BLOCKED = 0;

/** YouTube IFrame player error codes, as the streamer should read them. */
export function youtubeErrorText(code: number, ru: boolean): string {
  if (code === AUTOPLAY_BLOCKED) return ru ? 'браузер запретил звук без клика — оверлей открыт не в OBS. Кликните по странице оверлея или добавьте его в OBS' : 'the browser blocked sound without a click — the overlay is not in OBS. Click the overlay page or add it to OBS';
  if (code === 101 || code === 150) return ru ? `автор или лейбл запретил воспроизведение вне YouTube (${code})` : `the owner or label blocked playback outside YouTube (${code})`;
  if (code === 100 || code === 2) return ru ? `видео удалено, скрыто или ссылка неверная (${code})` : `the video is removed, private or the link is wrong (${code})`;
  if (code === 153) return ru ? 'YouTube не узнал страницу плеера — обновите источник в OBS (153)' : 'YouTube did not recognize the player page — refresh the OBS source (153)';
  return ru ? `ошибка YouTube ${code}` : `YouTube error ${code}`;
}

/**
 * Two song requests play a snippet each, chat votes, the winner jumps the queue and the loser
 * leaves it. The song player is paused for the duel and resumed afterwards.
 */
export class DuelService {
  private votes = new Map<string, 'a' | 'b'>();
  private timer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private resumeSong = false;

  constructor(private ctx: AppContext, private deps: StageDeps, private songs: DuelSongs) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => { if (key === 'duel' || key === 'language') this.push(); });
  }

  private get cfg(): DuelSettings {
    return this.ctx.settings.get('duel');
  }

  private get state(): DuelState {
    return this.ctx.state.current.duel;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  overlayMessage(): OverlayMessage {
    return { type: 'duel', duel: this.state, style: this.cfg, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  start(aId?: string, bId?: string): void {
    if (this.state.status !== 'idle' && this.state.status !== 'done') throw new Error(this.ru ? 'Дуэль уже идёт' : 'A duel is already running');
    if (!(this.ctx.state.current.overlayKinds.duel ?? 0)) throw new Error(this.ru ? 'Добавьте оверлей «Музыкальная дуэль» в OBS — он проигрывает треки' : 'Add the Music duel overlay to OBS — it plays the tracks');
    const queue = this.songs.upcoming();
    const pick = (id?: string) => (id ? queue.find((r) => r.id === id) : undefined);
    const a = pick(aId) ?? queue.find((r) => r.id !== bId);
    const b = pick(bId) ?? queue.find((r) => r.id !== a?.id);
    if (!a || !b || a.id === b.id) throw new Error(this.ru ? 'Для дуэли нужно два заказа в очереди' : 'A duel needs two requests in the queue');
    this.votes.clear();
    this.resumeSong = this.songs.hasCurrent() && !this.songs.isPaused();
    if (this.resumeSong) this.songs.pause(true);
    const side = (r: SongRequest): DuelSide => ({ requestId: r.id, videoId: r.videoId, title: r.title ?? r.url, userName: r.userName, votes: 0 });
    this.phase({ status: 'playingA', a: side(a), b: side(b), winner: null, error: null }, this.cfg.snippetSec);
    if (this.cfg.announce) {
      void this.deps.say(this.ru
        ? `🎵 Музыкальная дуэль! 1 — «${side(a).title}» (${a.userName}) против 2 — «${side(b).title}» (${b.userName}). Голосуйте 1 или 2!`
        : `🎵 Music duel! 1 — "${side(a).title}" (${a.userName}) vs 2 — "${side(b).title}" (${b.userName}). Vote 1 or 2!`);
    }
  }

  private phase(patch: Partial<DuelState>, seconds: number): void {
    this.clearTimer();
    const endsAt = Date.now() + Math.max(3, seconds) * 1000;
    this.ctx.state.replace('duel', { ...this.state, ...patch, endsAt });
    this.push();
    this.timer = setTimeout(() => this.advance(), endsAt - Date.now());
  }

  private advance(): void {
    switch (this.state.status) {
      case 'playingA': return this.phase({ status: 'playingB' }, this.cfg.snippetSec);
      case 'playingB': return this.phase({ status: 'voting' }, this.cfg.voteSec);
      case 'voting': return void this.finish();
      case 'done': return this.reset();
    }
  }

  private onChat(m: ChatMessage): void {
    const s = this.state;
    // Votes count once both tracks have started: viewers heard the first one and hear the second.
    if ((s.status !== 'playingB' && s.status !== 'voting') || m.fromSelf || !s.a || !s.b) return;
    const vote = parseDuelVote(m.text);
    if (!vote) return;
    this.votes.set(`${m.platform}:${m.userId}`, vote);
    let a = 0;
    for (const v of this.votes.values()) if (v === 'a') a++;
    this.ctx.state.replace('duel', { ...s, a: { ...s.a, votes: a }, b: { ...s.b, votes: this.votes.size - a } });
    this.schedulePush();
  }

  private async finish(): Promise<void> {
    const s = this.state;
    if (!s.a || !s.b) return this.reset();
    const winner = s.a.votes === s.b.votes ? 'tie' : s.a.votes > s.b.votes ? 'a' : 'b';
    this.phase({ status: 'done', winner }, RESULT_MS / 1000);
    if (winner === 'tie') {
      if (this.cfg.announce) void this.deps.say(this.ru ? '🤝 Ничья! Оба трека остаются в очереди.' : '🤝 A tie! Both tracks stay in the queue.');
      return;
    }
    const win = s[winner]!;
    const lose = s[winner === 'a' ? 'b' : 'a']!;
    if (this.cfg.loserAction === 'remove') this.songs.remove(lose.requestId);
    if (this.cfg.winnerAction === 'playNext') this.songs.move(win.requestId, 0);
    if (this.cfg.winnerAction === 'playNow') {
      this.resumeSong = false;
      await this.songs.play(win.requestId).catch(() => this.songs.move(win.requestId, 0));
    }
    if (this.cfg.announce) {
      void this.deps.say(this.ru
        ? `🏆 Побеждает «${win.title}» (${win.votes}:${lose.votes})! Спасибо, ${win.userName}.`
        : `🏆 "${win.title}" wins (${win.votes}:${lose.votes})! Thanks, ${win.userName}.`);
    }
  }

  /**
   * The overlay could not play a track. The duel goes on (chat can still vote on the other one),
   * but the streamer sees why it was silent.
   */
  playerError(videoId: string, code: number): void {
    const s = this.state;
    const side = s.a?.videoId === videoId ? s.a : s.b?.videoId === videoId ? s.b : null;
    if (!side || s.status === 'idle') return;
    const error = code === AUTOPLAY_BLOCKED ? youtubeErrorText(code, this.ru) : `«${side.title}»: ${youtubeErrorText(code, this.ru)}`;
    this.ctx.state.replace('duel', { ...s, error });
    this.ctx.toast('error', 'toast.actionError', { error });
    if (code === AUTOPLAY_BLOCKED) return;
    // Don't keep the stream silent for the rest of the snippet.
    if ((s.status === 'playingA' && s.a === side) || (s.status === 'playingB' && s.b === side)) this.advance();
  }

  stop(): void {
    if (this.state.status === 'idle') return;
    this.reset();
  }

  private reset(): void {
    this.clearTimer();
    this.votes.clear();
    this.ctx.state.replace('duel', { status: 'idle', a: null, b: null, endsAt: null, winner: null, error: null });
    this.push();
    if (this.resumeSong) this.songs.pause(false);
    this.resumeSong = false;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; this.push(); }, 200);
  }

  private push(): void {
    this.deps.broadcast('duel', this.overlayMessage());
  }

  dispose(): void {
    this.clearTimer();
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }
}
