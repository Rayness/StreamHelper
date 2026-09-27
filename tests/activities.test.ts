import { describe, expect, it } from 'vitest';
import { defaultGoal, defaultSettings } from '@shared/defaults';
import type { ChatMessage, Settings } from '@shared/types';
import type { AppContext } from '../src/main/core/context';
import { EventBus } from '../src/main/core/eventBus';
import { ProgressTracker } from '../src/main/features/progress';

describe('chat activities', () => {
  it('counts messages and unique people, ignores commands, and resets participants', () => {
    const bus = new EventBus();
    let data: Settings = defaultSettings('en');
    const messages = { ...defaultGoal('en'), id: 'messages', kind: 'chatMessages' as const };
    const chatters = { ...defaultGoal('en'), id: 'chatters', kind: 'chatters' as const };
    data = { ...data, goals: [messages, chatters] };
    const ctx = { bus, settings: {
      get: (key: keyof Settings) => data[key],
      set: (key: keyof Settings, value: never) => { data = { ...data, [key]: value }; },
      update: (key: keyof Settings, fn: (value: never) => never) => { data = { ...data, [key]: fn(data[key] as never) }; },
    } } as unknown as AppContext;
    const tracker = new ProgressTracker(ctx);
    const message = { id: '1', platform: 'twitch', userId: 'u1', userLogin: 'ann', userName: 'Ann', color: '#fff', badges: [], roles: { broadcaster: false, moderator: false, vip: false, subscriber: false }, text: 'hello', fragments: [], timestamp: 1 } satisfies ChatMessage;
    bus.emit('chat:message', message);
    bus.emit('chat:message', message);
    bus.emit('chat:message', { ...message, id: '2' });
    bus.emit('chat:message', { ...message, id: '3', text: '!commands' });
    bus.emit('chat:message', { ...message, id: '4', fromSelf: true });
    expect(data.goals.map((goal) => goal.current)).toEqual([2, 1]);
    tracker.addToGoal('chatters', -1);
    bus.emit('chat:message', { ...message, id: '5' });
    expect(data.goals.map((goal) => goal.current)).toEqual([3, 1]);
  });
});
