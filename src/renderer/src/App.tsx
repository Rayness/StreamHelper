import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '@shared/types';
import { Icon, type IconName } from './components/icons';
import { StatusDot } from './components/ui';
import { useT, useTDynamic, type TKey } from './i18n';
import { Alerts } from './pages/Alerts';
import { Bot } from './pages/Bot';
import { Connections } from './pages/Connections';
import { Dashboard } from './pages/Dashboard';
import { Obs } from './pages/Obs';
import { Overlays } from './pages/Overlays';
import { Settings } from './pages/Settings';
import { dismissToast, useApp } from './store';

type Page = 'dashboard' | 'alerts' | 'overlays' | 'bot' | 'obs' | 'connections' | 'settings';

const NAV: { id: Page; icon: IconName; label: TKey }[] = [
  { id: 'dashboard', icon: 'dashboard', label: 'nav.dashboard' },
  { id: 'alerts', icon: 'alert', label: 'nav.alerts' },
  { id: 'overlays', icon: 'layers', label: 'nav.overlays' },
  { id: 'bot', icon: 'bot', label: 'nav.bot' },
  { id: 'obs', icon: 'video', label: 'nav.obs' },
  { id: 'connections', icon: 'plug', label: 'nav.connections' },
  { id: 'settings', icon: 'settings', label: 'nav.settings' },
];

function readPage(): Page {
  try {
    const p = localStorage.getItem('page') as Page | null;
    return p && NAV.some((n) => n.id === p) ? p : 'dashboard';
  } catch {
    return 'dashboard';
  }
}

function Connections_({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const s = useApp((d) => d.state!);
  const items: { label: string; status: ConnectionStatus; show: boolean }[] = [
    { label: 'Twitch', status: s.twitch.status, show: true },
    { label: 'OBS', status: s.obs.status, show: true },
    { label: 'DonationAlerts', status: s.donationalerts.status, show: s.donationalerts.status !== 'disconnected' || !!s.donationalerts.account },
    { label: 'Streamlabs', status: s.streamlabs.status, show: s.streamlabs.status !== 'disconnected' },
  ];
  return (
    <button type="button" className="side-status" onClick={onOpen} title={t('nav.connections')}>
      {items
        .filter((i) => i.show)
        .map((i) => (
          <span key={i.label}>
            <StatusDot status={i.status} />
            {i.label}
          </span>
        ))}
    </button>
  );
}

function Toasts() {
  const toasts = useApp((d) => d.toasts);
  const td = useTDynamic();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
          <Icon name={t.kind === 'error' ? 'x' : t.kind === 'success' ? 'check' : 'alert'} size={16} />
          <span>{td(t.key, t.params)}</span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const t = useT();
  const [page, setPage] = useState<Page>(readPage);
  const live = useApp((d) => d.state!.stream.live);
  const lang = useApp((d) => d.settings!.language);

  useEffect(() => {
    try {
      localStorage.setItem('page', page);
    } catch {
      /* private mode etc. */
    }
  }, [page]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand-logo">
          <span className="logo-mark">
            <Icon name="broadcast" size={18} />
          </span>
          <span className="logo-text">StreamHelper</span>
          {live && <span className="live-pill">LIVE</span>}
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <button type="button" className={page === n.id ? 'active' : ''} onClick={() => setPage(n.id)}>
                <Icon name={n.icon} size={18} />
                <span>{t(n.label)}</span>
              </button>
            </li>
          ))}
        </ul>
        <Connections_ onOpen={() => setPage('connections')} />
      </nav>
      <main className="content">
        {page === 'dashboard' && <Dashboard />}
        {page === 'alerts' && <Alerts />}
        {page === 'overlays' && <Overlays />}
        {page === 'bot' && <Bot />}
        {page === 'obs' && <Obs />}
        {page === 'connections' && <Connections />}
        {page === 'settings' && <Settings />}
      </main>
      <Toasts />
    </div>
  );
}
