// Contracts shared by the main process, the renderer UI and (as plain JSON) the overlays.

export type Platform = 'twitch' | 'youtube' | 'vkplay' | 'kick';
export type DonationSource = 'donationalerts' | 'streamlabs' | 'streamelements';
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
  kawaki: KawakiState;
  twitchBot: ConnectionState & { deviceCode?: DeviceCodePrompt };
  donationalerts: ConnectionState;
  streamlabs: ConnectionState;
  streamelements: ConnectionState;
  streamerbot: ConnectionState & { actions: { id: string; name: string }[] };
  discord: ConnectionState;
  obs: ObsState;
  stream: StreamInfo;
  alerts: { paused: boolean; queueLength: number; current: string | null };
  overlayUrl: string;
  overlayClients: number;
  /** Connected overlays per kind, so the UI can show "in OBS" next to each overlay. */
  overlayKinds: Partial<Record<OverlayKind, number>>;
  wheel: { spinning: boolean; wheelId: string | null; lastResult: { wheelId: string; label: string; at: number } | null };
  poll: PollState | null;
  giveaway: GiveawayState;
  quiz: QuizState;
  boss: BossState;
  ad: { activeId: string | null; endsAt: number | null };
  spotlight: ChatMessage | null;
  update: UpdateState;
  dockUrl: string;
  /** Banners currently on screen (manual toggle or schedule). */
  bannersShown: string[];
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

export type BuiltinCommandId = 'uptime' | 'title' | 'game' | 'followage' | 'shoutout' | 'counter' | 'commands' | 'permit' | 'anime';

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
  | { type: 'wheelSpin'; wheelId: string }
  | { type: 'bannerToggle'; bannerId: string }
  | { type: 'emoteBurst' }
  | { type: 'streamerbotAction'; actionId: string }
  | { type: 'wait'; ms: number };

export interface QuickAction {
  id: string;
  label: string;
  color: string;
  /** Electron accelerator, e.g. "Ctrl+Shift+1". Empty = no global hotkey. */
  hotkey: string;
  showOnDashboard: boolean;
  /** Run when a channel-points reward with this title is redeemed. Empty = off. */
  redemptionTitle?: string;
  steps: ActionStep[];
}

// ---------- Banners, labels, stats ----------

export type BannerLayout = 'card' | 'ticker' | 'lowerThird';

export interface BannerSlide {
  id: string;
  /** Template: {title}, {game}, {lastfollower}, {anime}... */
  text: string;
  image: string | null;
}

export interface Banner {
  id: string;
  name: string;
  /** Manual on/off. With a schedule, "on" means "pop up every N minutes". */
  visible: boolean;
  layout: BannerLayout;
  slides: BannerSlide[];
  /** Seconds each slide stays before the next one (card / lower third). */
  intervalSec: number;
  /** Ticker speed, px per second. */
  tickerSpeed: number;
  /** 0 = stays on screen while visible; otherwise pops up every N minutes for `scheduleShowSec`. */
  scheduleEveryMin: number;
  scheduleShowSec: number;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  background: string;
  accentColor: string;
  align: 'left' | 'center' | 'right';
}

/** Graphic/video advertising, independent of the existing text banners. */
export type AdEntrance = 'fade' | 'slideUp' | 'slideDown' | 'slideSide' | 'zoom' | 'bounce' | 'flip' | 'blur' | 'wipe';

export interface AdCampaign {
  id: string;
  name: string;
  enabled: boolean;
  media: string | null;
  headline: string;
  caption: string;
  accentColor: string;
  position: 'bottomLeft' | 'bottomRight' | 'topLeft' | 'topRight';
  entrance: AdEntrance;
  entranceMs: number;
  width: number;
  durationSec: number;
  everyMin: number;
  onlyWhenLive: boolean;
}

export interface BossSettings {
  name: string;
  maxHp: number;
  damage: number;
  cooldownSec: number;
  command: string;
  redemptionTitle: string;
  accentColor: string;
  announce: boolean;
}

export interface BossState {
  status: 'idle' | 'running' | 'defeated';
  hp: number;
  maxHp: number;
  hits: number;
  lastHit: { user: string; damage: number } | null;
  top: { user: string; damage: number }[];
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'upToDate' | 'error' | 'unsupported';
  version: string | null;
  progress: number;
  error: string | null;
}

export interface Label {
  id: string;
  name: string;
  template: string;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  align: 'left' | 'center' | 'right';
}

export interface StatEntry {
  name: string;
  amount: number;
  currency?: string;
}

/** "Last follower", "top donation"... Survives restarts; reset per stream from the UI. */
export interface StreamStats {
  lastFollower: string;
  lastSubscriber: string;
  lastCheer: StatEntry | null;
  lastRaid: StatEntry | null;
  lastDonation: StatEntry | null;
  topDonation: StatEntry | null;
  topCheer: StatEntry | null;
  follows: number;
  subs: number;
  bits: number;
  donations: number;
  since: number;
}

export type EmoteRainStyle = 'rain' | 'rise' | 'bounce';

export interface EmoteRainSettings {
  fromChat: boolean;
  maxPerMessage: number;
  size: number;
  durationSec: number;
  style: EmoteRainStyle;
  /** Shower of recent chat emotes on subs, raids, donations and cheers. */
  burstOnEvents: boolean;
  burstCount: number;
}

// ---------- Interactive: wheel, poll, giveaway, quiz ----------

export interface WheelSegment {
  id: string;
  label: string;
  color: string;
  /** Relative chance. 0 = never lands here (still drawn). */
  weight: number;
}

export interface Wheel {
  id: string;
  name: string;
  segments: WheelSegment[];
  spinSec: number;
  /** Remove the winning segment afterwards (elimination rounds). */
  removeWinner: boolean;
  /** Chat message after the spin, {result} / {user}. Empty = silent. */
  announce: string;
  /** Chat command that spins it (without prefix). Empty = off. */
  command: string;
  commandPermission: Permission;
  commandCooldownSec: number;
  /** Channel-points reward title that spins it. Empty = off. */
  redemptionTitle: string;
  fontFamily: string;
  tickSound: boolean;
  winSound: string | null;
  volume: number;
  /** 0 = wheel always on screen; otherwise it appears for a spin and hides N seconds after the result. */
  hideAfterSec: number;
}

export interface WheelSpin {
  spinId: string;
  wheelId: string;
  winnerId: string;
  winnerLabel: string;
  /** Final rotation of the wheel, degrees (clockwise). */
  rotation: number;
  durationMs: number;
  segments: WheelSegment[];
  by: string;
}

export interface PollSettings {
  question: string;
  options: string[];
  durationSec: number;
  allowChange: boolean;
  /** Post start / result messages to chat. */
  announce: boolean;
  /** Keep the result on screen N seconds after the end. 0 = until cleared. */
  resultSec: number;
  barColor: string;
  textColor: string;
  fontFamily: string;
}

export interface PollState {
  id: string;
  question: string;
  options: { label: string; votes: number }[];
  total: number;
  status: 'running' | 'ended';
  endsAt: number | null;
  /** Indexes of the leading options (several on a tie). */
  leaders: number[];
}

export interface GiveawaySettings {
  title: string;
  /** Word to type in chat to enter, e.g. "!участвую". */
  keyword: string;
  eligible: Permission;
  /** Tickets for subscribers (1 = same chance as everyone). */
  subLuck: number;
  announceOpen: string;
  announceWinner: string;
  accentColor: string;
  fontFamily: string;
}

export interface GiveawayEntrant {
  userId: string;
  userName: string;
  platform: Platform;
  tickets: number;
}

export interface GiveawayState {
  status: 'idle' | 'open' | 'closed' | 'rolling' | 'done';
  entrants: GiveawayEntrant[];
  winner: GiveawayEntrant | null;
  /** What the winner wrote after being picked, so the streamer sees they are alive. */
  winnerMessages: { text: string; at: number }[];
}

export type QuizDifficulty = 'easy' | 'normal' | 'hard';

export interface QuizSettings {
  rounds: number;
  roundSec: number;
  revealSec: number;
  difficulty: QuizDifficulty;
  /** Open letters of the answer as time runs out. */
  hints: boolean;
  announce: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface QuizState {
  status: 'idle' | 'loading' | 'question' | 'reveal' | 'finished' | 'error';
  round: number;
  rounds: number;
  imageUrl: string | null;
  hint: string;
  endsAt: number | null;
  answer: { title: string; posterUrl: string | null; url: string } | null;
  winner: string | null;
  leaderboard: { userName: string; points: number }[];
  error?: string;
}

// ---------- Kawaki ----------

export interface KawakiNowWatching {
  animeId: string;
  externalId: number;
  title: string;
  titleEn: string | null;
  posterUrl: string | null;
  episode: number | null;
  episodesTotal: number | null;
  progressSec: number | null;
  durationSec: number | null;
  url: string;
  /** "live" = the Kawaki player is open right now; "list" = latest title from the Watching list. */
  source: 'live' | 'list';
}

export interface KawakiPartner {
  slug: string;
  displayName: string;
  liveUrl: string;
}

export interface KawakiState extends ConnectionState {
  deviceCode?: DeviceCodePrompt;
  nowWatching: KawakiNowWatching | null;
  partner: KawakiPartner | null;
}

export interface KawakiSettings {
  baseUrl: string;
  /** Update the stream title when the anime or episode changes. */
  autoTitle: boolean;
  titleTemplate: string;
  /** Reply of the !anime command. */
  commandTemplate: string;
  /** Keep showing the last title when nothing is playing. */
  keepLast: boolean;
  showPoster: boolean;
  showProgress: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface Settings {
  version: 1;
  language: Language;
  overlayPort: number;
  twitch: { clientId: string };
  donationalerts: { clientId: string; enabled: boolean };
  streamlabs: { enabled: boolean };
  streamelements: { enabled: boolean; channelId: string };
  streamerbot: { enabled: boolean; port: number };
  discord: { enabled: boolean; notifyLive: boolean; notifyOffline: boolean; notifyDonations: boolean };
  obs: { host: string; port: number; autoConnect: boolean };
  bot: BotSettings;
  alerts: AlertSettings;
  chatOverlay: ChatOverlaySettings;
  goals: Goal[];
  timers: OverlayTimer[];
  actions: QuickAction[];
  banners: Banner[];
  ads: AdCampaign[];
  labels: Label[];
  stats: StreamStats;
  emoteRain: EmoteRainSettings;
  wheels: Wheel[];
  poll: PollSettings;
  giveaway: GiveawaySettings;
  quiz: QuizSettings;
  boss: BossSettings;
  kawaki: KawakiSettings;
  /** Main currency for donation totals (goals, subathon). */
  currency: string;
  minimizeToTray: boolean;
}

export type SettingsKey = keyof Settings;

// ---------- Overlay wire protocol ----------

export type OverlayKind = 'chat' | 'alerts' | 'goal' | 'timer' | 'events' | 'banner' | 'ad' | 'label' | 'emotes' | 'wheel' | 'poll' | 'giveaway' | 'kawaki' | 'quiz' | 'boss' | 'live' | 'spotlight';

export interface RenderedBanner extends Omit<Banner, 'slides'> {
  slides: { id: string; text: string; image: string | null }[];
  shown: boolean;
}

export interface GiveawayOverlayState {
  status: GiveawayState['status'];
  count: number;
  /** A sample of entrant names for the roll animation. */
  names: string[];
  winner: string | null;
}

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
  | { type: 'banner'; banner: RenderedBanner | null }
  | { type: 'ad'; campaign: AdCampaign | null; endsAt: number | null }
  | { type: 'boss'; boss: BossState; style: BossSettings; lang: Language }
  | { type: 'live'; stream: StreamInfo; lang: Language }
  | { type: 'spotlight'; message: ChatMessage | null }
  | { type: 'label'; label: (Label & { text: string }) | null }
  | { type: 'emoteConfig'; config: EmoteRainSettings }
  | { type: 'emotes'; urls: string[]; burst?: boolean }
  | { type: 'wheel'; wheel: Wheel | null; lastWinnerId: string | null }
  | { type: 'wheelSpin'; spin: WheelSpin }
  | { type: 'poll'; poll: PollState | null; style: PollSettings; now: number; lang: Language }
  | { type: 'giveaway'; state: GiveawayOverlayState; style: GiveawaySettings; lang: Language }
  | { type: 'kawaki'; now: KawakiNowWatching | null; style: KawakiSettings; lang: Language }
  | { type: 'quiz'; quiz: QuizState; style: QuizSettings; now: number; lang: Language }
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
  'streamelements:connect': (channelId: string, token: string) => void;
  'streamelements:disconnect': () => void;
  'streamerbot:connect': (port: number) => void;
  'streamerbot:disconnect': () => void;
  'streamerbot:refresh': () => void;
  'discord:connect': (url: string) => void;
  'discord:disconnect': () => void;
  'discord:test': () => void;
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
  'banner:showNow': (bannerId: string) => void;
  'stats:reset': () => void;
  'emotes:test': () => void;
  'wheel:spin': (wheelId: string) => void;
  'poll:start': () => void;
  'poll:end': () => void;
  'poll:clear': () => void;
  'giveaway:open': () => void;
  'giveaway:close': () => void;
  'giveaway:roll': () => void;
  'giveaway:reset': () => void;
  'quiz:start': () => void;
  'quiz:skip': () => void;
  'quiz:stop': () => void;
  'boss:start': () => void;
  'boss:reset': () => void;
  'boss:hit': () => void;
  'ad:show': (campaignId: string) => void;
  'ad:hide': () => void;
  'spotlight:show': (messageId: string) => void;
  'spotlight:clear': () => void;
  'update:check': () => void;
  'update:install': () => void;
  'kawaki:login': () => void;
  'kawaki:logout': () => void;
  'kawaki:cancelLogin': () => void;
  'kawaki:refresh': () => void;
  /** Create a browser source in the current OBS scene. */
  'obs:addBrowserSource': (name: string, url: string, width: number, height: number) => void;
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
