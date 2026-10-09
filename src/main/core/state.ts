import type { RuntimeState } from '@shared/types';
import { emptyReportSummary } from '@shared/report';
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
    subForStream: { ...disconnected, overlayUrl: '' },
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
    music: { status: 'connecting', track: null, sources: [] },
    songRequests: { queue: [], current: null, paused: false, obsAudio: null, playerConnected: false, lastError: null },
    update: { status: 'idle', version: null, progress: 0, error: null },
    dockUrl: '',
    bannersShown: [],
    viewerQueue: { open: false, entries: [], picked: [] },
    guess: { status: 'idle', min: 1, max: 100, low: 1, high: 100, attempts: 0, endsAt: null, winner: null, answer: null, lastGuess: null },
    hype: { points: 0, level: 0, progress: 0, lastBumpAt: 0 },
    chatLeaders: [],
    clipper: { moments: [], rate: 0, baseline: 0, busy: false, lastError: null },
    curse: { status: 'idle', options: [], total: 0, endsAt: null, active: null, lastError: null },
    duel: { status: 'idle', a: null, b: null, endsAt: null, winner: null, error: null },
    melody: { status: 'idle', round: 0, rounds: 0, endsAt: null, playId: null, videoId: null, startFraction: 0.3, snippetSec: 8, hint: '', answer: null, winner: null, leaderboard: [], error: null },
    ducking: { listening: false, ducked: false, levelDb: -100, reason: null, error: null },
    market: { quotes: [], richest: [], traders: 0, lastTrade: null },
    portal: { status: 'disconnected', channel: '', messages: [] },
    report: { live: emptyReportSummary(Date.now()), reports: [], busy: false },
    shield: { status: 'off', readings: { newChatters: 0, similar: 0, young: 0 }, reason: null, activatedAt: null, releaseAt: null, suspects: [], history: [], error: null },
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
    if (Object.is(prev, next) || (prev && next && typeof prev === 'object' && !Array.isArray(prev) &&
      Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([k, v]) => Object.is((prev as Record<string, unknown>)[k], v)))) return;
    this.state = { ...this.state, [key]: next };
    this.bus.emit('state:dirty');
  }

  replace<K extends keyof RuntimeState>(key: K, value: RuntimeState[K]): void {
    if (Object.is(this.state[key], value)) return;
    this.state = { ...this.state, [key]: value };
    this.bus.emit('state:dirty');
  }
}
