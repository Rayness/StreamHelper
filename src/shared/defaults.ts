import type {
  AlertSettings,
  AlertType,
  AlertVariant,
  AdCampaign,
  Banner,
  BossSettings,
  BotSettings,
  BuiltinCommand,
  ChatOverlaySettings,
  GiveawaySettings,
  Goal,
  KawakiSettings,
  Label,
  Language,
  OverlayTimer,
  PollSettings,
  QuickAction,
  QuizSettings,
  Settings,
  StreamStats,
  Wheel,
} from './types';

/**
 * Client ID of the StreamHelper application registered at https://dev.twitch.tv/console
 * (client type "Public"). Can be overridden in Settings → Advanced.
 */
export const DEFAULT_TWITCH_CLIENT_ID = 'l56mrwhn62w53ijpnzgw05g5qbuj3n';
/** Client ID of the StreamHelper application at https://www.donationalerts.com/application/clients */
export const DEFAULT_DA_CLIENT_ID = '';
export const DEFAULT_OVERLAY_PORT = 4848;

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const ALERT_TEXT: Record<Language, Record<AlertType, [title: string, message: string]>> = {
  ru: {
    follow: ['{user} теперь отслеживает канал!', ''],
    sub: ['{user} оформил(а) подписку!', 'Уровень {tier}'],
    resub: ['{user} с нами уже {months} мес.!', '{message}'],
    giftsub: ['{user} дарит {count} подписок!', 'Спасибо за щедрость!'],
    cheer: ['{user} — {amount} битс!', '{message}'],
    raid: ['Рейд от {user}!', '{amount} зрителей залетают на стрим'],
    donation: ['{user} — {amount} {currency}', '{message}'],
    redemption: ['{user} активирует «{reward}»', '{message}'],
  },
  en: {
    follow: ['{user} is now following!', ''],
    sub: ['{user} just subscribed!', 'Tier {tier}'],
    resub: ['{user} resubscribed for {months} months!', '{message}'],
    giftsub: ['{user} gifted {count} subs!', 'Thank you!'],
    cheer: ['{user} cheered {amount} bits!', '{message}'],
    raid: ['{user} is raiding!', 'with {amount} viewers'],
    donation: ['{user} donated {amount} {currency}', '{message}'],
    redemption: ['{user} redeemed "{reward}"', '{message}'],
  },
};

export function defaultAlertVariant(type: AlertType, lang: Language): AlertVariant {
  const [title, message] = ALERT_TEXT[lang][type];
  return {
    enabled: type !== 'redemption',
    minAmount: 0,
    title,
    message,
    durationSec: type === 'follow' ? 5 : 8,
    sound: null,
    volume: 0.6,
    image: null,
    animation: type === 'raid' ? 'bounce' : type === 'donation' ? 'zoom' : 'slide',
    tts: false,
  };
}

export function defaultAlerts(lang: Language): AlertSettings {
  const types = {} as AlertSettings['types'];
  for (const t of Object.keys(ALERT_TEXT[lang]) as AlertType[]) types[t] = defaultAlertVariant(t, lang);
  return {
    gapSec: 1,
    style: { fontFamily: 'Montserrat', fontSize: 40, textColor: '#ffffff', accentColor: '#9b6bff', layout: 'stacked' },
    types,
  };
}

export function defaultBuiltins(lang: Language): BuiltinCommand[] {
  const ru = lang === 'ru';
  return [
    { id: 'uptime', enabled: true, trigger: ru ? 'аптайм' : 'uptime', permission: 'everyone' },
    { id: 'followage', enabled: true, trigger: 'followage', permission: 'everyone' },
    { id: 'commands', enabled: true, trigger: ru ? 'команды' : 'commands', permission: 'everyone' },
    { id: 'title', enabled: true, trigger: 'title', permission: 'moderator' },
    { id: 'game', enabled: true, trigger: 'game', permission: 'moderator' },
    { id: 'shoutout', enabled: true, trigger: 'so', permission: 'moderator' },
    { id: 'counter', enabled: true, trigger: 'count', permission: 'moderator' },
    { id: 'permit', enabled: true, trigger: 'permit', permission: 'moderator' },
    { id: 'anime', enabled: true, trigger: ru ? 'аниме' : 'anime', permission: 'everyone' },
  ];
}

export function defaultBot(lang: Language): BotSettings {
  const ru = lang === 'ru';
  return {
    enabled: true,
    prefix: '!',
    commands: [
      {
        id: uid('cmd_'),
        enabled: true,
        trigger: ru ? 'дс' : 'discord',
        aliases: ['discord'],
        response: ru ? 'Наш Discord: https://discord.gg/ваш-инвайт' : 'Join our Discord: https://discord.gg/your-invite',
        permission: 'everyone',
        cooldownSec: 30,
        userCooldownSec: 0,
        reply: false,
      },
      {
        id: uid('cmd_'),
        enabled: true,
        trigger: ru ? 'смерти' : 'deaths',
        aliases: [],
        response: ru ? 'Смертей на стриме: {count:deaths}' : 'Deaths this stream: {count:deaths}',
        permission: 'everyone',
        cooldownSec: 10,
        userCooldownSec: 0,
        reply: false,
      },
    ],
    builtins: defaultBuiltins(lang),
    timers: [
      {
        id: uid('tmr_'),
        enabled: false,
        name: ru ? 'Соцсети' : 'Socials',
        messages: [ru ? 'Не забудь подписаться на канал! Команды бота: !команды' : "Don't forget to follow! Bot commands: !commands"],
        intervalMin: 15,
        minChatLines: 5,
        onlyWhenLive: true,
      },
    ],
    counters: { deaths: 0 },
    moderation: {
      exempt: 'vip',
      permitSec: 60,
      links: {
        enabled: false,
        action: 'delete',
        timeoutSec: 10,
        warning: ru ? '@{user}, ссылки только с разрешения модератора' : '@{user}, please ask a moderator before posting links',
        allowed: ['twitch.tv', 'youtube.com', 'youtu.be'],
      },
      caps: {
        enabled: false,
        action: 'delete',
        timeoutSec: 10,
        warning: ru ? '@{user}, не кричи :)' : '@{user}, easy on the caps',
        minLength: 12,
        percent: 70,
      },
      words: {
        enabled: false,
        action: 'timeout',
        timeoutSec: 300,
        warning: '',
        list: [],
      },
      spam: {
        enabled: false,
        action: 'timeout',
        timeoutSec: 30,
        warning: ru ? '@{user}, не спамь' : '@{user}, no spam please',
        maxRepeats: 3,
        maxEmotes: 15,
        maxLength: 400,
      },
    },
    eventMessages: {
      follow: '',
      sub: ru ? 'Спасибо за подписку, {user}! <3' : 'Thanks for subscribing, {user}! <3',
      resub: ru ? '{user}, спасибо за {months} мес. поддержки!' : '{user}, thanks for {months} months!',
      giftsub: ru ? '{user} дарит {count} подписок! Спасибо!' : '{user} gifted {count} subs! Thank you!',
      cheer: '',
      raid: ru ? 'Добро пожаловать, рейдеры {user}! Спасибо за рейд!' : 'Welcome raiders from {user}!',
      donation: '',
      redemption: '',
    },
  };
}

export function defaultChatOverlay(): ChatOverlaySettings {
  return {
    fontFamily: 'Inter',
    fontSize: 20,
    showBadges: true,
    showPlatform: false,
    hideAfterSec: 0,
    maxMessages: 30,
    hideCommands: true,
    hideBots: ['nightbot', 'streamelements', 'moobot'],
    direction: 'up',
    background: 'rgba(0,0,0,0.35)',
    textColor: '#ffffff',
    accentColor: '#9b6bff',
    backgroundStyle: 'card',
    backgroundMedia: null,
    backgroundMediaOpacity: 35,
    shadow: false,
    borderRadius: 10,
    paddingX: 10,
    paddingY: 6,
    gap: 6,
    align: 'left',
    messageWidth: 100,
    enterAnimation: 'slideUp',
    exitAnimation: 'slideSide',
    enterMs: 250,
    exitMs: 600,
    showTimestamp: false,
    showReply: false,
    nameColor: 'user',
  };
}

export function defaultGoal(lang: Language): Goal {
  return {
    id: uid('goal_'),
    title: lang === 'ru' ? 'Цель по фолловерам' : 'Follower goal',
    kind: 'followers',
    target: 100,
    current: 0,
    currency: 'RUB',
    barColor: '#9b6bff',
    textColor: '#ffffff',
  };
}

export function defaultTimer(lang: Language): OverlayTimer {
  return {
    id: uid('timer_'),
    title: lang === 'ru' ? 'До конца стрима' : 'Stream ends in',
    mode: 'countdown',
    durationSec: 3600,
    running: false,
    anchorAt: null,
    pausedMs: 3600_000,
    addSec: { sub: 0, giftsubPerSub: 0, bitsPer100: 0, donationPerUnit: 0, follow: 0 },
    fontFamily: 'Montserrat',
    fontSize: 64,
    textColor: '#ffffff',
  };
}

export function defaultActions(lang: Language): QuickAction[] {
  const ru = lang === 'ru';
  return [
    {
      id: uid('act_'),
      label: ru ? 'Смерть +1' : 'Death +1',
      color: '#e5484d',
      hotkey: '',
      showOnDashboard: true,
      steps: [{ type: 'counter', name: 'deaths', delta: 1 }],
    },
    {
      id: uid('act_'),
      label: ru ? 'Пауза алертов' : 'Pause alerts',
      color: '#f5a524',
      hotkey: '',
      showOnDashboard: true,
      steps: [{ type: 'alertsPause' }],
    },
  ];
}

export const WHEEL_COLORS = ['#7c5cff', '#ff5d8f', '#ffb547', '#37d399', '#3fa7ff', '#ff7a45', '#c26bff', '#2ec4b6'];

export function defaultBanner(lang: Language): Banner {
  const ru = lang === 'ru';
  return {
    id: uid('banner_'),
    name: ru ? 'Бегущая строка' : 'Ticker',
    visible: false,
    layout: 'ticker',
    slides: [
      { id: uid('slide_'), text: ru ? 'Последний фолловер: {lastfollower}' : 'Latest follower: {lastfollower}', image: null },
      { id: uid('slide_'), text: ru ? 'Топ донат: {topdonor} — {topdonation}' : 'Top donation: {topdonor} — {topdonation}', image: null },
      { id: uid('slide_'), text: ru ? 'Команды бота: !команды' : 'Bot commands: !commands', image: null },
    ],
    intervalSec: 8,
    tickerSpeed: 90,
    scheduleEveryMin: 0,
    scheduleShowSec: 20,
    fontFamily: 'Montserrat',
    fontSize: 28,
    textColor: '#ffffff',
    background: 'rgba(12,12,18,0.78)',
    accentColor: '#9b6bff',
    align: 'left',
  };
}

export function defaultAd(lang: Language): AdCampaign {
  return {
    id: uid('ad_'),
    name: lang === 'ru' ? 'Рекламная кампания' : 'Ad campaign',
    enabled: false,
    media: null,
    headline: lang === 'ru' ? 'Партнёр эфира' : 'Stream partner',
    caption: '',
    accentColor: '#9b6bff',
    position: 'bottomRight',
    entrance: 'slideUp',
    entranceMs: 550,
    width: 700,
    durationSec: 15,
    everyMin: 0,
    onlyWhenLive: true,
  };
}

export function defaultBoss(lang: Language): BossSettings {
  return {
    name: lang === 'ru' ? 'Босс чата' : 'Chat boss',
    maxHp: 1000,
    damage: 10,
    cooldownSec: 10,
    command: lang === 'ru' ? 'удар' : 'hit',
    redemptionTitle: '',
    accentColor: '#ff5d8f',
    announce: true,
  };
}

export function defaultLabel(lang: Language, template?: string, name?: string): Label {
  const ru = lang === 'ru';
  return {
    id: uid('label_'),
    name: name ?? (ru ? 'Последний фолловер' : 'Latest follower'),
    template: template ?? (ru ? 'Последний фолловер: {lastfollower}' : 'Latest follower: {lastfollower}'),
    fontFamily: 'Montserrat',
    fontSize: 32,
    textColor: '#ffffff',
    align: 'left',
  };
}

export function emptyStats(): StreamStats {
  return {
    lastFollower: '',
    lastSubscriber: '',
    lastCheer: null,
    lastRaid: null,
    lastDonation: null,
    topDonation: null,
    topCheer: null,
    follows: 0,
    subs: 0,
    bits: 0,
    donations: 0,
    since: Date.now(),
  };
}

export function defaultWheel(lang: Language): Wheel {
  const ru = lang === 'ru';
  const labels = ru
    ? ['Приседания ×10', 'Спеть песню', 'Смена игры', 'Ничего', 'Хоррор-челлендж', 'Выбор чата']
    : ['10 squats', 'Sing a song', 'Change game', 'Nothing', 'Horror challenge', "Chat's choice"];
  return {
    id: uid('wheel_'),
    name: ru ? 'Колесо удачи' : 'Wheel of fortune',
    segments: labels.map((label, i) => ({ id: uid('seg_'), label, color: WHEEL_COLORS[i % WHEEL_COLORS.length], weight: 1 })),
    spinSec: 7,
    removeWinner: false,
    announce: ru ? 'Колесо выбрало: {result}!' : 'The wheel says: {result}!',
    command: '',
    commandPermission: 'moderator',
    commandCooldownSec: 30,
    redemptionTitle: '',
    fontFamily: 'Montserrat',
    tickSound: true,
    winSound: null,
    volume: 0.5,
    hideAfterSec: 0,
  };
}

export function defaultPoll(lang: Language): PollSettings {
  const ru = lang === 'ru';
  return {
    question: ru ? 'Во что играем дальше?' : 'What do we play next?',
    options: ru ? ['Хоррор', 'Инди', 'Шутер'] : ['Horror', 'Indie', 'Shooter'],
    durationSec: 90,
    allowChange: true,
    announce: true,
    resultSec: 20,
    barColor: '#9b6bff',
    textColor: '#ffffff',
    fontFamily: 'Montserrat',
  };
}

export function defaultGiveaway(lang: Language): GiveawaySettings {
  const ru = lang === 'ru';
  return {
    title: ru ? 'Розыгрыш' : 'Giveaway',
    keyword: ru ? '!участвую' : '!join',
    eligible: 'everyone',
    subLuck: 2,
    announceOpen: ru ? 'Розыгрыш начался! Пишите {keyword}, чтобы участвовать' : 'Giveaway is open! Type {keyword} to enter',
    announceWinner: ru ? 'Победитель розыгрыша — @{winner}! Поздравляем!' : 'The winner is @{winner}! Congratulations!',
    accentColor: '#ffb547',
    fontFamily: 'Montserrat',
  };
}

export function defaultQuiz(): QuizSettings {
  return {
    rounds: 10,
    roundSec: 40,
    revealSec: 7,
    difficulty: 'normal',
    hints: true,
    announce: true,
    accentColor: '#ff5d6c',
    fontFamily: 'Montserrat',
  };
}

export const DEFAULT_KAWAKI_URL = 'https://kawaki.ru';

export function defaultKawaki(lang: Language): KawakiSettings {
  const ru = lang === 'ru';
  return {
    baseUrl: DEFAULT_KAWAKI_URL,
    autoTitle: false,
    titleTemplate: ru ? 'Смотрим {anime} — серия {episode} | kawaki.ru' : 'Watching {anime} — episode {episode} | kawaki.ru',
    commandTemplate: ru ? 'Смотрим «{anime}», серия {episode}: {animeurl}' : 'Watching "{anime}", episode {episode}: {animeurl}',
    keepLast: true,
    showPoster: true,
    showProgress: true,
    accentColor: '#ff4d4f',
    fontFamily: 'Montserrat',
  };
}

export function defaultSettings(lang: Language): Settings {
  return {
    version: 1,
    language: lang,
    overlayPort: DEFAULT_OVERLAY_PORT,
    twitch: { clientId: '' },
    donationalerts: { clientId: DEFAULT_DA_CLIENT_ID, enabled: false },
    streamlabs: { enabled: false },
    streamelements: { enabled: false, channelId: '' },
    streamerbot: { enabled: false, port: 7474 },
    discord: { enabled: false, notifyLive: true, notifyOffline: false, notifyDonations: true },
    obs: { host: '127.0.0.1', port: 4455, autoConnect: true },
    bot: defaultBot(lang),
    alerts: defaultAlerts(lang),
    chatOverlay: defaultChatOverlay(),
    rewardsOverlay: { maxItems: 5, showInput: true, accentColor: '#9b6bff' },
    collabOverlay: { title: lang === 'ru' ? 'Коллаборация' : 'Collaboration', guests: [], showRaids: true, accentColor: '#9b6bff' },
    goals: [defaultGoal(lang)],
    timers: [defaultTimer(lang)],
    actions: defaultActions(lang),
    banners: [defaultBanner(lang)],
    ads: [defaultAd(lang)],
    labels: [
      defaultLabel(lang),
      defaultLabel(lang, lang === 'ru' ? 'Топ донат: {topdonor} — {topdonation}' : 'Top donation: {topdonor} — {topdonation}', lang === 'ru' ? 'Топ донат' : 'Top donation'),
    ],
    stats: emptyStats(),
    emoteRain: { fromChat: true, maxPerMessage: 5, size: 64, durationSec: 6, style: 'rain', burstOnEvents: true, burstCount: 40 },
    wheels: [defaultWheel(lang)],
    poll: defaultPoll(lang),
    giveaway: defaultGiveaway(lang),
    quiz: defaultQuiz(),
    boss: defaultBoss(lang),
    kawaki: defaultKawaki(lang),
    currency: lang === 'ru' ? 'RUB' : 'USD',
    minimizeToTray: true,
  };
}

/** The Client ID to actually use: the user's override, or the built-in one. */
export function twitchClientId(configured: string): string {
  return configured.trim() || DEFAULT_TWITCH_CLIENT_ID;
}

/**
 * Upgrades that `mergeDefaults` can't do: it keeps stored arrays as-is, so list items added in a
 * new version (like a new built-in command) have to be appended explicitly.
 */
export function migrateSettings(s: Settings): Settings {
  const known = new Set(s.bot.builtins.map((b) => b.id));
  const missing = defaultBuiltins(s.language).filter((b) => !known.has(b.id));
  return {
    ...s,
    bot: missing.length ? { ...s.bot, builtins: [...s.bot.builtins, ...missing] } : s.bot,
    ads: s.ads.map((ad) => ({ ...ad, entrance: ad.entrance ?? 'slideUp', entranceMs: ad.entranceMs ?? 550 })),
  };
}

/** Fill missing keys (new settings added in later versions) without touching user values. */
export function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (defaults === null) return (stored === undefined ? null : stored) as T;
  if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T;
  if (defaults && typeof defaults === 'object') {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults;
    const out: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
    for (const [k, v] of Object.entries(defaults as Record<string, unknown>)) {
      out[k] = mergeDefaults(v, (stored as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return (stored === undefined || typeof stored !== typeof defaults ? defaults : stored) as T;
}
