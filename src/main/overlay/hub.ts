import type { ChatMessage, ChatOverlaySettings, OverlayKind, OverlayMessage, Settings } from '@shared/types';
import { ALL_OVERLAY_KINDS } from '@shared/profiles';
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
  song: () => OverlayMessage;
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
    bus.on('event', (event) => {
      server.broadcast('events', { type: 'event', event });
      if (event.type === 'redemption') server.broadcast('rewards', { type: 'reward', event });
      if (event.type === 'raid') server.broadcast('collab', { type: 'collabRaid', event });
    });
    bus.on('stream:update', (stream) => server.broadcast('live', { type: 'live', stream, lang: this.settings.language }));
    bus.on('kawaki:now', () => server.broadcast('kawaki', this.kawakiMessage()));
    bus.on('music:changed', () => server.broadcast('music', this.musicMessage()));
    bus.on('settings:changed', (key) => {
      if (key === 'profiles' || key === 'activeProfileId') {
        const enabled = this.settings.profiles.find((p) => p.id === this.settings.activeProfileId)?.overlays;
        for (const kind of ALL_OVERLAY_KINDS) server.broadcast(kind, { type: 'profileVisibility', visible: enabled ? enabled.includes(kind) : true });
      }
      if (key === 'chatOverlay') server.broadcast('chat', { type: 'chatConfig', config: this.settings.chatOverlay });
      if (key === 'spotlightOverlay') server.broadcast('spotlight', { type: 'spotlightConfig', config: this.settings.spotlightOverlay });
      if (key === 'rewardsOverlay') server.broadcast('rewards', this.rewardsMessage());
      if (key === 'collabOverlay') server.broadcast('collab', this.collabMessage());
      if (key === 'musicOverlay') server.broadcast('music', this.musicMessage());
      if (key === 'songRequests' || key === 'songQueue') server.broadcast('song', this.sources.song());
      if (key === 'goals') server.forEachClient('goal', (id) => this.goalMessage(id));
      if (key === 'timers') server.forEachClient('timer', (id) => this.timerMessage(id));
      if (key === 'wheels') server.forEachClient('wheel', (id) => this.wheelMessage(id));
      if (key === 'emoteRain') server.broadcast('emotes', { type: 'emoteConfig', config: this.settings.emoteRain });
      if (key === 'kawaki') server.broadcast('kawaki', this.kawakiMessage());
      if (key === 'ads') server.forEachClient('ad', (id) => this.sources.ad(id));
      if (key === 'language') {
        server.broadcast('live', { type: 'live', stream: this.ctx.state.current.stream, lang: this.settings.language });
        server.broadcast('collab', this.collabMessage());
        server.broadcast('music', this.musicMessage());
        server.broadcast('song', this.sources.song());
      }
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

  private rewardsMessage(): OverlayMessage {
    return {
      type: 'rewards',
      config: this.settings.rewardsOverlay,
      events: this.sources.alerts().recentEvents.filter((event) => event.type === 'redemption').slice(0, 20),
    };
  }

  private collabMessage(): OverlayMessage {
    return {
      type: 'collab',
      config: this.settings.collabOverlay,
      raids: this.sources.alerts().recentEvents.filter((event) => event.type === 'raid').slice(0, 5),
      lang: this.settings.language,
    };
  }

  private musicMessage(): OverlayMessage {
    return { type: 'music', track: this.ctx.state.current.music.track, config: this.settings.musicOverlay, lang: this.settings.language };
  }

  initialMessages(kind: OverlayKind, id: string | null): OverlayMessage[] {
    const enabled = this.settings.profiles.find((p) => p.id === this.settings.activeProfileId)?.overlays;
    return [{ type: 'profileVisibility', visible: enabled ? enabled.includes(kind) : true }, ...this.kindMessages(kind, id)];
  }

  private kindMessages(kind: OverlayKind, id: string | null): OverlayMessage[] {
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
      case 'rewards':
        return [this.rewardsMessage()];
      case 'collab':
        return [this.collabMessage()];
      case 'music':
        return [this.musicMessage()];
      case 'song':
        return [this.sources.song()];
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
        return [{ type: 'spotlightConfig', config: this.settings.spotlightOverlay }, this.sources.spotlight()];
      case 'live':
        return [{ type: 'live', stream: this.ctx.state.current.stream, lang: this.settings.language }];
      case 'kawaki':
        return [this.kawakiMessage()];
    }
  }
}
