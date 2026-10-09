import type { DuckingSettings } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';

/** What ducking needs from OBS. */
export interface DuckingObs {
  readonly connected: boolean;
  onVolumeMeters(listener: (levels: Map<string, number>) => void): () => void;
  getVolume(input: string): Promise<number>;
  setVolume(input: string, multiplier: number): Promise<void>;
}

/**
 * Voice detector with attack and release: the voice must last `attackMs` to count (no ducking on
 * a keyboard click), and the music returns only after `releaseMs` of silence (no pumping between words).
 */
export class Ducker {
  private aboveSince: number | null = null;
  private lastVoiceAt = -Infinity;
  voice = false;

  update(levelDb: number, now: number, cfg: Pick<DuckingSettings, 'thresholdDb' | 'attackMs' | 'releaseMs'>): boolean {
    if (levelDb >= cfg.thresholdDb) {
      this.aboveSince ??= now;
      if (now - this.aboveSince >= Math.max(0, cfg.attackMs)) {
        this.voice = true;
        this.lastVoiceAt = now;
      }
    } else {
      this.aboveSince = null;
      if (this.voice && now - this.lastVoiceAt >= Math.max(0, cfg.releaseMs)) this.voice = false;
    }
    return this.voice;
  }

  reset(): void {
    this.aboveSince = null;
    this.lastVoiceAt = -Infinity;
    this.voice = false;
  }
}

const FADE_STEP_MS = 40;
const LEVEL_PUSH_MS = 200;

/**
 * Turns chosen OBS inputs (music, song requests) down while the streamer talks, then back up.
 * The original volume of every input is remembered and restored, also after an OBS reconnect.
 */
export class DuckingService {
  private ducker = new Ducker();
  private unsubscribe: (() => void) | null = null;
  /** Normal volume of every input we turned down. */
  private originals = new Map<string, number>();
  private ducked = false;
  private fadeGeneration = 0;
  private lastLevelPush = 0;
  private lastLevel = -100;
  private applying: Promise<void> = Promise.resolve();
  /** Quitting: no more fades, the original volumes are back. */
  private stopped = false;

  constructor(private ctx: AppContext, private obs: DuckingObs, private now: () => number = Date.now) {
    ctx.bus.on('settings:changed', (key) => { if (key === 'ducking') this.sync(); });
    // React to OBS connecting / disconnecting (state:dirty is frequent: only act on a change).
    let wasConnected = this.obs.connected;
    ctx.bus.on('state:dirty', () => {
      if (this.obs.connected === wasConnected) return;
      wasConnected = this.obs.connected;
      if (!wasConnected && this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
        this.ducker.reset();
        this.ducked = false;
        this.ctx.state.patch('ducking', { listening: false, ducked: false, reason: null, levelDb: -100 });
      }
      this.sync();
    });
  }

  private get cfg(): DuckingSettings {
    return this.ctx.settings.get('ducking');
  }

  start(): void {
    this.sync();
  }

  /** Subscribe to OBS audio levels only while ducking is on and OBS is there. */
  private sync(): void {
    const cfg = this.cfg;
    const want = cfg.enabled && !!cfg.micInput && cfg.targets.length > 0 && this.obs.connected;
    if (want && !this.unsubscribe) {
      this.unsubscribe = this.obs.onVolumeMeters((levels) => this.onLevels(levels));
      this.ctx.state.patch('ducking', { listening: true, error: null });
      // Volumes left lowered by a dropped connection come back first.
      if (this.originals.size && !this.ducked) this.queue(() => this.fadeTo(false));
    } else if (!want && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      this.ducker.reset();
      if (this.obs.connected) this.queue(() => this.fadeTo(false));
      this.ducked = false;
      this.ctx.state.patch('ducking', { listening: false, ducked: false, reason: null, levelDb: -100 });
    } else if (want) {
      // Inputs removed from the list get their volume back.
      for (const input of [...this.originals.keys()]) {
        if (!cfg.targets.includes(input)) {
          const volume = this.originals.get(input)!;
          this.originals.delete(input);
          void this.obs.setVolume(input, volume).catch(() => undefined);
        }
      }
    }
  }

  private onLevels(levels: Map<string, number>): void {
    const cfg = this.cfg;
    const now = this.now();
    const level = levels.get(cfg.micInput) ?? -100;
    const voice = this.ducker.update(level, now, cfg);
    const alert = cfg.duckOnAlerts && !!this.ctx.state.current.alerts.current;
    const duck = voice || alert;
    if (duck !== this.ducked) {
      this.ducked = duck;
      this.ctx.state.patch('ducking', { ducked: duck, reason: voice ? 'voice' : alert ? 'alert' : null });
      this.queue(() => this.fadeTo(duck));
    }
    // The meter in the UI: a few updates a second is plenty, and none when nobody looks.
    if (now - this.lastLevelPush >= LEVEL_PUSH_MS && Math.abs(level - this.lastLevel) >= 1 && (this.ctx.isUiVisible?.() ?? true)) {
      this.lastLevelPush = now;
      this.lastLevel = level;
      this.ctx.state.patch('ducking', { levelDb: Math.round(Math.max(-100, level)) });
    }
  }

  private queue(job: () => Promise<void>): void {
    this.applying = this.applying.then(job).catch((err) => this.ctx.state.patch('ducking', { error: errorMessage(err) }));
  }

  private async fadeTo(down: boolean): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.fadeGeneration;
    const cfg = this.cfg;
    const targets = down ? cfg.targets : [...this.originals.keys()];
    const plan: { input: string; from: number; to: number }[] = [];
    for (const input of targets) {
      try {
        const current = await this.obs.getVolume(input);
        if (down && !this.originals.has(input)) this.originals.set(input, current);
        const normal = this.originals.get(input) ?? current;
        plan.push({ input, from: current, to: down ? normal * Math.max(0, Math.min(100, cfg.duckPercent)) / 100 : normal });
      } catch (err) {
        this.ctx.state.patch('ducking', { error: `${input}: ${errorMessage(err)}` });
      }
    }
    const steps = Math.max(1, Math.round(Math.max(0, cfg.fadeMs) / FADE_STEP_MS));
    for (let i = 1; i <= steps; i++) {
      if (generation !== this.fadeGeneration) return;
      await Promise.all(plan.map((p) => this.obs.setVolume(p.input, p.from + ((p.to - p.from) * i) / steps).catch(() => undefined)));
      if (i < steps) await new Promise((r) => setTimeout(r, FADE_STEP_MS));
    }
    if (!down && generation === this.fadeGeneration) for (const p of plan) this.originals.delete(p.input);
  }

  /** Some inputs are turned down right now: quitting has to bring them back first. */
  get needsShutdown(): boolean {
    return this.originals.size > 0 && this.obs.connected;
  }

  /** Leave the mix as we found it, while OBS is still connected. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.fadeGeneration++;
    const restore = [...this.originals];
    this.originals.clear();
    await Promise.all(restore.map(([input, volume]) => this.obs.setVolume(input, volume).catch(() => undefined)));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
