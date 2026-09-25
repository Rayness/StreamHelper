import type { ChatMessage, QuizDifficulty, QuizSettings, QuizState } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';
import type { CatalogItemDto, KawakiApi } from '../integrations/kawaki/api';
import { normalizeText, type StageDeps } from './stage';

/** How deep into the "top by score" catalog the quiz may go. 48 titles per page. */
const DIFFICULTY_PAGES: Record<QuizDifficulty, number> = { easy: 2, normal: 5, hard: 15 };
const MAX_PICK_ATTEMPTS = 10;

export interface QuizSource {
  api: KawakiApi;
  authed<T>(fn: (token: string) => Promise<T>): Promise<T>;
  readonly connected: boolean;
}

interface Question {
  animeId: string;
  title: string;
  posterUrl: string | null;
  url: string;
  imageUrl: string;
  answers: string[];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Full title plus its short forms: "Frieren: Beyond Journey's End" also answers as "Frieren". */
export function answerVariants(title: string): string[] {
  const out = new Set<string>();
  const full = normalizeText(title);
  if (full) out.add(full);
  for (const sep of [':', ' — ', ' - ', '(', '!', '?']) {
    const head = normalizeText(title.split(sep)[0]);
    if (head.length >= 4) out.add(head);
  }
  return [...out];
}

/** Forgiving match: exact after normalization, or a small typo budget on longer titles. */
export function isCorrectAnswer(text: string, answers: string[]): boolean {
  const t = normalizeText(text);
  if (t.length < 2) return false;
  return answers.some((a) => {
    if (t === a) return true;
    if (a.length < 5) return false;
    const budget = a.length >= 12 ? 2 : 1;
    return Math.abs(a.length - t.length) <= budget && levenshtein(t, a) <= budget;
  });
}

/** "Провожающая" → "П_о_____щ__" — letters open up at `revealed` positions, spacing and punctuation stay. */
export function maskTitle(title: string, revealRatio: number, rand: () => number = Math.random): string {
  const letters = [...title].map((ch, i) => ({ ch, i })).filter(({ ch }) => /[\p{L}\p{N}]/u.test(ch));
  const count = Math.floor(letters.length * Math.max(0, Math.min(1, revealRatio)));
  const open = new Set<number>();
  // Deterministic per title for a given rand: pick positions without repeats.
  const pool = letters.map((l) => l.i);
  for (let k = 0; k < count && pool.length; k++) open.add(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return [...title].map((ch, i) => (/[\p{L}\p{N}]/u.test(ch) && !open.has(i) ? '_' : ch)).join('');
}

/**
 * "Guess the anime by a frame": frames and titles come from Kawaki (the same catalog routes the
 * Kawaki Quiz Creator uses), chat answers in any language the catalog knows.
 */
export class QuizService {
  private timer: NodeJS.Timeout | null = null;
  private hintTimers: NodeJS.Timeout[] = [];
  private current: Question | null = null;
  private upcoming: Promise<Question> | null = null;
  private used = new Set<string>();
  private scores = new Map<string, number>();
  private catalogCache = new Map<number, CatalogItemDto[]>();
  private runId = 0;
  private hintSeed = 0;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private source: QuizSource,
    private rand: () => number = Math.random,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => key === 'quiz' && this.push());
  }

  private get cfg(): QuizSettings {
    return this.ctx.settings.get('quiz');
  }

  private get state(): QuizState {
    return this.ctx.state.current.quiz;
  }

  private set(patch: Partial<QuizState>): void {
    this.ctx.state.replace('quiz', { ...this.state, ...patch });
    this.push();
  }

  overlayMessage() {
    return { type: 'quiz' as const, quiz: this.state, style: this.cfg, now: Date.now(), lang: this.ctx.settings.get('language') };
  }

  private push(): void {
    this.deps.broadcast('quiz', this.overlayMessage());
  }

  async start(): Promise<void> {
    if (!this.source.connected) throw new Error('connect Kawaki first');
    this.clearTimers();
    const run = ++this.runId;
    this.used.clear();
    this.scores.clear();
    this.current = null;
    this.set({ status: 'loading', round: 0, rounds: Math.max(1, this.cfg.rounds), imageUrl: null, hint: '', endsAt: null, answer: null, winner: null, leaderboard: [], error: undefined });
    if (this.cfg.announce) void this.deps.say(this.ru ? 'Аниме-квиз! Угадайте аниме по кадру — пишите название в чат' : 'Anime quiz! Guess the anime from the frame — type the title in chat');
    this.upcoming = this.prepareQuestion();
    await this.nextRound(run);
  }

  stop(): void {
    this.runId++;
    this.clearTimers();
    this.current = null;
    this.upcoming = null;
    this.set({ status: 'idle', round: 0, imageUrl: null, hint: '', endsAt: null, answer: null, winner: null, error: undefined });
  }

  skip(): void {
    if (this.state.status === 'question') this.reveal(null, 0);
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  private async nextRound(run: number): Promise<void> {
    const round = this.state.round + 1;
    if (round > this.state.rounds) return this.finish();
    let q: Question;
    try {
      q = await (this.upcoming ?? this.prepareQuestion());
    } catch (err) {
      if (run !== this.runId) return;
      this.set({ status: 'error', error: errorMessage(err), endsAt: null });
      this.ctx.toast('error', 'toast.quizFailed', { error: errorMessage(err) });
      return;
    }
    if (run !== this.runId) return;
    this.current = q;
    // Load the next frame while this round plays, so rounds follow each other without a pause.
    this.upcoming = round < this.state.rounds ? this.prepareQuestion() : null;
    this.upcoming?.catch(() => undefined);
    const roundMs = Math.max(10, this.cfg.roundSec) * 1000;
    this.hintSeed = this.rand();
    this.set({ status: 'question', round, imageUrl: q.imageUrl, hint: this.cfg.hints ? this.mask(q.title, 0) : '', endsAt: Date.now() + roundMs, answer: null, winner: null });
    if (this.cfg.hints) {
      this.hintTimers = [0.5, 0.75].map((at, i) => setTimeout(() => this.set({ hint: this.mask(q.title, i === 0 ? 0.25 : 0.5) }), roundMs * at));
    }
    this.timer = setTimeout(() => this.reveal(null, 0), roundMs);
  }

  private mask(title: string, ratio: number): string {
    // Same seed for the whole round: later hints only add letters, never shuffle them.
    let s = this.hintSeed * 2 ** 31;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    return maskTitle(title, ratio, rand);
  }

  private reveal(winner: string | null, points: number): void {
    const q = this.current;
    if (!q || this.state.status !== 'question') return;
    this.clearTimers();
    if (winner) this.scores.set(winner, (this.scores.get(winner) ?? 0) + points);
    this.set({ status: 'reveal', winner, hint: q.title, endsAt: null, answer: { title: q.title, posterUrl: q.posterUrl, url: q.url }, leaderboard: this.leaderboard() });
    if (this.cfg.announce) {
      const text = winner
        ? this.ru
          ? `${winner} угадал(а): ${q.title} (+${points})`
          : `${winner} got it: ${q.title} (+${points})`
        : this.ru
          ? `Никто не угадал — это ${q.title}`
          : `Nobody got it — it was ${q.title}`;
      void this.deps.say(text);
    }
    const run = this.runId;
    this.timer = setTimeout(() => void this.nextRound(run), Math.max(3, this.cfg.revealSec) * 1000);
  }

  private finish(): void {
    this.clearTimers();
    const board = this.leaderboard();
    this.set({ status: 'finished', endsAt: null, imageUrl: null, leaderboard: board });
    if (this.cfg.announce) {
      const top = board
        .slice(0, 3)
        .map((b, i) => `${i + 1}. ${b.userName} — ${b.points}`)
        .join(', ');
      void this.deps.say(top ? (this.ru ? `Квиз окончен! ${top}` : `Quiz over! ${top}`) : this.ru ? 'Квиз окончен — никто ничего не угадал' : 'Quiz over — no correct answers');
    }
  }

  private leaderboard(): QuizState['leaderboard'] {
    return [...this.scores.entries()]
      .map(([userName, points]) => ({ userName, points }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
  }

  private onChat(m: ChatMessage): void {
    if (m.fromSelf || this.state.status !== 'question' || !this.current) return;
    if (!isCorrectAnswer(m.text, this.current.answers)) return;
    const left = this.state.endsAt ? (this.state.endsAt - Date.now()) / (Math.max(10, this.cfg.roundSec) * 1000) : 0;
    // Faster answers, before the hints open letters, are worth more.
    const points = left > 0.5 ? 3 : left > 0.25 ? 2 : 1;
    this.reveal(m.userName, points);
  }

  // ---------- questions from Kawaki ----------

  private async prepareQuestion(): Promise<Question> {
    const { api } = this.source;
    const pages = DIFFICULTY_PAGES[this.cfg.difficulty] ?? 5;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
      try {
        const page = 1 + Math.floor(this.rand() * pages);
        let items = this.catalogCache.get(page);
        if (!items) {
          items = (await api.catalog(page)).items;
          this.catalogCache.set(page, items);
        }
        const fresh = items.filter((i) => !this.used.has(i.id));
        if (!fresh.length) continue;
        const item = fresh[Math.floor(this.rand() * fresh.length)];
        this.used.add(item.id);
        const frames = (await this.source.authed((t) => api.quizFrames(t, item.id))).items;
        if (!frames.length) continue;
        const frame = frames[Math.floor(this.rand() * frames.length)];
        const titles = await this.source.authed((t) => api.quizTitle(t, item.id)).catch(() => null);
        const names = [item.title, item.titleEn, item.titleJp, titles?.titles.ru, titles?.titles.en, titles?.titles.jp, titles?.titles.romaji];
        const answers = [...new Set(names.filter((n): n is string => !!n).flatMap(answerVariants))];
        return {
          animeId: item.id,
          title: item.title,
          posterUrl: item.posterUrl ?? titles?.poster ?? null,
          url: api.animeUrl(item.externalId),
          imageUrl: frame.url,
          answers,
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(this.ru ? 'Не удалось подобрать кадр' : 'Could not find a frame');
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hintTimers.forEach(clearTimeout);
    this.hintTimers = [];
  }

  dispose(): void {
    this.clearTimers();
  }
}
