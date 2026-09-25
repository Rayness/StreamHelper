import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; undefined = unknown / non-expiring. */
  expiresAt?: number;
  scopes: string[];
  userId?: string;
  login?: string;
}

export interface SecretsData {
  twitch?: OAuthToken;
  twitchBot?: OAuthToken;
  donationalerts?: OAuthToken;
  streamlabsSocketToken?: string;
  obsPassword?: string;
}

/**
 * Tokens and passwords, encrypted with the OS keychain (DPAPI on Windows) via Electron safeStorage.
 * Kept separate from settings.json so users can share their settings without leaking credentials.
 */
export class SecretStore {
  private data: SecretsData = {};

  constructor(private file: string) {
    try {
      if (!existsSync(file)) return;
      const raw = readFileSync(file);
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      this.data = JSON.parse(json);
    } catch (err) {
      console.error('[secrets] could not read secrets, you will need to log in again', err);
      this.data = {};
    }
  }

  get<K extends keyof SecretsData>(key: K): SecretsData[K] {
    return this.data[key];
  }

  set<K extends keyof SecretsData>(key: K, value: SecretsData[K] | undefined): void {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const json = JSON.stringify(this.data);
    writeFileSync(this.file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8'));
  }
}
