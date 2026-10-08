import type { MonitorLayout, MonitorRect, WorkspaceCard } from './types';

/** Dashboard grid: 12 columns, fixed-height rows. Cards snap to cells and never overlap. */
export const MONITOR_COLS = 12;
export const MONITOR_MIN_W = 3;
export const MONITOR_MIN_H = 4;
export const MONITOR_MAX_H = 40;
const LEGACY_HEIGHT = { compact: 8, normal: 11, tall: 15 } as const;

export type MonitorRects = Partial<Record<WorkspaceCard, MonitorRect>>;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

export function clampRect(r: MonitorRect): MonitorRect {
  const w = clamp(r.w, MONITOR_MIN_W, MONITOR_COLS);
  return { x: clamp(r.x, 0, MONITOR_COLS - w), y: clamp(r.y, 0, 10_000), w, h: clamp(r.h, MONITOR_MIN_H, MONITOR_MAX_H) };
}

export const overlaps = (a: MonitorRect, b: MonitorRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const byPosition = (rects: MonitorRects) => (a: WorkspaceCard, b: WorkspaceCard) => rects[a]!.y - rects[b]!.y || rects[a]!.x - rects[b]!.x;

/**
 * Removes every overlap by pushing cards down. `fixed` (the card being dragged or resized)
 * keeps its spot; the others keep their column and move only as far down as needed.
 */
export function resolveCollisions(rects: MonitorRects, fixed?: WorkspaceCard): MonitorRects {
  const ids = (Object.keys(rects) as WorkspaceCard[]).filter((id) => id !== fixed).sort(byPosition(rects));
  const placed: MonitorRect[] = fixed && rects[fixed] ? [rects[fixed]!] : [];
  const out: MonitorRects = fixed && rects[fixed] ? { [fixed]: rects[fixed] } : {};
  for (const id of ids) {
    const rect = { ...rects[id]! };
    for (let hit = placed.find((p) => overlaps(p, rect)); hit; hit = placed.find((p) => overlaps(p, rect))) rect.y = hit.y + hit.h;
    placed.push(rect);
    out[id] = rect;
  }
  return out;
}

/** Top-most, then left-most free spot for a w×h card. */
export function firstFit(placed: MonitorRect[], w: number, h: number): MonitorRect {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= MONITOR_COLS; x++) {
      const rect = { x, y, w, h };
      if (!placed.some((p) => overlaps(p, rect))) return rect;
    }
  }
}

/** Where every visible card goes: stored positions first, the rest auto-placed in `cards` order. */
export function monitorRects(cards: WorkspaceCard[], layout: MonitorLayout): MonitorRects {
  const stored: MonitorRects = {};
  for (const id of cards) if (layout.positions?.[id]) stored[id] = clampRect(layout.positions[id]!);
  const rects = resolveCollisions(stored);
  const placed = Object.values(rects) as MonitorRect[];
  for (const id of cards) {
    if (rects[id]) continue;
    const size = layout.sizes[id] ?? { width: 1, height: 'compact' as const };
    const rect = firstFit(placed, size.width * 4, LEGACY_HEIGHT[size.height]);
    rects[id] = rect;
    placed.push(rect);
  }
  return rects;
}

/** Put `id` at `rect` and shift whatever it lands on downwards. */
export function placeCard(rects: MonitorRects, id: WorkspaceCard, rect: MonitorRect): MonitorRects {
  return resolveCollisions({ ...rects, [id]: clampRect(rect) }, id);
}

/** Pull every card up as far as it can go, closing the gaps. */
export function compactRects(rects: MonitorRects): MonitorRects {
  const out: MonitorRects = {};
  const placed: MonitorRect[] = [];
  for (const id of (Object.keys(rects) as WorkspaceCard[]).sort(byPosition(rects))) {
    const rect = { ...rects[id]! };
    while (rect.y > 0 && !placed.some((p) => overlaps(p, { ...rect, y: rect.y - 1 }))) rect.y--;
    placed.push(rect);
    out[id] = rect;
  }
  return out;
}

/** Cards in reading order (for DOM / keyboard order). */
export function sortedCards(rects: MonitorRects): WorkspaceCard[] {
  return (Object.keys(rects) as WorkspaceCard[]).sort(byPosition(rects));
}

export const gridBottom = (rects: MonitorRects) => Math.max(0, ...(Object.values(rects) as MonitorRect[]).map((r) => r.y + r.h));
