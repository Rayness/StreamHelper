import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@shared/template';
import type { Category } from '@shared/types';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Icon } from '../components/icons';
import { Button, Card, Empty, IconButton } from '../components/ui';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { call, useApp } from '../store';

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
      <div className="dash-side">
        <StreamCard />
        <QuickActions />
        <ObsMini />
        <Card icon="zap" title={t('dash.events')} className="dash-feed">
          <EventFeed />
        </Card>
      </div>
    </div>
  );
}
