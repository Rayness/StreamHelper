import type { ChatMessage, OverlayMessage } from '@shared/types';
import type { AppContext } from '../core/context';
import type { ChatHistory } from './chatHistory';
import type { StageDeps } from './stage';

/** One selected chat message displayed in a dedicated OBS source. */
export class SpotlightService {
  constructor(private ctx: AppContext, private deps: StageDeps, private chat: ChatHistory) {
    ctx.bus.on('chat:delete', ({ id }) => {
      if (this.ctx.state.current.spotlight?.id === id) this.clear();
    });
    ctx.bus.on('chat:clearUser', ({ userId }) => {
      if (this.ctx.state.current.spotlight?.userId === userId) this.clear();
    });
    ctx.bus.on('chat:clear', () => this.clear());
  }

  overlayMessage(): OverlayMessage {
    return { type: 'spotlight', message: this.ctx.state.current.spotlight };
  }

  show(id: string): void {
    const message = this.chat.recent().find((m) => m.id === id && !m.deleted);
    if (!message) throw new Error('Chat message is no longer available');
    this.set(message);
  }

  clear(): void {
    this.set(null);
  }

  private set(message: ChatMessage | null): void {
    this.ctx.state.replace('spotlight', message);
    this.deps.broadcast('spotlight', this.overlayMessage());
  }
}
