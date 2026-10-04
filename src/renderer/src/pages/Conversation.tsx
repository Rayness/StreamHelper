import { lazy, Suspense, useState } from 'react';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Tabs } from '../components/ui';
import { useT } from '../i18n';
const Overlay = lazy(() => import('./Overlays').then((m) => ({ default:m.OverlayDetail })));

/** Live operation and presentation settings both belong to the installed module. */
export function Conversation({ kind }: { kind:'chat' | 'events' }) {
  const t = useT();
  const [tab,setTab] = useState<'live' | 'settings'>('live');
  return <><Tabs value={tab} onChange={setTab} tabs={[{id:'live',label:t(kind === 'chat' ? 'dash.chat' : 'dash.events')},{id:'settings',label:t('workspace.settings')}]} />
    {tab === 'live' ? <div className={`workspace-live-${kind}`}>{kind === 'chat' ? <ChatView /> : <EventFeed />}</div> : <Suspense fallback={<span role="status">…</span>}><Overlay kind={kind} /></Suspense>}
  </>;
}
