import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '@shared/types';
import { CommandPalette } from './components/CommandPalette';
import { Icon, type IconName } from './components/icons';
import { StatusDot } from './components/ui';
import { useT, useTDynamic, type TKey } from './i18n';
import { Alerts } from './pages/Alerts';
import { Bot } from './pages/Bot';
import { Connections } from './pages/Connections';
import { Dashboard } from './pages/Dashboard';
import { Interactive } from './pages/Interactive';
import { Kawaki } from './pages/Kawaki';
import { Obs } from './pages/Obs';
import { Overlays } from './pages/Overlays';
import { Settings } from './pages/Settings';
import { dismissToast, navigate, useApp, useNav, type Page } from './store';

interface NavItem {
  id: Page;
  icon: IconName;
  label: TKey;
}

/** Grouped by when you need it: on air, looks, automation, accounts. */
const NAV: { title: TKey | null; items: NavItem[] }[] = [
  {
    title: null,
    items: [
      { id: 'dashboard', icon: 'dashboard', label: 'nav.dashboard' },
      { id: 'interactive', icon: 'sparkle', label: 'nav.interactive' },
    ],
  },
  {
    title: 'navGroup.look',
    items: [
      { id: 'alerts', icon: 'alert', label: 'nav.alerts' },
      { id: 'overlays', icon: 'layers', label: 'nav.overlays' },
    ],
  },
  {
    title: 'navGroup.auto',
    items: [
      { id: 'bot', icon: 'bot', label: 'nav.bot' },
      { id: 'obs', icon: 'video', label: 'nav.obs' },
    ],
  },
  {
    title: 'navGroup.accounts',
    items: [
      { id: 'kawaki', icon: 'tv', label: 'nav.kawaki' },
      { id: 'connections', icon: 'plug', label: 'nav.connections' },
      { id: 'settings', icon: 'settings', label: 'nav.settings' },
    ],
  },
];

const ALL_PAGES = NAV.flatMap((g) => g.items.map((i) => i.id));

function SideStatus() {
  const t = useT();
  const s = useApp((d) => d.state!);
  const items: { label: string; status: ConnectionStatus; show: boolean; page: Page }[] = [
    { label: 'Twitch', status: s.twitch.status, show: true, page: 'connections' },
    { label: 'OBS', status: s.obs.status, show: true, page: 'connections' },
    { label: 'Kawaki', status: s.kawaki.status, show: s.kawaki.status !== 'disconnected' || !!s.kawaki.account, page: 'kawaki' },
    { label: 'DonationAlerts', status: s.donationalerts.status, show: s.donationalerts.status !== 'disconnected' || !!s.donationalerts.account, page: 'connections' },
    { label: 'Streamlabs', status: s.streamlabs.status, show: s.streamlabs.status !== 'disconnected', page: 'connections' },
    { label: 'StreamElements', status: s.streamelements.status, show: s.streamelements.status !== 'disconnected', page: 'connections' },
    { label: 'Streamer.bot', status: s.streamerbot.status, show: s.streamerbot.status !== 'disconnected', page: 'connections' },
    { label: 'Discord', status: s.discord.status, show: s.discord.status !== 'disconnected', page: 'connections' },
  ];
  return (
    <div className="side-status">
      {items
        .filter((i) => i.show)
        .map((i) => (
          <button key={i.label} type="button" onClick={() => navigate(i.page)} title={t(`status.${i.status}`)}>
            <StatusDot status={i.status} />
            {i.label}
          </button>
        ))}
      <span className="side-overlays">
        <Icon name="layers" size={13} />
        {t('overlays.clients', { n: s.overlayClients })}
      </span>
    </div>
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
  const nav = useNav();
  const page = ALL_PAGES.includes(nav.page) ? nav.page : 'dashboard';
  const live = useApp((d) => d.state!.stream.live);
  const lang = useApp((d) => d.settings!.language);
  const funLive = useApp((d) => d.state!.poll?.status === 'running' || d.state!.giveaway.status === 'open' || d.state!.boss.status === 'running' || ['question', 'reveal'].includes(d.state!.quiz.status));
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        <button type="button" className="search-btn" onClick={() => setPalette(true)}>
          <Icon name="search" size={15} />
          <span>{t('palette.button')}</span>
          <kbd>Ctrl K</kbd>
        </button>
        {NAV.map((g, gi) => (
          <div key={gi} className="nav-group">
            {g.title && <span className="nav-group-title">{t(g.title)}</span>}
            <ul>
              {g.items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined} onClick={() => navigate(n.id)}>
                    <Icon name={n.icon} size={18} />
                    <span>{t(n.label)}</span>
                    {n.id === 'interactive' && funLive && <span className="nav-live" title={t('fun.running')} />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <SideStatus />
      </nav>
      <main className="content">
        {page === 'dashboard' && <Dashboard />}
        {page === 'interactive' && <Interactive />}
        {page === 'alerts' && <Alerts />}
        {page === 'overlays' && <Overlays />}
        {page === 'bot' && <Bot />}
        {page === 'obs' && <Obs />}
        {page === 'kawaki' && <Kawaki />}
        {page === 'connections' && <Connections />}
        {page === 'settings' && <Settings />}
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <Toasts />
    </div>
  );
}
