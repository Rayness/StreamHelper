import type { OverlayKind, ProfileConfig, ProfileSettingsKey, Settings } from './types';

export const ALL_OVERLAY_KINDS: readonly OverlayKind[] = [
  'chat', 'alerts', 'goal', 'timer', 'events', 'rewards', 'collab', 'music', 'song',
  'banner', 'ad', 'label', 'emotes', 'wheel', 'poll', 'giveaway', 'kawaki', 'quiz',
  'boss', 'live', 'spotlight', 'queue', 'guess', 'counter', 'hype', 'leaders',
  'curse', 'duel', 'melody', 'stocks', 'portal',
];

export const PROFILE_KEYS: readonly ProfileSettingsKey[] = [
  'workspace',
  'bot', 'alerts', 'chatOverlay', 'spotlightOverlay', 'rewardsOverlay', 'collabOverlay', 'musicOverlay',
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
