import type { OverlayKind } from '@shared/types';
import type { IconName } from './components/icons';

export type OverlayGroup = 'main' | 'screen' | 'fun';

export interface OverlayDef {
  kind: OverlayKind;
  icon: IconName;
  group: OverlayGroup;
  /** Recommended browser-source size. */
  size: [number, number];
  /** Extra query for the URL (without the id). */
  query?: string;
}

/** Every overlay the app serves, in the order the Overlays page lists them. */
export const OVERLAYS: OverlayDef[] = [
  { kind: 'alerts', icon: 'alert', group: 'main', size: [1920, 1080] },
  { kind: 'chat', icon: 'chat', group: 'main', size: [400, 600] },
  { kind: 'events', icon: 'zap', group: 'main', size: [400, 300], query: 'limit=5' },
  { kind: 'rewards', icon: 'gift', group: 'main', size: [560, 450] },
  { kind: 'collab', icon: 'broadcast', group: 'screen', size: [650, 360] },
  { kind: 'banner', icon: 'banner', group: 'screen', size: [1920, 110] },
  { kind: 'ad', icon: 'banner', group: 'screen', size: [1920, 1080] },
  { kind: 'live', icon: 'broadcast', group: 'screen', size: [650, 160] },
  { kind: 'spotlight', icon: 'chat', group: 'screen', size: [820, 220] },
  { kind: 'label', icon: 'tag', group: 'screen', size: [700, 70] },
  { kind: 'goal', icon: 'target', group: 'screen', size: [600, 90] },
  { kind: 'timer', icon: 'clock', group: 'screen', size: [500, 150] },
  { kind: 'kawaki', icon: 'tv', group: 'screen', size: [560, 190] },
  { kind: 'wheel', icon: 'wheel', group: 'fun', size: [800, 800] },
  { kind: 'poll', icon: 'poll', group: 'fun', size: [620, 420] },
  { kind: 'giveaway', icon: 'gift', group: 'fun', size: [800, 320] },
  { kind: 'quiz', icon: 'quiz', group: 'fun', size: [1280, 720] },
  { kind: 'boss', icon: 'target', group: 'fun', size: [900, 260] },
  { kind: 'emotes', icon: 'smile', group: 'fun', size: [1920, 1080] },
];

export const overlayDef = (kind: OverlayKind): OverlayDef => OVERLAYS.find((o) => o.kind === kind)!;

export function overlayPath(kind: OverlayKind, id?: string): string {
  const def = overlayDef(kind);
  const q = [id ? `id=${encodeURIComponent(id)}` : '', def.query ?? ''].filter(Boolean).join('&');
  return `/overlay/${kind}${q ? `?${q}` : ''}`;
}
