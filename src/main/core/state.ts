import type { RuntimeState } from '@shared/types';
import type { EventBus } from './eventBus';

export function initialRuntimeState(): RuntimeState {
  const disconnected = { status: 'disconnected' as const };
  return {
    twitch: { ...disconnected },
    kawaki: { ...disconnected, nowWatching: null, partner: null },
    twitchBot: { ...disconnected },
    donationalerts: { ...disconnected },
    streamlabs: { ...disconnected },
    streamelements: { ...disconnected },
    streamerbot: { ...disconnected, actions: [] },
    discord: { ...disconnected },
    obs: { ...disconnected, scenes: [], currentScene: '', sceneItems: [], inputs: [], streaming: false, recording: false },
    stream: { live: false, title: '', categoryId: '', categoryName: '', tags: [], viewers: 0, startedAt: null },
    alerts: { paused: false, queueLength: 0, current: null },
    overlayUrl: '',
    overlayClients: 0,
    overlayKinds: {},
    wheel: { spinning: false, wheelId: null, lastResult: null },
    poll: null,
    giveaway: { status: 'idle', entrants: [], winner: null, winnerMessages: [] },
    quiz: { status: 'idle', round: 0, rounds: 0, imageUrl: null, hint: '', endsAt: null, answer: null, winner: null, leaderboard: [] },
    boss: { status: 'idle', hp: 0, maxHp: 0, hits: 0, lastHit: null, top: [] },
    ad: { activeId: null, endsAt: null },
    spotlight: null,
    update: { status: 'idle', version: null, progress: 0, error: null },
    dockUrl: '',
    bannersShown: [],
  };
}

/** Single source of truth for connection/live state shown in the UI. */
export class StateHub {
  private state = initialRuntimeState();

  constructor(private bus: EventBus) {}

  get current(): RuntimeState {
    return this.state;
  }

  patch<K extends keyof RuntimeState>(key: K, value: Partial<RuntimeState[K]> | RuntimeState[K]): void {
    const prev = this.state[key];
    const next = typeof prev === 'object' && prev !== null && !Array.isArray(prev) ? { ...prev, ...(value as object) } : value;
    this.state = { ...this.state, [key]: next };
    this.bus.emit('state:dirty');
  }

  replace<K extends keyof RuntimeState>(key: K, value: RuntimeState[K]): void {
    this.state = { ...this.state, [key]: value };
    this.bus.emit('state:dirty');
  }
}
