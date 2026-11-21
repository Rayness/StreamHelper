import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { normalizeWorkspaceCards, workspaceCards } from '@shared/workspace';
import { DONATION_PROVIDERS, DONATION_SOURCES } from '@shared/events';
import type { ConnectionStatus, WorkspaceCard } from '@shared/types';
import { saveAppearance, useAppearance, useApplyAppearance } from './appearance';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/icons';
import { ConfirmModal, IconButton, StatusDot } from './components/ui';
import { useT, useTDynamic } from './i18n';
import { Workspace } from './pages/Workspace';
import { closeDialog, dismissToast, navigate, openCatalog, openModule, useApp, useNav, type Page } from './store';
import { useBundledFonts } from './components/FontPicker';
import { MODULE_GROUPS_ORDER, moduleDef, moduleName } from './workspaceModules';
import type { IconName } from './components/icons';
import type { TKey } from './i18n';

const Monitor = lazy(() => import('./pages/Monitor').then((m) => ({ default: m.Monitor })));
const Connections = lazy(() => import('./pages/Connections').then((m) => ({ default: m.Connections })));
const Profiles = lazy(() => import('./pages/Profiles').then((m) => ({ default: m.Profiles })));
const Variables = lazy(() => import('./pages/Variables').then((m) => ({ default: m.Variables })));
const Designer = lazy(() => import('./pages/Designer').then((m) => ({ default: m.Designer })));
const EventStudio = lazy(() => import('./pages/EventStudio').then((m) => ({ default: m.EventStudio })));
const Preferences = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));

type PrimaryPage = Page & ('dashboard' | 'workspace' | 'connections');
type ProPage = Page & ('designer' | 'variables' | 'eventStudio');

const NAV_MAIN: { page: PrimaryPage; icon: IconName; label: TKey; kbd: string }[] = [
  { page: 'dashboard', icon: 'dashboard', label: 'workspace.monitor', kbd: 'Ctrl 1' },
  { page: 'workspace', icon: 'grid', label: 'workspace.title', kbd: 'Ctrl 2' },
  { page: 'connections', icon: 'plug', label: 'nav.connections', kbd: 'Ctrl 3' },
];

const NAV_PRO: { page: ProPage; icon: IconName; label: TKey; kbd: string }[] = [
  { page: 'designer', icon: 'designer', label: 'nav.designer', kbd: 'Ctrl 4' },
  { page: 'variables', icon: 'braces', label: 'nav.variables', kbd: 'Ctrl 5' },
  { page: 'eventStudio', icon: 'sparkle', label: 'nav.eventStudio', kbd: 'Ctrl 6' },
];

function readFlag(key: string, fallback = false): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function SideStatus() {
  const t = useT();
  const s = useApp((d) => d.state!);
  const workspace = useApp((d) => d.settings!.workspace);
  const cards = normalizeWorkspaceCards(workspace.cards);
  const items: { id: WorkspaceCard; label: string; status: ConnectionStatus }[] = [
    { id: 'twitch', label: 'Twitch', status: s.twitch.status },
    { id: 'obs', label: 'OBS', status: s.obs.status },
    { id: 'kawaki', label: 'Kawaki', status: s.kawaki.status },
    ...DONATION_SOURCES.map((id) => ({ id, label: DONATION_PROVIDERS[id].name, status: s[id].status })),
    { id: 'streamerbot', label: 'Streamer.bot', status: s.streamerbot.status },
    { id: 'discord', label: 'Discord', status: s.discord.status },
    { id: 'telegram', label: 'Telegram', status: s.telegram.status },
  ];
  const visible = items.filter((i) => cards.includes(i.id) || i.status !== 'disconnected');
  if (!visible.length) return null;
  return (
    <div className="side-status">
      {visible.map((i) => (
        <button key={i.id} type="button" onClick={() => navigate('connections', i.id)} title={`${i.label}: ${t(`status.${i.status}`)}`}>
          <StatusDot status={i.status} />
          <span>{i.label}</span>
        </button>
      ))}
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
  const rawNav = useNav();
  const lang = useApp((d) => d.settings!.language);
  const live = useApp((d) => d.state!.stream.live);
  const state = useApp((d) => d.state!);
  const rawCards = useApp((d) => d.settings!.workspace.cards);
  const installedCards = workspaceCards(rawCards);
  const profileName = useApp((d) => d.settings!.profiles.find((p) => p.id === d.settings!.activeProfileId)?.name ?? '—');
  const remote = useApp((d) => d.remote);

  // Connections (logins, tokens) stay on the streamer's computer.
  const nav = remote && (rawNav.page === 'connections' || rawNav.page === 'eventStudio') ? { ...rawNav, page: 'workspace' as const } : rawNav;
  const mainItems = remote ? NAV_MAIN.filter((item) => item.page !== 'connections') : NAV_MAIN;
  const proItems = remote ? NAV_PRO.filter((item) => item.page !== 'eventStudio') : NAV_PRO;

  const [palette, setPalette] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readFlag('sidebar.collapsed', false));
  const [proOpen, setProOpen] = useState(() => readFlag('sidebar.proOpen', false));
  const [modulesOpen, setModulesOpen] = useState(true);
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});

  const isProPage = nav.page === 'designer' || nav.page === 'variables' || nav.page === 'eventStudio';
  const showProItems = proOpen || isProPage;

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeFlag('sidebar.collapsed', next);
      return next;
    });
  };

  const togglePro = () => {
    setProOpen((prev) => {
      const next = !prev;
      writeFlag('sidebar.proOpen', next);
      return next;
    });
  };

  const look = useAppearance();
  useApplyAppearance();
  useBundledFonts();
  const toggleTheme = () => saveAppearance(look, { theme: look.theme === 'light' ? 'midnight' : 'light' });

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const toggleThemeRef = useRef(toggleTheme);
  toggleThemeRef.current = toggleTheme;
  const toggleCollapsedRef = useRef(toggleCollapsed);
  toggleCollapsedRef.current = toggleCollapsed;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyK') { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.key === 'Escape') { closeDialog(); return; }
      if (!mod || e.altKey) return;
      if (!e.shiftKey && e.code === 'KeyB') { e.preventDefault(); toggleCollapsedRef.current(); }
      else if (!e.shiftKey && e.code === 'Digit1') { e.preventDefault(); navigate('dashboard'); }
      else if (!e.shiftKey && e.code === 'Digit2') { e.preventDefault(); navigate('workspace'); }
      else if (!e.shiftKey && e.code === 'Digit3') { e.preventDefault(); navigate('connections'); }
      else if (!e.shiftKey && e.code === 'Digit4') { e.preventDefault(); navigate('designer'); }
      else if (!e.shiftKey && e.code === 'Digit5') { e.preventDefault(); navigate('variables'); }
      else if (!e.shiftKey && e.code === 'Digit6') { e.preventDefault(); navigate('eventStudio'); }
      else if (!e.shiftKey && e.code === 'Comma') { e.preventDefault(); navigate('settings'); }
      else if (e.shiftKey && e.code === 'KeyL') { e.preventDefault(); toggleThemeRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const connectedCount = [state.twitch, state.obs, state.donationalerts, state.streamlabs, state.streamelements, state.streamerbot, state.discord, state.kawaki, state.subForStream].filter((c) => c.status === 'connected').length;

  const groupedModules = MODULE_GROUPS_ORDER.map((group) => ({
    group,
    items: installedCards.filter((id) => moduleDef(id).group === group),
  })).filter((g) => g.items.length > 0);

  const activeModule = nav.page === 'workspace' && !nav.catalog ? nav.module : undefined;

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <nav className="sidebar" aria-label="StreamHelper">
        <div className="brand-logo">
          <span className="logo-mark">
            <Icon name="broadcast" size={17} />
          </span>
          {!collapsed && <span className="logo-text">StreamHelper</span>}
          {!collapsed && live && <span className="live-pill">LIVE</span>}
          <IconButton
            className="sidebar-collapse-btn"
            icon="sidebar"
            label={`${t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')} (Ctrl+B)`}
            onClick={toggleCollapsed}
          />
        </div>

        <button className="profile-current" onClick={() => navigate('profiles')} title={`${t('nav.profiles')}: ${profileName}`}>
          <Icon name="users" size={15} />
          {!collapsed && <span>{profileName}</span>}
          {!collapsed && <Icon name="chevron" size={13} />}
        </button>

        <button className="search-btn" onClick={() => setPalette(true)} title={`${t('palette.button')} (Ctrl+K)`}>
          <Icon name="search" size={15} />
          {!collapsed && <span>{t('palette.button')}</span>}
          {!collapsed && <kbd>Ctrl K</kbd>}
        </button>

        {remote && !collapsed && (
          <div className="remote-badge" title={t('remote.badgeHint')}>
            <Icon name="link" size={14} />
            <span>{t('remote.badge', { name: remote.name })}</span>
            <a href="/logout">{t('remote.signOut')}</a>
          </div>
        )}

        <div className="nav-group nav-primary">
          <ul>
            {mainItems.map((item) => {
              const isActive = item.page === 'workspace' ? nav.page === 'workspace' && !activeModule : nav.page === item.page;
              return (
                <li key={item.page}>
                  <button
                    className={isActive ? 'active' : ''}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => navigate(item.page)}
                    title={`${t(item.label)} (${item.kbd})`}
                    data-nav={item.page}
                    data-kbd={collapsed ? undefined : item.kbd}
                  >
                    <Icon name={item.icon} size={18} />
                    {!collapsed && <span>{t(item.label)}</span>}
                    {!collapsed && item.page === 'connections' && connectedCount > 0 && (
                      <span className="nav-pill ok">{connectedCount}</span>
                    )}
                    {!collapsed && item.page === 'workspace' && installedCards.length > 0 && (
                      <span className="nav-pill">{installedCards.length}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="sidebar-scroll">
          {installedCards.length > 0 && (
            <div className="sidebar-section sidebar-modules">
              {!collapsed && (
                <div className="sidebar-section-head">
                  <button type="button" className="sidebar-section-toggle" aria-expanded={modulesOpen} onClick={() => setModulesOpen((o) => !o)}>
                    <Icon name="chevronDown" size={12} className={modulesOpen ? '' : 'rotated'} />
                    <span>{t('workspace.modules')}</span>
                    <b>{installedCards.length}</b>
                  </button>
                  <IconButton icon="plus" label={t('workspace.add')} className="sidebar-mini-add" onClick={openCatalog} />
                </div>
              )}

              {(collapsed || modulesOpen) && (
                <div className="sidebar-module-groups">
                  {groupedModules.map(({ group, items }) => {
                    const groupClosed = !collapsed && groupedModules.length > 1 && !!closedGroups[group];
                    return (
                      <div key={group} className="sidebar-module-group">
                        {!collapsed && groupedModules.length > 1 && (
                          <button
                            type="button"
                            className="sidebar-group-label"
                            aria-expanded={!groupClosed}
                            onClick={() => setClosedGroups((prev) => ({ ...prev, [group]: !prev[group] }))}
                          >
                            <span>{t(`workspace.group.${group}`)}</span>
                            <Icon name="chevronDown" size={11} className={groupClosed ? 'rotated' : ''} />
                          </button>
                        )}
                        {!groupClosed && (
                          <ul>
                            {items.map((id) => {
                              const label = moduleName(id, t);
                              const active = activeModule === id;
                              return (
                                <li key={id}>
                                  <button
                                    type="button"
                                    data-module={id}
                                    className={`sidebar-module-btn ${active ? 'active' : ''}`}
                                    aria-current={active ? 'page' : undefined}
                                    title={label}
                                    onClick={() => openModule(id)}
                                  >
                                    <Icon name={moduleDef(id).icon} size={16} />
                                    {!collapsed && <span>{label}</span>}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="sidebar-section sidebar-pro">
            {!collapsed ? (
              <button type="button" className="sidebar-section-toggle" data-sidebar-advanced aria-expanded={showProItems} onClick={togglePro}>
                <Icon name="chevronDown" size={12} className={showProItems ? '' : 'rotated'} />
                <span>{t('sidebar.advanced')}</span>
              </button>
            ) : (
              <div className="sidebar-divider" />
            )}
            {(collapsed || showProItems) && (
              <ul>
                {proItems.map((item) => (
                  <li key={item.page}>
                    <button
                      type="button"
                      className={nav.page === item.page ? 'active' : ''}
                      aria-current={nav.page === item.page ? 'page' : undefined}
                      onClick={() => navigate(item.page)}
                      title={`${t(item.label)} (${item.kbd})`}
                      data-nav={item.page}
                      data-kbd={collapsed ? undefined : item.kbd}
                    >
                      <Icon name={item.icon} size={16} />
                      {!collapsed && <span>{t(item.label)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="workspace-side-footer">
          {!remote && !collapsed && <SideStatus />}
          <div className="sidebar-quick">
            <button className="workspace-preferences" onClick={() => navigate('settings')} title={`${t('workspace.preferences')} (Ctrl+,)`}>
              <Icon name="settings" size={16} />
              {!collapsed && <span>{t('workspace.preferences')}</span>}
            </button>
            {!collapsed && (
              <>
                <IconButton icon={look.theme === 'light' ? 'moon' : 'sun'} label={`${t('look.toggleTheme')} (Ctrl+Shift+L)`} onClick={toggleTheme} />
                <IconButton icon="palette" label={t('look.title')} onClick={() => navigate('settings', 'look')} />
              </>
            )}
          </div>
        </div>
      </nav>

      <main className="content">
        <ErrorBoundary key={nav.page}>
          <Suspense fallback={<div className="page" role="status">…</div>}>
            {nav.page === 'dashboard' ? (
              <Monitor />
            ) : nav.page === 'connections' ? (
              <Connections />
            ) : nav.page === 'variables' ? (
              <Variables />
            ) : nav.page === 'designer' ? (
              <Designer />
            ) : nav.page === 'eventStudio' ? (
              <EventStudio />
            ) : (
              <Workspace />
            )}
          </Suspense>
        </ErrorBoundary>
      </main>

      {nav.dialog && (
        <div className="workspace-dialog-backdrop" onMouseDown={closeDialog}>
          <section
            className="workspace-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t(nav.dialog === 'profiles' ? 'nav.profiles' : 'workspace.preferences')}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="workspace-dialog-close">
              <IconButton icon="x" label={t('common.cancel')} onClick={closeDialog} />
            </div>
            <ErrorBoundary key={nav.dialog}>
              <Suspense fallback={<span role="status">…</span>}>
                {nav.dialog === 'profiles' ? <Profiles /> : <Preferences />}
              </Suspense>
            </ErrorBoundary>
          </section>
        </div>
      )}

      <ConfirmModal />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <Toasts />
    </div>
  );
}
