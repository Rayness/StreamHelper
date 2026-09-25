import type { ChatBadge, ChatFragment, ChatMessage, ChatRoles, StreamEvent, SubTier } from '@shared/types';

export type BadgeLookup = (setId: string, version: string) => { imageUrl: string; title: string } | undefined;
/** Third-party emotes (7TV/BTTV/FFZ) by exact word. */
export type EmoteLookup = (word: string) => string | undefined;

const URL_RE = /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:[/?#][^\s]*)?$/i;

export function emoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

/** Split plain text into words so third-party emotes and links become their own fragments. */
export function splitText(text: string, emotes: EmoteLookup): ChatFragment[] {
  const out: ChatFragment[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const emote = /\s/.test(part) ? undefined : emotes(part);
    if (emote) {
      flush();
      out.push({ type: 'emote', text: part, url: emote });
    } else if (URL_RE.test(part) && part.includes('.')) {
      flush();
      out.push({ type: 'link', text: part, url: part.startsWith('http') ? part : `https://${part}` });
    } else {
      buffer += part;
    }
  }
  flush();
  return out;
}

export function rolesFromBadges(badges: { set_id: string }[], isBroadcaster: boolean): ChatRoles {
  const ids = new Set(badges.map((b) => b.set_id));
  return {
    broadcaster: isBroadcaster || ids.has('broadcaster'),
    moderator: ids.has('moderator') || ids.has('lead_moderator'),
    vip: ids.has('vip'),
    subscriber: ids.has('subscriber') || ids.has('founder'),
  };
}

export function normalizeChatMessage(e: any, badgeLookup: BadgeLookup, emoteLookup: EmoteLookup, selfUserIds: string[] = []): ChatMessage {
  let text: string = e.message?.text ?? '';
  let isAction = false;
  const fragments: ChatFragment[] = [];
  for (const f of e.message?.fragments ?? []) {
    switch (f.type) {
      case 'emote':
        fragments.push({ type: 'emote', text: f.text, url: emoteUrl(f.emote.id) });
        break;
      case 'mention':
        fragments.push({ type: 'mention', text: f.text, userLogin: f.mention?.user_login ?? f.text.replace(/^@/, '') });
        break;
      case 'cheermote':
        fragments.push({ type: 'text', text: f.text });
        break;
      default:
        fragments.push(...splitText(f.text ?? '', emoteLookup));
    }
  }
  const ACTION = '\u0001ACTION ';
  if (text.startsWith(ACTION)) {
    isAction = true;
    text = text.slice(ACTION.length).replace(/\u0001$/, '');
    const first = fragments[0];
    if (first?.type === 'text') first.text = first.text.replace(ACTION, '');
    const last = fragments[fragments.length - 1];
    if (last?.type === 'text') last.text = last.text.replace(/\u0001$/, '');
  }

  const rawBadges: { set_id: string; id: string }[] = e.badges ?? [];
  const badges: ChatBadge[] = rawBadges.map((b) => {
    const found = badgeLookup(b.set_id, b.id);
    return { id: b.set_id, version: b.id, imageUrl: found?.imageUrl, title: found?.title };
  });

  return {
    id: e.message_id,
    platform: 'twitch',
    userId: e.chatter_user_id,
    userLogin: e.chatter_user_login,
    userName: e.chatter_user_name,
    color: e.color || undefined,
    badges,
    roles: rolesFromBadges(rawBadges, e.chatter_user_id === e.broadcaster_user_id),
    text,
    fragments,
    timestamp: Date.now(),
    isAction,
    bits: e.cheer?.bits || undefined,
    highlighted: e.message_type === 'channel_points_highlighted',
    replyTo: e.reply
      ? { id: e.reply.parent_message_id, userName: e.reply.parent_user_name, text: e.reply.parent_message_body }
      : undefined,
    fromSelf: selfUserIds.includes(e.chatter_user_id) || undefined,
  };
}

function tier(t: string | undefined): SubTier {
  return t === '3000' || t === '2000' ? t : '1000';
}

let seq = 0;
const eventId = () => `tw_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** Map an EventSub notification to a StreamEvent. Returns null for events that aren't alerts. */
export function normalizeStreamEvent(type: string, e: any, anonymousName = 'Anonymous'): StreamEvent | null {
  const base = { id: eventId(), source: 'twitch' as const, timestamp: Date.now() };
  switch (type) {
    case 'channel.follow':
      return { ...base, type: 'follow', userName: e.user_name, userLogin: e.user_login };
    case 'channel.subscribe':
      // Gifted recipients are covered by the gift event; announcing each one floods the queue.
      if (e.is_gift) return null;
      return { ...base, type: 'sub', userName: e.user_name, userLogin: e.user_login, tier: tier(e.tier), isPrime: false };
    case 'channel.subscription.message':
      return {
        ...base,
        type: 'resub',
        userName: e.user_name,
        userLogin: e.user_login,
        tier: tier(e.tier),
        months: e.cumulative_months ?? 1,
        streak: e.streak_months ?? undefined,
        message: e.message?.text ?? '',
      };
    case 'channel.subscription.gift':
      return {
        ...base,
        type: 'giftsub',
        userName: e.is_anonymous ? anonymousName : e.user_name,
        userLogin: e.is_anonymous ? undefined : e.user_login,
        tier: tier(e.tier),
        count: e.total ?? 1,
        total: e.cumulative_total ?? undefined,
        anonymous: !!e.is_anonymous,
      };
    case 'channel.cheer':
      return {
        ...base,
        type: 'cheer',
        userName: e.is_anonymous ? anonymousName : e.user_name,
        userLogin: e.is_anonymous ? undefined : e.user_login,
        bits: e.bits,
        message: stripCheermotes(e.message ?? ''),
        anonymous: !!e.is_anonymous,
      };
    case 'channel.raid':
      return { ...base, type: 'raid', userName: e.from_broadcaster_user_name, userLogin: e.from_broadcaster_user_login, viewers: e.viewers };
    case 'channel.channel_points_custom_reward_redemption.add':
      return {
        ...base,
        id: e.id ?? base.id,
        type: 'redemption',
        userName: e.user_name,
        userLogin: e.user_login,
        rewardTitle: e.reward?.title ?? '',
        cost: e.reward?.cost ?? 0,
        input: e.user_input ?? '',
      };
    default:
      return null;
  }
}

const CHEER_PREFIXES =
  'cheer|biblethump|cheerwhal|corgo|uni|showlove|party|seemsgood|pride|kappa|frankerz|heyguys|dansgame|elegiggle|trihard|kreygasm|4head|swiftrage|notlikethis|failfish|vohiyo|pjsalt|mrdestructoid|bday|ripcheer|shamrock|bitboss|streamlabs|muxy|holidaycheer|goal|anon|charity';
const CHEERMOTE_RE = new RegExp(`(^|\\s)(?:${CHEER_PREFIXES})\\d+(?=\\s|$)`, 'gi');

/** "Cheer100 great stream" -> "great stream" */
export function stripCheermotes(message: string): string {
  return message
    .replace(CHEERMOTE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
