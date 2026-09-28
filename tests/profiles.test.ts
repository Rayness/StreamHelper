import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/main/core/eventBus';
import { SettingsStore } from '../src/main/core/store';
import { defaultSettings } from '../src/shared/defaults';

describe('stream profiles', () => {
  it('wraps an existing setup in a default profile without losing its values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamhelper-old-settings-'));
    const path = join(dir, 'settings.json');
    try {
      const old = defaultSettings('en') as unknown as Record<string, unknown>;
      (old.chatOverlay as { fontSize: number }).fontSize = 57;
      delete old.profiles;
      delete old.activeProfileId;
      delete old.spotlightOverlay;
      writeFileSync(path, JSON.stringify(old));
      const store = new SettingsStore(path, new EventBus(), 'en');
      expect(store.get('chatOverlay').fontSize).toBe(57);
      expect(store.get('profiles')[0].config.chatOverlay.fontSize).toBe(57);
      expect(store.get('profiles')[0].overlays).toContain('alerts');
      expect(store.get('spotlightOverlay').mode).toBe('single');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates current settings, keeps edits in each profile and persists switching', () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamhelper-profiles-'));
    const path = join(dir, 'settings.json');
    try {
      const bus = new EventBus();
      const changed: string[] = [];
      bus.on('settings:changed', (key) => changed.push(key));
      const store = new SettingsStore(path, bus, 'ru');
      const originalId = store.get('activeProfileId');
      expect(store.get('profiles')).toHaveLength(1);
      store.set('chatOverlay', { ...store.get('chatOverlay'), fontSize: 31 });
      store.createProfile('Игры');
      const gamesId = store.get('activeProfileId');
      store.setProfileOverlay(gamesId, 'alerts', false);
      store.set('chatOverlay', { ...store.get('chatOverlay'), fontSize: 48 });
      store.set('spotlightOverlay', { ...store.get('spotlightOverlay'), mode: 'rain' });
      store.activateProfile(originalId);
      expect(store.get('chatOverlay').fontSize).toBe(31);
      expect(store.get('spotlightOverlay').mode).toBe('single');
      store.setForProfile('chatOverlay', { ...store.get('chatOverlay'), fontSize: 52 }, gamesId);
      expect(store.get('chatOverlay').fontSize).toBe(31);
      store.activateProfile(gamesId);
      expect(store.get('chatOverlay').fontSize).toBe(52);
      expect(store.get('spotlightOverlay').mode).toBe('rain');
      expect(store.get('profiles').find((p) => p.id === gamesId)?.overlays).not.toContain('alerts');
      expect(store.get('profiles').find((p) => p.id === originalId)?.overlays).toContain('alerts');
      expect(changed).toContain('chatOverlay');
      expect(changed).toContain('spotlightOverlay');
      store.flush();
      const reopened = new SettingsStore(path, new EventBus(), 'ru');
      expect(reopened.get('activeProfileId')).toBe(gamesId);
      expect(reopened.get('profiles')).toHaveLength(2);
      expect(JSON.parse(readFileSync(path, 'utf8')).profiles).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
