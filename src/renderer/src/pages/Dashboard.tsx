import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@shared/template';
import type { Category } from '@shared/types';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Icon } from '../components/icons';
import { Button, Card, Empty, IconButton } from '../components/ui';
import { useNow } from '../hooks';
import { useT, type TKey } from '../i18n';
import { call, callOk, navigate, useApp, type Page } from '../store';

function StreamCard() {
  const t = useT();
  const stream = useApp((d) => d.state!.stream);
  const connected = useApp((d) => d.state!.twitch.status === 'connected');
  const lang = useApp((d) => d.settings!.language);
  const now = useNow(stream.live ? 1000 : 60_000);
  const [title, setTitle] = useState(stream.title);
  const [category, setCategory] = useState<Category | null>(null);
  const [query, setQuery] = useState(stream.categoryName);
  const [results, setResults] = useState<Category[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow remote changes (e.g. !title from chat) unless the user is editing.
  const dirty = title !== stream.title || (category && category.id !== stream.categoryId);
  useEffect(() => {
    if (!dirty) {
      setTitle(stream.title);
      setQuery(stream.categoryName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.title, stream.categoryName]);

  const search = (q: string) => {
    setQuery(q);
    setOpen(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => setResults((await call('twitch:searchCategories', q)) ?? []), 300);
  };

  const save = async () => {
    setSaving(true);
    await call('twitch:updateStream', { title, ...(category ? { categoryId: category.id } : {}) });
    setSaving(false);
    setCategory(null);
  };

  return (
    <Card
      icon="broadcast"
      title={t('dash.stream')}
      actions={
        <span className={`live-badge ${stream.live ? 'on' : ''}`}>
          <span className="live-dot" />
          {stream.live ? t('dash.live') : t('dash.offline')}
        </span>
      }
    >
      {!connected ? (
        <p className="muted">{t('dash.connectTwitch')}</p>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <Icon name="users" size={16} />
              <b>{stream.live ? stream.viewers : '—'}</b>
              <span>{t('dash.viewers')}</span>
            </div>
            <div className="stat">
              <Icon name="clock" size={16} />
              <b>{stream.live && stream.startedAt ? formatDuration(now - stream.startedAt, lang) : '—'}</b>
              <span>{t('dash.uptime')}</span>
            </div>
          </div>
          <label className="field">
            <span className="field-label">{t('dash.title')}</span>
            <input className="input" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field combo">
            <span className="field-label">{t('dash.category')}</span>
            <input
              className="input"
              value={query}
              onChange={(e) => search(e.target.value)}
              onFocus={() => query && search(query)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
            />
            {open && results.length > 0 && (
              <ul className="combo-list">
                {results.map((c) => (
                  <li
                    key={c.id}
                    onMouseDown={() => {
                      setCategory(c);
                      setQuery(c.name);
                      setOpen(false);
                    }}
                  >
                    {c.boxArtUrl && <img src={c.boxArtUrl} alt="" />}
                    {c.name}
                  </li>
                ))}
              </ul>
            )}
          </label>
          <div className="card-footer">
            <Button variant="primary" icon="check" disabled={!dirty || saving} onClick={() => void save()}>
              {t('dash.saveStream')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function QuickActions() {
  const t = useT();
  // Selectors must return stable references (useSyncExternalStore), so filter after selecting.
  const actions = useApp((d) => d.settings!.actions).filter((a) => a.showOnDashboard);
  const alerts = useApp((d) => d.state!.alerts);
  return (
    <Card icon="zap" title={t('dash.quick')}>
      <div className="alert-ctl">
        <span className="muted">
          {alerts.current ? t('dash.alertNow', { title: alerts.current }) : t('dash.alertIdle')}
          {alerts.queueLength > 0 && ` · ${t('dash.alertQueue', { n: alerts.queueLength })}`}
        </span>
        <div className="row-gap">
          <Button size="sm" icon={alerts.paused ? 'play' : 'pause'} variant={alerts.paused ? 'primary' : 'secondary'} onClick={() => void call('alerts:pause', !alerts.paused)}>
            {alerts.paused ? t('dash.alertsResume') : t('dash.alertsPause')}
          </Button>
          <Button size="sm" icon="skip" disabled={!alerts.current} onClick={() => void call('alerts:skip')}>
            {t('dash.alertsSkip')}
          </Button>
        </div>
      </div>
      {actions.length > 0 && (
        <div className="quick-grid">
          {actions.map((a) => (
            <button key={a.id} type="button" className="quick-btn" style={{ '--c': a.color } as React.CSSProperties} onClick={() => void call('actions:run', a.id)}>
              <span>{a.label}</span>
              {a.hotkey && <kbd>{a.hotkey}</kbd>}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

function ObsMini() {
  const t = useT();
  const obs = useApp((d) => d.state!.obs);
  if (obs.status !== 'connected') {
    return (
      <Card icon="video" title="OBS">
        <p className="muted">{t('dash.obsOff')}</p>
      </Card>
    );
  }
  return (
    <Card
      icon="video"
      title="OBS"
      actions={
        <>
          <IconButton icon="broadcast" label={obs.streaming ? t('obs.stopStream') : t('obs.startStream')} active={obs.streaming} variant={obs.streaming ? 'danger' : 'ghost'} onClick={() => void call('obs:stream', 'toggle')} />
          <IconButton icon="record" label={obs.recording ? t('obs.stopRecord') : t('obs.startRecord')} active={obs.recording} variant={obs.recording ? 'danger' : 'ghost'} onClick={() => void call('obs:record', 'toggle')} />
        </>
      }
    >
      <div className="scene-grid">
        {obs.scenes.map((s) => (
          <button key={s} type="button" className={`scene-btn ${s === obs.currentScene ? 'active' : ''}`} onClick={() => void call('obs:setScene', s)}>
            {s}
          </button>
        ))}
      </div>
    </Card>
  );
}

/** First-run checklist; disappears once everything essential is set up (or when dismissed). */
function SetupSteps() {
  const t = useT();
  const s = useApp((d) => d.state!);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('setupDismissed') === '1';
    } catch {
      return false;
    }
  });
  const steps: { done: boolean; label: TKey; page: Page; sub?: string }[] = [
    { done: !!s.twitch.account, label: 'setup.twitch', page: 'connections' },
    { done: s.obs.status === 'connected', label: 'setup.obs', page: 'connections' },
    { done: s.overlayClients > 0, label: 'setup.overlays', page: 'overlays', sub: 'alerts' },
    { done: !!s.kawaki.account, label: 'setup.kawaki', page: 'kawaki' },
  ];
  const left = steps.filter((x) => !x.done).length;
  if (hidden || left === 0) return null;
  return (
    <Card
      icon="check"
      title={t('setup.title', { done: steps.length - left, total: steps.length })}
      className="setup-card"
      actions={
        <IconButton
          icon="x"
          label={t('setup.dismiss')}
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem('setupDismissed', '1');
            } catch {
              /* ignore */
            }
          }}
        />
      }
    >
      <ol className="setup-steps">
        {steps.map((st) => (
          <li key={st.label} className={st.done ? 'done' : ''}>
            <span className="setup-check">{st.done && <Icon name="check" size={13} />}</span>
            <span>{t(st.label)}</span>
            {!st.done && (
              <Button size="sm" onClick={() => navigate(st.page, st.sub)}>
                {t('setup.go')}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Wheel, poll, giveaway, quiz and banners — one click each while live. */
function FunWidget() {
  const t = useT();
  const wheels = useApp((d) => d.settings!.wheels);
  const banners = useApp((d) => d.settings!.banners);
  const shown = useApp((d) => d.state!.bannersShown);
  const poll = useApp((d) => d.state!.poll);
  const give = useApp((d) => d.state!.giveaway);
  const quiz = useApp((d) => d.state!.quiz);
  const wheel = useApp((d) => d.state!.wheel);
  const now = useNow(1000);
  const quizActive = quiz.status === 'question' || quiz.status === 'reveal' || quiz.status === 'loading';
  return (
    <Card icon="sparkle" title={t('nav.interactive')} actions={<IconButton icon="chevron" label={t('dash.openInteractive')} onClick={() => navigate('interactive')} />}>
      <div className="fun-rows">
        {wheels.length > 0 && (
          <div className="fun-row">
            <Icon name="wheel" size={16} />
            <div className="fun-row-main">
              {wheels.map((w) => (
                <Button key={w.id} size="sm" disabled={w.segments.length === 0} onClick={() => void callOk('wheel:spin', w.id)}>
                  {w.name}
                </Button>
              ))}
            </div>
            <span className="muted small fun-row-state">{wheel.spinning ? t('wheel.spinning') : (wheel.lastResult?.label ?? '')}</span>
          </div>
        )}
        <div className="fun-row">
          <Icon name="poll" size={16} />
          <div className="fun-row-main">
            {poll?.status === 'running' ? (
              <Button size="sm" variant="danger" onClick={() => void call('poll:end')}>
                {t('poll.end')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => void call('poll:start')}>
                {t('poll.start')}
              </Button>
            )}
          </div>
          <span className="muted small fun-row-state">
            {poll ? `${t('poll.votes', { n: poll.total })}${poll.status === 'running' && poll.endsAt ? ` · ${Math.max(0, Math.ceil((poll.endsAt - now) / 1000))}s` : ''}` : ''}
          </span>
        </div>
        <div className="fun-row">
          <Icon name="gift" size={16} />
          <div className="fun-row-main">
            {give.status === 'idle' || give.status === 'done' ? (
              <Button size="sm" onClick={() => void call('giveaway:open')}>
                {t('give.open')}
              </Button>
            ) : (
              <>
                {give.status === 'open' && (
                  <Button size="sm" onClick={() => void call('giveaway:close')}>
                    {t('give.close')}
                  </Button>
                )}
                <Button size="sm" variant="primary" disabled={!give.entrants.length || give.status === 'rolling'} onClick={() => void callOk('giveaway:roll')}>
                  {t('give.roll')}
                </Button>
              </>
            )}
          </div>
          <span className="muted small fun-row-state">
            {give.status === 'done' && give.winner ? t('give.winnerIs', { name: give.winner.userName }) : give.status !== 'idle' ? t('give.entrants', { n: give.entrants.length }) : ''}
          </span>
        </div>
        <div className="fun-row">
          <Icon name="quiz" size={16} />
          <div className="fun-row-main">
            {quizActive ? (
              <Button size="sm" variant="danger" onClick={() => void call('quiz:stop')}>
                {t('quiz.stop')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => void callOk('quiz:start')}>
                {t('quiz.start')}
              </Button>
            )}
          </div>
          <span className="muted small fun-row-state">{quiz.round ? `${quiz.round} / ${quiz.rounds}` : ''}</span>
        </div>
        {banners.length > 0 && (
          <div className="fun-row">
            <Icon name="banner" size={16} />
            <div className="fun-row-main">
              {banners.map((b) => (
                <button key={b.id} type="button" className={`chip ${shown.includes(b.id) ? 'active' : ''}`} onClick={() => void call('banner:showNow', b.id)} title={t('banners.showNow')}>
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function KawakiMini() {
  const t = useT();
  const k = useApp((d) => d.state!.kawaki);
  if (!k.account) return null;
  const w = k.nowWatching;
  return (
    <Card icon="tv" title="Kawaki" actions={<IconButton icon="chevron" label={t('nav.kawaki')} onClick={() => navigate('kawaki')} />}>
      {w ? (
        <div className="now-mini">
          {w.posterUrl && <img src={w.posterUrl} alt="" />}
          <div>
            <b>{w.title}</b>
            <span className="muted small">
              {w.episode != null ? `${t('kawaki.episode', { n: w.episode })} · ` : ''}
              {w.source === 'live' ? t('kawaki.sourceLive') : t('kawaki.sourceList')}
            </span>
          </div>
        </div>
      ) : (
        <p className="muted small">{t('kawaki.nothing')}</p>
      )}
    </Card>
  );
}

export function Dashboard() {
  const t = useT();
  const hasChat = useApp((d) => d.state!.twitch.status !== 'disconnected' || d.chat.length > 0);
  return (
    <div className="dashboard">
      <section className="card dash-chat">
        <header className="card-head">
          <h3>
            <Icon name="chat" size={16} />
            {t('dash.chat')}
          </h3>
        </header>
        {hasChat ? (
          <ChatView />
        ) : (
          <Empty icon="plug" title={t('dash.noTwitch')}>
            {t('dash.noTwitchHint')}
          </Empty>
        )}
      </section>
      <div className="dash-cols">
        <div className="dash-col">
          <SetupSteps />
          <StreamCard />
          <QuickActions />
          <FunWidget />
        </div>
        <div className="dash-col">
          <KawakiMini />
          <ObsMini />
          <Card icon="zap" title={t('dash.events')} className="dash-feed">
            <EventFeed />
          </Card>
        </div>
      </div>
    </div>
  );
}
