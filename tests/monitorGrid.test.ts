import { describe, expect, it } from 'vitest';
import { compactRects, monitorRects, MONITOR_COLS, overlaps, placeCard, type MonitorRects } from '@shared/monitorGrid';
import { normalizeMonitorLayout } from '@shared/workspace';
import type { MonitorRect, WorkspaceCard } from '@shared/types';

const noOverlap = (rects: MonitorRects) => {
  const list = Object.values(rects) as MonitorRect[];
  list.forEach((a, i) => list.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
  list.forEach((r) => { expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.w).toBeLessThanOrEqual(MONITOR_COLS); });
};

describe('monitor grid', () => {
  const layout = normalizeMonitorLayout({ sizes: { chat: { width: 2, height: 'tall' } } });
  const cards: WorkspaceCard[] = ['events', 'stream', 'chat', 'alerts'];

  it('auto-places cards without stored positions like the old three-column grid', () => {
    const rects = monitorRects(cards, layout);
    expect(rects.events).toEqual({ x: 0, y: 0, w: 4, h: 8 });
    expect(rects.stream).toEqual({ x: 4, y: 0, w: 4, h: 8 });
    expect(rects.chat).toEqual({ x: 0, y: 8, w: 8, h: 15 });
    expect(rects.alerts).toEqual({ x: 8, y: 0, w: 4, h: 8 });
    noOverlap(rects);
  });

  it('pushes whatever a dropped card lands on downwards', () => {
    const rects = monitorRects(cards, layout);
    const next = placeCard(rects, 'alerts', { x: 0, y: 0, w: 4, h: 8 });
    expect(next.alerts).toEqual({ x: 0, y: 0, w: 4, h: 8 });
    expect(next.events!.y).toBe(8);
    expect(next.chat!.y).toBeGreaterThanOrEqual(16);
    noOverlap(next);
  });

  it('keeps resized and out-of-range cards inside the grid without overlaps', () => {
    const rects = monitorRects(cards, layout);
    noOverlap(placeCard(rects, 'events', { x: 10, y: -3, w: 20, h: 99 }));
    noOverlap(placeCard(rects, 'stream', { x: 2, y: 4, w: 1, h: 1 }));
  });

  it('repairs overlapping stored positions and closes gaps on request', () => {
    const stored = normalizeMonitorLayout({ positions: { events: { x: 0, y: 0, w: 6, h: 6 }, stream: { x: 2, y: 2, w: 6, h: 6 }, chat: { x: 8, y: 30, w: 4, h: 4 } } });
    const rects = monitorRects(['events', 'stream', 'chat'], stored);
    noOverlap(rects);
    const compact = compactRects(rects);
    noOverlap(compact);
    expect(compact.chat!.y).toBe(0);
    expect(compact.stream!.y).toBe(6);
  });

  it('drops invalid stored positions', () => {
    expect(normalizeMonitorLayout({ positions: { chat: { x: 'a', y: 0, w: 4, h: 4 }, fake: { x: 0, y: 0, w: 4, h: 4 } } }).positions).toEqual({});
  });
});
