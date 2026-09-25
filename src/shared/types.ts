// Contracts shared by the main process, the renderer UI and (as plain JSON) the overlays.

export type Platform = 'twitch' | 'youtube' | 'vkplay' | 'kick';
export type DonationSource = 'donationalerts' | 'streamlabs';
export type EventSource = Platform | DonationSource | 'test';
export type Language = 'ru' | 'en';

// ---------- Chat ----------

export interface ChatBadge {
  id: string;
  version: string;
  imageUrl?: string;
  title?: string;
}

export type ChatFragment =
  | { type: 'text'; text: string }
  | { type: 'emote'; text: string; url: string }
  | { type: 'mention'; text: string; userLogin: string }
  | { type: 'link'; text: string; url: string };

export interface ChatRoles {
  broadcaster: boolean;
  moderator: boolean;
  vip: boolean;
  subscriber: boolean;
}

export interface ChatMessage {
  id: string;
  platform: Platform;
  userId: string;
  userLogin: string;
  userName: string;
  color?: string;
  badges: ChatBadge[];
  roles: ChatRoles;
  text: string;
  fragments: ChatFragment[];
  timestamp: number;
  isAction?: boolean;
  /** Bits cheered inside the message, if any. */
  bits?: number;
  /** Highlighted / channel-points "highlight my message". */
  highlighted?: boolean;
  replyTo?: { id: string; userName: string; text: string };
  /** Message sent by this app (bot replies), so the bot never answers itself. */
  fromSelf?: boolean;
  /** UI only: removed by a moderator, shown struck-through. */
  deleted?: boolean;
}

// ---------- Stream events (alerts, activity feed) ----------

export type AlertType =
  | 'follow'
  | 'sub'
  | 'resub'
  | 'giftsub'
  | 'cheer'
  | 'raid'
  | 'donation'
  | 'redemption';

export const ALERT_TYPES: AlertType[] = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'donation', 'redemption'];

interface EventBase {
  id: string;
  source: EventSource;
  timestamp: number;
  userName: string;
  userLogin?: string;
}

export type StreamEvent =
  | (EventBase & { type: 'follow' })
  | (EventBase & { type: 'sub'; tier: SubTier; isPrime: boolean })
  | (EventBase & { type: 'resub'; tier: SubTier; months: number; streak?: number; message: string })
  | (EventBase & { type: 'giftsub'; tier: SubTier; count: number; total?: number; anonymous: boolean })
  | (EventBase & { type: 'cheer'; bits: number; message: string; anonymous: boolean })
  | (EventBase & { type: 'raid'; viewers: number })
  | (EventBase & {
      type: 'donation';
      amount: number;
      currency: string;
      /** Amount converted to the streamer's main currency when the provider supplies it. */
      amountMain?: number;
      message: string;
    })
  | (EventBase & { type: 'redemption'; rewardTitle: string; cost: number; input: string });

export type SubTier = '1000' | '2000' | '3000';

export type StreamEventOf<T extends AlertType> = Extract<StreamEvent, { type: T }>;

// ---------- Stream state ----------

export interface StreamInfo {
  live: boolean;
  title: string;
  categoryId: string;
  categoryName: string;
  tags: string[];
  viewers: number;
  startedAt: number | null;
}

export interface Category {
  id: string;
  name: string;
  boxArtUrl?: string;
}

// ---------- Connections ----------

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface AccountInfo {
  userId: string;
  login: string;
  displayName: string;
  avatarUrl?: string;
}

export interface ConnectionState {
  status: ConnectionStatus;
  account?: AccountInfo;
  error?: string;
}

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface ObsSceneItem {
  id: number;
  name: string;
  enabled: boolean;
}

export interface ObsState extends ConnectionState {
  scenes: string[];
  currentScene: string;
  sceneItems: ObsSceneItem[];
  inputs: { name: string; muted: boolean }[];
  streaming: boolean;
  recording: boolean;
}

export interface RuntimeState {
  twitch: ConnectionState & { deviceCode?: DeviceCodePrompt };
  twitchBot: ConnectionState & { deviceCode?: DeviceCodePrompt };
  donationalerts: ConnectionState;
  streamlabs: ConnectionState;
  obs: ObsState;
  stream: StreamInfo;
  alerts: { paused: boolean; queueLength: number; current: string | null };
  overlayUrl: string;
  overlayClients: number;
}

// ---------- Settings ----------

export type Permission = 'everyone' | 'subscriber' | 'vip' | 'moderator' | 'broadcaster';

export interface BotCommand {
  id: string;
  enabled: boolean;
  /** Trigger without prefix, e.g. "discord" for "!discord". */
  trigger: string;
  aliases: string[];
  response: string;
  permission: Permission;
  cooldownSec: number;
  userCooldownSec: number;
  /** Reply to the message thread instead of posting a plain message. */
  reply: boolean;
}

export type BuiltinCommandId = 'uptime' | 'title' | 'game' | 'followage' | 'shoutout' | 'counter' | 'commands' | 'permit';

export interface BuiltinCommand {
  id: BuiltinCommandId;
  enabled: boolean;
  trigger: string;
  permission: Permission;
}

export interface BotTimer {
  id: string;
  enabled: boolean;
  name: string;
  messages: string[];
  intervalMin: number;
  /** Minimum chat lines since the last post, so the bot doesn't talk to an empty room. */
  minChatLines: number;
  onlyWhenLive: boolean;
}

export type ModAction = 'delete' | 'timeout' | 'ban' | 'warn';

export interface ModFilter {
  enabled: boolean;
  action: ModAction;
  timeoutSec: number;
  warning: string;
}

export interface ModerationSettings {
  exempt: Permission;
  links: ModFilter & { allowed: string[] };
  caps: ModFilter & { minLength: number; percent: number };
  words: ModFilter & { list: string[] };
  spam: ModFilter & { maxRepeats: number; maxEmotes: number; maxLength: number };
  permitSec: number;
}

export interface BotSettings {
  enabled: boolean;
  prefix: string;
  commands: BotCommand[];
  builtins: BuiltinCommand[];
  timers: BotTimer[];
  counters: Record<string, number>;
  moderation: ModerationSettings;
  /** Event replies posted to chat, e.g. thank a new follower. Empty template = disabled. */
  eventMessages: Partial<Record<AlertType, string>>;
}

export type AlertAnimation = 'fade' | 'slide' | 'zoom' | 'bounce';

export interface AlertVariant {
  enabled: boolean;
  /** Minimum amount (bits, viewers, months, currency units, gift count) for this alert to fire. */
  minAmount: number;
  title: string;
  message: string;
  durationSec: number;
  sound: string | null;
  volume: number;
  image: string | null;
  animation: AlertAnimation;
  tts: boolean;
}

export interface AlertStyle {
  fontFamily: string;
  fontSize: number;
  textColor: string;
  accentColor: string;
  layout: 'stacked' | 'side';
}

export interface AlertSettings {
  gapSec: number;
  style: AlertStyle;
  types: Record<AlertType, AlertVariant>;
}

export interface ChatOverlaySettings {
  fontFamily: string;
  fontSize: number;
  showBadges: boolean;
  showPlatform: boolean;
  hideAfterSec: number;
  maxMessages: number;
  hideCommands: boolean;
  hideBots: string[];
  direction: 'up' | 'down';
  background: string;
  textColor: string;
}

export type GoalKind = 'followers' | 'subs' | 'bits' | 'donations' | 'manual';

export interface Goal {
  id: string;
  title: string;
  kind: GoalKind;
  target: number;
  current: number;
  /** Currency label shown for donation goals. */
  currency: string;
  barColor: string;
  textColor: string;
}

export type TimerMode = 'countdown' | 'stopwatch';

export interface OverlayTimer {
  id: string;
  title: string;
  mode: TimerMode;
  durationSec: number;
  running: boolean;
  /** For countdown: when running, the epoch ms it ends; for stopwatch: epoch ms it started. */
  anchorAt: number | null;
  /** Remaining (countdown) or elapsed (stopwatch) ms while paused. */
  pausedMs: number;
  /** Subathon: seconds added per event. 0 disables that source. */
  addSec: { sub: number; giftsubPerSub: number; bitsPer100: number; donationPerUnit: number; follow: number };
  fontFamily: string;
  fontSize: number;
  textColor: string;
}

export type ActionStep =
  | { type: 'obsScene'; scene: string }
  | { type: 'obsToggleSource'; scene: string; source: string }
  | { type: 'obsToggleMute'; input: string }
  | { type: 'obsStream'; mode: 'start' | 'stop' | 'toggle' }
  | { type: 'obsRecord'; mode: 'start' | 'stop' | 'toggle' }
  | { type: 'chat'; text: string }
  | { type: 'alertsPause' }
  | { type: 'alertsSkip' }
  | { type: 'counter'; name: string; delta: number }
  | { type: 'timerToggle'; timerId: string }
  | { type: 'timerAdd'; timerId: string; seconds: number }
  | { type: 'goalAdd'; goalId: string; amount: number }
  | { type: 'wait'; ms: number };

export interface QuickAction {
  id: string;
  label: string;
  color: string;
  /** Electron accelerator, e.g. "Ctrl+Shift+1". Empty = no global hotkey. */
  hotkey: string;
  showOnDashboard: boolean;
  steps: ActionStep[];
}

export interface Settings {
  version: 1;
  language: Language;
  overlayPort: number;
  twitch: { clientId: string };
  donationalerts: { clientId: string; enabled: boolean };
  streamlabs: { enabled: boolean };
  obs: { host: string; port: number; autoConnect: boolean };
  bot: BotSettings;
  alerts: AlertSettings;
  chatOverlay: ChatOverlaySettings;
  goals: Goal[];
  timers: OverlayTimer[];
  actions: QuickAction[];
  /** Main currency for donation totals (goals, subathon). */
  currency: string;
  minimizeToTray: boolean;
}

export type SettingsKey = keyof Settings;

// ---------- Overlay wire protocol ----------

export type OverlayKind = 'chat' | 'alerts' | 'goal' | 'timer' | 'events';

export interface RenderedAlert {
  id: string;
  type: AlertType;
  title: string;
  message: string;
  /** Highlighted with the accent color wherever it appears in the title. */
  userName: string;
  durationSec: number;
  sound: string | null;
  volume: number;
  image: string | null;
  animation: AlertAnimation;
  tts: boolean;
  style: AlertStyle;
}

export type OverlayMessage =
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chatDelete'; id: string }
  | { type: 'chatClearUser'; userId: string }
  | { type: 'chatClear' }
  | { type: 'chatConfig'; config: ChatOverlaySettings }
  | { type: 'alert'; alert: RenderedAlert }
  | { type: 'alertSkip' }
  | { type: 'goal'; goal: Goal | null }
  | { type: 'timer'; timer: OverlayTimer | null; now: number }
  | { type: 'event'; event: StreamEvent }
  | { type: 'events'; events: StreamEvent[] }
  | { type: 'reload' };

// ---------- IPC ----------

export interface MediaFile {
  name: string;
  url: string;
  kind: 'image' | 'audio' | 'video';
}

/** Request/response calls from renderer to main. */
export interface IpcInvoke {
  'app:init': () => { settings: Settings; state: RuntimeState; chat: ChatMessage[]; events: StreamEvent[]; version: string };
  'settings:set': <K extends SettingsKey>(key: K, value: Settings[K]) => void;
  'settings:reset': (key: SettingsKey) => Settings;
  'twitch:login': (account: 'broadcaster' | 'bot') => void;
  'twitch:logout': (account: 'broadcaster' | 'bot') => void;
  'twitch:cancelLogin': (account: 'broadcaster' | 'bot') => void;
  'twitch:updateStream': (patch: { title?: string; categoryId?: string; tags?: string[] }) => void;
  'twitch:searchCategories': (query: string) => Category[];
  'chat:send': (text: string, replyTo?: string) => void;
  'chat:delete': (messageId: string) => void;
  'chat:timeout': (userId: string, seconds: number) => void;
  'chat:ban': (userId: string) => void;
  /** Inject a sample message so the streamer can style the chat overlay without going live. */
  'chat:test': () => void;
  'da:login': () => void;
  'da:logout': () => void;
  'streamlabs:connect': (token: string) => void;
  'streamlabs:disconnect': () => void;
  'obs:connect': (password?: string) => void;
  'obs:disconnect': () => void;
  'obs:setScene': (scene: string) => void;
  'obs:toggleSource': (scene: string, itemId: number) => void;
  'obs:toggleMute': (input: string) => void;
  'obs:stream': (mode: 'start' | 'stop' | 'toggle') => void;
  'obs:record': (mode: 'start' | 'stop' | 'toggle') => void;
  'alerts:test': (type: AlertType) => void;
  'alerts:pause': (paused: boolean) => void;
  'alerts:skip': () => void;
  'alerts:replay': (eventId: string) => void;
  'actions:run': (actionId: string) => void;
  'timer:control': (timerId: string, op: 'start' | 'pause' | 'reset' | 'add', seconds?: number) => void;
  'media:import': () => MediaFile | null;
  'media:list': () => MediaFile[];
  'shell:openExternal': (url: string) => void;
  'clipboard:write': (text: string) => void;
}

/** Push notifications from main to renderer. */
export interface IpcPush {
  'state': RuntimeState;
  'settings': Settings;
  'chat:message': ChatMessage;
  'chat:delete': { id: string };
  'chat:clearUser': { userId: string };
  'chat:clear': Record<string, never>;
  'event': StreamEvent;
  /** `key` is an i18n key; the renderer translates it with `params`. */
  'toast': { kind: 'info' | 'error' | 'success'; key: string; params?: Record<string, string | number> };
}
