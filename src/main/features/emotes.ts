import type { ChatMessage, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';
import type { StageDeps } from './stage';

/** Global Twitch emotes, used for bursts before chat has shown any emotes. */
const FALLBACK = [25, 425618, 81274, 1902, 354, 86, 28087].map((id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`);
const POOL_SIZE = 60;
const BURST_EVENTS = new Set<StreamEvent['type']>(['sub', 'resub', 'giftsub', 'cheer', 'raid', 'donation']);

/** Emote URLs in a chat message, capped. */
export function emoteUrls(m: ChatMessage, max: number): string[] {
  return m.fragments
    .filter((f): f is Extract<typeof f, { type: 'emote' }> => f.type === 'emote')
    .map((f) => f.url)
    .slice(0, Math.max(0, max));
}

/** Emotes from chat fall across the screen; big moments get a burst of recent emotes. */
export class EmoteRain {
  private pool: string[] = [];

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
  ) {
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('event', (e) => {
      if (BURST_EVENTS.has(e.type) && ctx.settings.get('emoteRain').burstOnEvents) this.burst();
    });
  }

  private onChat(m: ChatMessage): void {
    const cfg = this.ctx.settings.get('emoteRain');
    const urls = emoteUrls(m, cfg.maxPerMessage);
    if (!urls.length) return;
    for (const u of urls) {
      if (this.pool.includes(u)) continue;
      this.pool.push(u);
      if (this.pool.length > POOL_SIZE) this.pool.shift();
    }
    if (cfg.fromChat && !m.fromSelf) this.deps.broadcast('emotes', { type: 'emotes', urls });
  }

  burst(): void {
    const cfg = this.ctx.settings.get('emoteRain');
    const pool = this.pool.length ? this.pool : FALLBACK;
    const urls = Array.from({ length: Math.max(1, Math.min(150, cfg.burstCount)) }, () => pool[Math.floor(Math.random() * pool.length)]);
    this.deps.broadcast('emotes', { type: 'emotes', urls, burst: true });
  }
}
