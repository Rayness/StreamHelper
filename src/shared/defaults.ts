import type {
  AlertSettings,
  AlertType,
  AlertVariant,
  BotSettings,
  BuiltinCommand,
  ChatOverlaySettings,
  Goal,
  Language,
  OverlayTimer,
  QuickAction,
  Settings,
} from './types';

/**
 * Client ID of the StreamHelper application registered at https://dev.twitch.tv/console
 * (client type "Public"). Can be overridden in Settings → Advanced.
 */
export const DEFAULT_TWITCH_CLIENT_ID = '';
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

export function defaultSettings(lang: Language): Settings {
  return {
    version: 1,
    language: lang,
    overlayPort: DEFAULT_OVERLAY_PORT,
    twitch: { clientId: DEFAULT_TWITCH_CLIENT_ID },
    donationalerts: { clientId: DEFAULT_DA_CLIENT_ID, enabled: false },
    streamlabs: { enabled: false },
    obs: { host: '127.0.0.1', port: 4455, autoConnect: true },
    bot: defaultBot(lang),
    alerts: defaultAlerts(lang),
    chatOverlay: defaultChatOverlay(),
    goals: [defaultGoal(lang)],
    timers: [defaultTimer(lang)],
    actions: defaultActions(lang),
    currency: lang === 'ru' ? 'RUB' : 'USD',
    minimizeToTray: true,
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
