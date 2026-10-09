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
      amountMainCurrency?: string;
      message: string;
    })
  | (EventBase & { type: 'redemption'; rewardTitle: string; rewardId?: string; cost: number; input: string });

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

/** One StreamHelper overlay placed in an OBS scene. */
export interface ObsAppSource {
  /** Top-level scene the overlay is shown in. */
  scene: string;
  /** Group or StreamHelper container scene that holds the item; null = directly in the scene. */
  parent: string | null;
  parentType: 'group' | 'container' | null;
  /** Scene (or group) the item id belongs to. */
  itemScene: string;
  itemId: number;
  sourceName: string;
  kind: OverlayKind;
  /** Instance id (`?id=`): a goal, label, custom overlay... */
  id: string | null;
  /** Per-scene settings variant (`?v=`). */
  variant: string | null;
  enabled: boolean;
}

export interface ObsState extends ConnectionState {
  scenes: string[];
  currentScene: string;
  /** StreamHelper browser sources found in every scene, including inside groups and our container scenes. */
  appSources: ObsAppSource[];
  /** Nested scenes StreamHelper uses as its "StreamHelper" group (hidden from scene pickers). */
  containers: string[];
  sceneItems: ObsSceneItem[];
  inputs: { name: string; muted: boolean }[];
  streaming: boolean;
  recording: boolean;
}

export interface RuntimeState {
  /** `missingScopes`: permissions added in newer versions that the saved login lacks (reconnect to grant). */
  twitch: ConnectionState & { deviceCode?: DeviceCodePrompt; subscriptionErrors?: Record<string, string>; missingScopes?: string[] };
  kawaki: KawakiState;
  twitchBot: ConnectionState & { deviceCode?: DeviceCodePrompt };
  donationalerts: ConnectionState;
  streamlabs: ConnectionState;
  streamelements: ConnectionState;
  streamerbot: ConnectionState & { actions: { id: string; name: string }[] };
  discord: ConnectionState;
  subForStream: ConnectionState & { overlayUrl: string };
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
  music: MusicRuntimeState;
  songRequests: SongRequestState;
  update: UpdateState;
  dockUrl: string;
  /** Banners currently on screen (manual toggle or schedule). */
  bannersShown: string[];
  viewerQueue: ViewerQueueState;
  guess: GuessState;
  hype: HypeState;
  /** Most active chatters since the app started (or the last reset). */
  chatLeaders: ChatLeader[];
  clipper: ClipperState;
  curse: CurseState;
  duel: DuelState;
  melody: MelodyState;
  ducking: DuckingState;
  market: MarketState;
  portal: PortalState;
  report: ReportState;
  shield: ShieldState;
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
  /** Position in the browser source, in percent. */
  x: number;
  y: number;
  width: number;
  anchor: 'center' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
  safeMargin: number;
  imageWidth: number;
  imageHeight: number;
  messageFontSize: number;
  textAlign: 'left' | 'center' | 'right';
  backgroundColor: string;
  backgroundOpacity: number;
  padding: number;
  borderRadius: number;
}

export interface AlertSettings {
  gapSec: number;
  style: AlertStyle;
  types: Record<AlertType, AlertVariant>;
  donationTiers: { id: string; minAmount: number; variant: AlertVariant; style?: AlertStyle }[];
}

export type ChatBackgroundStyle = 'card' | 'glass' | 'gradient' | 'outline' | 'neon' | 'stripe' | 'bubble' | 'none';
export type ChatEnterAnimation = 'none' | 'fade' | 'slideUp' | 'slideSide' | 'zoom' | 'bounce' | 'blur' | 'drop' | 'swing' | 'glitch';
export type ChatExitAnimation = 'none' | 'fade' | 'slideSide' | 'slideUp' | 'shrink' | 'blur' | 'pop' | 'glitch';

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
  accentColor: string;
  backgroundStyle: ChatBackgroundStyle;
  backgroundMedia: string | null;
  backgroundMediaOpacity: number;
  shadow: boolean;
  borderRadius: number;
  paddingX: number;
  paddingY: number;
  gap: number;
  align: 'left' | 'right';
  messageWidth: number;
  enterAnimation: ChatEnterAnimation;
  exitAnimation: ChatExitAnimation;
  enterMs: number;
  exitMs: number;
  showTimestamp: boolean;
  showReply: boolean;
  nameColor: 'user' | 'accent' | 'text';
}

export interface SpotlightOverlaySettings {
  autoHighlighted: boolean;
  mode: 'single' | 'stack' | 'rain';
  cardStyle: 'solid' | 'glass' | 'outline';
  fontSize: number;
  accentColor: string;
  textColor: string;
  background: string;
  durationSec: number;
  maxMessages: number;
  gravity: number;
  bounce: number;
  x: number;
  y: number;
  fontFamily: string;
}

export type GoalKind = 'followers' | 'subs' | 'bits' | 'donations' | 'chatMessages' | 'chatters' | 'manual';

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
  donationMinAmount?: number;
  donationMaxAmount?: number;
  donationSources?: DonationSource[];
  showPercent?: boolean;
  showAmounts?: boolean;
  fontFamily?: string;
  /** Internal count for the unique-chatters activity; persisted across restarts. */
  chattersSeen?: string[];
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
  | { type: 'clipMoment' }
  | { type: 'shieldToggle' }
  | { type: 'curseVote' }
  /** Set a custom variable; `value` is a template, "+5" / "-1" change a number. */
  | { type: 'variable'; name: string; value: string }
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
  /** Ticker strip width, percent of the browser source (placed by `align`). */
  tickerWidth?: number;
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
export type AdEntrance = 'fade' | 'slideUp' | 'slideDown' | 'slideSide' | 'zoom' | 'bounce' | 'flip' | 'blur' | 'wipe' | 'glitch' | 'rotate' | 'drop' | 'pulse' | 'curtain';

export interface RewardOverlaySettings {
  maxItems: number;
  showInput: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface EventsOverlaySettings {
  fontFamily: string;
  fontSize: number;
  textColor: string;
  background: string;
}

export interface LiveOverlaySettings {
  fontFamily: string;
  accentColor: string;
}

export interface CollabOverlaySettings {
  title: string;
  guests: string[];
  showRaids: boolean;
  accentColor: string;
  fontFamily: string;
}

export type MusicSourceKind = 'spotify' | 'yandex' | 'browser' | 'other';
export type MusicSourcePreference = 'auto' | MusicSourceKind | 'any';

export interface MusicTrack {
  source: MusicSourceKind;
  title: string;
  artist: string;
  album: string;
  artwork: string | null;
  playing: boolean;
  positionMs: number | null;
  durationMs: number | null;
  observedAt: number;
}

export interface MusicRuntimeState {
  status: 'connecting' | 'ready' | 'unavailable';
  track: MusicTrack | null;
  sources: MusicSourceKind[];
}

export interface SongRequest {
  id: string;
  videoId: string;
  url: string;
  userName: string;
  source: 'redemption' | 'donation' | 'chat' | 'manual';
  requestedAt: number;
  /** Video title from YouTube, when it could be looked up. */
  title?: string;
  /** Channel-points redemption to fulfil or refund (Twitch `redemption.id` / `reward.id`). */
  redemption?: { id: string; rewardId: string };
}

export interface SongRequestSettings {
  enabled: boolean;
  rewardTitle: string;
  rewardId: string;
  /** Answer viewers in chat: queued with position, or why the link was rejected. */
  replyInChat: boolean;
  /** Return channel points when a request is rejected, cannot play or is removed. */
  refundRejected: boolean;
  /** Who hears the song player: OBS audio monitoring of the Song Request source. */
  listen: SongListen;
  chatEnabled: boolean;
  chatCommand: string;
  chatPermission: Permission;
  chatCooldownSec: number;
  minDonation: number;
  autoPlay: boolean;
  pauseWindowsMusic: boolean;
  resumeWindowsMusic: boolean;
  maxQueue: number;
  videoLayout: 'full' | 'compact' | 'queue';
  videoPosition: 'left' | 'right';
  videoWidth: number;
  showRequester: boolean;
  showTitle: boolean;
  showQueueCount: boolean;
  showControls: boolean;
  volume: number;
  accentColor: string;
  backgroundOpacity: number;
  fontFamily: string;
}

/** viewers = stream only, both = stream + streamer's headphones, me = headphones only. */
export type SongListen = 'viewers' | 'both' | 'me';

export interface SongRequestState {
  queue: SongRequest[];
  current: SongRequest | null;
  /** The playing track is paused by the streamer. */
  paused: boolean;
  /** Result of applying `listen` to the Song Request sources in OBS. */
  obsAudio: { sources: number; error: string | null } | null;
  playerConnected: boolean;
  lastError: string | null;
  /** Last viewer request that was turned down, shown to the streamer. */
  lastRejected?: { userName: string; reason: string; at: number } | null;
}

export interface MusicOverlaySettings {
  source: MusicSourcePreference;
  style: 'card' | 'glass' | 'minimal';
  showArtwork: boolean;
  showAlbum: boolean;
  showProgress: boolean;
  hideWhenPaused: boolean;
  accentColor: string;
  layout: 'horizontal' | 'vertical';
  coverSize: number;
  fontSize: number;
  backgroundOpacity: number;
  showSource: boolean;
  fontFamily: string;
}

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
  fontFamily?: string;
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
  fontFamily: string;
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

// ---------- Viewer queue, guess the number, counters, hype, chat leaders ----------

export interface ViewerQueueSettings {
  title: string;
  /** Chat commands without prefix. */
  joinCommand: string;
  leaveCommand: string;
  eligible: Permission;
  /** 0 = unlimited. */
  maxSize: number;
  /** Subscribers join ahead of non-subscribers. */
  subPriority: boolean;
  announce: boolean;
  /** Names shown on the overlay. */
  showCount: number;
  accentColor: string;
  fontFamily: string;
}

export interface QueueEntry {
  userId: string;
  userName: string;
  platform: Platform;
  sub: boolean;
  joinedAt: number;
}

export interface ViewerQueueState {
  open: boolean;
  entries: QueueEntry[];
  /** Picked viewers ("playing now"), latest first. */
  picked: QueueEntry[];
}

export interface GuessSettings {
  min: number;
  max: number;
  /** 0 = until someone guesses. */
  durationSec: number;
  /** Per-viewer pause between guesses. */
  cooldownSec: number;
  announce: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface GuessState {
  status: 'idle' | 'running' | 'won' | 'ended';
  min: number;
  max: number;
  /** The range still possible after the "higher / lower" hints. */
  low: number;
  high: number;
  attempts: number;
  endsAt: number | null;
  winner: string | null;
  /** Revealed only when the round is over. */
  answer: number | null;
  lastGuess: { user: string; value: number; hint: 'higher' | 'lower' | 'exact' } | null;
}

export interface CounterOverlay {
  id: string;
  /** Bot counter name, e.g. "deaths" ({count:deaths}). */
  counter: string;
  title: string;
  style: 'card' | 'minimal' | 'badge';
  fontFamily: string;
  fontSize: number;
  textColor: string;
  accentColor: string;
}

export interface HypeSettings {
  title: string;
  /** Points needed for each level. */
  levelPoints: number;
  maxLevel: number;
  points: { follow: number; sub: number; bitsPer100: number; donationPerUnit: number; raidPerViewer: number; chatMessage: number; redemption: number };
  /** Percent of points lost per minute without new hype. */
  decayPerMin: number;
  hideWhenEmpty: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface HypeState {
  points: number;
  level: number;
  /** 0..1 inside the current level. */
  progress: number;
  lastBumpAt: number;
}

export interface LeadersOverlaySettings {
  title: string;
  count: number;
  showCounts: boolean;
  /** Logins never ranked (bots). */
  exclude: string[];
  accentColor: string;
  fontFamily: string;
}

export interface ChatLeader {
  userId: string;
  userName: string;
  color?: string;
  messages: number;
}

// ---------- Auto clipper ("Moment!") ----------

export type ClipReason = 'burst' | 'keywords' | 'vote' | 'manual';

export interface ClipperSettings {
  enabled: boolean;
  /** Rolling window the chat burst is measured in. */
  windowSec: number;
  /** A burst = this many times the usual chat speed. */
  sensitivity: number;
  /** Fewer messages than this in the window never count as a burst (quiet chats). */
  minMessages: number;
  /** Reaction words ("KEKW", "ахах"): this many messages with them in the window is a moment too. */
  keywords: string[];
  keywordHits: number;
  /** Viewers vote with a command; this many different viewers in the window make a clip. 0 = off. */
  voteCommand: string;
  voteThreshold: number;
  cooldownSec: number;
  createClip: boolean;
  createMarker: boolean;
  onlyWhenLive: boolean;
  /** Post the clip link to chat. {url}, {reason}. Empty = silent. */
  announce: string;
  sendToDiscord: boolean;
}

export interface ClipMoment {
  id: string;
  at: number;
  reason: ClipReason;
  /** How strong the reaction was: messages in the window divided by the usual speed. */
  score: number;
  messages: number;
  sample: { user: string; text: string }[];
  clipId?: string;
  clipUrl?: string;
  editUrl?: string;
  /** Stream time of the marker, seconds. */
  markerSec?: number;
  error?: string;
}

export interface ClipperState {
  moments: ClipMoment[];
  /** Chat speed in the current window and the usual speed, messages per window. */
  rate: number;
  baseline: number;
  busy: boolean;
  lastError: string | null;
}

// ---------- Curses (chat votes a handicap for the streamer) ----------

export type CurseStep =
  | { type: 'filter'; source: string; filter: string }
  | { type: 'source'; scene: string; source: string; show: boolean }
  | { type: 'mute'; input: string };

export interface Curse {
  id: string;
  enabled: boolean;
  name: string;
  description: string;
  durationSec: number;
  /** OBS changes while the curse lasts; all of them are undone at the end. Empty = a challenge for the streamer. */
  steps: CurseStep[];
}

export interface CurseSettings {
  curses: Curse[];
  /** Curses offered per vote. */
  choices: number;
  voteSec: number;
  /** Start a vote automatically every N minutes while live. 0 = off. */
  autoEveryMin: number;
  /** Channel-points reward that starts a vote. */
  redemptionTitle: string;
  announce: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface CurseOption {
  id: string;
  name: string;
  description: string;
  durationSec: number;
  votes: number;
}

export interface CurseState {
  status: 'idle' | 'voting' | 'active';
  options: CurseOption[];
  total: number;
  endsAt: number | null;
  active: { id: string; name: string; description: string; startedAt: number; endsAt: number } | null;
  lastError: string | null;
}

// ---------- Music duel ----------

export interface DuelSettings {
  /** Seconds of each track. */
  snippetSec: number;
  /** Skip intros: start this many seconds into the video. */
  startOffsetSec: number;
  voteSec: number;
  winnerAction: 'playNext' | 'playNow' | 'none';
  loserAction: 'remove' | 'keep';
  volume: number;
  announce: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface DuelSide {
  requestId: string;
  videoId: string;
  title: string;
  userName: string;
  votes: number;
}

export interface DuelState {
  status: 'idle' | 'playingA' | 'playingB' | 'voting' | 'done';
  a: DuelSide | null;
  b: DuelSide | null;
  endsAt: number | null;
  winner: 'a' | 'b' | 'tie' | null;
  /** YouTube refused a track (removed, embedding blocked); shown to the streamer. */
  error: string | null;
}

// ---------- Guess the melody ----------

export interface MelodyTrack {
  id: string;
  videoId: string;
  title: string;
  /** Accepted answers (song names). */
  answers: string[];
  artist: string;
}

export interface MelodySettings {
  playlist: MelodyTrack[];
  rounds: number;
  /** First snippet length; the hint replays a longer one. */
  snippetSec: number;
  roundSec: number;
  /** Replay a longer snippet and open first letters after N seconds. 0 = no hint. */
  hintAfterSec: number;
  revealSec: number;
  /** Naming the artist counts too. */
  acceptArtist: boolean;
  volume: number;
  announce: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface MelodyState {
  status: 'idle' | 'playing' | 'reveal' | 'finished';
  round: number;
  rounds: number;
  endsAt: number | null;
  /** Changes every time the overlay should (re)play a snippet. */
  playId: string | null;
  videoId: string | null;
  /** Where the snippet starts, as a share of the video length. */
  startFraction: number;
  snippetSec: number;
  hint: string;
  answer: { title: string; videoId: string } | null;
  winner: string | null;
  leaderboard: { userName: string; points: number }[];
  /** YouTube refused the last track; the round was skipped. */
  error: string | null;
}

// ---------- Audio ducking ----------

export interface DuckingSettings {
  enabled: boolean;
  /** OBS input of the streamer's microphone. */
  micInput: string;
  thresholdDb: number;
  /** OBS inputs turned down while the streamer talks. */
  targets: string[];
  /** Target volume while ducked, percent of the normal volume. */
  duckPercent: number;
  /** Voice must last this long before ducking (ignores clicks). */
  attackMs: number;
  /** Silence this long before the music comes back. */
  releaseMs: number;
  fadeMs: number;
  duckOnAlerts: boolean;
}

export interface DuckingState {
  /** OBS sends audio levels. */
  listening: boolean;
  ducked: boolean;
  levelDb: number;
  reason: 'voice' | 'alert' | null;
  error: string | null;
}

// ---------- Viewer stock exchange ----------

export interface MarketSettings {
  enabled: boolean;
  currencyName: string;
  startBalance: number;
  earnPerMessage: number;
  earnCooldownSec: number;
  /** Paid every tick to everyone who chatted recently. */
  activeIncome: number;
  /** Messages a viewer needs before their stock is listed. */
  listMinMessages: number;
  ipoPrice: number;
  tickSec: number;
  /** Max share of the price an activity tick can move it, percent. */
  volatility: number;
  /** Percent lost per tick while the viewer is silent on a live stream. */
  decayPct: number;
  /** Price move per trade, percent (grows with the square root of the shares). */
  impactPct: number;
  /** Paid to shareholders when the viewer chats, percent of the price per share (once per tick). */
  dividendPct: number;
  commands: { market: string; buy: string; sell: string; portfolio: string; balance: string; price: string };
  exclude: string[];
  tickerCount: number;
  /** Market news in chat: IPOs, crashes and rallies. */
  announceNews: boolean;
  accentColor: string;
  fontFamily: string;
}

export interface StockQuote {
  userId: string;
  name: string;
  price: number;
  /** Change since the session open, percent. */
  change: number;
  history: number[];
  holders: number;
}

export interface MarketState {
  quotes: StockQuote[];
  richest: { name: string; worth: number }[];
  traders: number;
  lastTrade: { user: string; stock: string; qty: number; price: number; side: 'buy' | 'sell'; at: number } | null;
}

// ---------- Portal (chat bridge with a partner channel) ----------

export interface PortalSettings {
  enabled: boolean;
  /** Twitch login of the partner channel. */
  partner: string;
  /** command = only "!портал text"; all = every message (rate limited). */
  mode: 'command' | 'all';
  command: string;
  maxPerMinute: number;
  /** Also show our viewers' portal messages flying into the portal. */
  showOutgoing: boolean;
  /** Repeat partner messages in our chat via the bot. */
  relayToChat: boolean;
  durationSec: number;
  side: 'left' | 'right';
  accentColor: string;
  fontFamily: string;
}

export interface PortalMessage {
  id: string;
  direction: 'in' | 'out';
  userName: string;
  color?: string;
  text: string;
  fragments: ChatFragment[];
  channel: string;
  at: number;
}

export interface PortalState {
  status: ConnectionStatus;
  channel: string;
  error?: string;
  messages: PortalMessage[];
}

// ---------- Stream report ----------

export interface ReportSettings {
  autoGenerate: boolean;
  postToChat: boolean;
  sendToDiscord: boolean;
  accentColor: string;
  /** Words never counted as "word of the stream". */
  stopWords: string[];
}

export interface ReportSummary {
  startedAt: number;
  endedAt: number | null;
  title: string;
  category: string;
  peakViewers: number;
  avgViewers: number;
  messages: number;
  chatters: number;
  mvp: { name: string; messages: number; color?: string }[];
  topWord: { word: string; count: number } | null;
  topEmote: { name: string; url: string; count: number } | null;
  follows: number;
  subs: number;
  gifts: number;
  bits: number;
  donations: number;
  currency: string;
  topDonation: { name: string; amount: number; currency: string } | null;
  raids: { name: string; viewers: number }[];
  /** Busiest minute of chat: the drama of the evening. */
  drama: { at: number; messages: number; quote: { user: string; text: string } | null } | null;
  bestClip: { url: string; reason: ClipReason; at: number } | null;
  clips: number;
}

export interface SavedReport {
  id: string;
  createdAt: number;
  summary: ReportSummary;
  imageUrl: string;
}

export interface ReportState {
  live: ReportSummary;
  reports: SavedReport[];
  busy: boolean;
}

// ---------- Raid shield ----------

export interface ShieldSettings {
  enabled: boolean;
  windowSec: number;
  /** Chatters never seen on this channel before, inside the window. */
  newChatters: number;
  /** Different viewers posting the same text inside the window. */
  similar: number;
  /** Accounts younger than `youngDays` among the new chatters. 0 = off. */
  youngDays: number;
  young: number;
  /** After a real raid new chatters are expected: thresholds are multiplied for this long. */
  raidGraceSec: number;
  exempt: Permission;
  followersOnly: boolean;
  followersMinutes: number;
  slowMode: boolean;
  slowSec: number;
  emoteOnly: boolean;
  shieldMode: boolean;
  deleteMessages: boolean;
  /** Time out the suspects, seconds. 0 = off. */
  timeoutSec: number;
  /** Lift the protection automatically. 0 = only by hand. */
  autoReleaseMin: number;
  announce: string;
}

export interface ShieldSuspect {
  userId: string;
  userName: string;
  text: string;
  at: number;
}

export interface ShieldState {
  status: 'off' | 'watching' | 'active';
  /** Current readings inside the window. */
  readings: { newChatters: number; similar: number; young: number };
  reason: string | null;
  activatedAt: number | null;
  releaseAt: number | null;
  suspects: ShieldSuspect[];
  history: { at: number; reason: string; suspects: number; manual: boolean }[];
  error: string | null;
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

// ---------- Donation board ----------

export interface DonationRecord {
  id: string;
  name: string;
  amount: number;
  currency: string;
  /** Amount in the main currency, when known (top lists compare these). */
  amountMain: number | null;
  message: string;
  source: DonationSource;
  at: number;
}

/** latest = newest first, top = biggest donors (summed), all = every donation one by one, total = sum. */
export type DonationsPage = 'latest' | 'top' | 'all' | 'total';

export interface DonationsOverlaySettings {
  /** Pages shown in turn. */
  pages: DonationsPage[];
  pageSec: number;
  /** list = several rows, single = one donation at a time, ticker = a scrolling line. */
  layout: 'list' | 'single' | 'ticker';
  /** Rows in "latest" and "top". */
  count: number;
  /** "single" layout: seconds per donation. */
  itemSec: number;
  tickerSpeed: number;
  /** session = since the stats were last reset, all = whole history. */
  period: 'session' | 'all';
  showTitle: boolean;
  showMessage: boolean;
  titles: Record<DonationsPage, string>;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  accentColor: string;
  background: string;
  align: 'left' | 'center' | 'right';
}

export interface DonationsBoard {
  latest: DonationRecord[];
  top: { name: string; amount: number; count: number }[];
  all: DonationRecord[];
  total: number;
  count: number;
  currency: string;
}

// ---------- Custom variables ----------

export interface CustomVariable {
  id: string;
  /** Used as {name} in any template. */
  name: string;
  value: string;
  description: string;
}

// ---------- Overlay designer ----------

interface CustomElementBase {
  id: string;
  name: string;
  /** Position and size in canvas pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** 0..100 */
  opacity: number;
  visible: boolean;
  locked: boolean;
}

export type CustomElement =
  | (CustomElementBase & {
      type: 'text';
      /** Template with variables: {title}, {lastfollower}, {count:deaths}... */
      text: string;
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      italic: boolean;
      uppercase: boolean;
      color: string;
      align: 'left' | 'center' | 'right';
      valign: 'top' | 'middle' | 'bottom';
      letterSpacing: number;
      lineHeight: number;
      strokeColor: string;
      strokeWidth: number;
      shadow: boolean;
      /** Single line: shrink to fit instead of wrapping. */
      autoFit: boolean;
    })
  | (CustomElementBase & { type: 'image'; media: string | null; fit: 'contain' | 'cover' | 'fill'; radius: number })
  | (CustomElementBase & {
      type: 'shape';
      shape: 'rect' | 'ellipse' | 'line';
      fill: string;
      /** Second color: a gradient when set. */
      fill2: string;
      gradientAngle: number;
      borderColor: string;
      borderWidth: number;
      radius: number;
      blur: number;
    })
  | (CustomElementBase & {
      type: 'widget';
      kind: OverlayKind;
      /** Instance of the embedded overlay (a goal, label...). */
      itemId: string | null;
    });

export type CustomElementType = CustomElement['type'];

export interface CustomOverlay {
  id: string;
  name: string;
  width: number;
  height: number;
  /** CSS color behind everything; transparent by default. */
  background: string;
  elements: CustomElement[];
}

/** A custom overlay as sent to the browser source: text templates already filled in. */
export type RenderedCustomOverlay = CustomOverlay;

// ---------- Per-scene overlay settings ----------

export interface OverlayVariant {
  id: string;
  kind: OverlayKind;
  /** OBS scene the variant was made for (also its label). */
  scene: string;
  /** Changed top-level fields of the overlay's settings section. */
  overrides: Record<string, unknown>;
}

export type ObsGroupMode = 'perScene' | 'shared' | 'none';

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
  subForStream: { enabled: boolean; port: number };
  obs: { host: string; port: number; autoConnect: boolean; group: ObsGroupMode };
  bot: BotSettings;
  alerts: AlertSettings;
  chatOverlay: ChatOverlaySettings;
  spotlightOverlay: SpotlightOverlaySettings;
  rewardsOverlay: RewardOverlaySettings;
  eventsOverlay: EventsOverlaySettings;
  liveOverlay: LiveOverlaySettings;
  donationsOverlay: DonationsOverlaySettings;
  /** Donations received (newest first), for the donation board. Not per profile. */
  donationLog: DonationRecord[];
  /** User variables available in every template. Not per profile. */
  variables: CustomVariable[];
  customOverlays: CustomOverlay[];
  overlayVariants: OverlayVariant[];
  collabOverlay: CollabOverlaySettings;
  musicOverlay: MusicOverlaySettings;
  songRequests: SongRequestSettings;
  songQueue: SongRequest[];
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
  viewerQueue: ViewerQueueSettings;
  guess: GuessSettings;
  counterOverlays: CounterOverlay[];
  hype: HypeSettings;
  leadersOverlay: LeadersOverlaySettings;
  clipper: ClipperSettings;
  curses: CurseSettings;
  duel: DuelSettings;
  melody: MelodySettings;
  ducking: DuckingSettings;
  market: MarketSettings;
  portal: PortalSettings;
  report: ReportSettings;
  shield: ShieldSettings;
  /** Main currency for donation totals (goals, subathon). */
  currency: string;
  minimizeToTray: boolean;
  /** App look; shared by all profiles. */
  appearance: AppearanceSettings;
  profiles: StreamProfile[];
  activeProfileId: string;
  workspace: { cards: WorkspaceCard[]; monitor?: MonitorLayout };
}

export type ThemeId = 'midnight' | 'graphite' | 'ocean' | 'oled' | 'light';
/** Windows 11 system backdrop behind the window (needs the glass effect). */
export type WindowMaterial = 'none' | 'mica' | 'acrylic';
export interface AppearanceSettings {
  theme: ThemeId;
  /** #rrggbb */
  accent: string;
  glass: boolean;
  /** 0 = almost opaque panels, 100 = most transparent. */
  glassStrength: number;
  windowMaterial: WindowMaterial;
  density: 'comfortable' | 'compact';
  corners: 'sharp' | 'normal' | 'round';
  /** Percent, applied as the window zoom factor. */
  scale: number;
  animations: boolean;
}

export interface MonitorLayout {
  order: WorkspaceCard[];
  hidden: WorkspaceCard[];
  sizes: Partial<Record<WorkspaceCard, { width: 1 | 2 | 3; height: 'compact' | 'normal' | 'tall' }>>;
  /** Free placement on the dashboard grid. Cards without one are auto-placed from `sizes`. */
  positions: Partial<Record<WorkspaceCard, MonitorRect>>;
}

/** Grid cells: `x`/`w` in columns (of MONITOR_COLS), `y`/`h` in rows. */
export interface MonitorRect { x: number; y: number; w: number; h: number }

/** Modules without an overlay of their own. */
export type ToolModule = 'clipper' | 'ducking' | 'shield' | 'report';

export type WorkspaceCard = 'stream' | 'obs' | 'actions' | 'bot' | 'twitch' | 'donationalerts' | 'streamlabs' | 'streamelements' | 'streamerbot' | 'discord' | 'subforstream' | ToolModule | OverlayKind;

export type ProfileSettingsKey = 'workspace' | 'bot' | 'alerts' | 'chatOverlay' | 'spotlightOverlay' | 'rewardsOverlay' | 'eventsOverlay' | 'liveOverlay' | 'donationsOverlay' | 'customOverlays' | 'overlayVariants' | 'collabOverlay' | 'musicOverlay' | 'songRequests' | 'goals' | 'timers' | 'actions' | 'banners' | 'ads' | 'labels' | 'emoteRain' | 'wheels' | 'poll' | 'giveaway' | 'quiz' | 'boss' | 'kawaki' | 'viewerQueue' | 'guess' | 'counterOverlays' | 'hype' | 'leadersOverlay'
  | 'clipper' | 'curses' | 'duel' | 'melody' | 'ducking' | 'market' | 'portal' | 'report' | 'shield';
export type ProfileConfig = Pick<Settings, ProfileSettingsKey>;
export interface StreamProfile { id: string; name: string; config: ProfileConfig; overlays: OverlayKind[] }

export type SettingsKey = keyof Settings;

// ---------- Overlay wire protocol ----------

export type OverlayKind = 'chat' | 'alerts' | 'goal' | 'timer' | 'events' | 'rewards' | 'collab' | 'music' | 'song' | 'banner' | 'ad' | 'label' | 'emotes' | 'wheel' | 'poll' | 'giveaway' | 'kawaki' | 'quiz' | 'boss' | 'live' | 'spotlight' | 'queue' | 'guess' | 'counter' | 'hype' | 'leaders'
  | 'curse' | 'duel' | 'melody' | 'stocks' | 'portal' | 'donations' | 'custom';

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
  | { type: 'profileVisibility'; visible: boolean }
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
  | { type: 'events'; events: StreamEvent[]; style?: EventsOverlaySettings }
  | { type: 'rewards'; events: StreamEventOf<'redemption'>[]; config: RewardOverlaySettings }
  | { type: 'reward'; event: StreamEventOf<'redemption'> }
  | { type: 'collab'; config: CollabOverlaySettings; raids: StreamEventOf<'raid'>[]; lang: Language }
  | { type: 'collabRaid'; event: StreamEventOf<'raid'> }
  | { type: 'music'; track: MusicTrack | null; config: MusicOverlaySettings; lang: Language }
  | { type: 'song'; request: SongRequest | null; nonce: string | null; paused: boolean; config: SongRequestSettings; queue: SongRequest[]; lang: Language }
  | { type: 'banner'; banner: RenderedBanner | null }
  | { type: 'ad'; campaign: AdCampaign | null; endsAt: number | null }
  | { type: 'boss'; boss: BossState; style: BossSettings; lang: Language; prefix: string }
  | { type: 'live'; stream: StreamInfo; lang: Language; style?: LiveOverlaySettings }
  | { type: 'spotlight'; message: ChatMessage | null }
  | { type: 'spotlightConfig'; config: SpotlightOverlaySettings }
  | { type: 'spotlightRemove'; id: string }
  | { type: 'spotlightRemoveUser'; userId: string }
  | { type: 'label'; label: (Label & { text: string }) | null }
  | { type: 'emoteConfig'; config: EmoteRainSettings }
  | { type: 'emotes'; urls: string[]; burst?: boolean }
  | { type: 'wheel'; wheel: Wheel | null; lastWinnerId: string | null }
  | { type: 'wheelSpin'; spin: WheelSpin }
  | { type: 'poll'; poll: PollState | null; style: PollSettings; now: number; lang: Language }
  | { type: 'giveaway'; state: GiveawayOverlayState; style: GiveawaySettings; lang: Language }
  | { type: 'kawaki'; now: KawakiNowWatching | null; style: KawakiSettings; lang: Language }
  | { type: 'quiz'; quiz: QuizState; style: QuizSettings; now: number; lang: Language }
  | { type: 'queue'; state: ViewerQueueState; style: ViewerQueueSettings; lang: Language; prefix: string }
  | { type: 'guess'; guess: GuessState; style: GuessSettings; now: number; lang: Language }
  | { type: 'counter'; counter: (CounterOverlay & { value: number }) | null }
  | { type: 'hype'; hype: HypeState; style: HypeSettings; lang: Language }
  | { type: 'leaders'; leaders: ChatLeader[]; style: LeadersOverlaySettings; lang: Language }
  | { type: 'curse'; curse: CurseState; style: CurseSettings; now: number; lang: Language }
  | { type: 'duel'; duel: DuelState; style: DuelSettings; now: number; lang: Language }
  | { type: 'melody'; melody: MelodyState; style: MelodySettings; now: number; lang: Language }
  | { type: 'stocks'; quotes: StockQuote[]; lastTrade: MarketState['lastTrade']; style: MarketSettings; lang: Language }
  | { type: 'portalConfig'; config: PortalSettings; channel: string; lang: Language }
  | { type: 'portal'; message: PortalMessage }
  | { type: 'portalDelete'; id: string }
  | { type: 'donations'; board: DonationsBoard; style: DonationsOverlaySettings; lang: Language }
  | { type: 'custom'; overlay: RenderedCustomOverlay | null }
  | { type: 'reload' };

// ---------- IPC ----------

export interface MediaFile {
  name: string;
  url: string;
  kind: 'image' | 'audio' | 'video';
}

/** Request/response calls from renderer to main. */
export interface IpcInvoke {
  'app:init': () => { settings: Settings; state: RuntimeState; chat: ChatMessage[]; events: StreamEvent[]; version: string; windowMaterial: boolean };
  /** `base` is the value the editor started from, so changes made by the app meanwhile survive the save. */
  'settings:set': <K extends SettingsKey>(key: K, value: Settings[K], profileId?: string, base?: Settings[K]) => Settings;
  'settings:reset': (key: SettingsKey) => Settings;
  'profiles:create': (name: string, mode?: 'empty' | 'copy') => Settings;
  'profiles:rename': (id: string, name: string) => Settings;
  'profiles:activate': (id: string) => Settings;
  'profiles:delete': (id: string) => Settings;
  'profiles:overlay': (id: string, kind: OverlayKind, enabled: boolean) => Settings;
  'twitch:login': (account: 'broadcaster' | 'bot') => void;
  'twitch:logout': (account: 'broadcaster' | 'bot') => void;
  'twitch:cancelLogin': (account: 'broadcaster' | 'bot') => void;
  'twitch:updateStream': (patch: { title?: string; categoryId?: string; tags?: string[] }) => void;
  'twitch:searchCategories': (query: string) => Category[];
  'twitch:rewards': () => { id: string; title: string; inputRequired: boolean; enabled: boolean; manageable: boolean }[];
  'twitch:createSongReward': (title: string, cost: number) => { id: string; title: string };
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
  'alerts:test': (type: AlertType, donationAmount?: number, tierId?: string) => void;
  'overlays:test': (kind: 'events' | 'rewards' | 'collab', type: AlertType) => void;
  'alerts:pause': (paused: boolean) => void;
  'alerts:skip': () => void;
  'alerts:replay': (eventId: string) => void;
  'actions:run': (actionId: string) => void;
  'timer:control': (timerId: string, op: 'start' | 'pause' | 'reset' | 'add', seconds?: number) => void;
  'banner:showNow': (bannerId: string) => void;
  'song:add': (url: string) => void;
  'song:play': (id?: string) => void;
  'song:skip': () => void;
  'song:remove': (id: string) => void;
  'song:pause': (paused: boolean) => void;
  /** Move a queued (not playing) request to `index` among the upcoming ones. */
  'song:move': (id: string, index: number) => void;
  'music:control': (source: MusicSourceKind, action: 'play' | 'pause' | 'next') => void;
  'subs:check': () => void;
  'subs:clear': () => void;
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
  'spotlight:test': () => void;
  'spotlight:clear': () => void;
  'queue:open': (open: boolean) => void;
  'queue:next': (random?: boolean) => void;
  'queue:remove': (userId: string) => void;
  'queue:clear': () => void;
  'guess:start': () => void;
  'guess:stop': () => void;
  'counter:add': (name: string, delta: number) => void;
  'hype:add': (points: number) => void;
  'hype:reset': () => void;
  'leaders:reset': () => void;
  'update:check': () => void;
  'update:install': () => void;
  'kawaki:login': () => void;
  'kawaki:logout': () => void;
  'kawaki:cancelLogin': () => void;
  'kawaki:refresh': () => void;
  /** Create a browser source in the current OBS scene. */
  'obs:addBrowserSource': (name: string, url: string, width: number, height: number, scene?: string) => void;
  'obs:refreshAppSources': () => void;
  'obs:setItemEnabled': (sceneName: string, itemId: number, enabled: boolean) => void;
  'obs:removeItem': (sceneName: string, itemId: number) => void;
  /** Move the StreamHelper sources lying loose in a scene into its StreamHelper group. */
  'obs:tidyScene': (scene: string) => number;
  /** Installed system font families. */
  'fonts:system': () => string[];
  'donations:clear': () => void;
  /** Every OBS input and scene name (filters can sit on both). */
  'obs:sources': () => string[];
  'obs:filters': (source: string) => string[];
  'clipper:clip': () => void;
  'curse:vote': () => void;
  'curse:apply': (curseId: string) => void;
  'curse:lift': () => void;
  'curse:cancel': () => void;
  /** Without ids: the next two requests in the song queue. */
  'duel:start': (aId?: string, bId?: string) => void;
  'duel:stop': () => void;
  'melody:start': () => void;
  'melody:skip': () => void;
  'melody:stop': () => void;
  /** Add YouTube links to the playlist; returns how many were added. */
  'melody:add': (urls: string[]) => number;
  'melody:fromSongs': () => number;
  'market:reset': () => void;
  'market:grant': (login: string, amount: number) => void;
  'portal:test': () => void;
  'report:generate': () => void;
  'report:reset': () => void;
  'report:delete': (id: string) => void;
  'report:open': (id?: string) => void;
  'report:copy': (id: string) => void;
  'report:discord': (id: string) => void;
  'shield:activate': () => void;
  'shield:release': () => void;
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
