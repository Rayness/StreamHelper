import type { ChatMessage, ClipMoment, KawakiNowWatching, MusicTrack, SettingsKey, StreamEvent, StreamInfo } from '@shared/types';
import { isTrustedStreamEvent } from '@shared/events';

export interface BusEvents {
  'chat:message': ChatMessage;
  'chat:delete': { id: string };
  'chat:clearUser': { userId: string };
  'chat:clear': Record<string, never>;
  /** A normalized stream event (follow, sub, donation...). Emitted once per real-world event. */
  event: StreamEvent;
  'stream:update': StreamInfo;
  'settings:changed': SettingsKey;
  /** Something in RuntimeState changed; the state hub debounces and pushes it to the UI. */
  'state:dirty': void;
  /** What's playing on Kawaki changed (or the account logged out). */
  'kawaki:now': KawakiNowWatching | null;
  'music:changed': MusicTrack | null;
  /** The auto clipper saved a moment (clip and/or marker). */
  'clip:moment': ClipMoment;
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  emit<K extends keyof BusEvents>(event: K, ...[payload]: BusEvents[K] extends void ? [] : [BusEvents[K]]): void {
    if (event === 'event' && !isTrustedStreamEvent(payload as StreamEvent)) return;
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as Handler<BusEvents[K]>)(payload as BusEvents[K]);
      } catch (err) {
        console.error(`[bus] handler for "${String(event)}" failed`, err);
      }
    }
  }
}
