import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CONNECTION_MODULES, INTERACTIVE_MODULES, workspaceCards } from '@shared/workspace';
import type { OverlayKind, WorkspaceCard, SettingsKey } from '@shared/types';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { OnboardingWizard } from '../components/OnboardingWizard';
import { SceneVariants } from '../components/SceneVariants';
import { supportsVariants } from '@shared/variants';
import { Icon } from '../components/icons';
import { Button, IconButton, TextInput } from '../components/ui';
import { useT, type TKey } from '../i18n';
import { MODULES, MODULE_GROUPS_ORDER, MODULE_REQUIRES, POPULAR_MODULES, STARTER_PRESETS, moduleDef, type ModuleGroup } from '../workspaceModules';
import { askConfirm, navigate, openCatalog, openModule, profileAction, saveSettings, toast, useApp, useNav } from '../store';

const Conversation = lazy(() => import('./Conversation').then((m) => ({ default: m.Conversation })));
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
const CurseModule = lazy(() => import('./FeaturesFun').then((m) => ({ default: m.CurseModule })));
const DuelModule = lazy(() => import('./FeaturesFun').then((m) => ({ default: m.DuelModule })));
const MelodyModule = lazy(() => import('./FeaturesFun').then((m) => ({ default: m.MelodyModule })));
const StocksModule = lazy(() => import('./FeaturesFun').then((m) => ({ default: m.StocksModule })));
const PortalModule = lazy(() => import('./FeaturesFun').then((m) => ({ default: m.PortalModule })));
const ClipperModule = lazy(() => import('./FeaturesTools').then((m) => ({ default: m.ClipperModule })));
const DuckingModule = lazy(() => import('./FeaturesTools').then((m) => ({ default: m.DuckingModule })));
const ShieldModule = lazy(() => import('./FeaturesTools').then((m) => ({ default: m.ShieldModule })));
const ReportModule = lazy(() => import('./FeaturesTools').then((m) => ({ default: m.ReportModule })));
const FocusModule = lazy(() => import('./FeaturesStream').then((m) => ({ default: m.FocusModule })));
const ShoutoutModule = lazy(() => import('./FeaturesStream').then((m) => ({ default: m.ShoutoutModule })));
const CaptionsModule = lazy(() => import('./FeaturesCaptions').then((m) => ({ default: m.CaptionsModule })));
const TtsModule = lazy(() => import('./FeaturesTts').then((m) => ({ default: m.TtsModule })));

const RESET_KEYS: Partial<Record<WorkspaceCard, SettingsKey>> = { alerts: 'alerts', bot: 'bot', chat: 'chatOverlay', actions: 'actions' };
const GROUPS: ('all' | Exclude<ModuleGroup, 'setup'>)[] = ['all', ...MODULE_GROUPS_ORDER];

function ModuleEditor({ id }: { id: WorkspaceCard }) {
  if (id === 'chat' || id === 'events') return <Conversation kind={id} />;
  if (id === 'alerts') return <Alerts />;
  if (id === 'bot') return <Bot />;
  if (id === 'obs') return <Obs />;
  if (id === 'actions') return <Actions />;
  if (id === 'subforstream') return <SubForStream />;
  if (id === 'stream') return <Stream />;
  if (id === 'kawaki') return <Kawaki />;
  if (CONNECTION_MODULES.includes(id as typeof CONNECTION_MODULES[number])) return <Connection kind={id as typeof CONNECTION_MODULES[number]} />;
  if (INTERACTIVE_MODULES.includes(id as typeof INTERACTIVE_MODULES[number])) return <Interactive kind={id as typeof INTERACTIVE_MODULES[number]} />;
  switch (id) {
    case 'curse': return <CurseModule />;
    case 'duel': return <DuelModule />;
    case 'melody': return <MelodyModule />;
    case 'stocks': return <StocksModule />;
    case 'portal': return <PortalModule />;
    case 'clipper': return <ClipperModule />;
    case 'ducking': return <DuckingModule />;
    case 'shield': return <ShieldModule />;
    case 'report': return <ReportModule />;
    case 'focus': return <FocusModule />;
    case 'shoutout': return <ShoutoutModule />;
    case 'tts': return <TtsModule />;
    case 'captions': return <CaptionsModule />;
  }
  return <Overlay kind={id as OverlayKind} />;
}

/** Inline banner inside a module editor when Twitch or OBS is needed and not connected yet. */
function PrerequisiteBanner({ id }: { id: WorkspaceCard }) {
  const t = useT();
  const state = useApp((d) => d.state!);
  const remote = useApp((d) => !!d.remote);
  if (remote) return null;
  const reqs = MODULE_REQUIRES[id];
  if (!reqs?.length) return null;
  const missingTwitch = reqs.includes('twitch') && state.twitch.status !== 'connected';
  const missingObs = reqs.includes('obs') && state.obs.status !== 'connected';
  if (id === 'song' || (!missingTwitch && !missingObs)) return null;
  return (
    <div className="prereq-banner" role="note">
      <Icon name="info" size={16} />
      <span>{missingTwitch ? t('prereq.twitch') : t('prereq.obs')}</span>
      <div className="row-gap">
        {missingTwitch && (
          <Button size="sm" variant="primary" icon="plug" onClick={() => navigate('connections', 'twitch')}>
            {t('prereq.connectTwitch')}
          </Button>
        )}
        {missingObs && (
          <Button size="sm" variant={missingTwitch ? 'secondary' : 'primary'} icon="video" onClick={() => navigate('connections', 'obs')}>
            {t('prereq.connectObs')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function Workspace() {
  const t = useT();
  const workspace = useApp((d) => d.settings!.workspace);
  const state = useApp((d) => d.state!);
  const profileId = useApp((d) => d.settings!.activeProfileId);
  const remote = useApp((d) => !!d.remote);
  const previousProfile = useRef(profileId);
  const nav = useNav();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<'all' | Exclude<ModuleGroup, 'setup'>>('all');
  const [tab, setTab] = useState<'mine' | 'catalog'>('mine');
  const cards = workspaceCards(workspace.cards);
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      const el = menu.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.removeAttribute('open');
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  const editor = nav.module && cards.includes(nav.module) ? nav.module : undefined;
  const missing = nav.module && !cards.includes(nav.module) ? nav.module : typeof nav.catalog === 'string' ? nav.catalog : undefined;
  const catalogMode = !!nav.catalog || !!missing;

  useEffect(() => {
    if (previousProfile.current !== profileId) {
      previousProfile.current = profileId;
      navigate('workspace');
      setQuery('');
      setGroup('all');
      setTab('mine');
    }
  }, [profileId]);

  useEffect(() => {
    if (missing) {
      setQuery('');
      setGroup('all');
    }
  }, [missing]);

  useEffect(() => {
    if (catalogMode) setTab('catalog');
    else if (!editor && cards.length > 0) setTab('mine');
  }, [catalogMode, editor, cards.length]);

  useEffect(() => {
    document.querySelector('.content')?.scrollTo({ top: 0 });
  }, [nav.module, nav.catalog, profileId]);

  const name = (id: WorkspaceCard) => {
    const m = moduleDef(id);
    return m.title ? t(m.title) : m.name!;
  };
  const save = (next: WorkspaceCard[]) => saveSettings('workspace', { ...workspace, cards: next });
  /** Add and stay in catalog (multi-select ergonomics). */
  const toggleModule = (id: WorkspaceCard) => {
    if (cards.includes(id)) save(cards.filter((x) => x !== id));
    else save([...cards, id]);
  };
  /** Add and immediately jump into editor (used for missing-module direct route gate). */
  const addAndOpen = (id: WorkspaceCard) => {
    if (!cards.includes(id)) save([...cards, id]);
    openModule(id);
  };
  const addBundle = (bundleCards: readonly WorkspaceCard[]) => {
    const merged = [...new Set([...cards, ...bundleCards])];
    if (merged.length === cards.length) return;
    save(merged);
    toast('success', 'modules.bundleAddedToast');
  };
  const move = (id: WorkspaceCard, delta: number) => {
    const next = [...cards];
    const i = next.indexOf(id);
    if (i + delta < 0 || i + delta >= next.length) return;
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    save(next);
  };

  const resetModule = async (id: WorkspaceCard) => {
    const key = RESET_KEYS[id];
    if (!key) return;
    const ok = await askConfirm({
      title: t('workspace.reset'),
      message: t('settings.resetConfirm'),
      confirmLabel: t('workspace.reset'),
      danger: true,
    });
    if (ok) void profileAction('settings:reset', key);
  };

  const renderCard = (m: typeof MODULES[number], mode: 'catalog' | 'mine' | 'popular') => {
    const installed = cards.includes(m.id);
    const inObsCount = state.overlayKinds[m.id as OverlayKind] ?? 0;
    const reqs = MODULE_REQUIRES[m.id] ?? [];
    const needsTwitch = !remote && reqs.includes('twitch') && state.twitch.status !== 'connected';
    const needsObs = !remote && reqs.includes('obs') && state.obs.status !== 'connected';
    return (
      <article
        key={`${mode}:${m.id}`}
        className={`mod-card ${installed ? 'installed' : ''} ${mode === 'popular' ? 'featured' : ''} ${mode === 'mine' ? 'workspace-installed' : ''}`}
        data-mod-card={m.id}
      >
        <div className="mod-card-top">
          <span className={`workspace-tile-icon cat-${m.group}`}>
            <Icon name={m.icon} size={18} />
          </span>
          <div className="mod-card-title">
            <strong>{name(m.id)}</strong>
            <span className="mod-kind-tag">{t(`moduleKind.${m.kindTag}` as TKey)}</span>
          </div>
        </div>
        <p className="mod-card-desc">{t(m.description)}</p>
        {(installed && inObsCount > 0) || needsTwitch || needsObs ? (
          <div className="module-badges">
            {installed && inObsCount > 0 && <span className="module-badge obs">{t('modules.inObs')}</span>}
            {needsTwitch && <span className="module-badge warn">{t('modules.needsTwitch')}</span>}
            {needsObs && <span className="module-badge warn">{t('modules.needsObs')}</span>}
          </div>
        ) : null}
        <div className="mod-card-foot">
          {mode === 'mine' ? (
            <>
              <Button size="sm" variant="secondary" icon="settings" data-open-module={m.id} onClick={() => openModule(m.id)}>
                {t('workspace.settings')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => toggleModule(m.id)}>
                {t('modules.toggleRemove')}
              </Button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-add-module={mode === 'catalog' ? m.id : undefined}
                className={`mod-toggle-btn ${installed ? 'on' : ''}`}
                aria-pressed={installed}
                onClick={() => toggleModule(m.id)}
              >
                <Icon name={installed ? 'check' : 'plus'} size={13} />
                <span>{t(installed ? 'modules.enabled' : 'common.add')}</span>
              </button>
              {installed && (
                <button type="button" className="mod-open-link" data-open-module={m.id} onClick={() => openModule(m.id)}>
                  <span>{t('workspace.settings')}</span>
                  <Icon name="chevron" size={13} />
                </button>
              )}
            </>
          )}
        </div>
      </article>
    );
  };

  if (editor && !catalogMode) {
    return (
      <div className="workspace workspace-single">
        <div className="workspace-editor" data-editor-module={editor} key={`${profileId}:${editor}`}>
          <div className="editor-breadcrumb">
            <button type="button" className="breadcrumb-back" onClick={() => navigate('workspace')}>
              <Icon name="arrowLeft" size={14} />
              <span>{t('modules.backToModules')}</span>
            </button>
            <span className="breadcrumb-sep">/</span>
            <span className="breadcrumb-current">{name(editor)}</span>
          </div>

          <header className="workspace-canvas-head">
            <div>
              <h2>
                <span className={`editor-title-icon cat-${moduleDef(editor).group}`}>
                  <Icon name={moduleDef(editor).icon} size={20} />
                </span>
                {name(editor)}
              </h2>
              <p className="muted small">{t(moduleDef(editor).description)}</p>
            </div>
            <details
              className="workspace-module-menu"
              ref={menu}
              onClick={(e) => {
                if ((e.target as Element).closest('button')) menu.current?.removeAttribute('open');
              }}
            >
              <summary title={t('workspace.edit')}>
                <Icon name="settings" size={15} />
                <span>{t('workspace.moduleActions')}</span>
                <Icon name="chevronDown" size={13} className="workspace-module-menu-arrow" />
              </summary>
              <div>
                <Button size="sm" disabled={cards[0] === editor} onClick={() => move(editor, -1)}>
                  {t('workspace.moveLeft')}
                </Button>
                <Button size="sm" disabled={cards.at(-1) === editor} onClick={() => move(editor, 1)}>
                  {t('workspace.moveRight')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  onClick={() => {
                    save(cards.filter((id) => id !== editor));
                    navigate('workspace');
                  }}
                >
                  {t('workspace.remove')}
                </Button>
                {RESET_KEYS[editor] && (
                  <Button size="sm" onClick={() => void resetModule(editor)}>
                    {t('workspace.reset')}
                  </Button>
                )}
                <p className="muted small">{t('workspace.removeHint')}</p>
              </div>
            </details>
          </header>

          <PrerequisiteBanner id={editor} />
          {supportsVariants(editor as OverlayKind) && <SceneVariants key={editor} kind={editor as OverlayKind} />}
          <ErrorBoundary>
            <Suspense fallback={<span role="status">…</span>}>
              <ModuleEditor id={editor} />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  if (!cards.length && !catalogMode) {
    return (
      <div className="workspace workspace-single">
        <OnboardingWizard />
      </div>
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matchesFilter = (m: typeof MODULES[number]) =>
    m.group !== 'setup' &&
    (group === 'all' || m.group === group) &&
    (!normalizedQuery || `${m.title ? t(m.title) : m.name} ${t(m.description)} ${m.id}`.toLowerCase().includes(normalizedQuery));

  const activeTab = catalogMode || !cards.length ? 'catalog' : tab;
  const catalogItems = MODULES.filter(matchesFilter);
  const installedItems = cards.map((id) => moduleDef(id)).filter(matchesFilter);
  const popularItems = POPULAR_MODULES.map((id) => moduleDef(id)).filter((m) => m && !cards.includes(m.id));
  const showExtras = activeTab === 'catalog' && !normalizedQuery && group === 'all' && !missing;

  return (
    <div className="workspace workspace-single">
      <header className="workspace-header">
        <div>
          <h1>{t('workspace.title')}</h1>
          <p className="muted small">{t('workspace.hint')}</p>
        </div>
        <div className="row-gap">
          {cards.length > 0 && (
            <Button icon="dashboard" onClick={() => navigate('dashboard')}>
              {t('workspace.monitor')}
            </Button>
          )}
          {activeTab !== 'catalog' ? (
            <Button variant="primary" icon="plus" onClick={openCatalog}>
              {t('workspace.add')}
            </Button>
          ) : catalogMode ? (
            <IconButton icon="x" label={t('common.cancel')} onClick={() => navigate('workspace')} />
          ) : null}
        </div>
      </header>

      <div className="module-center" data-testid={activeTab === 'catalog' ? 'module-catalog' : 'module-center'}>
        {missing && (
          <div className="workspace-required">
            <Icon name={moduleDef(missing).icon} size={22} />
            <div>
              <strong>{name(missing)}</strong>
              <p>{t('workspace.required')}</p>
            </div>
            <Button variant="primary" icon="plus" onClick={() => addAndOpen(missing)}>
              {t('workspace.addThis')}
            </Button>
          </div>
        )}

        <div className="module-center-bar">
          {cards.length > 0 && (
            <div className="segmented" role="tablist" aria-label={t('workspace.title')}>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'mine'}
                className={activeTab === 'mine' ? 'active' : ''}
                onClick={() => {
                  setTab('mine');
                  if (catalogMode) navigate('workspace');
                }}
              >
                {t('modules.tabMine', { n: cards.length })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'catalog'}
                className={activeTab === 'catalog' ? 'active' : ''}
                onClick={() => setTab('catalog')}
              >
                {t('modules.tabCatalog')}
              </button>
            </div>
          )}

          <div className="module-search">
            <Icon name="search" size={15} />
            <TextInput value={query} onChange={setQuery} placeholder={t('modules.searchPlaceholder')} />
          </div>
        </div>

        <div className="workspace-category" role="group" aria-label={t('workspace.add')}>
          {GROUPS.map((g) => (
            <button key={g} type="button" className={g === group ? 'active' : ''} onClick={() => setGroup(g)}>
              {t(`workspace.group.${g}`)}
            </button>
          ))}
        </div>

        {showExtras && (
          <section className="module-section">
            <div className="module-section-head">
              <h3>{t('modules.bundles')}</h3>
              <span className="muted small">{t('modules.bundlesHint')}</span>
            </div>
            <div className="bundle-strip">
              {STARTER_PRESETS.map((bundle) => {
                const missingCount = bundle.cards.filter((id) => !cards.includes(id)).length;
                return (
                  <div key={bundle.id} className="bundle-card">
                    <div className="bundle-card-head">
                      <span className="preset-icon">
                        <Icon name={bundle.icon} size={16} />
                      </span>
                      <strong>{t(`preset.${bundle.id}.title` as TKey)}</strong>
                    </div>
                    <p className="muted small">{t(`preset.${bundle.id}.desc` as TKey)}</p>
                    <Button
                      size="sm"
                      variant={missingCount > 0 ? 'secondary' : 'ghost'}
                      icon={missingCount > 0 ? 'plus' : 'check'}
                      disabled={missingCount === 0}
                      onClick={() => addBundle(bundle.cards)}
                    >
                      {missingCount > 0 ? t('modules.bundleAdd', { n: missingCount }) : t('modules.bundleInstalled')}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {showExtras && popularItems.length > 0 && (
          <section className="module-section">
            <div className="module-section-head">
              <h3>{t('modules.popular')}</h3>
              <span className="muted small">{t('modules.popularHint')}</span>
            </div>
            <div className="workspace-catalog-grid">
              {popularItems.map((m) => renderCard(m, 'popular'))}
            </div>
          </section>
        )}

        {activeTab === 'catalog' ? (
          <section className="module-section">
            {showExtras && (
              <div className="module-section-head">
                <h3>{t('modules.allCatalog')}</h3>
              </div>
            )}
            <div className="workspace-catalog-grid">
              {catalogItems.map((m) => renderCard(m, 'catalog'))}
            </div>
            {!catalogItems.length && <p className="muted">{t('palette.empty')}</p>}
          </section>
        ) : (
          <section className="module-section">
            <div className="workspace-installed-grid">
              {installedItems.map((m) => renderCard(m, 'mine'))}
            </div>
            {!installedItems.length && <p className="muted">{t('palette.empty')}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
