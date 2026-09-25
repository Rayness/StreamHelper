import type { RuntimeState } from '@shared/types';
import type { EventBus } from './eventBus';

export function initialRuntimeState(): RuntimeState {
  const disconnected = { status: 'disconnected' as const };
  return {
    twitch: { ...disconnected },
    twitchBot: { ...disconnected },
    donationalerts: { ...disconnected },
    streamlabs: { ...disconnected },
    obs: { ...disconnected, scenes: [], currentScene: '', sceneItems: [], inputs: [], streaming: false, recording: false },
    stream: { live: false, title: '', categoryId: '', categoryName: '', tags: [], viewers: 0, startedAt: null },
    alerts: { paused: false, queueLength: 0, current: null },
    overlayUrl: '',
    overlayClients: 0,
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
