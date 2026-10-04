import { ALL_OVERLAY_KINDS } from './profiles';
import type { WorkspaceCard } from './types';

export const INTERACTIVE_MODULES = ['wheel', 'poll', 'giveaway', 'queue', 'guess', 'quiz', 'boss'] as const;
export const CONNECTION_MODULES = ['twitch', 'donationalerts', 'streamlabs', 'streamelements', 'streamerbot', 'discord'] as const;
export const WORKSPACE_CARDS: readonly WorkspaceCard[] = ['stream', 'obs', 'actions', 'bot', ...CONNECTION_MODULES, 'subforstream', ...ALL_OVERLAY_KINDS];

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
