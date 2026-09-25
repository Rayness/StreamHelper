import type { OverlayTimer } from './types';

/** Milliseconds to display: remaining for countdown, elapsed for stopwatch. */
export function timerValue(t: OverlayTimer, now: number): number {
  if (!t.running || t.anchorAt === null) return t.pausedMs;
  return t.mode === 'countdown' ? Math.max(0, t.anchorAt - now) : now - t.anchorAt;
}

export function timerStart(t: OverlayTimer, now: number): OverlayTimer {
  if (t.running) return t;
  const anchorAt = t.mode === 'countdown' ? now + t.pausedMs : now - t.pausedMs;
  return { ...t, running: true, anchorAt };
}

export function timerPause(t: OverlayTimer, now: number): OverlayTimer {
  if (!t.running) return t;
  return { ...t, running: false, anchorAt: null, pausedMs: timerValue(t, now) };
}

export function timerReset(t: OverlayTimer): OverlayTimer {
  return { ...t, running: false, anchorAt: null, pausedMs: t.mode === 'countdown' ? t.durationSec * 1000 : 0 };
}

/** Add (or subtract) time. For a countdown this extends it; for a stopwatch it shifts the elapsed time. */
export function timerAdd(t: OverlayTimer, seconds: number, now: number): OverlayTimer {
  const delta = seconds * 1000;
  if (t.mode === 'countdown') {
    if (t.running && t.anchorAt !== null) return { ...t, anchorAt: Math.max(now, t.anchorAt) + delta };
    return { ...t, pausedMs: Math.max(0, t.pausedMs + delta) };
  }
  if (t.running && t.anchorAt !== null) return { ...t, anchorAt: Math.min(now, t.anchorAt - delta) };
  return { ...t, pausedMs: Math.max(0, t.pausedMs + delta) };
}
