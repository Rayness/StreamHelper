import { describe, expect, it } from 'vitest';
import { defaultBot } from '@shared/defaults';
import type { ChatMessage, ModerationSettings } from '@shared/types';
import { Cooldowns } from '../src/main/bot/cooldowns';
import { capsRatio, extractDomains, isAllowedDomain, matchesBannedWord, Moderator } from '../src/main/bot/moderation';
import { hasPermission } from '../src/main/bot/permissions';
import { parseCommand, randomValue } from '../src/main/bot/variables';

function msg(text: string, roles: Partial<ChatMessage['roles']> = {}, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: Math.random().toString(),
    platform: 'twitch',
    userId: 'u1',
    userLogin: 'user',
    userName: 'User',
    badges: [],
    roles: { broadcaster: false, moderator: false, vip: false, subscriber: false, ...roles },
    text,
    fragments: [{ type: 'text', text }],
    timestamp: 0,
    ...extra,
  };
}

function modSettings(patch: (s: ModerationSettings) => void): ModerationSettings {
  const s = structuredClone(defaultBot('en').moderation);
  patch(s);
  return s;
}

describe('parseCommand', () => {
  it('parses name and args, case-insensitively', () => {
    expect(parseCommand('!Discord now', '!')).toEqual({ name: 'discord', args: ['now'] });
    expect(parseCommand('  !аптайм  ', '!')).toEqual({ name: 'аптайм', args: [] });
    expect(parseCommand('hello !cmd', '!')).toBeNull();
    expect(parseCommand('!', '!')).toBeNull();
  });
});

describe('randomValue', () => {
  it('supports ranges and choices', () => {
    expect(randomValue('1-6', () => 0)).toBe('1');
    expect(randomValue('1-6', () => 0.9999)).toBe('6');
    expect(randomValue('10-1', () => 0)).toBe('1');
    expect(randomValue('heads|tails', () => 0.6)).toBe('tails');
  });
});

describe('permissions', () => {
  it('ranks roles', () => {
    expect(hasPermission(msg('').roles, 'everyone')).toBe(true);
    expect(hasPermission(msg('', { subscriber: true }).roles, 'vip')).toBe(false);
    expect(hasPermission(msg('', { moderator: true }).roles, 'vip')).toBe(true);
    expect(hasPermission(msg('', { broadcaster: true }).roles, 'broadcaster')).toBe(true);
  });
});

describe('Cooldowns', () => {
  it('enforces global and per-user cooldowns', () => {
    let now = 0;
    const cd = new Cooldowns(() => now);
    expect(cd.ready('c', 'a', 10, 60)).toBe(true);
    cd.start('c', 'a', 10, 60);
    expect(cd.ready('c', 'b', 10, 60)).toBe(false);
    now = 11_000;
    expect(cd.ready('c', 'b', 10, 60)).toBe(true);
    expect(cd.ready('c', 'a', 10, 60)).toBe(false);
    now = 61_000;
    expect(cd.ready('c', 'a', 10, 60)).toBe(true);
  });
});

describe('moderation helpers', () => {
  it('finds domains but ignores casual dots', () => {
    expect(extractDomains('go to https://Evil.example/x and www.site.io')).toEqual(['evil.example', 'site.io']);
    expect(extractDomains('ok.so wait.what version 1.5')).toEqual([]);
    expect(extractDomains('check youtube.com/watch')).toEqual(['youtube.com']);
  });
  it('allows subdomains of allowed domains', () => {
    expect(isAllowedDomain('clips.twitch.tv', ['twitch.tv'])).toBe(true);
    expect(isAllowedDomain('nottwitch.tv', ['twitch.tv'])).toBe(false);
  });
  it('computes caps ratio for any alphabet', () => {
    expect(capsRatio('ПРИВЕТ ВСЕМ').ratio).toBe(100);
    expect(capsRatio('Hello').ratio).toBe(20);
    expect(capsRatio('123 !!!').letters).toBe(0);
  });
  it('matches banned words and regex entries', () => {
    expect(matchesBannedWord('You are BADWORD', ['badword'])).toBe(true);
    expect(matchesBannedWord('buy followers cheap', ['/buy\\s+follow/'])).toBe(true);
    expect(matchesBannedWord('fine text', ['/[invalid/', ''])).toBe(false);
  });
});

describe('Moderator', () => {
  it('flags links unless allowed, exempt or permitted', () => {
    let now = 0;
    const m = new Moderator(() => now);
    const s = modSettings((x) => (x.links.enabled = true));
    expect(m.check(msg('visit spam.com'), s)?.filter).toBe('links');
    expect(m.check(msg('clip at twitch.tv/x'), s)).toBeNull();
    expect(m.check(msg('visit spam.com', { vip: true }), s)).toBeNull();
    m.permit('@User', 60);
    expect(m.check(msg('visit spam.com'), s)).toBeNull();
    expect(m.check(msg('visit spam.com'), s)?.filter).toBe('links'); // permit is single-use
    m.permit('user', 60);
    now = 61_000;
    expect(m.check(msg('visit spam.com'), s)?.filter).toBe('links'); // expired
  });

  it('flags caps only above the minimum length', () => {
    const m = new Moderator();
    const s = modSettings((x) => (x.caps.enabled = true));
    expect(m.check(msg('OK LOL'), s)).toBeNull();
    expect(m.check(msg('WHY IS THIS SO LOUD'), s)?.filter).toBe('caps');
  });

  it('flags repeated messages', () => {
    const m = new Moderator(() => 0);
    const s = modSettings((x) => {
      x.spam.enabled = true;
      x.spam.maxRepeats = 2;
    });
    expect(m.check(msg('buy now'), s)).toBeNull();
    expect(m.check(msg('BUY NOW'), s)).toBeNull();
    expect(m.check(msg('buy now'), s)?.filter).toBe('spam');
  });

  it('never moderates our own messages', () => {
    const m = new Moderator();
    const s = modSettings((x) => (x.words.enabled = true, x.words.list = ['bad']));
    expect(m.check(msg('bad', {}, { fromSelf: true }), s)).toBeNull();
  });
});
