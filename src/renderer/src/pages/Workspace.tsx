import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CONNECTION_MODULES, INTERACTIVE_MODULES, workspaceCards } from '@shared/workspace';
import type { OverlayKind, WorkspaceCard, SettingsKey } from '@shared/types';
import { Icon } from '../components/icons';
import { Button, Empty, IconButton, TextInput } from '../components/ui';
import { useT } from '../i18n';
import { MODULES, moduleDef, type ModuleGroup } from '../workspaceModules';
import { profileAction, navigate, openCatalog, openModule, saveSettings, useApp, useNav } from '../store';

const Conversation = lazy(() => import('./Conversation').then((m) => ({ default:m.Conversation })));
const Alerts = lazy(() => import('./Alerts').then((m) => ({ default: m.Alerts })));
const Bot = lazy(() => import('./Bot').then((m) => ({ default: m.Bot })));
const Obs = lazy(() => import('./Obs').then((m) => ({ default: m.Obs })));
const Actions = lazy(() => import('./Obs').then((m) => ({ default: m.Actions })));
const SubForStream = lazy(() => import('./Obs').then((m) => ({ default: m.SubForStream })));
const Stream = lazy(() => import('./Dashboard').then((m) => ({ default: m.StreamCard })));
const Kawaki = lazy(() => import('./Kawaki').then((m) => ({ default: m.Kawaki })));
const Connection = lazy(() => import('./Connections').then((m) => ({ default: m.ConnectionDetail })));
const Interactive = lazy(() => import('./Interactive').then((m) => ({ default: m.InteractiveModule })));
const Overlay = lazy(() => import('./Overlays').then((m) => ({ default: m.OverlayDetail })));
const RESET_KEYS: Partial<Record<WorkspaceCard, SettingsKey>> = { alerts:'alerts', bot:'bot', chat:'chatOverlay', actions:'actions' };
const GROUPS: ('all' | ModuleGroup)[] = ['all','channel','display','fun','automation'];

function ModuleEditor({ id }: { id: WorkspaceCard }) {
  if (id === 'chat' || id === 'events') return <Conversation kind={id} />;
  if (id === 'alerts') return <Alerts />;
  if (id === 'bot') return <Bot />;
  if (id === 'obs') return <Obs />;
  if (id === 'actions') return <Actions />;
  if (id === 'subforstream') return <SubForStream />;
  if (id === 'stream') return <Stream />;
  if (id === 'kawaki') return <><Kawaki /><Overlay kind="kawaki" /></>;
  if (CONNECTION_MODULES.includes(id as typeof CONNECTION_MODULES[number])) return <Connection kind={id as typeof CONNECTION_MODULES[number]} />;
  if (INTERACTIVE_MODULES.includes(id as typeof INTERACTIVE_MODULES[number])) return <Interactive kind={id as typeof INTERACTIVE_MODULES[number]} />;
  return <Overlay kind={id as OverlayKind} />;
}

export function Workspace() {
  const t = useT();
  const workspace = useApp((d) => d.settings!.workspace);
  const profileId = useApp((d) => d.settings!.activeProfileId);
  const previousProfile = useRef(profileId);
  const nav = useNav();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<'all' | ModuleGroup>('all');
  const cards = workspaceCards(workspace.cards);
  // Membership is checked on every render, including settings pushes and profile changes.
  const editor = nav.module && cards.includes(nav.module) ? nav.module : undefined;
  const missing = nav.module && !cards.includes(nav.module) ? nav.module : typeof nav.catalog === 'string' ? nav.catalog : undefined;
  const catalog = !!nav.catalog || !!missing;
  useEffect(() => {
    if (previousProfile.current !== profileId) { previousProfile.current = profileId; navigate('workspace'); setQuery(''); setGroup('all'); }
  }, [profileId]);
  useEffect(() => { if (missing) { setQuery(''); setGroup('all'); } }, [missing]);
  const name = (id: WorkspaceCard) => { const m = moduleDef(id); return m.title ? t(m.title) : m.name!; };
  const save = (next: WorkspaceCard[]) => saveSettings('workspace', { ...workspace, cards: next });
  const add = (id: WorkspaceCard) => { if (!cards.includes(id)) save([...cards, id]); openModule(id); };
  const move = (id: WorkspaceCard, delta: number) => { const next = [...cards]; const i = next.indexOf(id); if (i + delta < 0 || i + delta >= next.length) return; [next[i], next[i + delta]] = [next[i + delta], next[i]]; save(next); };
  useEffect(() => { document.querySelector('.content')?.scrollTo({ top: 0 }); }, [nav.module, nav.catalog, profileId]);
  const choices = MODULES.filter((m) => m.group !== 'setup' && (group === 'all' || m.group === group) && (!query.trim() || `${m.title ? t(m.title) : m.name} ${t(m.description)}`.toLowerCase().includes(query.trim().toLowerCase())));
  return <div className="workspace">
    <header className="workspace-header"><div><h1>{t('workspace.title')}</h1><p className="muted small">{t('workspace.hint')}</p></div><Button variant="primary" icon="plus" onClick={openCatalog}>{t('workspace.add')}</Button></header>
    <div className="workspace-layout">
      <aside className="workspace-rail" aria-label={t('workspace.modules')}>
        <button className={`workspace-overview ${!editor && !catalog ? 'active' : ''}`} onClick={() => navigate('workspace')}><Icon name="layers" size={17} />{t('workspace.overview')}</button>
        <span className="workspace-rail-label">{t('workspace.modules')} <b>{cards.length}</b></span>
        <div className="workspace-module-list">{cards.map((id) => <button key={id} data-module={id} className={`workspace-module ${editor === id && !catalog ? 'active' : ''}`} aria-current={editor === id && !catalog ? 'page' : undefined} onClick={() => openModule(id)}><Icon name={moduleDef(id).icon} size={18} /><span>{name(id)}</span><Icon name="chevron" size={13} /></button>)}</div>
        <button className="workspace-rail-add" onClick={openCatalog}><Icon name="plus" size={16} />{t('workspace.add')}</button>
        <p className="muted small">{t('workspace.setupHint')}</p>
      </aside>
      <section className="workspace-canvas">
        {catalog ? <div className="workspace-catalog" data-testid="module-catalog">
          <header className="workspace-canvas-head"><div><h2>{t('workspace.add')}</h2><p className="muted small">{t('workspace.emptyHint')}</p></div><IconButton icon="x" label={t('common.cancel')} onClick={() => navigate('workspace')} /></header>
          {missing && <div className="workspace-required"><Icon name={moduleDef(missing).icon} /><div><strong>{name(missing)}</strong><p>{t('workspace.required')}</p></div><Button variant="primary" icon="plus" onClick={() => add(missing)}>{t('workspace.addThis')}</Button></div>}
          <TextInput value={query} onChange={setQuery} placeholder={t('common.search')} />
          <div className="workspace-category" role="group" aria-label={t('workspace.add')}>{GROUPS.map((g) => <button key={g} className={g === group ? 'active' : ''} onClick={() => setGroup(g)}>{t(`workspace.group.${g}`)}</button>)}</div>
          <div className="workspace-catalog-grid">{choices.map((m) => <button key={m.id} data-add-module={m.id} type="button" className={`workspace-module-choice ${cards.includes(m.id) ? 'added' : ''}`} disabled={cards.includes(m.id)} onClick={() => add(m.id)}><span className="workspace-tile-icon"><Icon name={m.icon} size={23} /></span><strong>{name(m.id)}</strong><p>{t(m.description)}</p><span className="workspace-tile-action"><Icon name={cards.includes(m.id) ? 'check' : 'plus'} size={15} />{t(cards.includes(m.id) ? 'workspace.added' : 'common.add')}</span></button>)}</div>
          {!choices.length && <p className="muted">{t('palette.empty')}</p>}
        </div> : editor ? <div className="workspace-editor" data-editor-module={editor} key={`${profileId}:${editor}`}>
          <header className="workspace-canvas-head"><div><span className="workspace-eyebrow">{t('workspace.modules')}</span><h2><Icon name={moduleDef(editor).icon} size={24} />{name(editor)}</h2><p className="muted small">{t(moduleDef(editor).description)}</p></div><details className="workspace-module-menu"><summary aria-label={t('workspace.edit')}><Icon name="settings" size={17} /></summary><div><Button size="sm" disabled={cards[0] === editor} onClick={() => move(editor,-1)}>{t('workspace.moveLeft')}</Button><Button size="sm" disabled={cards.at(-1) === editor} onClick={() => move(editor,1)}>{t('workspace.moveRight')}</Button><Button size="sm" variant="danger" icon="trash" onClick={() => { save(cards.filter((id) => id !== editor)); navigate('workspace'); }}>{t('workspace.remove')}</Button>{RESET_KEYS[editor] && <Button size="sm" onClick={() => { if (window.confirm(t('settings.resetConfirm'))) void profileAction('settings:reset', RESET_KEYS[editor]!); }}>{t('workspace.reset')}</Button>}<p className="muted small">{t('workspace.removeHint')}</p></div></details></header>
          <Suspense fallback={<span role="status">…</span>}><ModuleEditor id={editor} /></Suspense>
        </div> : <div className="workspace-overview-content">
          {!cards.length ? <div className="workspace-welcome"><span className="workspace-welcome-icon"><Icon name="layers" size={42} /></span><Empty icon="plus" title={t('workspace.empty')}>{t('workspace.emptyHint')}</Empty><Button variant="primary" icon="plus" onClick={openCatalog}>{t('workspace.add')}</Button></div> : <><header className="workspace-canvas-head"><div><h2>{t('workspace.overview')}</h2><p className="muted">{t('workspace.select')}</p></div><span className="pill">{t('workspace.moduleCount',{n:cards.length})}</span></header><div className="workspace-installed-grid">{cards.map((id) => <button key={id} className="workspace-installed" onClick={() => openModule(id)}><Icon name={moduleDef(id).icon} size={25} /><strong>{name(id)}</strong><p>{t(moduleDef(id).description)}</p><span>{t('workspace.settings')} <Icon name="chevron" size={14} /></span></button>)}</div><Button icon="dashboard" onClick={() => navigate('dashboard')}>{t('workspace.monitor')}</Button></>}
        </div>}
      </section>
    </div>
  </div>;
}
