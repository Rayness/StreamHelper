import type { OverlayKind, OverlayMessage, OverlayVariant, Settings, SettingsKey } from './types';

/**
 * Overlays whose look comes from one settings section can get per-scene variants: a copy of the
 * section's changed fields, applied to what that browser source receives (`?v=<variant id>`).
 * Overlays with instances (goals, labels, banners...) pick a different instance per scene instead.
 */
export const VARIANT_KEYS: Partial<Record<OverlayKind, SettingsKey>> = {
  alerts: 'alerts',
  chat: 'chatOverlay',
  events: 'eventsOverlay',
  live: 'liveOverlay',
  spotlight: 'spotlightOverlay',
  rewards: 'rewardsOverlay',
  collab: 'collabOverlay',
  music: 'musicOverlay',
  song: 'songRequests',
  emotes: 'emoteRain',
  poll: 'poll',
  giveaway: 'giveaway',
  quiz: 'quiz',
  boss: 'boss',
  kawaki: 'kawaki',
  queue: 'viewerQueue',
  guess: 'guess',
  hype: 'hype',
  leaders: 'leadersOverlay',
  curse: 'curses',
  duel: 'duel',
  melody: 'melody',
  stocks: 'market',
  portal: 'portal',
  donations: 'donationsOverlay',
};

export const supportsVariants = (kind: OverlayKind): boolean => kind in VARIANT_KEYS;

/** Top-level fields of `value` that differ from `base`. */
export function variantDiff(base: unknown, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const b = (base && typeof base === 'object' ? base : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (JSON.stringify(v) !== JSON.stringify(b[k])) out[k] = v;
  }
  return out;
}

/** The section as a scene sees it. Arrays and non-objects can't have variants. */
export function withVariant<T>(base: T, overrides: Record<string, unknown> | undefined): T {
  if (!overrides || !base || typeof base !== 'object' || Array.isArray(base)) return base;
  return { ...base, ...overrides } as T;
}

export function findVariant(s: Pick<Settings, 'overlayVariants'>, id: string | null | undefined, kind?: OverlayKind): OverlayVariant | undefined {
  if (!id) return undefined;
  return (s.overlayVariants ?? []).find((v) => v.id === id && (!kind || v.kind === kind));
}

/** Apply a variant to an outgoing overlay message: its style/config, or an alert's style. */
export function applyVariant(msg: OverlayMessage, variant: OverlayVariant | undefined): OverlayMessage {
  if (!variant || !Object.keys(variant.overrides).length) return msg;
  const o = variant.overrides;
  if (msg.type === 'alert') {
    const style = o.style && typeof o.style === 'object' ? o.style as Record<string, unknown> : null;
    return style ? { ...msg, alert: { ...msg.alert, style: { ...msg.alert.style, ...style } } } : msg;
  }
  const m = msg as unknown as Record<string, unknown>;
  if (m.config && typeof m.config === 'object') return { ...m, config: { ...m.config as object, ...o } } as unknown as OverlayMessage;
  if (m.style && typeof m.style === 'object') return { ...m, style: { ...m.style as object, ...o } } as unknown as OverlayMessage;
  return msg;
}
