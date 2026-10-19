import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { RemoteModerator } from '@shared/remote';

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; undefined = unknown / non-expiring. */
  expiresAt?: number;
  scopes: string[];
  userId?: string;
  login?: string;
}

/** Kawaki refresh tokens rotate: every refresh returns a new pair and burns the old one. */
export interface KawakiSession {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  userId: string;
  username: string;
  avatarUrl?: string;
}

export interface SecretsData {
  sceneStudio?: { config: import('@shared/sceneAi').SceneAiConfig; apiKey?: string; mcpToken?: string; mcpEnabled?: boolean; mcpPort?: number };
  twitch?: OAuthToken;
  twitchBot?: OAuthToken;
  donationalerts?: OAuthToken;
  kawaki?: KawakiSession;
  streamlabsSocketToken?: string;
  streamelementsJwt?: string;
  discordWebhookUrl?: string;
  telegramBotToken?: string;
  /** The live announcement in Telegram, so a restart mid-stream neither posts again nor loses it. */
  telegramPost?: { startedAt: number; chatId: string; messageId: number; photo: boolean; pinned: boolean; endedAt?: number };
  /** Lets the captions microphone page (in Chrome or Edge) send what it heard. */
  captionsToken?: string;
  obsPassword?: string;
  dockToken?: string;
  /** Remote access for moderators: each moderator signs in with their own key. */
  remoteAccess?: { enabled: boolean; port: number; moderators: (RemoteModerator & { key: string })[] };
  /** Yandex Music account for playing requests in the streamer's Yandex Music app (Ynison). */
  yandexMusic?: { accessToken: string; deviceId: string; uid?: string; login?: string; displayName?: string };
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
