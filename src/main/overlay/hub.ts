import type { ChatMessage, ChatOverlaySettings, OverlayKind, OverlayMessage, Settings } from '@shared/types';
import type { AppContext } from '../core/context';
import type { AlertQueue } from '../features/alerts';
import type { ChatHistory } from '../features/chatHistory';
import type { OverlayServer } from './server';

/** Whether a chat message belongs in the on-stream chat overlay. */
export function showInChatOverlay(m: ChatMessage, cfg: ChatOverlaySettings, prefix: string): boolean {
  if (cfg.hideCommands && prefix && m.text.trim().startsWith(prefix)) return false;
  const hidden = cfg.hideBots.map((b) => b.trim().toLowerCase()).filter(Boolean);
  return !hidden.includes(m.userLogin.toLowerCase());
}

/** Wires bus events and settings changes to connected overlays. */
export class OverlayHub {
  constructor(
    private ctx: AppContext,
    server: OverlayServer,
    private chat: ChatHistory,
    private alerts: () => AlertQueue,
  ) {
    const { bus } = ctx;
    bus.on('chat:message', (message) => {
      if (showInChatOverlay(message, this.settings.chatOverlay, this.settings.bot.prefix)) server.broadcast('chat', { type: 'chat', message });
    });
    bus.on('chat:delete', ({ id }) => server.broadcast('chat', { type: 'chatDelete', id }));
    bus.on('chat:clearUser', ({ userId }) => server.broadcast('chat', { type: 'chatClearUser', userId }));
    bus.on('chat:clear', () => server.broadcast('chat', { type: 'chatClear' }));
    bus.on('event', (event) => server.broadcast('events', { type: 'event', event }));
    bus.on('settings:changed', (key) => {
      if (key === 'chatOverlay') server.broadcast('chat', { type: 'chatConfig', config: this.settings.chatOverlay });
      if (key === 'goals') server.forEachClient('goal', (id) => this.goalMessage(id));
      if (key === 'timers') server.forEachClient('timer', (id) => this.timerMessage(id));
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
        return [{ type: 'events', events: this.alerts().recentEvents.slice(0, 20) }];
      case 'alerts':
        return [];
    }
  }
}
