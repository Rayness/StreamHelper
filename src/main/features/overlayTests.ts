import { renderAlert, sampleEvent } from '@shared/alerts';
import type { AlertType, OverlayKind, OverlayMessage, StreamEvent } from '@shared/types';
import type { AppContext } from '../core/context';
import type { AlertQueue } from './alerts';

/** Tests reach one selected widget, never the real-event bus or unrelated automation. */
export class OverlayTests {
  constructor(private ctx: AppContext, private alerts: AlertQueue,
    private broadcast: (kind: OverlayKind, message: OverlayMessage) => void,
    private displayEvent: (event: StreamEvent) => void) {}

  alert(type: AlertType, amount?: number, tierId?: string): void {
    const settings = this.ctx.settings.get('alerts');
    const tier = type === 'donation' && tierId ? settings.donationTiers.find((item) => item.id === tierId) : undefined;
    if (tierId && !tier) throw new Error('Donation tier no longer exists');
    const variant = tier?.variant ?? settings.types[type];
    if (!variant) throw new Error('Invalid alert type');
    const event = sampleEvent(type, this.ctx.settings.get('language'), this.ctx.settings.get('currency'), amount ?? tier?.minAmount);
    const alert = renderAlert(event, { ...settings, donationTiers: [],
      types: { ...settings.types, [type]: { ...variant, enabled: true, minAmount: 0 } },
      style: tier?.style ?? settings.style,
    }, this.ctx.settings.get('currency'))!;
    this.alerts.enqueueAlert(alert);
  }

  widget(kind: 'events' | 'rewards' | 'collab', type: AlertType): void {
    if (!['events','rewards','collab'].includes(kind)) throw new Error('Invalid test widget');
    if (kind === 'rewards' && type !== 'redemption' || kind === 'collab' && type !== 'raid') throw new Error('Invalid widget event');
    const event = sampleEvent(type, this.ctx.settings.get('language'), this.ctx.settings.get('currency'));
    if (!event) throw new Error('Invalid test event');
    if (kind === 'events') { this.broadcast(kind, { type: 'event', event }); this.displayEvent(event); }
    else if (kind === 'rewards' && event.type === 'redemption') this.broadcast(kind, { type: 'reward', event });
    else if (kind === 'collab' && event.type === 'raid') this.broadcast(kind, { type: 'collabRaid', event });
  }
}
