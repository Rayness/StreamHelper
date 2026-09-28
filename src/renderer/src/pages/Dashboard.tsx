import { useEffect, useRef, useState } from 'react';
import { formatAmount } from '@shared/events';
import { formatDuration } from '@shared/template';
import type { Category } from '@shared/types';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Icon, type IconName } from '../components/icons';
import { Button, Card, Empty, IconButton } from '../components/ui';
import { useNow } from '../hooks';
import { useT, type TKey } from '../i18n';
import { call, callOk, navigate, useApp, type Page } from '../store';

/** Always-visible line on top: live state, numbers of this stream, alert queue and OBS output. */
function LiveStrip() {
  const t = useT();
  const stream = useApp((d) => d.state!.stream);
  const obs = useApp((d) => d.state!.obs);
  const alerts = useApp((d) => d.state!.alerts);
  const stats = useApp((d) => d.settings!.stats);
  const currency = useApp((d) => d.settings!.currency);
  const lang = useApp((d) => d.settings!.language);
  const now = useNow(stream.live ? 1000 : 60_000);
  const obsOn = obs.status === 'connected';
  const toggleStream = () => {
    // Ending a broadcast by a stray click is the one mistake that can't be undone on air.
    if (obs.streaming && !confirm(t('dash.stopStreamConfirm'))) return;
    void call('obs:stream', 'toggle');
  };
  return (
    <section className="live-strip" aria-label={t('dash.stream')}>
      <div className="strip-group">
        <span className={`live-badge ${stream.live ? 'on' : ''}`}>
          <span className="live-dot" />
          {stream.live ? t('dash.live') : t('dash.offline')}
        </span>
        <span className="strip-stat" title={t('dash.viewers')}>
          <Icon name="users" size={15} />
          <b>{stream.live ? stream.viewers : '—'}</b>
        </span>
        <span className="strip-stat" title={t('dash.uptime')}>
          <Icon name="clock" size={15} />
          <b>{stream.live && stream.startedAt ? formatDuration(now - stream.startedAt, lang) : '—'}</b>
        </span>
      </div>
      <div className="strip-group strip-session" title={t('dash.sessionHint')}>
        <span className="strip-stat"><Icon name="heart" size={14} /><b>{stats.follows}</b></span>
        <span className="strip-stat"><Icon name="star" size={14} /><b>{stats.subs}</b></span>
        <span className="strip-stat"><Icon name="diamond" size={14} /><b>{stats.bits}</b></span>
        <span className="strip-stat"><Icon name="coin" size={14} /><b>{formatAmount(stats.donations)} {currency}</b></span>
      </div>
      <div className="strip-group strip-alerts">
        <span className="muted small strip-alert-text">
          {alerts.paused ? t('dash.alertsPaused') : alerts.current ? t('dash.alertNow', { title: alerts.current }) : t('dash.alertIdle')}
          {alerts.queueLength > 0 && ` · ${t('dash.alertQueue', { n: alerts.queueLength })}`}
        </span>
        <IconButton
          icon={alerts.paused ? 'play' : 'pause'}
          label={alerts.paused ? t('dash.alertsResume') : t('dash.alertsPause')}
          active={alerts.paused}
          variant={alerts.paused ? 'primary' : 'ghost'}
          onClick={() => void call('alerts:pause', !alerts.paused)}
        />
        <IconButton icon="skip" label={t('dash.alertsSkip')} disabled={!alerts.current} onClick={() => void call('alerts:skip')} />
      </div>
      {obsOn && (
        <div className="strip-group strip-obs">
          <span className="muted small strip-scene" title={t('obs.scenes')}>{obs.currentScene}</span>
          <button type="button" className={`strip-out ${obs.streaming ? 'on' : ''}`} onClick={toggleStream} title={obs.streaming ? t('obs.stopStream') : t('obs.startStream')}>
            <Icon name="broadcast" size={15} />
            {obs.streaming ? t('dash.onAir') : t('dash.goLive')}
          </button>
          <button type="button" className={`strip-out ${obs.recording ? 'on' : ''}`} onClick={() => void call('obs:record', 'toggle')} title={obs.recording ? t('obs.stopRecord') : t('obs.startRecord')}>
            <Icon name="record" size={15} />
            REC
          </button>
        </div>
      )}
    </section>
  );
}

function StreamCard() {
  const t = useT();
  const stream = useApp((d) => d.state!.stream);
  const connected = useApp((d) => d.state!.twitch.status === 'connected');
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
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const search = (q: string) => {
    setQuery(q);
    setOpen(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) return setResults([]);
    searchTimer.current = setTimeout(async () => setResults((await call('twitch:searchCategories', q)) ?? []), 300);
  };

  const save = async () => {
    setSaving(true);
    const ok = await callOk('twitch:updateStream', { title, ...(category ? { categoryId: category.id } : {}) });
    setSaving(false);
    // Keep the picked category on failure so "Save" can simply be pressed again.
    if (ok) setCategory(null);
  };

  if (!connected) {
    return (
      <Card icon="broadcast" title={t('dash.stream')}>
        <p className="muted">{t('dash.connectTwitch')}</p>
      </Card>
    );
  }
  return (
    <Card icon="broadcast" title={t('dash.stream')}>
      <label className="field">
        <span className="field-label">{t('dash.title')}</span>
        <input
          className="input"
          value={title}
          maxLength={140}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && !saving && void save()}
        />
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
        {dirty && (
          <Button
            variant="ghost"
            onClick={() => {
              setTitle(stream.title);
              setQuery(stream.categoryName);
              setCategory(null);
            }}
          >
            {t('common.cancel')}
          </Button>
        )}
        <Button variant="primary" icon="check" disabled={!dirty || saving} onClick={() => void save()}>
          {t('dash.saveStream')}
        </Button>
      </div>
    </Card>
  );
}

function QuickActions() {
  const t = useT();
  // Selectors must return stable references (useSyncExternalStore), so filter after selecting.
  const actions = useApp((d) => d.settings!.actions).filter((a) => a.showOnDashboard);
  return (
    <Card icon="zap" title={t('dash.quick')} actions={<IconButton icon="edit" label={t('dash.editActions')} onClick={() => navigate('obs')} />}>
      {actions.length > 0 ? (
        <div className="quick-grid">
          {actions.map((a) => (
            <button key={a.id} type="button" className="quick-btn" style={{ '--c': a.color } as React.CSSProperties} onClick={() => void call('actions:run', a.id)}>
              <span>{a.label}</span>
              {a.hotkey && <kbd>{a.hotkey}</kbd>}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small">{t('dash.noActions')}</p>
      )}
    </Card>
  );
}

/** Bot counters shown as overlays, with big +/- buttons: deaths, wins, drinks. */
function Counters() {
  const t = useT();
  const list = useApp((d) => d.settings!.counterOverlays);
  const counters = useApp((d) => d.settings!.bot.counters);
  if (!list.length) return null;
  return (
    <Card icon="hash" title={t('dash.counters')} actions={<IconButton icon="edit" label={t('ov.counter')} onClick={() => navigate('overlays', 'counter')} />}>
      <div className="counter-rows">
        {list.map((c) => (
          <div key={c.id} className="counter-row">
            <span className="counter-name">{c.title}</span>
            <IconButton icon="minus" label="−1" onClick={() => void call('counter:add', c.counter, -1)} />
            <b className="counter-num" style={{ color: c.accentColor }}>{counters[c.counter] ?? 0}</b>
            <IconButton icon="plus" label="+1" variant="primary" onClick={() => void call('counter:add', c.counter, 1)} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function ObsMini() {
  const t = useT();
  const obs = useApp((d) => d.state!.obs);
  if (obs.status !== 'connected') {
    return (
      <Card icon="video" title="OBS">
        <p className="muted small">{t('dash.obsOff')}</p>
        <Button size="sm" icon="plug" onClick={() => void call('obs:connect')}>{t('common.connect')}</Button>
      </Card>
    );
  }
  return (
    <Card icon="video" title={t('obs.scenes')}>
      <div className="scene-grid">
        {obs.scenes.map((s) => (
          <button key={s} type="button" className={`scene-btn ${s === obs.currentScene ? 'active' : ''}`} onClick={() => void call('obs:setScene', s)}>
            {s}
          </button>
        ))}
      </div>
      {obs.inputs.length > 0 && (
        <div className="mute-row">
          {obs.inputs.map((i) => (
            <button key={i.name} type="button" className={`chip ${i.muted ? 'muted-chip' : 'active'}`} onClick={() => void call('obs:toggleMute', i.name)} title={i.muted ? t('dash.unmute') : t('dash.mute')}>
              <Icon name="mic" size={13} />
              {i.name}
            </button>
          ))}
        </div>
      )}
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

function ActivityRow({ icon, page = 'interactive', tab, children, state, live }: { icon: IconName; page?: Page; tab: string; children: React.ReactNode; state?: React.ReactNode; live?: boolean }) {
  const t = useT();
  return (
    <div className={`fun-row ${live ? 'live' : ''}`}>
      <button type="button" className="fun-row-icon" onClick={() => navigate(page, tab)} title={t('dash.openInteractive')}>
        <Icon name={icon} size={16} />
      </button>
      <div className="fun-row-main">{children}</div>
      {state && <span className="muted small fun-row-state">{state}</span>}
    </div>
  );
}

/** Every viewer activity, one click each while live. */
function Activities() {
  const t = useT();
  const wheels = useApp((d) => d.settings!.wheels);
  const banners = useApp((d) => d.settings!.banners);
  const shown = useApp((d) => d.state!.bannersShown);
  const poll = useApp((d) => d.state!.poll);
  const give = useApp((d) => d.state!.giveaway);
  const quiz = useApp((d) => d.state!.quiz);
  const wheel = useApp((d) => d.state!.wheel);
  const boss = useApp((d) => d.state!.boss);
  const queue = useApp((d) => d.state!.viewerQueue);
  const guess = useApp((d) => d.state!.guess);
  const hype = useApp((d) => d.state!.hype);
  const hypeMax = useApp((d) => Math.max(1, d.settings!.hype.maxLevel));
  const kawaki = useApp((d) => d.state!.kawaki.status === 'connected');
  const now = useNow(1000);
  const quizActive = quiz.status === 'question' || quiz.status === 'reveal' || quiz.status === 'loading';
  return (
    <Card icon="sparkle" title={t('dash.activities')} actions={<IconButton icon="chevron" label={t('dash.openInteractive')} onClick={() => navigate('interactive')} />}>
      <div className="fun-rows">
        {wheels.length > 0 && (
          <ActivityRow icon="wheel" tab="wheel" live={wheel.spinning} state={wheel.spinning ? t('wheel.spinning') : wheel.lastResult?.label}>
            {wheels.map((w) => (
              <Button key={w.id} size="sm" disabled={w.segments.length === 0} onClick={() => void callOk('wheel:spin', w.id)}>
                {w.name}
              </Button>
            ))}
          </ActivityRow>
        )}
        <ActivityRow
          icon="poll"
          tab="poll"
          live={poll?.status === 'running'}
          state={poll ? `${t('poll.votes', { n: poll.total })}${poll.status === 'running' && poll.endsAt ? ` · ${Math.max(0, Math.ceil((poll.endsAt - now) / 1000))}s` : ''}` : undefined}
        >
          {poll?.status === 'running' ? (
            <Button size="sm" variant="danger" onClick={() => void call('poll:end')}>{t('poll.end')}</Button>
          ) : (
            <Button size="sm" onClick={() => void callOk('poll:start')}>{t('poll.start')}</Button>
          )}
        </ActivityRow>
        <ActivityRow
          icon="gift"
          tab="giveaway"
          live={give.status === 'open' || give.status === 'rolling'}
          state={give.status === 'done' && give.winner ? t('give.winnerIs', { name: give.winner.userName }) : give.status !== 'idle' ? t('give.entrants', { n: give.entrants.length }) : undefined}
        >
          {give.status === 'idle' || give.status === 'done' ? (
            <Button size="sm" onClick={() => void callOk('giveaway:open')}>{t('give.open')}</Button>
          ) : (
            <>
              {give.status === 'open' && <Button size="sm" onClick={() => void call('giveaway:close')}>{t('give.close')}</Button>}
              <Button size="sm" variant="primary" disabled={!give.entrants.length || give.status === 'rolling'} onClick={() => void callOk('giveaway:roll')}>
                {t('give.roll')}
              </Button>
            </>
          )}
        </ActivityRow>
        <ActivityRow
          icon="users"
          tab="queue"
          live={queue.open}
          state={queue.picked[0] ? `${t('queue.upNow')}: ${queue.picked[0].userName}` : undefined}
        >
          <Button size="sm" onClick={() => void call('queue:open', !queue.open)}>{queue.open ? t('dash.queueClose') : t('dash.queueOpen')}</Button>
          <Button size="sm" variant="primary" disabled={!queue.entries.length} onClick={() => void callOk('queue:next')}>
            {t('dash.queueNext')}{queue.entries.length ? ` (${queue.entries.length})` : ''}
          </Button>
        </ActivityRow>
        <ActivityRow
          icon="hash"
          tab="guess"
          live={guess.status === 'running'}
          state={guess.status === 'running' ? `${guess.low}–${guess.high} · ${t('guess.attempts', { n: guess.attempts })}` : guess.status === 'won' ? t('guess.won', { name: guess.winner ?? '' }) : undefined}
        >
          {guess.status === 'running' ? (
            <Button size="sm" variant="danger" onClick={() => void call('guess:stop')}>{t('guess.stop')}</Button>
          ) : (
            <Button size="sm" onClick={() => void callOk('guess:start')}>{t('fun.guess')}</Button>
          )}
        </ActivityRow>
        <ActivityRow icon="target" tab="boss" live={boss.status === 'running'} state={boss.status !== 'idle' ? `${boss.hp} / ${boss.maxHp} HP` : undefined}>
          {boss.status === 'running' ? (
            <Button size="sm" onClick={() => void call('boss:reset')}>{t('boss.reset')}</Button>
          ) : (
            <Button size="sm" onClick={() => void call('boss:start')}>{t('fun.boss')}</Button>
          )}
        </ActivityRow>
        {kawaki && (
          <ActivityRow icon="quiz" tab="quiz" live={quizActive} state={quiz.round ? `${quiz.round} / ${quiz.rounds}` : undefined}>
            {quizActive ? (
              <Button size="sm" variant="danger" onClick={() => void call('quiz:stop')}>{t('quiz.stop')}</Button>
            ) : (
              <Button size="sm" onClick={() => void callOk('quiz:start')}>{t('fun.quiz')}</Button>
            )}
          </ActivityRow>
        )}
        {banners.length > 0 && (
          <ActivityRow icon="banner" page="overlays" tab="banner">
            {banners.map((b) => (
              <button key={b.id} type="button" className={`chip ${shown.includes(b.id) ? 'active' : ''}`} onClick={() => void call('banner:showNow', b.id)} title={t('banners.showNow')}>
                {b.name}
              </button>
            ))}
          </ActivityRow>
        )}
        <div className="fun-row">
          <span className="fun-row-icon static"><Icon name="zap" size={16} /></span>
          <div className="hype-mini" title={t('ov.hype')}>
            <div className="meter"><span style={{ width: `${hype.level ? Math.min(1, (hype.level - 1 + hype.progress) / hypeMax) * 100 : 0}%` }} /></div>
          </div>
          <span className="muted small fun-row-state">{hype.level ? t('hype.level', { n: hype.level }) : t('hype.calm')}</span>
        </div>
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
      <LiveStrip />
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
          <QuickActions />
          <Activities />
          <Counters />
        </div>
        <div className="dash-col">
          <StreamCard />
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
