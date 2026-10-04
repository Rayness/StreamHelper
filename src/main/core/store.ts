import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings, mergeDefaults, migrateSettings } from '@shared/defaults';
import { merge3 } from '@shared/merge';
import { ALL_OVERLAY_KINDS, PROFILE_KEYS, profileSnapshot } from '@shared/profiles';
import { normalizeWorkspaceCards } from '@shared/workspace';
import type { Language, OverlayKind, ProfileConfig, ProfileSettingsKey, Settings, SettingsKey } from '@shared/types';
import type { EventBus } from './eventBus';

/** JSON-file settings store. Writes are debounced and atomic (tmp file + rename). */
export class SettingsStore {
  private data: Settings;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private file: string,
    private bus: EventBus,
    systemLanguage: Language,
  ) {
    let stored: unknown;
    try {
      if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('[store] settings file is corrupted, starting from defaults', err);
      try {
        renameSync(file, file + '.corrupted-' + Date.now());
      } catch {
        /* keep going with defaults */
      }
    }
    const lang = (stored as Partial<Settings> | undefined)?.language ?? systemLanguage;
    this.data = migrateSettings(mergeDefaults(defaultSettings(lang), stored));
    const base = profileSnapshot(this.data);
    if (!this.data.profiles.length) {
      const id = randomUUID();
      this.data.profiles = [{ id, name: lang === 'ru' ? 'Основной' : 'Default', config: base, overlays: [...ALL_OVERLAY_KINDS] }];
      this.data.activeProfileId = id;
    } else {
      this.data.profiles = this.data.profiles.map((profile) => {
        const config = mergeDefaults(base, profile.config);
        config.workspace = { cards: normalizeWorkspaceCards(config.workspace.cards) };
        config.alerts.donationTiers = config.alerts.donationTiers.map((tier) => ({
          ...tier,
          style: tier.style ? { ...config.alerts.style, ...tier.style } : undefined,
        }));
        return {
          ...profile,
          config,
          overlays: Array.isArray(profile.overlays) ? profile.overlays.filter((kind) => ALL_OVERLAY_KINDS.includes(kind)) : [...ALL_OVERLAY_KINDS],
        };
      });
      if (!this.data.profiles.some((profile) => profile.id === this.data.activeProfileId)) {
        this.data.activeProfileId = this.data.profiles[0].id;
      }
    }
    if (!stored) this.flush();
  }

  get all(): Settings {
    return this.data;
  }

  get<K extends SettingsKey>(key: K): Settings[K] {
    return this.data[key];
  }

  set<K extends SettingsKey>(key: K, value: Settings[K], opts: { silent?: boolean } = {}): void {
    this.data = { ...this.data, [key]: value };
    if (PROFILE_KEYS.includes(key as ProfileSettingsKey)) {
      this.data.profiles = this.data.profiles.map((profile) => profile.id === this.data.activeProfileId
        ? { ...profile, config: { ...profile.config, [key]: structuredClone(value) } as ProfileConfig }
        : profile);
    }
    this.scheduleSave();
    if (!opts.silent) this.bus.emit('settings:changed', key);
  }

  /**
   * Save an edit from the UI to the profile that owned the form, even if OBS switched profiles
   * meanwhile. With `base` (what the form started from), fields the form didn't touch keep the
   * app's newer values: goal progress, counters and subathon time move while the streamer edits.
   */
  setForProfile<K extends SettingsKey>(key: K, value: Settings[K], profileId?: string, base?: Settings[K]): void {
    if (profileId && profileId !== this.data.activeProfileId && PROFILE_KEYS.includes(key as ProfileSettingsKey)) {
      const target = this.data.profiles.find((profile) => profile.id === profileId);
      if (!target) return;
      const merged = base === undefined ? value : merge3(base, value, target.config[key as ProfileSettingsKey]);
      this.data = { ...this.data, profiles: this.data.profiles.map((profile) => profile.id === profileId
        ? { ...profile, config: { ...profile.config, [key]: structuredClone(merged) } as ProfileConfig }
        : profile) };
      this.scheduleSave();
      this.bus.emit('settings:changed', 'profiles');
      return;
    }
    this.set(key, base === undefined ? value : merge3(base, value, this.data[key]));
  }

  /** Mutate a section in place (for high-frequency internal updates like goal progress). */
  update<K extends SettingsKey>(key: K, fn: (value: Settings[K]) => Settings[K], opts: { silent?: boolean } = {}): void {
    this.set(key, fn(this.data[key]), opts);
  }

  reset(key: SettingsKey): void {
    const defaults = defaultSettings(this.data.language);
    this.set(key, defaults[key]);
  }

  createProfile(name: string): Settings {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw new Error('Profile name is required');
    const id = randomUUID();
    this.data = {
      ...this.data,
      activeProfileId: id,
      profiles: [...this.data.profiles, { id, name: trimmed, config: profileSnapshot(this.data), overlays: [...this.data.profiles.find((p) => p.id === this.data.activeProfileId)!.overlays] }],
    };
    this.scheduleSave();
    this.bus.emit('settings:changed', 'profiles');
    return this.data;
  }

  renameProfile(id: string, name: string): Settings {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed || !this.data.profiles.some((p) => p.id === id)) throw new Error('Invalid profile');
    this.data = { ...this.data, profiles: this.data.profiles.map((p) => p.id === id ? { ...p, name: trimmed } : p) };
    this.scheduleSave();
    this.bus.emit('settings:changed', 'profiles');
    return this.data;
  }

  activateProfile(id: string): Settings {
    const profile = this.data.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Profile not found');
    if (id === this.data.activeProfileId) return this.data;
    const patch = {} as Partial<Settings>;
    for (const key of PROFILE_KEYS) (patch as Record<string, unknown>)[key] = structuredClone(profile.config[key]);
    this.data = { ...this.data, ...patch, activeProfileId: id };
    this.scheduleSave();
    for (const key of PROFILE_KEYS) this.bus.emit('settings:changed', key);
    this.bus.emit('settings:changed', 'activeProfileId');
    return this.data;
  }

  deleteProfile(id: string): Settings {
    if (this.data.profiles.length <= 1) throw new Error('Keep at least one profile');
    if (!this.data.profiles.some((p) => p.id === id)) throw new Error('Profile not found');
    if (id === this.data.activeProfileId) {
      this.activateProfile(this.data.profiles.find((p) => p.id !== id)!.id);
    }
    this.data = { ...this.data, profiles: this.data.profiles.filter((p) => p.id !== id) };
    this.scheduleSave();
    this.bus.emit('settings:changed', 'profiles');
    return this.data;
  }

  setProfileOverlay(id: string, kind: OverlayKind, enabled: boolean): Settings {
    if (!ALL_OVERLAY_KINDS.includes(kind) || !this.data.profiles.some((p) => p.id === id)) throw new Error('Invalid profile overlay');
    this.data = { ...this.data, profiles: this.data.profiles.map((profile) => profile.id === id
      ? { ...profile, overlays: enabled ? [...new Set([...profile.overlays, kind])] : profile.overlays.filter((item) => item !== kind) }
      : profile) };
    this.scheduleSave();
    this.bus.emit('settings:changed', 'profiles');
    return this.data;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
