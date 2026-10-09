import { ALL_OVERLAY_KINDS } from './profiles';
import type { MonitorLayout, WorkspaceCard } from './types';
import { clampRect } from './monitorGrid';

export const INTERACTIVE_MODULES = ['wheel', 'poll', 'giveaway', 'queue', 'guess', 'quiz', 'boss'] as const;
/** Modules added in the "stream tools" pack, each with its own editor. */
export const FEATURE_MODULES = ['clipper', 'curse', 'duel', 'melody', 'ducking', 'stocks', 'portal', 'report', 'shield'] as const;
export type FeatureModule = typeof FEATURE_MODULES[number];
export const CONNECTION_MODULES = ['twitch', 'donationalerts', 'streamlabs', 'streamelements', 'streamerbot', 'discord'] as const;
export const CONNECTION_TABS = [...CONNECTION_MODULES, 'obs', 'subforstream'] as const;
export type ConnectionTab = typeof CONNECTION_TABS[number];
export const isConnectionOnly = (id: WorkspaceCard) => CONNECTION_MODULES.includes(id as typeof CONNECTION_MODULES[number]) || id === 'subforstream';
export const workspaceCards = (value: unknown) => normalizeWorkspaceCards(value).filter((id) => !isConnectionOnly(id));

export function normalizeMonitorLayout(value: unknown): MonitorLayout {
  const raw = value && typeof value === 'object' ? value as Partial<MonitorLayout> : {};
  const sizes: MonitorLayout['sizes'] = {};
  for (const id of WORKSPACE_CARDS) {
    const size = raw.sizes?.[id];
    if (size && typeof size === 'object') sizes[id] = {
      width: [1,2,3].includes(size.width) ? size.width : 1,
      height: ['compact','normal','tall'].includes(size.height) ? size.height : 'compact',
    };
  }
  const positions: MonitorLayout['positions'] = {};
  for (const id of WORKSPACE_CARDS) {
    const rect = raw.positions?.[id];
    if (rect && typeof rect === 'object' && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) positions[id] = clampRect(rect);
  }
  return { order: workspaceCards(raw.order), hidden: workspaceCards(raw.hidden), sizes, positions };
}

export function monitorCards(cards: unknown, layout: unknown): WorkspaceCard[] {
  const installed = workspaceCards(cards);
  const normalized = normalizeMonitorLayout(layout);
  return [...new Set([...normalized.order, ...installed])].filter((id) => installed.includes(id) && !normalized.hidden.includes(id));
}

export function reorderCards(cards: WorkspaceCard[], from: WorkspaceCard, to: WorkspaceCard): WorkspaceCard[] {
  if (from === to || !cards.includes(from) || !cards.includes(to)) return cards;
  const next = cards.filter((id) => id !== from);
  next.splice(cards.indexOf(to), 0, from);
  return next;
}
export const TOOL_MODULES = ['clipper', 'ducking', 'shield', 'report'] as const;
export const WORKSPACE_CARDS: readonly WorkspaceCard[] = ['stream', 'obs', 'actions', 'bot', ...CONNECTION_MODULES, 'subforstream', ...TOOL_MODULES, ...ALL_OVERLAY_KINDS];

/** Preserve explicit selections from the old card layout, including an empty workspace. */
export function normalizeWorkspaceCards(value: unknown): WorkspaceCard[] {
  if (!Array.isArray(value)) return [];
  const expanded = value.flatMap((id) => id === 'activities' ? [...INTERACTIVE_MODULES] : id === 'counters' ? ['counter'] : [id]);
  return [...new Set(expanded.filter((id): id is WorkspaceCard => WORKSPACE_CARDS.includes(id)))];
}

export function isWorkspaceModule(value: unknown): value is WorkspaceCard {
  return typeof value === 'string' && WORKSPACE_CARDS.includes(value as WorkspaceCard);
}

/** Every old shortcut resolves through the same installed-module boundary. Never auto-add. */
export function workspaceTarget(page: string, sub?: string): WorkspaceCard | undefined {
  if (page === 'overlays' || page === 'interactive') return isWorkspaceModule(sub) ? sub : page === 'interactive' ? 'wheel' : 'chat';
  if (page === 'connections') return CONNECTION_MODULES.includes(sub as typeof CONNECTION_MODULES[number]) ? sub as WorkspaceCard : 'twitch';
  return isWorkspaceModule(page) ? page : undefined;
}

export function resolveModuleAccess(target: unknown, cards: unknown): { module?: WorkspaceCard; catalog?: WorkspaceCard } {
  if (!isWorkspaceModule(target)) return {};
  return normalizeWorkspaceCards(cards).includes(target) ? { module: target } : { catalog: target };
}
