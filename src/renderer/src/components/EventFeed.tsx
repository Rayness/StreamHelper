import type { StreamEvent } from '@shared/types';
import { formatAmount } from '@shared/events';
import { useT, type TFn } from '../i18n';
import { call, useApp } from '../store';
import { Icon, type IconName } from './icons';
import { Empty, IconButton } from './ui';

export const EVENT_ICON: Record<StreamEvent['type'], IconName> = {
  follow: 'heart',
  sub: 'star',
  resub: 'star',
  giftsub: 'gift',
  cheer: 'diamond',
  raid: 'flag',
  donation: 'coin',
  redemption: 'sparkle',
};

export function describeEvent(t: TFn, e: StreamEvent): string {
  switch (e.type) {
    case 'follow':
      return t('feed.follow');
    case 'sub':
      return t('feed.sub', { tier: e.tier === '3000' ? 3 : e.tier === '2000' ? 2 : 1 });
    case 'resub':
      return t('feed.resub', { months: e.months });
    case 'giftsub':
      return t('feed.giftsub', { count: e.count });
    case 'cheer':
      return t('feed.cheer', { bits: e.bits });
    case 'raid':
      return t('feed.raid', { viewers: e.viewers });
    case 'donation':
      return `${formatAmount(e.amount)} ${e.currency}`;
    case 'redemption':
      return e.rewardTitle;
  }
}

function eventMessage(e: StreamEvent): string {
  if (e.type === 'resub' || e.type === 'cheer' || e.type === 'donation') return e.message;
  if (e.type === 'redemption') return e.input;
  return '';
}

export function EventFeed({ limit = 100 }: { limit?: number }) {
  const t = useT();
  const events = useApp((d) => d.events);
  if (events.length === 0) {
    return (
      <Empty icon="zap" title={t('feed.empty')}>
        {t('feed.emptyHint')}
      </Empty>
    );
  }
  return (
    <ul className="feed">
      {events.slice(0, limit).map((e) => {
        const msg = eventMessage(e);
        return (
          <li key={e.id} className={`feed-item feed-${e.type}`}>
            <span className="feed-icon">
              <Icon name={EVENT_ICON[e.type]} size={16} />
            </span>
            <div className="feed-body">
              <div className="feed-line">
                <b>{e.userName}</b> <span>{describeEvent(t, e)}</span>
                {e.source === 'test' && <span className="pill">{t('feed.test')}</span>}
                {(e.source === 'donationalerts' || e.source === 'streamlabs') && <span className="pill">{e.source === 'donationalerts' ? 'DA' : 'SL'}</span>}
              </div>
              {msg && <div className="feed-msg">{msg}</div>}
            </div>
            <span className="feed-time">{new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <IconButton icon="replay" label={t('feed.replay')} onClick={() => void call('alerts:replay', e.id)} />
          </li>
        );
      })}
    </ul>
  );
}
