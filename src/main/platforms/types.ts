import type { Platform } from '@shared/types';

/**
 * What the bot, moderation and the unified chat need from any streaming platform.
 * Twitch is the first implementation; YouTube / VK Play / Kick plug in here later.
 */
export interface ChatPlatform {
  readonly platform: Platform;
  isChatReady(): boolean;
  /**
   * Bot/app messages are marked as our own so the bot never answers itself.
   * `asBroadcaster` = the streamer typed it in the app: send from their account and let the bot react.
   */
  sendMessage(text: string, replyTo?: string, opts?: { asBroadcaster?: boolean }): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  timeout(userId: string, seconds: number, reason?: string): Promise<void>;
  ban(userId: string, reason?: string): Promise<void>;
  /** Epoch ms when the user followed, or null. Platforms without follows return null. */
  getFollowedAt(userId: string): Promise<number | null>;
  shoutout(login: string): Promise<{ displayName: string; category: string } | null>;
}

export class PlatformRegistry {
  private map = new Map<Platform, ChatPlatform>();

  register(p: ChatPlatform): void {
    this.map.set(p.platform, p);
  }

  get(platform: Platform): ChatPlatform | undefined {
    return this.map.get(platform);
  }

  /** Platforms whose chat is currently connected. */
  ready(): ChatPlatform[] {
    return [...this.map.values()].filter((p) => p.isChatReady());
  }
}
