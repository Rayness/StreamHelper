import type { IpcPush } from '@shared/types';
import type { EventBus } from './eventBus';
import type { SecretStore } from './secrets';
import type { StateHub } from './state';
import type { SettingsStore } from './store';

export interface AppContext {
  bus: EventBus;
  settings: SettingsStore;
  secrets: SecretStore;
  state: StateHub;
  /** Show a notification in the UI. `key` is an i18n key. */
  toast: (kind: IpcPush['toast']['kind'], key: string, params?: Record<string, string | number>) => void;
  openExternal: (url: string) => void;
  /** Absolute directory with user-imported media (sounds, images). */
  mediaDir: string;
  isUiVisible?: () => boolean;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
