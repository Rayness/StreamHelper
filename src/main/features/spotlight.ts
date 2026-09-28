import type { ChatMessage, OverlayMessage } from '@shared/types';
import type { AppContext } from '../core/context';
import type { ChatHistory } from './chatHistory';
import type { StageDeps } from './stage';
import { sampleChatMessage } from './chatHistory';

/** One selected chat message displayed in a dedicated OBS source. */
export class SpotlightService {
  private clearTimer: NodeJS.Timeout | null = null;
  constructor(private ctx: AppContext, private deps: StageDeps, private chat: ChatHistory) {
    ctx.bus.on('chat:message', (message) => {
      if (message.highlighted && !message.fromSelf && ctx.settings.get('spotlightOverlay').autoHighlighted) this.set(message);
    });
    ctx.bus.on('chat:delete', ({ id }) => {
      this.deps.broadcast('spotlight', { type: 'spotlightRemove', id });
      if (this.ctx.state.current.spotlight?.id === id) this.clear();
    });
    ctx.bus.on('chat:clearUser', ({ userId }) => {
      this.deps.broadcast('spotlight', { type: 'spotlightRemoveUser', userId });
      if (this.ctx.state.current.spotlight?.userId === userId) this.clear();
    });
    ctx.bus.on('chat:clear', () => this.clear());
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'spotlightOverlay' && this.ctx.state.current.spotlight) this.scheduleClear();
    });
  }

  overlayMessage(): OverlayMessage {
    return { type: 'spotlight', message: this.ctx.state.current.spotlight };
  }

  show(id: string): void {
    const message = this.chat.recent().find((m) => m.id === id && !m.deleted);
    if (!message) throw new Error('Chat message is no longer available');
    this.set(message);
  }

  test(): void {
    const message = sampleChatMessage(this.ctx.settings.get('language'));
    this.ctx.bus.emit('chat:message', message);
    this.set(message);
  }

  clear(): void {
    this.set(null);
  }

  private set(message: ChatMessage | null): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    this.ctx.state.replace('spotlight', message);
    this.deps.broadcast('spotlight', this.overlayMessage());
    if (message) this.scheduleClear();
  }

  private scheduleClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    const durationSec = this.ctx.settings.get('spotlightOverlay').durationSec;
    this.clearTimer = setTimeout(() => this.clear(), Math.max(2, Math.min(120, durationSec)) * 1000);
  }
}
