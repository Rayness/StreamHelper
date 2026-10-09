import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatMessage, ShieldSettings, ShieldState, ShieldSuspect } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';
import { hasPermission } from '../bot/permissions';

/** Text "skeleton" for spotting copy-paste spam: case, digits, mentions, punctuation and stretched letters removed. */
export function spamKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/@\S+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1$1')
    // "ахахахах", "hahaha": laughter, not a copy-paste.
    .replace(/(\p{L}{2})\1{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

interface Entry { messageId: string; userId: string; userName: string; text: string; key: string; at: number; fresh: boolean }

/** Shorter skeletons ("lul", "ахах", "+++") are reactions every chat repeats, not spam. */
const MIN_SPAM_KEY = 5;

export interface Readings { newChatters: number; similar: number; young: number }

export interface Verdict {
  readings: Readings;
  reason: 'newChatters' | 'similar' | 'young' | null;
  suspects: Entry[];
}

/**
 * Hate-raid detector over a short window: a flood of never-seen chatters, the same text from many
 * accounts, or many freshly created accounts. Chatters seen before are remembered between runs.
 */
export class RaidDetector {
  private entries: Entry[] = [];
  /** First message time of chatters new to the channel, inside the current window. */
  private fresh = new Map<string, number>();
  private created = new Map<string, number>();

  constructor(private known: Set<string>) {}

  /**
   * Returns true when the chatter has never been seen on this channel before.
   * `keyText` is what copy-paste detection compares (the text without emotes; empty for commands).
   */
  push(e: Omit<Entry, 'key' | 'fresh'> & { keyText?: string }): boolean {
    const isNew = !this.known.has(e.userId);
    if (isNew) {
      this.known.add(e.userId);
      this.fresh.set(e.userId, e.at);
    }
    const { keyText, ...entry } = e;
    this.entries.push({ ...entry, key: spamKey(keyText ?? e.text), fresh: this.fresh.has(e.userId) });
    return isNew;
  }

  setAccountCreated(userId: string, createdAt: number): void {
    this.created.set(userId, createdAt);
    if (this.created.size > 5000) this.created.delete(this.created.keys().next().value!);
  }

  private prune(now: number, windowMs: number): void {
    const cutoff = now - Math.max(windowMs, 60_000);
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].at < cutoff) drop++;
    if (drop) this.entries.splice(0, drop);
    for (const [id, at] of this.fresh) if (at < cutoff) this.fresh.delete(id);
  }

  /** `trustNew = false` while the list of known chatters is still being learned (a fresh install). */
  evaluate(now: number, cfg: ShieldSettings, graceUntil = 0, trustNew = true): Verdict {
    const windowMs = Math.max(5, cfg.windowSec) * 1000;
    this.prune(now, windowMs);
    const recent = this.entries.filter((e) => e.at >= now - windowMs && e.at <= now);
    const freshIds = new Set(recent.filter((e) => e.fresh).map((e) => e.userId));
    const groups = new Map<string, Set<string>>();
    // Only chatters new to the channel: regulars spamming the same emote or command is just a hype moment.
    for (const e of recent) {
      if (!e.fresh || e.key.length < MIN_SPAM_KEY) continue;
      let users = groups.get(e.key);
      if (!users) groups.set(e.key, (users = new Set()));
      users.add(e.userId);
    }
    let topKey = '';
    let similar = 0;
    for (const [key, users] of groups) if (users.size > similar) { similar = users.size; topKey = key; }
    const youngMs = cfg.youngDays * 86_400_000;
    const youngIds = cfg.youngDays > 0 ? [...freshIds].filter((id) => { const c = this.created.get(id); return c !== undefined && now - c < youngMs; }) : [];
    const readings = { newChatters: freshIds.size, similar, young: youngIds.length };
    // A real raid brings new faces and "raid hype" spam: allow much more for a while.
    const k = now < graceUntil ? 3 : 1;
    const over = (value: number, limit: number) => limit > 0 && value >= limit * k;
    let reason: Verdict['reason'] = null;
    let suspects: Entry[] = [];
    if (over(similar, cfg.similar)) { reason = 'similar'; suspects = recent.filter((e) => e.fresh && e.key === topKey); }
    else if (over(readings.young, cfg.young)) { reason = 'young'; const ids = new Set(youngIds); suspects = recent.filter((e) => ids.has(e.userId)); }
    else if (trustNew && over(readings.newChatters, cfg.newChatters)) { reason = 'newChatters'; suspects = recent.filter((e) => e.fresh); }
    return { readings, reason, suspects };
  }

  /** Fresh chatters waiting for an account-age lookup. */
  freshIds(): string[] {
    return [...this.fresh.keys()].filter((id) => !this.created.has(id));
  }
}

export interface ChatModesLike {
  followerMode: boolean;
  followerMinutes: number;
  slowMode: boolean;
  slowSec: number;
  emoteMode: boolean;
}

export interface ShieldDeps {
  getChatSettings(): Promise<ChatModesLike>;
  updateChatSettings(modes: Partial<ChatModesLike>): Promise<void>;
  setShieldMode(active: boolean): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  timeout(userId: string, seconds: number, reason: string): Promise<void>;
  accountAges(ids: string[]): Promise<Map<string, number>>;
  say(text: string): Promise<void>;
}

const KNOWN_MAX = 150_000;
const RELEASE_RETRY_MS = 30_000;

interface ShieldLock {
  restore: Partial<ChatModesLike> | null;
  shieldModeOn: boolean;
  reason: string;
  activatedAt: number;
  releaseAt: number | null;
}
/** Until the shield knows this many regulars (or has watched this long), "new chatters" alone don't trigger it. */
const LEARNED_CHATTERS = 300;
const LEARN_MS = 20 * 60_000;

/**
 * Raid shield: watches chat for hate-raid patterns and locks it down (followers-only, slow mode,
 * Twitch Shield Mode), cleans up the spam and restores the previous chat settings afterwards.
 */
export class ShieldService {
  private detector: RaidDetector;
  private known: Set<string>;
  private knownDirty = false;
  private graceUntil = 0;
  private timers: NodeJS.Timeout[] = [];
  private releaseTimer: NodeJS.Timeout | null = null;
  /** What we changed, to put it back exactly. */
  private restore: Partial<ChatModesLike> | null = null;
  private shieldModeOn = false;
  private activating = false;
  private agesBusy = false;
  private disposed = false;
  /** Messages already deleted and chatters already timed out during this lockdown. */
  private handled = new Set<string>();
  private timedOut = new Set<string>();
  /** What we changed survives a crash or quit, so the chat is never left locked. */
  private lockFile: string;
  private knownAtStart: number;
  private startedAt: number;

  constructor(private ctx: AppContext, private deps: ShieldDeps, private knownFile: string, private now: () => number = Date.now) {
    this.lockFile = join(dirname(knownFile), 'shield-lock.json');
    this.known = this.loadKnown();
    this.knownAtStart = this.known.size;
    this.startedAt = this.now();
    this.detector = new RaidDetector(this.known);
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('event', (e) => { if (e.type === 'raid' && e.source !== 'test') this.graceUntil = this.now() + Math.max(0, this.cfg.raidGraceSec) * 1000; });
    ctx.bus.on('settings:changed', (key) => { if (key === 'shield') this.syncStatus(); });
    this.syncStatus();
  }

  private get cfg(): ShieldSettings {
    return this.ctx.settings.get('shield');
  }

  private get state(): ShieldState {
    return this.ctx.state.current.shield;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  start(): void {
    this.resumeLock();
    this.timers.push(
      setInterval(() => this.check(), 1000),
      setInterval(() => void this.lookupAges(), 3000),
      setInterval(() => this.saveKnown(), 60_000),
    );
  }

  private loadKnown(): Set<string> {
    try {
      if (existsSync(this.knownFile)) {
        const ids = JSON.parse(readFileSync(this.knownFile, 'utf8'));
        if (Array.isArray(ids)) return new Set(ids.filter((x): x is string => typeof x === 'string'));
      }
    } catch { /* start fresh */ }
    return new Set();
  }

  private saveLock(): void {
    try {
      if (!this.restore && !this.shieldModeOn) {
        if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
        return;
      }
      const s = this.state;
      const lock: ShieldLock = { restore: this.restore, shieldModeOn: this.shieldModeOn, reason: s.reason ?? '', activatedAt: s.activatedAt ?? this.now(), releaseAt: s.releaseAt };
      mkdirSync(dirname(this.lockFile), { recursive: true });
      writeFileSync(this.lockFile + '.tmp', JSON.stringify(lock), 'utf8');
      renameSync(this.lockFile + '.tmp', this.lockFile);
    } catch (err) {
      console.warn('[shield] save lock failed', errorMessage(err));
    }
  }

  /** The app was closed (or crashed) while the chat was locked: pick the lockdown up again. */
  private resumeLock(): void {
    let lock: ShieldLock | null = null;
    try {
      if (existsSync(this.lockFile)) lock = JSON.parse(readFileSync(this.lockFile, 'utf8')) as ShieldLock;
    } catch { /* unreadable: nothing to restore */ }
    if (!lock || (!lock.restore && !lock.shieldModeOn)) return;
    this.restore = lock.restore;
    this.shieldModeOn = !!lock.shieldModeOn;
    this.ctx.state.replace('shield', { ...this.state, status: 'active', reason: lock.reason, activatedAt: lock.activatedAt, releaseAt: lock.releaseAt });
    // Twitch needs a moment to connect after start; a failed release retries on its own.
    if (lock.releaseAt !== null) this.scheduleRelease(Math.max(5000, lock.releaseAt - this.now()));
  }

  private scheduleRelease(ms: number): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => void this.release(), ms);
  }

  private saveKnown(): void {
    if (!this.knownDirty) return;
    this.knownDirty = false;
    try {
      let ids = [...this.known];
      if (ids.length > KNOWN_MAX) {
        ids = ids.slice(-KNOWN_MAX);
        this.known.clear();
        for (const id of ids) this.known.add(id);
      }
      mkdirSync(dirname(this.knownFile), { recursive: true });
      writeFileSync(this.knownFile + '.tmp', JSON.stringify(ids), 'utf8');
      renameSync(this.knownFile + '.tmp', this.knownFile);
    } catch (err) {
      console.warn('[shield] save known chatters failed', errorMessage(err));
    }
  }

  private syncStatus(): void {
    if (this.state.status === 'active') return;
    this.ctx.state.patch('shield', { status: this.cfg.enabled ? 'watching' : 'off' });
  }

  private onChat(m: ChatMessage): void {
    if (m.fromSelf || m.platform !== 'twitch') return;
    // Everyone who talks becomes "known", even with the shield off: the history is what makes it accurate.
    const exempt = m.roles.broadcaster || m.roles.moderator || hasPermission(m.roles, this.cfg.exempt);
    if (exempt || !this.cfg.enabled) {
      if (!this.known.has(m.userId)) { this.known.add(m.userId); this.knownDirty = true; }
      return;
    }
    // Commands ("!join", "!clip") and emotes are what a whole chat types at once: not copy-paste spam.
    const prefix = this.ctx.settings.get('bot').prefix;
    const trimmed = m.text.trim();
    const command = trimmed.startsWith('!') || (!!prefix && trimmed.startsWith(prefix));
    const keyText = command ? '' : m.fragments.length ? m.fragments.filter((f) => f.type === 'text').map((f) => f.text).join(' ') : m.text;
    if (this.detector.push({ messageId: m.id, userId: m.userId, userName: m.userName, text: m.text, keyText, at: m.timestamp || this.now() })) this.knownDirty = true;
  }

  private async lookupAges(): Promise<void> {
    if (!this.cfg.enabled || this.cfg.youngDays <= 0 || this.agesBusy) return;
    const ids = this.detector.freshIds().slice(0, 100);
    if (!ids.length) return;
    this.agesBusy = true;
    try {
      const ages = await this.deps.accountAges(ids);
      for (const id of ids) this.detector.setAccountCreated(id, ages.get(id) ?? 0);
    } catch { /* Twitch offline: age stays unknown */ } finally {
      this.agesBusy = false;
    }
  }

  private check(): void {
    const cfg = this.cfg;
    if (!cfg.enabled) return;
    const now = this.now();
    const v = this.detector.evaluate(now, cfg, this.graceUntil, this.knownAtStart >= LEARNED_CHATTERS || now - this.startedAt >= LEARN_MS);
    const r = this.state.readings;
    if (r.newChatters !== v.readings.newChatters || r.similar !== v.readings.similar || r.young !== v.readings.young) this.ctx.state.patch('shield', { readings: v.readings });
    if (!v.reason) return;
    const suspects = v.suspects.map((e) => ({ userId: e.userId, userName: e.userName, text: e.text, at: e.at, messageId: e.messageId }));
    if (this.state.status === 'active') {
      // Still raging: keep cleaning up.
      void this.punish(suspects);
      return;
    }
    void this.activate(this.reasonText(v.reason, v.readings), suspects, false);
  }

  private reasonText(reason: NonNullable<Verdict['reason']>, r: Readings): string {
    const ru = this.ru;
    switch (reason) {
      case 'similar': return ru ? `${r.similar} аккаунтов пишут одно и то же` : `${r.similar} accounts posting the same text`;
      case 'young': return ru ? `${r.young} новых аккаунтов младше ${this.cfg.youngDays} дн.` : `${r.young} accounts younger than ${this.cfg.youngDays} days`;
      case 'newChatters': return ru ? `${r.newChatters} незнакомых зрителей за ${this.cfg.windowSec} с` : `${r.newChatters} unknown chatters in ${this.cfg.windowSec}s`;
    }
  }

  /** Lock the chat. `manual` = the streamer's panic button. */
  async activate(reason = '', suspects: (ShieldSuspect & { messageId?: string })[] = [], manual = true): Promise<void> {
    if (this.state.status === 'active' || this.activating) return;
    this.activating = true;
    this.handled.clear();
    this.timedOut.clear();
    const cfg = this.cfg;
    const errors: string[] = [];
    const now = this.now();
    try {
      const before = await this.deps.getChatSettings().catch((err) => { errors.push(errorMessage(err)); return null; });
      const patch: Partial<ChatModesLike> = {};
      const restore: Partial<ChatModesLike> = {};
      if (cfg.followersOnly && before && (!before.followerMode || before.followerMinutes < cfg.followersMinutes)) {
        Object.assign(patch, { followerMode: true, followerMinutes: cfg.followersMinutes });
        Object.assign(restore, { followerMode: before.followerMode, followerMinutes: before.followerMinutes });
      }
      if (cfg.slowMode && before && (!before.slowMode || before.slowSec < cfg.slowSec)) {
        Object.assign(patch, { slowMode: true, slowSec: cfg.slowSec });
        Object.assign(restore, { slowMode: before.slowMode, slowSec: before.slowSec });
      }
      if (cfg.emoteOnly && before && !before.emoteMode) { patch.emoteMode = true; restore.emoteMode = false; }
      if (Object.keys(patch).length) {
        try { await this.deps.updateChatSettings(patch); this.restore = restore; }
        catch (err) { errors.push(this.permissionText(err)); }
      }
      if (cfg.shieldMode) {
        try { await this.deps.setShieldMode(true); this.shieldModeOn = true; }
        catch (err) { errors.push(this.permissionText(err)); }
      }
      const releaseAt = cfg.autoReleaseMin > 0 ? now + cfg.autoReleaseMin * 60_000 : null;
      const text = reason || (this.ru ? 'включено вручную' : 'turned on by hand');
      this.ctx.state.replace('shield', {
        ...this.state, status: 'active', reason: text, activatedAt: now, releaseAt, suspects: [],
        history: [{ at: now, reason: text, suspects: new Set(suspects.map((s) => s.userId)).size, manual }, ...this.state.history].slice(0, 20),
        error: errors.length ? [...new Set(errors)].join(' ') : null,
      });
      this.saveLock();
      if (releaseAt) this.scheduleRelease(releaseAt - now);
      this.ctx.toast('error', 'toast.shieldOn', { reason: text });
      if (cfg.announce.trim()) void this.deps.say(cfg.announce).catch(() => undefined);
      if (!manual) await this.punish(suspects);
    } finally {
      this.activating = false;
    }
  }

  private permissionText(err: unknown): string {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403 || /scope/i.test(errorMessage(err))) return this.ru ? 'Нет прав на настройки чата. Переподключите Twitch в «Подключениях».' : 'No permission to change chat settings. Reconnect Twitch in Connections.';
    return errorMessage(err);
  }

  /** Delete the spam and time out its authors (if set up). Each message and chatter is handled once per lockdown. */
  private async punish(suspects: (ShieldSuspect & { messageId?: string })[]): Promise<void> {
    const key = (s: ShieldSuspect & { messageId?: string }) => s.messageId || `${s.userId}:${s.at}`;
    suspects = suspects.filter((s) => !this.handled.has(key(s)));
    if (!suspects.length) return;
    for (const s of suspects) this.handled.add(key(s));
    const cfg = this.cfg;
    this.ctx.state.patch('shield', { suspects: [...suspects.map(({ userId, userName, text, at }) => ({ userId, userName, text, at })), ...this.state.suspects].slice(0, 100) });
    const timedOut = this.timedOut;
    for (const s of suspects) {
      if (cfg.deleteMessages && s.messageId) await this.deps.deleteMessage(s.messageId).catch(() => undefined);
      if (cfg.timeoutSec > 0 && !timedOut.has(s.userId)) {
        timedOut.add(s.userId);
        await this.deps.timeout(s.userId, cfg.timeoutSec, 'StreamHelper: raid shield').catch(() => undefined);
      }
    }
  }

  /**
   * Unlock: put back exactly the chat settings we changed. If Twitch refuses (offline, the app has
   * just started), the shield stays on, keeps what to restore and tries again a little later.
   */
  async release(): Promise<boolean> {
    if (this.state.status !== 'active') return true;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    const errors: string[] = [];
    if (this.restore && Object.keys(this.restore).length) {
      try { await this.deps.updateChatSettings(this.restore); this.restore = null; }
      catch (err) { errors.push(this.permissionText(err)); }
    } else this.restore = null;
    if (this.shieldModeOn) {
      try { await this.deps.setShieldMode(false); this.shieldModeOn = false; }
      catch (err) { errors.push(this.permissionText(err)); }
    }
    this.saveLock();
    if (errors.length) {
      const error = [...new Set(errors)].join(' ');
      this.ctx.state.replace('shield', { ...this.state, error });
      if (!this.disposed) {
        this.ctx.toast('error', 'toast.actionError', { error });
        this.scheduleRelease(RELEASE_RETRY_MS);
      }
      return false;
    }
    this.handled.clear();
    this.timedOut.clear();
    this.ctx.state.replace('shield', { ...this.state, status: this.cfg.enabled ? 'watching' : 'off', releaseAt: null, error: null });
    if (!this.disposed) this.ctx.toast('success', 'toast.shieldOff');
    return true;
  }

  /** The chat is locked by us and quitting should unlock it first. */
  get needsShutdown(): boolean {
    return this.state.status === 'active' && (!!this.restore || this.shieldModeOn);
  }

  /** Before quitting: unlock the chat. Whatever fails stays in the lock file for the next start. */
  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.needsShutdown) await this.release();
  }

  async toggle(): Promise<void> {
    if (this.state.status === 'active') await this.release();
    else await this.activate();
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.knownDirty = true;
    this.saveKnown();
  }
}
