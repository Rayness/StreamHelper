import { eventVars } from '@shared/events';
import { formatDuration, renderTemplate, renderTemplateAsync } from '@shared/template';
import type { BotCommand, BotTimer, BuiltinCommand, ChatMessage, StreamEvent } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';
import { resolveStreamVar } from '../features/vars';
import type { ChatPlatform, PlatformRegistry } from '../platforms/types';
import { Cooldowns } from './cooldowns';
import { Moderator, type Violation } from './moderation';
import { hasPermission } from './permissions';
import { botText, type BotTextKey } from './texts';
import { normalizeLogin, parseCommand, randomValue } from './variables';

export interface StreamControl {
  updateStream(patch: { title?: string; categoryId?: string }): Promise<void>;
  findCategory(name: string): Promise<{ id: string; name: string } | null>;
}

const TIMER_TICK_MS = 30_000;
const WARNING_COOLDOWN_MS = 30_000;

export class BotService {
  private cooldowns = new Cooldowns();
  private moderator = new Moderator();
  private timerState = new Map<string, { lastAt: number; lines: number; index: number }>();
  private tickTimer: NodeJS.Timeout | null = null;
  private lastWarning = new Map<string, number>();
  private disposers: (() => void)[] = [];

  constructor(
    private ctx: AppContext,
    private platforms: PlatformRegistry,
    private stream: StreamControl,
  ) {}

  private get s() {
    return this.ctx.settings.get('bot');
  }

  private get lang() {
    return this.ctx.settings.get('language');
  }

  start(): void {
    this.disposers.push(
      this.ctx.bus.on('chat:message', (m) => void this.onMessage(m).catch((err) => console.error('[bot]', err))),
      this.ctx.bus.on('event', (e) => void this.onEvent(e).catch((err) => console.error('[bot] event message', err))),
    );
    this.tickTimer = setInterval(() => this.tickTimers(), TIMER_TICK_MS);
  }

  stop(): void {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  // ---------- chat ----------

  async onMessage(msg: ChatMessage): Promise<void> {
    if (msg.fromSelf) return;
    for (const st of this.timerState.values()) st.lines++;
    if (!this.s.enabled) return;
    const platform = this.platforms.get(msg.platform);
    if (!platform) return;

    const violation = this.moderator.check(msg, this.s.moderation);
    if (violation) {
      await this.enforce(platform, msg, violation);
      return;
    }

    const parsed = parseCommand(msg.text, this.s.prefix);
    if (!parsed) return;
    const builtin = this.s.builtins.find((b) => b.enabled && b.trigger.toLowerCase() === parsed.name);
    if (builtin) {
      if (!hasPermission(msg.roles, builtin.permission)) return;
      if (!this.cooldowns.ready(`builtin:${builtin.id}`, msg.userId, 5, 0)) return;
      this.cooldowns.start(`builtin:${builtin.id}`, msg.userId, 5, 0);
      await this.runBuiltin(builtin, parsed.args, msg, platform);
      return;
    }
    const cmd = this.findCommand(parsed.name);
    if (!cmd || !hasPermission(msg.roles, cmd.permission)) return;
    // Moderators skip cooldowns so they can demo commands.
    const bypass = hasPermission(msg.roles, 'moderator');
    if (!bypass && !this.cooldowns.ready(cmd.id, msg.userId, cmd.cooldownSec, cmd.userCooldownSec)) return;
    this.cooldowns.start(cmd.id, msg.userId, cmd.cooldownSec, cmd.userCooldownSec);
    const text = await this.render(cmd.response, msg, parsed.args, platform);
    if (text.trim()) await platform.sendMessage(text, cmd.reply ? msg.id : undefined);
  }

  findCommand(name: string): BotCommand | undefined {
    const n = name.toLowerCase();
    return this.s.commands.find((c) => c.enabled && (c.trigger.toLowerCase() === n || c.aliases.some((a) => a.toLowerCase() === n)));
  }

  private async enforce(platform: ChatPlatform, msg: ChatMessage, v: Violation): Promise<void> {
    try {
      if (v.action === 'delete') await platform.deleteMessage(msg.id);
      else if (v.action === 'timeout') await platform.timeout(msg.userId, v.timeoutSec, `StreamHelper: ${v.filter}`);
      else if (v.action === 'ban') await platform.ban(msg.userId, `StreamHelper: ${v.filter}`);
    } catch (err) {
      console.warn('[bot] moderation action failed', errorMessage(err));
    }
    const last = this.lastWarning.get(v.filter) ?? 0;
    if (v.warning.trim() && Date.now() - last > WARNING_COOLDOWN_MS) {
      this.lastWarning.set(v.filter, Date.now());
      await platform.sendMessage(renderTemplate(v.warning, { user: msg.userName })).catch(() => undefined);
    }
  }

  /** Render a command response with all bot variables. */
  async render(template: string, msg: ChatMessage, args: string[], platform: ChatPlatform): Promise<string> {
    const st = this.ctx.state.current.stream;
    const lang = this.lang;
    return renderTemplateAsync(template, async (name, arg) => {
      switch (name) {
        case 'user':
          return msg.userName;
        case 'touser':
          return normalizeLogin(args[0]) || msg.userName;
        case 'args':
          return args.join(' ');
        case 'arg':
          return args[Number(arg) - 1] ?? '';
        case 'channel':
          return this.ctx.state.current.twitch.account?.displayName ?? '';
        case 'uptime':
          return st.live && st.startedAt ? formatDuration(Date.now() - st.startedAt, lang) : botText(lang, 'offline');
        case 'title':
          return st.title;
        case 'game':
          return st.categoryName;
        case 'viewers':
          return st.viewers;
        case 'time':
          return new Date().toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' });
        case 'random':
          return randomValue(arg);
        case 'count':
          return arg ? (this.s.counters[arg] ?? 0) : undefined;
        case 'count+':
          return arg ? this.addCounter(arg, 1) : undefined;
        case 'count-':
          return arg ? this.addCounter(arg, -1) : undefined;
        case 'followage': {
          const at = await platform.getFollowedAt(msg.userId).catch(() => null);
          return at ? formatDuration(Date.now() - at, lang) : '—';
        }
        default:
          // Stats ({lastfollower}, {topdonation}...) and Kawaki ({anime}, {animeurl}) are shared with overlays.
          return resolveStreamVar(name, arg, this.ctx.settings.all, this.ctx.state.current);
      }
    });
  }

  addCounter(name: string, delta: number): number {
    return this.setCounter(name, (this.s.counters[name] ?? 0) + delta);
  }

  setCounter(name: string, value: number): number {
    this.ctx.settings.update('bot', (b) => ({ ...b, counters: { ...b.counters, [name]: value } }));
    return value;
  }

  private async runBuiltin(b: BuiltinCommand, args: string[], msg: ChatMessage, platform: ChatPlatform): Promise<void> {
    const lang = this.lang;
    const say = (key: BotTextKey, vars: Record<string, string | number> = {}) => platform.sendMessage(botText(lang, key, vars));
    const st = this.ctx.state.current.stream;
    const isMod = hasPermission(msg.roles, 'moderator');
    try {
      switch (b.id) {
        case 'uptime':
          return st.live && st.startedAt ? say('uptime', { uptime: formatDuration(Date.now() - st.startedAt, lang) }) : say('offline');
        case 'followage': {
          if (msg.roles.broadcaster) return;
          const at = await platform.getFollowedAt(msg.userId);
          return at ? say('followage', { user: msg.userName, duration: formatDuration(Date.now() - at, lang) }) : say('notFollowing', { user: msg.userName });
        }
        case 'commands': {
          const p = this.s.prefix;
          const list = this.s.commands
            .filter((c) => c.enabled && c.permission === 'everyone')
            .map((c) => p + c.trigger)
            .concat(this.s.builtins.filter((x) => x.enabled && x.permission === 'everyone' && x.id !== 'commands').map((x) => p + x.trigger));
          return say('commands', { list: list.join(', ') });
        }
        case 'title': {
          const title = args.join(' ').trim();
          if (!title || !isMod) return say('title', { title: st.title });
          await this.stream.updateStream({ title });
          return say('titleSet', { title });
        }
        case 'game': {
          const query = args.join(' ').trim();
          if (!query || !isMod) return say('game', { game: st.categoryName });
          const cat = await this.stream.findCategory(query);
          if (!cat) return say('gameNotFound', { query });
          await this.stream.updateStream({ categoryId: cat.id });
          return say('gameSet', { game: cat.name });
        }
        case 'shoutout': {
          const login = normalizeLogin(args[0]);
          if (!login) return;
          const so = await platform.shoutout(login);
          if (!so) return say('userNotFound', { login });
          return say(so.category ? 'shoutout' : 'shoutoutNoGame', { name: so.displayName, login: login.toLowerCase(), game: so.category });
        }
        case 'counter': {
          const [name, op] = args;
          if (!name) return;
          let value = this.s.counters[name] ?? 0;
          const m = op ? /^([+=-])?(\d+)$/.exec(op) : null;
          if (m) {
            const n = Number(m[2]);
            value = this.setCounter(name, m[1] === '+' ? value + n : m[1] === '-' ? value - n : n);
          } else if (op === '++' || op === '+') value = this.addCounter(name, 1);
          else if (op === '--' || op === '-') value = this.addCounter(name, -1);
          return say('counter', { name, value });
        }
        case 'anime': {
          const now = this.ctx.state.current.kawaki.nowWatching;
          if (!now) return say('animeNone');
          const s = this.ctx.settings.all;
          return platform.sendMessage(renderTemplate(s.kawaki.commandTemplate, (name, arg) => resolveStreamVar(name, arg, s, this.ctx.state.current)));
        }
        case 'permit': {
          const login = normalizeLogin(args[0]);
          if (!login) return;
          const sec = this.s.moderation.permitSec;
          this.moderator.permit(login, sec);
          return say('permit', { login, sec });
        }
      }
    } catch (err) {
      await say('failed', { error: errorMessage(err) }).catch(() => undefined);
    }
  }

  // ---------- timers ----------

  private tickTimers(): void {
    if (!this.s.enabled) return;
    const now = Date.now();
    const live = this.ctx.state.current.stream.live;
    const known = new Set<string>();
    for (const t of this.s.timers) {
      known.add(t.id);
      let st = this.timerState.get(t.id);
      if (!st) this.timerState.set(t.id, (st = { lastAt: now, lines: 0, index: 0 }));
      if (!this.timerDue(t, st, now, live)) continue;
      const text = t.messages[st.index % t.messages.length];
      st.index++;
      st.lastAt = now;
      st.lines = 0;
      for (const p of this.platforms.ready()) void p.sendMessage(text).catch((err) => console.warn('[bot] timer send', errorMessage(err)));
    }
    for (const id of this.timerState.keys()) if (!known.has(id)) this.timerState.delete(id);
  }

  private timerDue(t: BotTimer, st: { lastAt: number; lines: number }, now: number, live: boolean): boolean {
    if (!t.enabled || t.messages.length === 0) return false;
    if (t.onlyWhenLive && !live) return false;
    return now - st.lastAt >= Math.max(1, t.intervalMin) * 60_000 && st.lines >= t.minChatLines;
  }

  // ---------- event messages ----------

  private async onEvent(e: StreamEvent): Promise<void> {
    if (!this.s.enabled || e.source === 'test') return;
    const template = this.s.eventMessages[e.type];
    if (!template?.trim()) return;
    const text = renderTemplate(template, eventVars(e));
    for (const p of this.platforms.ready()) await p.sendMessage(text).catch((err) => console.warn('[bot] event send', errorMessage(err)));
  }
}
