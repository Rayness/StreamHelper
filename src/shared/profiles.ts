import type { OverlayKind, ProfileConfig, ProfileSettingsKey, Settings } from './types';

export const ALL_OVERLAY_KINDS: readonly OverlayKind[] = [
  'chat', 'alerts', 'goal', 'timer', 'events', 'rewards', 'collab', 'music', 'song',
  'banner', 'ad', 'label', 'emotes', 'wheel', 'poll', 'giveaway', 'kawaki', 'quiz',
  'boss', 'live', 'spotlight', 'queue', 'guess', 'counter', 'hype', 'leaders',
  'curse', 'duel', 'melody', 'stocks', 'portal', 'donations', 'custom',
];

/**
 * Overlay kinds that existed before the app started remembering which kinds profiles have seen
 * (up to 0.10.x). A profile's `overlays` is a whitelist, so every kind added later is switched on
 * in existing profiles once, on upgrade; kinds the streamer turns off afterwards stay off.
 */
export const LEGACY_OVERLAY_KINDS: readonly OverlayKind[] = ALL_OVERLAY_KINDS.slice(0, 26);

/** Kinds 0.12.0 already switched on by itself (it detected the upgrade by `donationsOverlay`). */
export const OVERLAY_KINDS_0_12: readonly OverlayKind[] = [...LEGACY_OVERLAY_KINDS, 'donations', 'custom'];

export const PROFILE_KEYS: readonly ProfileSettingsKey[] = [
  'workspace',
  'bot', 'alerts', 'chatOverlay', 'spotlightOverlay', 'rewardsOverlay', 'collabOverlay', 'musicOverlay',
  'eventsOverlay', 'liveOverlay', 'donationsOverlay', 'customOverlays', 'overlayVariants',
  'songRequests', 'goals', 'timers', 'actions', 'banners', 'ads', 'labels',
  'emoteRain', 'wheels', 'poll', 'giveaway', 'quiz', 'boss', 'kawaki',
  'viewerQueue', 'guess', 'counterOverlays', 'hype', 'leadersOverlay',
  'clipper', 'curses', 'duel', 'melody', 'ducking', 'market', 'portal', 'report', 'shield',
];

/** Profiles store independent copies; live settings remain the source used by existing services. */
export function profileSnapshot(settings: Settings): ProfileConfig {
  const snapshot = {} as ProfileConfig;
  for (const key of PROFILE_KEYS) {
    (snapshot as unknown as Record<string, unknown>)[key] = structuredClone(settings[key]);
  }
  return snapshot;
}
