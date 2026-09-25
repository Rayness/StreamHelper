import type { ChatMessage } from '@shared/types';
import type { EventBus } from '../core/eventBus';

let sampleSeq = 0;
const SAMPLE_USERS = [
  { name: 'StreamHelper', color: '#9B6BFF', roles: { broadcaster: false, moderator: true, vip: false, subscriber: true } },
  { name: 'Viewer_42', color: '#1E90FF', roles: { broadcaster: false, moderator: false, vip: false, subscriber: false } },
  { name: 'КиберКотик', color: '#FF7F50', roles: { broadcaster: false, moderator: false, vip: true, subscriber: true } },
];

/** A realistic message for previewing the chat overlay without going live. */
export function sampleChatMessage(lang: 'ru' | 'en'): ChatMessage {
  const n = sampleSeq++;
  const u = SAMPLE_USERS[n % SAMPLE_USERS.length];
  const text = lang === 'ru' ? ['Привет, чат!', 'Отличный стрим', 'Как дела?'][n % 3] : ['Hello chat!', 'Great stream', 'How is it going?'][n % 3];
  return {
    id: `sample_${Date.now().toString(36)}_${n}`,
    platform: 'twitch',
    userId: `sample_${n % SAMPLE_USERS.length}`,
    userLogin: u.name.toLowerCase(),
    userName: u.name,
    color: u.color,
    badges: [],
    roles: u.roles,
    text: `${text} Kappa`,
    fragments: [
      { type: 'text', text: `${text} ` },
      { type: 'emote', text: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' },
    ],
    timestamp: Date.now(),
    fromSelf: true,
  };
}

/** Recent chat, so the UI and freshly (re)loaded overlays don't start empty. */
export class ChatHistory {
  private messages: ChatMessage[] = [];

  constructor(
    bus: EventBus,
    private limit = 300,
  ) {
    bus.on('chat:message', (m) => {
      this.messages.push(m);
      if (this.messages.length > this.limit) this.messages.splice(0, this.messages.length - this.limit);
    });
    bus.on('chat:delete', ({ id }) => (this.messages = this.messages.filter((m) => m.id !== id)));
    bus.on('chat:clearUser', ({ userId }) => (this.messages = this.messages.filter((m) => m.userId !== userId)));
    bus.on('chat:clear', () => (this.messages = []));
  }

  recent(n = this.limit): ChatMessage[] {
    return this.messages.slice(-n);
  }
}
