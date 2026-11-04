import type { IpcInvoke, SettingsKey } from './types';

/**
 * What a moderator connected over remote access may do. The streamer picks these per moderator;
 * everything not covered here (connections, logins, files on the streamer's PC) stays local only.
 */
export const REMOTE_PERMISSIONS = ['stream', 'obs', 'chat', 'alerts', 'songs', 'tts', 'interactive', 'settings'] as const;
export type RemotePermission = typeof REMOTE_PERMISSIONS[number];

export interface RemoteModerator {
  id: string;
  name: string;
  permissions: RemotePermission[];
  createdAt: number;
}

export interface RemoteClientInfo {
  /** Connection id. */
  id: string;
  moderatorId: string;
  name: string;
  address: string;
  since: number;
}

export interface RemoteLogEntry {
  at: number;
  name: string;
  /** IPC channel the moderator called. */
  action: string;
  /** Settings section for `settings:set` / `settings:reset`. */
  detail?: string;
}

export interface RemoteState {
  status: 'off' | 'running' | 'error';
  port: number;
  /** Local network addresses the server answers on. */
  addresses: string[];
  moderators: RemoteModerator[];
  clients: RemoteClientInfo[];
  log: RemoteLogEntry[];
  error: string | null;
}

/** Who is using the UI: sent to a remote browser in `app:init`. */
export interface RemoteSession {
  name: string;
  permissions: RemotePermission[];
}

export const DEFAULT_REMOTE_PORT = 4848;

/** Always allowed: reading what the UI needs to render. */
const VIEW = 'view' as const;
type Need = RemotePermission | typeof VIEW;

const CHANNELS: Partial<Record<keyof IpcInvoke, Need>> = {
  'app:init': VIEW,
  'fonts:system': VIEW,
  'media:list': VIEW,
  'obs:sources': VIEW,
  'obs:filters': VIEW,
  'twitch:searchCategories': VIEW,
  'twitch:rewards': VIEW,

  'twitch:updateStream': 'stream',
  'clipper:clip': 'stream',
  'shield:activate': 'stream',
  'shield:release': 'stream',
  'report:generate': 'stream',
  'report:reset': 'stream',
  'report:delete': 'stream',
  'report:discord': 'stream',
  'stats:reset': 'stream',
  'donations:clear': 'stream',

  'obs:setScene': 'obs',
  'obs:toggleSource': 'obs',
  'obs:toggleMute': 'obs',
  'obs:stream': 'obs',
  'obs:record': 'obs',
  'obs:addBrowserSource': 'obs',
  'obs:refreshAppSources': 'obs',
  'obs:setItemEnabled': 'obs',
  'obs:removeItem': 'obs',
  'obs:tidyScene': 'obs',

  'chat:send': 'chat',
  'chat:delete': 'chat',
  'chat:timeout': 'chat',
  'chat:ban': 'chat',
  'chat:test': 'chat',
  'spotlight:show': 'chat',
  'spotlight:test': 'chat',
  'spotlight:clear': 'chat',
  'shoutout:show': 'chat',
  'shoutout:test': 'chat',
  'shoutout:skip': 'chat',
  'captions:test': 'stream',
  'captions:clear': 'stream',

  'alerts:test': 'alerts',
  'overlays:test': 'alerts',
  'alerts:pause': 'alerts',
  'alerts:skip': 'alerts',
  'alerts:replay': 'alerts',
  'emotes:test': 'alerts',

  'song:add': 'songs',
  'song:play': 'songs',
  'song:skip': 'songs',
  'song:remove': 'songs',
  'song:pause': 'songs',
  'song:move': 'songs',
  'song:banUser': 'songs',
  'song:banVideo': 'songs',
  'song:backgroundAdd': 'songs',
  'song:favorite': 'songs',
  'song:favoriteRemove': 'songs',
  'song:favoritePlay': 'songs',
  'song:jamAdd': 'songs',
  'music:control': 'songs',

  'tts:test': 'tts',
  'tts:skip': 'tts',
  'tts:clear': 'tts',
  'tts:forgetVoices': 'tts',
  'tts:voices': 'tts',

  'actions:run': 'interactive',
  'timer:control': 'interactive',
  'banner:showNow': 'interactive',
  'subs:clear': 'interactive',
  'wheel:spin': 'interactive',
  'poll:start': 'interactive',
  'poll:end': 'interactive',
  'poll:clear': 'interactive',
  'giveaway:open': 'interactive',
  'giveaway:close': 'interactive',
  'giveaway:roll': 'interactive',
  'giveaway:reset': 'interactive',
  'quiz:start': 'interactive',
  'quiz:skip': 'interactive',
  'quiz:stop': 'interactive',
  'boss:start': 'interactive',
  'boss:reset': 'interactive',
  'boss:hit': 'interactive',
  'ad:show': 'interactive',
  'ad:hide': 'interactive',
  'queue:open': 'interactive',
  'queue:next': 'interactive',
  'queue:remove': 'interactive',
  'queue:clear': 'interactive',
  'guess:start': 'interactive',
  'guess:stop': 'interactive',
  'counter:add': 'interactive',
  'hype:add': 'interactive',
  'hype:reset': 'interactive',
  'leaders:reset': 'interactive',
  'curse:vote': 'interactive',
  'curse:apply': 'interactive',
  'curse:lift': 'interactive',
  'curse:cancel': 'interactive',
  'duel:start': 'interactive',
  'duel:stop': 'interactive',
  'melody:start': 'interactive',
  'melody:skip': 'interactive',
  'melody:stop': 'interactive',
  'melody:add': 'interactive',
  'melody:fromSongs': 'interactive',
  'market:reset': 'interactive',
  'market:grant': 'interactive',
  'portal:test': 'interactive',
  'focus:toggle': 'interactive',
  'focus:skip': 'interactive',
  'focus:stop': 'interactive',
  'focus:add': 'interactive',
  'kawaki:refresh': 'interactive',

  'settings:set': 'settings',
  'settings:reset': 'settings',
  'profiles:create': 'settings',
  'profiles:rename': 'settings',
  'profiles:activate': 'settings',
  'profiles:overlay': 'settings',
};

/**
 * Settings sections a moderator may never write: connections, the app itself (port, tray, language,
 * the streamer's window look) and profile bookkeeping, which goes through the profile calls.
 */
const LOCKED_SETTINGS: readonly SettingsKey[] = [
  'version', 'language', 'overlayPort', 'twitch', 'donationalerts', 'streamlabs', 'streamelements', 'streamerbot', 'discord', 'telegram',
  'subForStream', 'obs', 'minimizeToTray', 'appearance', 'profiles', 'activeProfileId', 'overlayKindsSeen',
];

const SETTINGS_PERMISSION: Partial<Record<SettingsKey, RemotePermission>> = {
  songRequests: 'songs',
  songQueue: 'songs',
  musicOverlay: 'songs',
  tts: 'tts',
};

/** The permission a settings section needs, or null when it is never writable remotely. */
export function settingsPermission(key: string): RemotePermission | null {
  if (LOCKED_SETTINGS.includes(key as SettingsKey)) return null;
  return SETTINGS_PERMISSION[key as SettingsKey] ?? 'settings';
}

/**
 * Whether a moderator with `permissions` may call `channel` with `args`.
 * Unknown channels (logins, files, updates, remote access itself) are refused.
 */
export function remoteAllowed(permissions: readonly RemotePermission[], channel: string, args: readonly unknown[]): boolean {
  if (!Object.prototype.hasOwnProperty.call(CHANNELS, channel)) return false;
  const need = CHANNELS[channel as keyof IpcInvoke]!;
  if (need === VIEW) return true;
  if (channel === 'settings:set' || channel === 'settings:reset') {
    if (typeof args[0] !== 'string') return false;
    const key = settingsPermission(args[0]);
    return key !== null && permissions.includes(key);
  }
  return permissions.includes(need);
}

/** Calls that only read: not written to the action log. */
export function remoteReadOnly(channel: string): boolean {
  return CHANNELS[channel as keyof IpcInvoke] === VIEW;
}

export function normalizePermissions(value: unknown): RemotePermission[] {
  return Array.isArray(value) ? REMOTE_PERMISSIONS.filter((p) => value.includes(p)) : [];
}
