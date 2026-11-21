import type { WorkspaceCard } from '@shared/types';
import { DONATION_PROVIDERS, DONATION_SOURCES } from '@shared/events';
import type { IconName } from './components/icons';
import type { TKey } from './i18n';
import { OVERLAYS } from './overlayCatalog';

export type ModuleGroup = 'setup' | 'core' | 'screen' | 'audio' | 'fun' | 'automation';
export type ModuleKindTag = 'overlay' | 'control' | 'interactive' | 'audio';

export interface ModuleDef {
  id: WorkspaceCard;
  title?: TKey;
  name?: string;
  description: TKey;
  icon: IconName;
  group: ModuleGroup;
  kindTag: ModuleKindTag;
}

const CORE_OVERLAYS: readonly WorkspaceCard[] = ['alerts', 'chat', 'events', 'rewards', 'donations', 'collab'];
const AUDIO_OVERLAYS: readonly WorkspaceCard[] = ['song', 'music', 'tts'];

function overlayGroup(kind: WorkspaceCard, rawGroup: 'main' | 'screen' | 'fun'): ModuleGroup {
  if (AUDIO_OVERLAYS.includes(kind)) return 'audio';
  if (CORE_OVERLAYS.includes(kind)) return 'core';
  if (rawGroup === 'fun') return 'fun';
  return 'screen';
}

function overlayKindTag(kind: WorkspaceCard, rawGroup: 'main' | 'screen' | 'fun'): ModuleKindTag {
  if (AUDIO_OVERLAYS.includes(kind)) return 'audio';
  if (rawGroup === 'fun') return 'interactive';
  return 'overlay';
}

export const MODULES: ModuleDef[] = [
  { id: 'twitch', name: 'Twitch', description: 'workspace.desc.connection', icon: 'broadcast', group: 'setup', kindTag: 'control' },
  { id: 'obs', name: 'OBS', description: 'workspace.desc.obs', icon: 'video', group: 'core', kindTag: 'control' },
  ...DONATION_SOURCES.map(
    (id): ModuleDef => ({
      id,
      name: DONATION_PROVIDERS[id].name,
      description: 'workspace.desc.connection',
      icon: 'plug',
      group: 'setup',
      kindTag: 'control',
    }),
  ),
  ...(['streamerbot', 'discord', 'telegram'] as const).map(
    (id): ModuleDef => ({
      id,
      name: ({ streamerbot: 'Streamer.bot', discord: 'Discord', telegram: 'Telegram' })[id],
      description: 'workspace.desc.connection',
      icon: 'plug',
      group: 'setup',
      kindTag: 'control',
    }),
  ),
  { id: 'subforstream', name: 'SubForStream', description: 'workspace.desc.subs', icon: 'mic', group: 'setup', kindTag: 'control' },
  { id: 'stream', title: 'dash.stream', description: 'workspace.desc.stream', icon: 'broadcast', group: 'core', kindTag: 'control' },
  { id: 'bot', title: 'nav.bot', description: 'workspace.desc.bot', icon: 'bot', group: 'automation', kindTag: 'control' },
  { id: 'actions', title: 'dash.quick', description: 'workspace.desc.actions', icon: 'zap', group: 'automation', kindTag: 'control' },
  { id: 'clipper', title: 'tool.clipper', description: 'toolDesc.clipper', icon: 'scissors', group: 'automation', kindTag: 'control' },
  { id: 'shield', title: 'tool.shield', description: 'toolDesc.shield', icon: 'shield', group: 'automation', kindTag: 'control' },
  { id: 'ducking', title: 'tool.ducking', description: 'toolDesc.ducking', icon: 'volume', group: 'audio', kindTag: 'audio' },
  { id: 'report', title: 'tool.report', description: 'toolDesc.report', icon: 'report', group: 'screen', kindTag: 'control' },
  ...OVERLAYS.filter((o) => o.kind !== 'custom').map(
    (o): ModuleDef => ({
      id: o.kind,
      title: `ov.${o.kind}`,
      description: `ovDesc.${o.kind}`,
      icon: o.icon,
      group: overlayGroup(o.kind, o.group),
      kindTag: overlayKindTag(o.kind, o.group),
    }),
  ),
];

export const moduleDef = (id: WorkspaceCard) => MODULES.find((m) => m.id === id)!;
/** Display name of a module (connections use brand names, the rest are translated). */
export const moduleName = (id: WorkspaceCard, t: (key: TKey) => string) => {
  const m = moduleDef(id);
  return m.title ? t(m.title) : m.name!;
};

export const MODULE_GROUPS_ORDER: readonly Exclude<ModuleGroup, 'setup'>[] = ['core', 'screen', 'audio', 'fun', 'automation'];

/** Featured starter modules shown at the top of the catalog for beginners. */
export const POPULAR_MODULES: readonly WorkspaceCard[] = ['alerts', 'chat', 'events', 'obs', 'bot', 'song', 'goal', 'wheel'];

export type ModuleRequirement = 'twitch' | 'obs';

/** Lightweight prerequisite hints shown on module cards and inside editors. */
export const MODULE_REQUIRES: Partial<Record<WorkspaceCard, readonly ModuleRequirement[]>> = {
  stream: ['twitch'],
  chat: ['twitch'],
  events: ['twitch'],
  alerts: ['twitch'],
  bot: ['twitch'],
  rewards: ['twitch'],
  song: ['twitch', 'obs'],
  obs: ['obs'],
  ducking: ['obs'],
  poll: ['twitch'],
  giveaway: ['twitch'],
  queue: ['twitch'],
  guess: ['twitch'],
  quiz: ['twitch'],
  boss: ['twitch'],
  emotes: ['twitch'],
  leaders: ['twitch'],
  hype: ['twitch'],
  clipper: ['twitch'],
  shield: ['twitch'],
  report: ['twitch'],
  shoutout: ['twitch'],
  tts: ['twitch'],
  curse: ['twitch'],
  duel: ['twitch'],
  melody: ['twitch'],
  stocks: ['twitch'],
  portal: ['twitch'],
};

export interface StarterPreset {
  id: 'starter' | 'interactive' | 'chill';
  icon: IconName;
  recommended?: boolean;
  cards: readonly WorkspaceCard[];
}

export const STARTER_PRESETS: readonly StarterPreset[] = [
  { id: 'starter', icon: 'rocket', recommended: true, cards: ['chat', 'events', 'alerts', 'stream', 'obs', 'goal'] },
  { id: 'interactive', icon: 'sparkle', cards: ['chat', 'events', 'alerts', 'bot', 'wheel', 'poll', 'giveaway', 'emotes', 'song', 'obs'] },
  { id: 'chill', icon: 'music', cards: ['chat', 'alerts', 'music', 'song', 'focus', 'goal', 'obs'] },
];
