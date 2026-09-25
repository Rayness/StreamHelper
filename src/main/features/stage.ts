import type { OverlayKind, OverlayMessage } from '@shared/types';

/** What interactive features (wheel, poll, giveaway, quiz) need from the outside world. */
export interface StageDeps {
  /** Send to overlays of a kind (optionally only the one bound to `id`). */
  broadcast(kind: OverlayKind, msg: OverlayMessage, id?: string): void;
  /** Post to every connected chat. Never throws: a silent bot must not break a game. */
  say(text: string): Promise<void>;
}

/** Weighted random pick. Items with weight <= 0 never win. Returns -1 if nothing can win. */
export function pickWeighted<T>(items: T[], weight: (item: T) => number, rand: () => number = Math.random): number {
  const total = items.reduce((sum, it) => sum + Math.max(0, weight(it)), 0);
  if (total <= 0) return -1;
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    const w = Math.max(0, weight(items[i]));
    if (w <= 0) continue;
    if (r < w) return i;
    r -= w;
  }
  // Floating-point edge: fall back to the last winnable item.
  for (let i = items.length - 1; i >= 0; i--) if (weight(items[i]) > 0) return i;
  return -1;
}

/** Lowercase, ё→е, letters and digits only: how chat answers and keywords are compared. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
