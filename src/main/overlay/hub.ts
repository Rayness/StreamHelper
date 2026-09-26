import type { ChatMessage, ChatOverlaySettings, OverlayKind, OverlayMessage, Settings } from '@shared/types';
import type { AppContext } from '../core/context';
import type { AlertQueue } from '../features/alerts';
import type { TextOverlays } from '../features/banners';
import type { ChatHistory } from '../features/chatHistory';
import type { OverlayServer } from './server';

/** Whether a chat message belongs in the on-stream chat overlay. */
export function showInChatOverlay(m: ChatMessage, cfg: ChatOverlaySettings, prefix: string): boolean {
  if (cfg.hideCommands && prefix && m.text.trim().startsWith(prefix)) return false;
  const hidden = cfg.hideBots.map((b) => b.trim().toLowerCase()).filter(Boolean);
  return !hidden.includes(m.userLogin.toLowerCase());
}

/** Current state of the stateful features, for overlays that connect mid-stream. */
export interface HubSources {
  alerts: () => AlertQueue;
  text: () => TextOverlays;
  poll: () => OverlayMessage;
  giveaway: () => OverlayMessage;
  quiz: () => OverlayMessage;
  boss: () => OverlayMessage;
  ad: (id?: string | null) => OverlayMessage;
  spotlight: () => OverlayMessage;
}

/** Wires bus events and settings changes to connected overlays. */
export class OverlayHub {
  constructor(
    private ctx: AppContext,
    server: OverlayServer,
    private chat: ChatHistory,
    private sources: HubSources,
  ) {
    const { bus } = ctx;
    bus.on('chat:message', (message) => {
      if (showInChatOverlay(message, this.settings.chatOverlay, this.settings.bot.prefix)) server.broadcast('chat', { type: 'chat', message });
    });
    bus.on('chat:delete', ({ id }) => server.broadcast('chat', { type: 'chatDelete', id }));
    bus.on('chat:clearUser', ({ userId }) => server.broadcast('chat', { type: 'chatClearUser', userId }));
    bus.on('chat:clear', () => server.broadcast('chat', { type: 'chatClear' }));
    bus.on('event', (event) => server.broadcast('events', { type: 'event', event }));
    bus.on('stream:update', (stream) => server.broadcast('live', { type: 'live', stream, lang: this.settings.language }));
    bus.on('kawaki:now', () => server.broadcast('kawaki', this.kawakiMessage()));
    bus.on('settings:changed', (key) => {
      if (key === 'chatOverlay') server.broadcast('chat', { type: 'chatConfig', config: this.settings.chatOverlay });
      if (key === 'goals') server.forEachClient('goal', (id) => this.goalMessage(id));
      if (key === 'timers') server.forEachClient('timer', (id) => this.timerMessage(id));
      if (key === 'wheels') server.forEachClient('wheel', (id) => this.wheelMessage(id));
      if (key === 'emoteRain') server.broadcast('emotes', { type: 'emoteConfig', config: this.settings.emoteRain });
      if (key === 'kawaki') server.broadcast('kawaki', this.kawakiMessage());
      if (key === 'ads') server.forEachClient('ad', (id) => this.sources.ad(id));
      if (key === 'language') server.broadcast('live', { type: 'live', stream: this.ctx.state.current.stream, lang: this.settings.language });
    });
  }

  private get settings(): Settings {
    return this.ctx.settings.all;
  }

  private goalMessage(id: string | null): OverlayMessage {
    const goals = this.settings.goals;
    return { type: 'goal', goal: (id ? goals.find((g) => g.id === id) : goals[0]) ?? null };
  }

  private timerMessage(id: string | null): OverlayMessage {
    const timers = this.settings.timers;
    return { type: 'timer', timer: (id ? timers.find((t) => t.id === id) : timers[0]) ?? null, now: Date.now() };
  }

  private wheelMessage(id: string | null): OverlayMessage {
    const wheels = this.settings.wheels;
    const wheel = (id ? wheels.find((w) => w.id === id) : wheels[0]) ?? null;
    const last = this.ctx.state.current.wheel.lastResult;
    const lastWinnerId = wheel && last?.wheelId === wheel.id ? (wheel.segments.find((s) => s.label === last.label)?.id ?? null) : null;
    return { type: 'wheel', wheel, lastWinnerId };
  }

  private kawakiMessage(): OverlayMessage {
    return { type: 'kawaki', now: this.ctx.state.current.kawaki.nowWatching, style: this.settings.kawaki, lang: this.settings.language };
  }

  initialMessages(kind: OverlayKind, id: string | null): OverlayMessage[] {
    switch (kind) {
      case 'chat': {
        const cfg = this.settings.chatOverlay;
        const recent = this.chat
          .recent()
          .filter((m) => showInChatOverlay(m, cfg, this.settings.bot.prefix))
          .slice(-cfg.maxMessages);
        return [{ type: 'chatConfig', config: cfg }, ...recent.map((message): OverlayMessage => ({ type: 'chat', message }))];
      }
      case 'goal':
        return [this.goalMessage(id)];
      case 'timer':
        return [this.timerMessage(id)];
      case 'events':
        return [{ type: 'events', events: this.sources.alerts().recentEvents.slice(0, 20) }];
      case 'alerts':
        return [];
      case 'banner':
      case 'label':
        return [this.sources.text().initial(kind, id)];
      case 'emotes':
        return [{ type: 'emoteConfig', config: this.settings.emoteRain }];
      case 'wheel':
        return [this.wheelMessage(id)];
      case 'poll':
        return [this.sources.poll()];
      case 'giveaway':
        return [this.sources.giveaway()];
      case 'quiz':
        return [this.sources.quiz()];
      case 'boss':
        return [this.sources.boss()];
      case 'ad':
        return [this.sources.ad(id)];
      case 'spotlight':
        return [this.sources.spotlight()];
      case 'live':
        return [{ type: 'live', stream: this.ctx.state.current.stream, lang: this.settings.language }];
      case 'kawaki':
        return [this.kawakiMessage()];
    }
  }
}
