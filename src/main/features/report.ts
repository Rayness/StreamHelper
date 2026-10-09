import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportSettings, ReportSummary, SavedReport, StreamInfo } from '@shared/types';
import { ReportCollector } from '@shared/report';
import { errorMessage, type AppContext } from '../core/context';
import { reportHtml, reportText } from './reportCard';

export interface ReportDeps {
  /** Directory with saved cards: `<id>.png` + `<id>.json`. */
  dir: string;
  /** The stream in progress, saved every minute. */
  sessionFile: string;
  /** HTML → PNG (an offscreen window in the app). */
  render(html: string): Promise<Buffer>;
  imageUrl(id: string): string;
  say(text: string): Promise<void>;
  discord?(text: string, png: Buffer, filename: string): Promise<void>;
}

const KEEP_LISTED = 40;
const SAVE_MS = 60_000;
const PUBLISH_MS = 10_000;

/**
 * "Stream recap": collects stats while live and turns them into a shareable card when the stream
 * ends (or on demand). The collection survives app restarts.
 */
export class ReportService {
  private collector: ReportCollector;
  private wasLive: boolean;
  private dirty = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private ctx: AppContext, private deps: ReportDeps, private now: () => number = Date.now) {
    mkdirSync(deps.dir, { recursive: true });
    this.collector = this.restore() ?? new ReportCollector(this.startTime(), ctx.settings.get('currency'));
    this.wasLive = ctx.state.current.stream.live;
    const exclude = () => new Set([...ctx.settings.get('leadersOverlay').exclude, ...ctx.settings.get('chatOverlay').hideBots].map((x) => x.trim().toLowerCase()));
    let excluded = exclude();
    ctx.bus.on('settings:changed', (key) => { if (key === 'leadersOverlay' || key === 'chatOverlay') excluded = exclude(); });
    ctx.bus.on('chat:message', (m) => { this.collector.addChat(m, excluded, this.cfg.stopWords); this.dirty = true; });
    ctx.bus.on('event', (e) => { this.collector.addEvent(e, ctx.settings.get('currency')); this.dirty = true; });
    ctx.bus.on('clip:moment', (m) => { this.collector.addClip(m); this.dirty = true; });
    ctx.bus.on('stream:update', (s) => this.onStream(s));
    this.publishList();
    this.publishLive();
  }

  private get cfg(): ReportSettings {
    return this.ctx.settings.get('report');
  }

  start(): void {
    this.timers.push(setInterval(() => this.save(), SAVE_MS), setInterval(() => this.publishLive(), PUBLISH_MS));
  }

  private startTime(): number {
    return this.ctx.state.current.stream.startedAt ?? this.now();
  }

  private restore(): ReportCollector | null {
    try {
      if (!existsSync(this.deps.sessionFile)) return null;
      return ReportCollector.restore(JSON.parse(readFileSync(this.deps.sessionFile, 'utf8')));
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeFileSync(this.deps.sessionFile + '.tmp', JSON.stringify(this.collector.data), 'utf8');
      renameSync(this.deps.sessionFile + '.tmp', this.deps.sessionFile);
    } catch (err) {
      console.warn('[report] session save failed', errorMessage(err));
    }
  }

  private onStream(s: StreamInfo): void {
    this.collector.setStream(s.title, s.categoryName);
    if (s.live) this.collector.sampleViewers(s.viewers);
    const was = this.wasLive;
    this.wasLive = s.live;
    if (s.live && !was) {
      const started = s.startedAt ?? this.now();
      // The previous stream's data (app closed before it ended) gets its own card first.
      // Offline chatter before the stream (no viewer samples) is simply dropped.
      const old = this.collector.data;
      const earlier = old.startedAt < started - 10 * 60_000;
      if (earlier && old.viewerSamples > 0 && old.messages > 0) void this.finish(true).catch(() => undefined);
      if (earlier || old.viewerSamples === 0) this.collector = new ReportCollector(started, this.ctx.settings.get('currency'));
      // The app was restarted mid-stream: keep counting from the real start.
      else this.collector.data.startedAt = Math.min(old.startedAt, started);
      this.collector.setStream(s.title, s.categoryName);
      this.collector.sampleViewers(s.viewers);
      this.dirty = true;
    } else if (!s.live && was) {
      this.collector.data.endedAt = this.now();
      if (this.cfg.autoGenerate) void this.finish(true).catch((err) => this.ctx.toast('error', 'toast.reportFailed', { error: errorMessage(err) }));
    }
    this.publishLive();
  }

  private publishLive(): void {
    this.ctx.state.patch('report', { live: this.collector.summary() });
  }

  /** Card for the current session. `reset` starts a fresh collection afterwards. */
  async finish(reset: boolean): Promise<SavedReport> {
    const collector = this.collector;
    if (reset) this.collector = new ReportCollector(this.now(), this.ctx.settings.get('currency'));
    const summary: ReportSummary = { ...collector.summary(), endedAt: collector.data.endedAt ?? this.now() };
    const saved = await this.generate(summary);
    if (reset) { this.dirty = true; this.save(); this.publishLive(); }
    return saved;
  }

  async generate(summary: ReportSummary = { ...this.collector.summary(), endedAt: this.now() }): Promise<SavedReport> {
    this.ctx.state.patch('report', { busy: true });
    try {
      const lang = this.ctx.settings.get('language');
      const channel = this.ctx.state.current.twitch.account?.login ?? '';
      const png = await this.deps.render(reportHtml(summary, this.cfg, lang, channel));
      const id = `report-${new Date(summary.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${this.now().toString(36)}`;
      writeFileSync(join(this.deps.dir, `${id}.png`), png);
      const saved: SavedReport = { id, createdAt: this.now(), summary, imageUrl: this.deps.imageUrl(id) };
      writeFileSync(join(this.deps.dir, `${id}.json`), JSON.stringify(saved), 'utf8');
      this.publishList();
      this.ctx.toast('success', 'toast.reportSaved');
      const text = reportText(summary, lang);
      if (this.cfg.postToChat) void this.deps.say(text).catch(() => undefined);
      if (this.cfg.sendToDiscord && this.deps.discord) void this.deps.discord(text, png, `${id}.png`).catch((err) => this.ctx.toast('error', 'toast.reportFailed', { error: errorMessage(err) }));
      return saved;
    } finally {
      this.ctx.state.patch('report', { busy: false });
    }
  }

  /** Start collecting from zero (e.g. after a test run). */
  reset(): void {
    this.collector = new ReportCollector(this.startTime(), this.ctx.settings.get('currency'));
    this.dirty = true;
    this.save();
    this.publishLive();
  }

  list(): SavedReport[] {
    const out: SavedReport[] = [];
    for (const name of readdirSync(this.deps.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const r = JSON.parse(readFileSync(join(this.deps.dir, name), 'utf8')) as SavedReport;
        if (r?.id && r.summary) out.push({ ...r, imageUrl: this.deps.imageUrl(r.id) });
      } catch { /* a broken file is skipped */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  pngPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid report');
    return join(this.deps.dir, `${id}.png`);
  }

  get(id: string): SavedReport | undefined {
    return this.list().find((r) => r.id === id);
  }

  remove(id: string): void {
    const png = this.pngPath(id);
    for (const file of [png, png.replace(/\.png$/, '.json')]) if (existsSync(file)) unlinkSync(file);
    this.publishList();
  }

  async resend(id: string): Promise<void> {
    const r = this.get(id);
    if (!r || !this.deps.discord) throw new Error('Report not found');
    await this.deps.discord(reportText(r.summary, this.ctx.settings.get('language')), readFileSync(this.pngPath(id)), `${id}.png`);
  }

  private publishList(): void {
    this.ctx.state.patch('report', { reports: this.list().slice(0, KEEP_LISTED) });
  }

  dispose(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.dirty = true;
    this.save();
  }
}
