import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultSettings, mergeDefaults, migrateSettings } from '@shared/defaults';
import type { Language, Settings, SettingsKey } from '@shared/types';
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
    this.scheduleSave();
    if (!opts.silent) this.bus.emit('settings:changed', key);
  }

  /** Mutate a section in place (for high-frequency internal updates like goal progress). */
  update<K extends SettingsKey>(key: K, fn: (value: Settings[K]) => Settings[K], opts: { silent?: boolean } = {}): void {
    this.set(key, fn(this.data[key]), opts);
  }

  reset(key: SettingsKey): void {
    const defaults = defaultSettings(this.data.language);
    this.set(key, defaults[key]);
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
