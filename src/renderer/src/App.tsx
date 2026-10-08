import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { normalizeWorkspaceCards } from '@shared/workspace';
import type { ConnectionStatus, WorkspaceCard } from '@shared/types';
import { saveAppearance, useAppearance, useApplyAppearance } from './appearance';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/icons';
import { IconButton, StatusDot } from './components/ui';
import { useT, useTDynamic } from './i18n';
import { Workspace } from './pages/Workspace';
import { closeDialog, dismissToast, navigate, openModule, useApp, useNav } from './store';
const Monitor = lazy(() => import('./pages/Monitor').then((m) => ({ default:m.Monitor })));
const Connections = lazy(() => import('./pages/Connections').then((m) => ({ default:m.Connections })));
const Profiles = lazy(() => import('./pages/Profiles').then((m) => ({ default:m.Profiles })));
const Preferences = lazy(() => import('./pages/Settings').then((m) => ({ default:m.Settings })));

function SideStatus() {
  const t = useT();
  const s = useApp((d) => d.state!);
  const workspace = useApp((d) => d.settings!.workspace);
  const cards = normalizeWorkspaceCards(workspace.cards);
  const items: { id:WorkspaceCard; label:string; status:ConnectionStatus }[] = [
    {id:'twitch',label:'Twitch',status:s.twitch.status},{id:'obs',label:'OBS',status:s.obs.status},{id:'kawaki',label:'Kawaki',status:s.kawaki.status},{id:'donationalerts',label:'DonationAlerts',status:s.donationalerts.status},{id:'streamlabs',label:'Streamlabs',status:s.streamlabs.status},{id:'streamelements',label:'StreamElements',status:s.streamelements.status},{id:'streamerbot',label:'Streamer.bot',status:s.streamerbot.status},{id:'discord',label:'Discord',status:s.discord.status},
  ];
  const visible = items.filter((i) => cards.includes(i.id) || i.status !== 'disconnected');
  if (!visible.length) return null;
  return <div className="side-status">{visible.map((i) => <button key={i.id} type="button" onClick={() => i.id === 'kawaki' ? openModule(i.id) : navigate('connections',i.id)} title={t(`status.${i.status}`)}><StatusDot status={i.status} />{i.label}</button>)}</div>;
}
function Toasts() {
  const toasts = useApp((d) => d.toasts);
  const td = useTDynamic();
  return <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}><Icon name={t.kind === 'error' ? 'x' : t.kind === 'success' ? 'check' : 'alert'} size={16} /><span>{td(t.key,t.params)}</span></div>)}</div>;
}
export function App() {
  const t = useT();
  const nav = useNav();
  const lang = useApp((d) => d.settings!.language);
  const live = useApp((d) => d.state!.stream.live);
  const profileName = useApp((d) => d.settings!.profiles.find((p) => p.id === d.settings!.activeProfileId)?.name ?? '—');
  const [palette,setPalette] = useState(false);
  const look = useAppearance();
  useApplyAppearance();
  const toggleTheme = () => saveAppearance(look, { theme: look.theme === 'light' ? 'midnight' : 'light' });
  useEffect(() => { document.documentElement.lang = lang; },[lang]);
  useEffect(() => {
    const onKey = (e:KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyK') { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.key === 'Escape') { closeDialog(); return; }
      if (!mod || e.altKey) return;
      // Shortcuts that never collide with typing: they all need Ctrl.
      if (!e.shiftKey && e.code === 'Digit1') { e.preventDefault(); navigate('workspace'); }
      else if (!e.shiftKey && e.code === 'Digit2') { e.preventDefault(); navigate('dashboard'); }
      else if (!e.shiftKey && e.code === 'Digit3') { e.preventDefault(); navigate('connections'); }
      else if (!e.shiftKey && e.code === 'Comma') { e.preventDefault(); navigate('settings'); }
      else if (e.shiftKey && e.code === 'KeyL') { e.preventDefault(); toggleThemeRef.current(); }
    };
    window.addEventListener('keydown',onKey); return () => window.removeEventListener('keydown',onKey);
  },[]);
  const toggleThemeRef = useRef(toggleTheme);
  toggleThemeRef.current = toggleTheme;
  return <div className="app">
    <nav className="sidebar" aria-label="StreamHelper"><div className="brand-logo"><span className="logo-mark"><Icon name="broadcast" size={18} /></span><span className="logo-text">StreamHelper</span>{live && <span className="live-pill">LIVE</span>}</div>
      <button className="profile-current" onClick={() => navigate('profiles')} title={t('nav.profiles')}><Icon name="users" size={15} /><span>{profileName}</span><Icon name="chevron" size={14} /></button>
      <button className="search-btn" onClick={() => setPalette(true)}><Icon name="search" size={15} /><span>{t('palette.button')}</span><kbd>Ctrl K</kbd></button>
      <div className="nav-group"><ul><li><button className={nav.page === 'workspace' ? 'active' : ''} aria-current={nav.page === 'workspace' ? 'page' : undefined} onClick={() => navigate('workspace')} title="Ctrl+1" data-kbd="Ctrl 1"><Icon name="layers" size={18} /><span>{t('workspace.title')}</span></button></li><li><button className={nav.page === 'dashboard' ? 'active' : ''} aria-current={nav.page === 'dashboard' ? 'page' : undefined} onClick={() => navigate('dashboard')} title="Ctrl+2" data-kbd="Ctrl 2"><Icon name="dashboard" size={18} /><span>{t('workspace.monitor')}</span></button></li><li><button className={nav.page === 'connections' ? 'active' : ''} aria-current={nav.page === 'connections' ? 'page' : undefined} onClick={() => navigate('connections')} title="Ctrl+3" data-kbd="Ctrl 3"><Icon name="plug" size={18} /><span>{t('nav.connections')}</span></button></li></ul></div>
      <div className="workspace-side-footer"><SideStatus /><div className="sidebar-quick"><button className="workspace-preferences" onClick={() => navigate('settings')} title={`${t('workspace.preferences')} (Ctrl+,)`}><Icon name="settings" size={16} /><span>{t('workspace.preferences')}</span></button><IconButton icon={look.theme === 'light' ? 'moon' : 'sun'} label={`${t('look.toggleTheme')} (Ctrl+Shift+L)`} onClick={toggleTheme} /><IconButton icon="palette" label={t('look.title')} onClick={() => navigate('settings','look')} /></div></div>
    </nav>
    <main className="content"><ErrorBoundary key={nav.page}><Suspense fallback={<div className="page" role="status">…</div>}>{nav.page === 'dashboard' ? <Monitor /> : nav.page === 'connections' ? <Connections /> : <Workspace />}</Suspense></ErrorBoundary></main>
    {nav.dialog && <div className="workspace-dialog-backdrop" onMouseDown={closeDialog}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-label={t(nav.dialog === 'profiles' ? 'nav.profiles' : 'workspace.preferences')} onMouseDown={(e) => e.stopPropagation()}><div className="workspace-dialog-close"><IconButton icon="x" label={t('common.cancel')} onClick={closeDialog} /></div><ErrorBoundary key={nav.dialog}><Suspense fallback={<span role="status">…</span>}>{nav.dialog === 'profiles' ? <Profiles /> : <Preferences />}</Suspense></ErrorBoundary></section></div>}
    <CommandPalette open={palette} onClose={() => setPalette(false)} /><Toasts />
  </div>;
}
