import { describe, expect, it } from 'vitest';
import { normalizeChatMessage, normalizeStreamEvent, splitText, stripCheermotes } from '../src/main/platforms/twitch/normalize';

const noBadges = () => undefined;
const noEmotes = () => undefined;

function chatEvent(overrides: Record<string, unknown> = {}) {
  return {
    broadcaster_user_id: '1',
    chatter_user_id: '42',
    chatter_user_login: 'viewer',
    chatter_user_name: 'Viewer',
    message_id: 'm1',
    color: '#FF0000',
    badges: [{ set_id: 'subscriber', id: '12', info: '12' }],
    message_type: 'text',
    message: {
      text: 'hello Kappa @streamer',
      fragments: [
        { type: 'text', text: 'hello ' },
        { type: 'emote', text: 'Kappa', emote: { id: '25' } },
        { type: 'text', text: ' ' },
        { type: 'mention', text: '@streamer', mention: { user_login: 'streamer' } },
      ],
    },
    reply: null,
    cheer: null,
    ...overrides,
  };
}

describe('normalizeChatMessage', () => {
  it('maps fragments, roles and badges', () => {
    const msg = normalizeChatMessage(chatEvent(), (set, v) => (set === 'subscriber' ? { imageUrl: `u/${v}`, title: 'Sub' } : undefined), noEmotes);
    expect(msg).toMatchObject({ id: 'm1', platform: 'twitch', userName: 'Viewer', color: '#FF0000' });
    expect(msg.roles).toEqual({ broadcaster: false, moderator: false, vip: false, subscriber: true });
    expect(msg.badges[0]).toMatchObject({ id: 'subscriber', version: '12', imageUrl: 'u/12' });
    expect(msg.fragments.map((f) => f.type)).toEqual(['text', 'emote', 'text', 'mention']);
    expect(msg.fragments[1]).toMatchObject({ url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' });
  });

  it('detects the broadcaster and self messages', () => {
    const msg = normalizeChatMessage(chatEvent({ chatter_user_id: '1', badges: [] }), noBadges, noEmotes, ['1']);
    expect(msg.roles.broadcaster).toBe(true);
    expect(msg.fromSelf).toBe(true);
  });

  it('strips /me action markers', () => {
    const text = '\u0001ACTION dances\u0001';
    const msg = normalizeChatMessage(chatEvent({ message: { text, fragments: [{ type: 'text', text }] } }), noBadges, noEmotes);
    expect(msg.isAction).toBe(true);
    expect(msg.text).toBe('dances');
    expect(msg.fragments).toEqual([{ type: 'text', text: 'dances' }]);
  });

  it('replaces third-party emotes inside text fragments', () => {
    const msg = normalizeChatMessage(
      chatEvent({ message: { text: 'nice OMEGALUL', fragments: [{ type: 'text', text: 'nice OMEGALUL' }] } }),
      noBadges,
      (w) => (w === 'OMEGALUL' ? 'https://cdn/omega' : undefined),
    );
    expect(msg.fragments).toEqual([
      { type: 'text', text: 'nice ' },
      { type: 'emote', text: 'OMEGALUL', url: 'https://cdn/omega' },
    ]);
  });
});

describe('splitText', () => {
  it('extracts links', () => {
    expect(splitText('see twitch.tv/foo now', noEmotes)).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'twitch.tv/foo', url: 'https://twitch.tv/foo' },
      { type: 'text', text: ' now' },
    ]);
  });
});

describe('normalizeStreamEvent', () => {
  it('maps follows, raids and resubs', () => {
    expect(normalizeStreamEvent('channel.follow', { user_name: 'A', user_login: 'a' })).toMatchObject({ type: 'follow', userName: 'A' });
    expect(normalizeStreamEvent('channel.raid', { from_broadcaster_user_name: 'R', viewers: 9 })).toMatchObject({ type: 'raid', viewers: 9 });
    expect(
      normalizeStreamEvent('channel.subscription.message', { user_name: 'S', tier: '2000', cumulative_months: 5, message: { text: 'hey' } }),
    ).toMatchObject({ type: 'resub', months: 5, tier: '2000', message: 'hey' });
  });

  it('skips gifted-recipient subscribe events', () => {
    expect(normalizeStreamEvent('channel.subscribe', { user_name: 'G', is_gift: true, tier: '1000' })).toBeNull();
    expect(normalizeStreamEvent('channel.subscribe', { user_name: 'G', is_gift: false, tier: '1000' })).toMatchObject({ type: 'sub' });
  });

  it('handles anonymous gifts and cheers', () => {
    expect(normalizeStreamEvent('channel.subscription.gift', { is_anonymous: true, total: 5, tier: '1000' }, 'Anon')).toMatchObject({
      userName: 'Anon',
      count: 5,
      anonymous: true,
    });
    expect(normalizeStreamEvent('channel.cheer', { user_name: 'C', bits: 100, message: 'Cheer100 gg' })).toMatchObject({ bits: 100, message: 'gg' });
  });

  it('ignores unknown types', () => {
    expect(normalizeStreamEvent('channel.ban', {})).toBeNull();
  });
});

describe('stripCheermotes', () => {
  it('removes only real cheermotes', () => {
    expect(stripCheermotes('Cheer100 great stream Kappa50 level99')).toBe('great stream level99');
  });
});
