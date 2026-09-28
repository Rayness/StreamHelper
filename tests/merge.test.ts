import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/main/core/eventBus';
import { SettingsStore } from '../src/main/core/store';
import { deepEqual, merge3 } from '../src/shared/merge';

describe('merge3', () => {
  it('keeps values the app changed while the form edited something else', () => {
    const base = { prefix: '!', counters: { deaths: 1 } };
    const mine = { prefix: '?', counters: { deaths: 1 } };
    const theirs = { prefix: '!', counters: { deaths: 4, wins: 1 } };
    expect(merge3(base, mine, theirs)).toEqual({ prefix: '?', counters: { deaths: 4, wins: 1 } });
  });

  it('merges lists by id: progress survives a title edit, removals on either side stick', () => {
    const base = [{ id: 'a', title: 'Goal', current: 1 }, { id: 'b', title: 'B', current: 0 }, { id: 'c', title: 'C', current: 0 }];
    const mine = [{ id: 'a', title: 'New goal', current: 1 }, { id: 'c', title: 'C', current: 0 }, { id: 'd', title: 'D', current: 0 }];
    const theirs = [{ id: 'a', title: 'Goal', current: 9 }, { id: 'b', title: 'B', current: 2 }];
    expect(merge3(base, mine, theirs)).toEqual([
      { id: 'a', title: 'New goal', current: 9 },
      { id: 'd', title: 'D', current: 0 },
    ]);
  });

  it('lets the form win a real conflict and returns the app value for an untouched form', () => {
    expect(merge3({ n: 1 }, { n: 2 }, { n: 3 })).toEqual({ n: 2 });
    const theirs = { n: 3 };
    expect(merge3({ n: 1 }, { n: 1 }, theirs)).toBe(theirs);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it('protects counters and goal progress from a stale settings form', () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamhelper-merge-'));
    try {
      const store = new SettingsStore(join(dir, 'settings.json'), new EventBus(), 'en');
      const formBot = store.get('bot');
      const formGoals = store.get('goals');
      store.update('bot', (b) => ({ ...b, counters: { ...b.counters, deaths: 7 } }));
      store.update('goals', (goals) => goals.map((g, i) => (i === 0 ? { ...g, current: 42 } : g)));
      store.setForProfile('bot', { ...formBot, prefix: '?' }, store.get('activeProfileId'), formBot);
      store.setForProfile('goals', formGoals.map((g, i) => (i === 0 ? { ...g, title: 'Renamed' } : g)), undefined, formGoals);
      expect(store.get('bot').prefix).toBe('?');
      expect(store.get('bot').counters.deaths).toBe(7);
      expect(store.get('goals')[0]).toMatchObject({ title: 'Renamed', current: 42 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
