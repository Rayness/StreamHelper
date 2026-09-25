import { renderTemplate } from '@shared/template';
import type { ChatMessage, StreamEvent, Wheel, WheelSegment, WheelSpin } from '@shared/types';
import { Cooldowns } from '../bot/cooldowns';
import { hasPermission } from '../bot/permissions';
import { parseCommand } from '../bot/variables';
import type { AppContext } from '../core/context';
import { pickWeighted, type StageDeps } from './stage';

/** Pause between queued spins so viewers can read the result. */
const QUEUE_GAP_MS = 2500;

/**
 * Final rotation (degrees, clockwise) that stops `winnerIndex` under the pointer at the top.
 * Segments are equal slices starting at the top and going clockwise; the stop point is jittered
 * inside the slice so the wheel doesn't always land dead centre.
 */
export function wheelRotation(segmentCount: number, winnerIndex: number, rand: () => number = Math.random, turns = 6): number {
  const size = 360 / segmentCount;
  const center = (winnerIndex + 0.5) * size;
  const jitter = (rand() - 0.5) * size * 0.7;
  const target = (((360 - (center + jitter)) % 360) + 360) % 360;
  return turns * 360 + target;
}

/** Which segment sits under the top pointer after rotating by `rotation` degrees. */
export function segmentAtPointer(segmentCount: number, rotation: number): number {
  const size = 360 / segmentCount;
  const a = (((360 - (rotation % 360)) % 360) + 360) % 360;
  return Math.min(segmentCount - 1, Math.floor(a / size));
}

export class WheelService {
  private queue: { wheelId: string; by: string }[] = [];
  private busyUntil = 0;
  private cooldowns = new Cooldowns();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private rand: () => number = Math.random,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('event', (e) => this.onEvent(e));
  }

  private wheels(): Wheel[] {
    return this.ctx.settings.get('wheels');
  }

  /** Queue a spin; spins run one after another. */
  spin(wheelId: string, by = ''): void {
    const wheel = this.wheels().find((w) => w.id === wheelId);
    if (!wheel) throw new Error('wheel not found');
    if (!wheel.segments.some((s) => s.weight > 0)) throw new Error('the wheel has no segments that can win');
    this.queue.push({ wheelId, by });
    this.next();
  }

  get spinning(): boolean {
    return Date.now() < this.busyUntil;
  }

  private next(): void {
    if (this.timer || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const wheel = this.wheels().find((w) => w.id === job.wheelId);
    if (!wheel) return this.next();
    const segments = wheel.segments;
    const winner = pickWeighted(segments, (s) => s.weight, this.rand);
    if (winner < 0) return this.next();
    const durationMs = Math.max(2, Math.min(30, wheel.spinSec)) * 1000;
    const spin: WheelSpin = {
      spinId: `spin_${Date.now().toString(36)}`,
      wheelId: wheel.id,
      winnerId: segments[winner].id,
      winnerLabel: segments[winner].label,
      rotation: wheelRotation(segments.length, winner, this.rand, 5 + Math.round(wheel.spinSec / 2)),
      durationMs,
      segments,
      by: job.by,
    };
    this.busyUntil = Date.now() + durationMs;
    this.ctx.state.patch('wheel', { spinning: true, wheelId: wheel.id });
    // Every wheel overlay gets it; each one ignores spins of other wheels (an overlay without ?id shows the first wheel).
    this.deps.broadcast('wheel', { type: 'wheelSpin', spin });
    this.timer = setTimeout(() => {
      this.finish(wheel, segments[winner], job.by);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.next();
      }, QUEUE_GAP_MS);
    }, durationMs + 300);
  }

  private finish(wheel: Wheel, seg: WheelSegment, by: string): void {
    this.ctx.state.patch('wheel', { spinning: this.queue.length > 0, lastResult: { wheelId: wheel.id, label: seg.label, at: Date.now() } });
    this.ctx.toast('success', 'toast.wheelResult', { name: wheel.name, result: seg.label });
    if (wheel.announce.trim()) void this.deps.say(renderTemplate(wheel.announce, { result: seg.label, user: by || '', wheel: wheel.name }));
    if (wheel.removeWinner) {
      this.ctx.settings.update('wheels', (ws) => ws.map((w) => (w.id === wheel.id ? { ...w, segments: w.segments.filter((s) => s.id !== seg.id) } : w)));
    }
  }

  private onChat(m: ChatMessage): void {
    if (m.fromSelf) return;
    const parsed = parseCommand(m.text, this.ctx.settings.get('bot').prefix);
    if (!parsed) return;
    for (const w of this.wheels()) {
      if (!w.command.trim() || w.command.trim().toLowerCase() !== parsed.name) continue;
      if (!hasPermission(m.roles, w.commandPermission)) return;
      const bypass = hasPermission(m.roles, 'moderator');
      if (!bypass && !this.cooldowns.ready(w.id, m.userId, w.commandCooldownSec, 0)) return;
      this.cooldowns.start(w.id, m.userId, w.commandCooldownSec, 0);
      try {
        this.spin(w.id, m.userName);
      } catch {
        /* empty wheel: nothing to do from chat */
      }
      return;
    }
  }

  private onEvent(e: StreamEvent): void {
    if (e.type !== 'redemption') return;
    const title = e.rewardTitle.trim().toLowerCase();
    for (const w of this.wheels()) {
      if (w.redemptionTitle.trim() && w.redemptionTitle.trim().toLowerCase() === title) {
        try {
          this.spin(w.id, e.userName);
        } catch {
          /* empty wheel */
        }
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
