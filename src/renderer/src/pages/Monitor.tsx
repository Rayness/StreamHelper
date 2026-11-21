import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { monitorCards, normalizeMonitorLayout, workspaceCards } from '@shared/workspace';
import { compactRects, gridBottom, monitorRects, MONITOR_COLS, placeCard, sortedCards, type MonitorRects } from '@shared/monitorGrid';
import { timerValue } from '@shared/timer';
import { formatClock } from '@shared/template';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Icon } from '../components/icons';
import { Button, Card, Empty, IconButton, StatusText, TextInput, Toggle } from '../components/ui';
import { StreamCard } from './Dashboard';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { MODULE_GROUPS_ORDER, moduleDef } from '../workspaceModules';
import { call, navigate, openModule, saveSettings, useApp } from '../store';
import type { ConnectionState, MonitorLayout, MonitorRect, OverlayKind, WorkspaceCard } from '@shared/types';

const ROW = 24;
const GAP = 12;
const DRAG_THRESHOLD = 4;
const ESSENTIAL_CARDS: readonly WorkspaceCard[] = ['chat', 'events', 'alerts', 'stream', 'obs', 'actions', 'song'];

interface Drag { id: WorkspaceCard; mode: 'move' | 'resize'; origin: MonitorRect; base: MonitorRects; startX: number; startY: number; dx: number; dy: number; active: boolean }

function useNarrow(): boolean {
  const query = '(max-width: 800px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

const gridArea = (r: MonitorRect): CSSProperties => ({ gridColumn: `${r.x + 1} / span ${r.w}`, gridRow: `${r.y + 1} / span ${r.h}` });

export function Monitor() {
  const t = useT();
  const s = useApp((d) => d.settings!);
  const state = useApp((d) => d.state!);
  const [editing, setEditing] = useState(false);
  const [editStream, setEditStream] = useState(false);
  const [editQuery, setEditQuery] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const remote = useApp((d) => !!d.remote);
  const grid = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const layout = normalizeMonitorLayout(s.workspace.monitor);
  const installed = workspaceCards(s.workspace.cards);
  const cards = monitorCards(installed, layout);
  const layoutKey = JSON.stringify([cards, layout]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rects = useMemo(() => monitorRects(cards, layout), [layoutKey]);
  const saveLayout = (patch: Partial<MonitorLayout>) => saveSettings('workspace', { ...s.workspace, monitor: { ...layout, ...patch } });
  const savePositions = (next: MonitorRects) => saveLayout({ positions: { ...layout.positions, ...next } });
  const ticking = (cards.includes('timer') && s.timers.some((timer) => timer.running)) || (cards.includes('focus') && state.focus.status === 'running');
  const now = useNow(ticking ? 1000 : 60_000);

  const unit = () => {
    const width = grid.current?.clientWidth ?? 1200;
    return { x: (width - GAP * (MONITOR_COLS - 1)) / MONITOR_COLS + GAP, y: ROW + GAP };
  };
  const target = (d: Drag): MonitorRect => {
    const u = unit();
    const cols = Math.round(d.dx / u.x);
    const rows = Math.round(d.dy / u.y);
    return d.mode === 'move' ? { ...d.origin, x: d.origin.x + cols, y: d.origin.y + rows } : { ...d.origin, w: d.origin.w + cols, h: d.origin.h + rows };
  };
  const preview = drag?.active ? placeCard(drag.base, drag.id, target(drag)) : rects;

  const dragRef = useRef(drag);
  dragRef.current = drag;
  const finish = useRef<(d: Drag) => void>(() => undefined);
  finish.current = (d) => savePositions(placeCard(d.base, d.id, target(d)));
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setDrag({ ...d, dx, dy, active: d.active || Math.hypot(dx, dy) > DRAG_THRESHOLD });
    };
    const up = () => {
      const d = dragRef.current;
      if (d?.active) finish.current(d);
      setDrag(null);
    };
    const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', cancel);
    };
  }, [dragging]);

  const begin = (id: WorkspaceCard, mode: Drag['mode'], e: React.PointerEvent) => {
    if (narrow || e.button !== 0 || !rects[id]) return;
    e.preventDefault();
    setDrag({ id, mode, origin: rects[id]!, base: rects, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, active: false });
  };
  const onKey = (id: WorkspaceCard, e: React.KeyboardEvent) => {
    const step = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (!step || !rects[id]) return;
    e.preventDefault();
    const r = rects[id]!;
    savePositions(placeCard(rects, id, e.shiftKey ? { ...r, w: r.w + step[0], h: r.h + step[1] } : { ...r, x: r.x + step[0], y: r.y + step[1] }));
  };

  const connection = (id: WorkspaceCard): ConnectionState | undefined =>
    ({ twitch: state.twitch, obs: state.obs, donationalerts: state.donationalerts, streamlabs: state.streamlabs, streamelements: state.streamelements, donatex: state.donatex, streamerbot: state.streamerbot, discord: state.discord, telegram: state.telegram, subforstream: state.subForStream, kawaki: state.kawaki })[id as 'twitch'];
  const name = (id: WorkspaceCard) => { const m = moduleDef(id); return m.title ? t(m.title) : m.name!; };

  const liveCardBody = (id: WorkspaceCard) => {
    if (id === 'obs') {
      const scenes = state.obs.scenes.filter((sc) => !(state.obs.containers ?? []).includes(sc));
      return (
        <div className="monitor-stack">
          <div className="monitor-status-row">
            <StatusText status={state.obs.status} error={state.obs.error} />
            <span className={`monitor-pill ${state.obs.streaming ? 'live' : ''}`}>
              {state.obs.streaming ? 'LIVE' : t('dash.offline')}
            </span>
          </div>
          {state.obs.status === 'connected' && scenes.length > 0 ? (
            <div className="monitor-scenes" aria-label={t('monitor.scenes')}>
              {scenes.slice(0, 6).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  className={`monitor-scene-btn ${state.obs.currentScene === sc ? 'active' : ''}`}
                  onClick={() => void call('obs:setScene', sc)}
                >
                  {sc}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">{state.obs.currentScene || '—'}</p>
          )}
        </div>
      );
    }

    const conn = connection(id);
    if (conn) {
      return (
        <div className="monitor-stack">
          <StatusText status={conn.status} error={conn.error} />
          {conn.account && <strong>{conn.account.displayName}</strong>}
        </div>
      );
    }

    switch (id) {
      case 'chat':
        return <ChatView />;
      case 'events':
        return <EventFeed limit={25} />;
      case 'stream':
        return (
          <div className="monitor-stack">
            <div className="monitor-status-row">
              <strong className={state.stream.live ? 'live-text' : ''}>{state.stream.live ? t('dash.live') : t('dash.offline')}</strong>
              <span className="pill">{t('dash.viewers')}: {state.stream.viewers}</span>
            </div>
            <p className="monitor-clamp">{state.stream.title || '—'}</p>
            {state.stream.categoryName && <p className="muted small">{state.stream.categoryName}</p>}
          </div>
        );
      case 'alerts':
        return (
          <div className="monitor-stack">
            <div>
              <strong>{state.alerts.current || t(state.alerts.paused ? 'dash.alertsPaused' : 'workspace.alertIdle')}</strong>
              <p className="muted small">{t('dash.alertQueue', { n: state.alerts.queueLength })}</p>
            </div>
            <div className="row-gap wrap">
              <Button size="sm" icon={state.alerts.paused ? 'play' : 'pause'} onClick={() => void call('alerts:pause', !state.alerts.paused)}>
                {t(state.alerts.paused ? 'dash.alertsResume' : 'dash.alertsPause')}
              </Button>
              <Button size="sm" icon="skip" disabled={!state.alerts.current} onClick={() => void call('alerts:skip')}>
                {t('dash.alertsSkip')}
              </Button>
            </div>
          </div>
        );
      case 'actions':
        return s.actions.length ? (
          <div className="monitor-actions-grid">
            {s.actions.slice(0, 8).map((a) => (
              <Button key={a.id} size="sm" icon="zap" onClick={() => void call('actions:run', a.id)}>
                {a.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="muted small">{t('monitor.noActions')}</p>
        );
      case 'goal':
        return s.goals.length ? (
          s.goals.map((g) => (
            <div key={g.id} className="monitor-progress">
              <div className="monitor-progress-head">
                <strong>{g.title}</strong>
                <span>{g.current} / {g.target}</span>
              </div>
              <progress max={Math.max(1, g.target)} value={Math.min(g.current, Math.max(1, g.target))} />
            </div>
          ))
        ) : (
          <p className="muted">{t('workspace.noProgress')}</p>
        );
      case 'timer':
        return (
          <div className="monitor-stack">
            {s.timers.map((timer) => (
              <div key={timer.id} className="monitor-number">
                <span>{timer.title}</span>
                <div className="row-gap">
                  <strong>{formatClock(timerValue(timer, now))}</strong>
                  <IconButton
                    icon={timer.running ? 'pause' : 'play'}
                    label={t(timer.running ? 'song.pause' : 'song.resume')}
                    onClick={() => void call('timer:control', timer.id, timer.running ? 'pause' : 'start')}
                  />
                </div>
              </div>
            ))}
          </div>
        );
      case 'counter':
        return (
          <div className="monitor-stack">
            {s.counterOverlays.map((c) => (
              <div key={c.id} className="monitor-number">
                <span>{c.title}</span>
                <div className="row-gap">
                  <IconButton icon="minus" label="-1" onClick={() => void call('counter:add', c.counter, -1)} />
                  <strong>{s.bot.counters[c.counter] ?? 0}</strong>
                  <IconButton icon="plus" label="+1" onClick={() => void call('counter:add', c.counter, 1)} />
                </div>
              </div>
            ))}
          </div>
        );
      case 'song':
        return (
          <div className="monitor-stack">
            <div>
              <strong className="monitor-clamp">{state.songRequests.current?.title || state.songRequests.current?.videoId || t('song.empty')}</strong>
              <p className="muted small">
                {state.songRequests.queue.length} · {t(state.songRequests.playerConnected ? 'song.playerReady' : 'song.playerMissing')}
              </p>
            </div>
            {state.songRequests.lastError && <p className="error small">{state.songRequests.lastError}</p>}
            <div className="row-gap wrap">
              {state.songRequests.current ? (
                <>
                  <Button size="sm" icon={state.songRequests.paused ? 'play' : 'pause'} onClick={() => void call('song:pause', !state.songRequests.paused)}>
                    {t(state.songRequests.paused ? 'song.resume' : 'song.pause')}
                  </Button>
                  <Button size="sm" icon="skip" onClick={() => void call('song:skip')}>
                    {t('song.skip')}
                  </Button>
                </>
              ) : state.songRequests.queue.length > 0 ? (
                <Button size="sm" variant="primary" icon="play" onClick={() => void call('song:play')}>
                  {t('song.playFirst')}
                </Button>
              ) : null}
            </div>
          </div>
        );
      case 'music':
        return <p>{state.music.track?.title || t('workspace.noProgress')}</p>;
      case 'bot':
        return (
          <div className="monitor-stack">
            <strong>{t(s.bot.enabled ? 'workspace.ready' : 'workspace.disabled')}</strong>
            <p className="muted small">{t('workspace.botSender', { name: state.twitchBot.account?.displayName ?? state.twitch.account?.displayName ?? '—' })}</p>
          </div>
        );
      case 'wheel': {
        const w = s.wheels[0];
        return (
          <div className="monitor-stack">
            <div>
              <strong>{state.wheel.spinning ? t('fun.running') : t('workspace.ready')}</strong>
              {state.wheel.lastResult && <p className="muted small">{state.wheel.lastResult.label}</p>}
            </div>
            {w && (
              <Button size="sm" variant="primary" icon="wheel" disabled={state.wheel.spinning} onClick={() => void call('wheel:spin', w.id)}>
                {t('wheel.spin')}
              </Button>
            )}
          </div>
        );
      }
      case 'leaders':
        return state.chatLeaders.slice(0, s.leadersOverlay.count).map((row) => (
          <div className="monitor-number" key={row.userId}>
            <span>{row.userName}</span>
            <strong>{row.messages}</strong>
          </div>
        ));
      case 'banner':
        return <p>{state.bannersShown.length} / {s.banners.length}</p>;
      case 'ad':
        return <p>{state.ad.activeId ? s.ads.find((a) => a.id === state.ad.activeId)?.name : t('workspace.noProgress')}</p>;
      case 'spotlight':
        return (
          <div className="monitor-stack">
            <p className="monitor-clamp">{state.spotlight ? `${state.spotlight.userName}: ${state.spotlight.text}` : t('workspace.noProgress')}</p>
            {state.spotlight && (
              <Button size="sm" icon="x" onClick={() => void call('spotlight:clear')}>
                {t('spotlight.clear')}
              </Button>
            )}
          </div>
        );
      case 'poll':
        return (
          <div className="monitor-stack">
            <div>
              <strong className="monitor-clamp">{s.poll.question}</strong>
              <p className="muted small">{state.poll?.status === 'running' ? t('fun.running') : t('workspace.ready')}</p>
            </div>
            <Button
              size="sm"
              variant={state.poll?.status === 'running' ? 'secondary' : 'primary'}
              icon="poll"
              onClick={() => void call(state.poll?.status === 'running' ? 'poll:end' : 'poll:start')}
            >
              {t(state.poll?.status === 'running' ? 'poll.end' : 'poll.start')}
            </Button>
          </div>
        );
      case 'giveaway': {
        const g = state.giveaway.status;
        return (
          <div className="monitor-stack">
            <p>{state.giveaway.entrants.length} · {g === 'open' ? t('fun.running') : t('workspace.ready')}</p>
            <div className="row-gap wrap">
              {(g === 'idle' || g === 'done') && (
                <Button size="sm" variant="primary" icon="gift" onClick={() => void call('giveaway:open')}>
                  {t('give.open')}
                </Button>
              )}
              {g === 'open' && (
                <Button size="sm" icon="pause" onClick={() => void call('giveaway:close')}>
                  {t('give.close')}
                </Button>
              )}
              {(g === 'open' || g === 'closed') && state.giveaway.entrants.length > 0 && (
                <Button size="sm" variant="primary" icon="trophy" onClick={() => void call('giveaway:roll')}>
                  {t('give.roll')}
                </Button>
              )}
            </div>
          </div>
        );
      }
      case 'queue':
        return (
          <div className="monitor-stack">
            <p>{state.viewerQueue.entries.length} · {state.viewerQueue.open ? t('fun.running') : t('workspace.ready')}</p>
            <div className="row-gap wrap">
              <Button size="sm" onClick={() => void call('queue:open', !state.viewerQueue.open)}>
                {t(state.viewerQueue.open ? 'queue.close' : 'queue.open')}
              </Button>
              {state.viewerQueue.entries.length > 0 && (
                <Button size="sm" variant="primary" onClick={() => void call('queue:next')}>
                  {t('queue.next')}
                </Button>
              )}
            </div>
          </div>
        );
      case 'guess':
        return (
          <div className="monitor-stack">
            <p>{state.guess.status === 'running' ? t('fun.running') : t('workspace.ready')} · {state.guess.low} — {state.guess.high}</p>
            {state.guess.winner && <strong>{state.guess.winner}</strong>}
            <Button size="sm" onClick={() => void call(state.guess.status === 'running' ? 'guess:stop' : 'guess:start')}>
              {t(state.guess.status === 'running' ? 'guess.stop' : 'guess.start')}
            </Button>
          </div>
        );
      case 'quiz':
        return (
          <div className="monitor-stack">
            <p>{state.quiz.round} / {state.quiz.rounds} · {['loading', 'question', 'reveal'].includes(state.quiz.status) ? t('fun.running') : t('workspace.ready')}</p>
            {state.quiz.leaderboard.slice(0, 5).map((row) => (
              <div className="monitor-number" key={row.userName}>
                <span>{row.userName}</span>
                <strong>{row.points}</strong>
              </div>
            ))}
            {state.quiz.error && <p className="error">{state.quiz.error}</p>}
          </div>
        );
      case 'boss':
        return (
          <div className="monitor-progress">
            <div className="monitor-progress-head">
              <strong>{s.boss.name}</strong>
              <span>{state.boss.hp} / {state.boss.maxHp}</span>
            </div>
            <progress value={state.boss.hp} max={Math.max(1, state.boss.maxHp)} />
          </div>
        );
      case 'hype':
        return (
          <div className="monitor-progress">
            <strong>{state.hype.level}</strong>
            <progress value={state.hype.progress} max={1} />
          </div>
        );
      case 'clipper':
        return (
          <div className="monitor-stack">
            <strong>{s.clipper.enabled ? t('clipper.rate', { n: state.clipper.rate, base: state.clipper.baseline }) : t('workspace.disabled')}</strong>
            {state.clipper.moments.slice(0, 3).map((m) => (
              <p key={m.id} className="muted small">{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {t(`clipReason.${m.reason}`)}{m.clipUrl ? ' 🎬' : ''}</p>
            ))}
            <Button size="sm" icon="scissors" onClick={() => void call('clipper:clip')}>
              {t('clipper.clipNow')}
            </Button>
          </div>
        );
      case 'shield':
        return (
          <div className="monitor-stack">
            <strong className={state.shield.status === 'active' ? 'error' : ''}>{t(`shieldStatus.${state.shield.status}`)}</strong>
            {state.shield.status === 'active' ? (
              <>
                <p className="small">{state.shield.reason}</p>
                <Button size="sm" onClick={() => void call('shield:release')}>{t('shield.release')}</Button>
              </>
            ) : (
              <Button size="sm" variant="danger" icon="shield" onClick={() => void call('shield:activate')}>{t('shield.panic')}</Button>
            )}
          </div>
        );
      case 'ducking':
        return (
          <div className="monitor-stack">
            <strong>{!s.ducking.enabled ? t('workspace.disabled') : state.ducking.ducked ? t('ducking.ducked') : t('ducking.normal')}</strong>
            <p className="muted small">{s.ducking.micInput || '—'}</p>
          </div>
        );
      case 'report':
        return (
          <div className="monitor-stack">
            <div className="monitor-number"><span>{t('report.messages')}</span><strong>{state.report.live.messages}</strong></div>
            <div className="monitor-number"><span>{t('report.peak')}</span><strong>{state.report.live.peakViewers}</strong></div>
            {state.report.live.mvp[0] && <p className="muted small">MVP: {state.report.live.mvp[0].name}</p>}
          </div>
        );
      case 'curse':
        return (
          <div className="monitor-stack">
            <strong>{state.curse.active?.name ?? t(`curseStatus.${state.curse.status}`)}</strong>
            {state.curse.status === 'idle' ? (
              <Button size="sm" icon="skull" onClick={() => void call('curse:vote')}>{t('curse.vote')}</Button>
            ) : state.curse.status === 'active' ? (
              <Button size="sm" onClick={() => void call('curse:lift')}>{t('curse.lift')}</Button>
            ) : (
              <p className="muted small">{t('curse.votes', { n: state.curse.total })}</p>
            )}
          </div>
        );
      case 'duel':
        return (
          <div className="monitor-stack">
            <strong>{t(`duelStatus.${state.duel.status}`)}</strong>
            {state.duel.a && state.duel.b && <p>{state.duel.a.votes} : {state.duel.b.votes}</p>}
          </div>
        );
      case 'melody':
        return (
          <div className="monitor-stack">
            <strong>{t(`melodyStatus.${state.melody.status}`)}</strong>
            {state.melody.round > 0 && <p className="muted small">{state.melody.round} / {state.melody.rounds}</p>}
            {state.melody.leaderboard.slice(0, 3).map((r) => (
              <div className="monitor-number" key={r.userName}><span>{r.userName}</span><strong>{r.points}</strong></div>
            ))}
          </div>
        );
      case 'stocks':
        return state.market.quotes.length ? (
          state.market.quotes.slice(0, 5).map((q) => (
            <div className="monitor-number" key={q.userId}>
              <span>${q.name}</span>
              <strong className={q.change >= 0 ? 'up' : 'down'}>{q.price} <small>{q.change > 0 ? '+' : ''}{q.change}%</small></strong>
            </div>
          ))
        ) : (
          <p className="muted">{t('market.empty')}</p>
        );
      case 'portal':
        return (
          <div className="monitor-stack">
            <StatusText status={state.portal.status} error={state.portal.error} />
            {state.portal.channel && <strong>{state.portal.channel}</strong>}
            {state.portal.messages.slice(0, 3).map((m) => (
              <p key={m.id} className="muted small">{m.direction === 'in' ? '⬅' : '➡'} {m.userName}: {m.text}</p>
            ))}
          </div>
        );
      case 'focus': {
        const f = state.focus;
        const left = f.status === 'running' && f.endsAt ? f.endsAt - now : f.leftMs;
        return f.status === 'idle' ? (
          <div className="monitor-stack">
            <p className="muted small">{t('focus.idle')}</p>
            <Button size="sm" icon="play" onClick={() => void call('focus:toggle')}>{t('focus.start')}</Button>
          </div>
        ) : (
          <div className="monitor-stack">
            <div className="monitor-number">
              <span>{s.focus.labels[f.phase] || t(`focusPhase.${f.phase}`)}{f.status === 'paused' ? ` · ${t('focus.paused')}` : ''}</span>
              <strong>{formatClock(Math.max(0, left))}</strong>
            </div>
            <p className="muted small">{t('focus.sessions', { n: f.done })}</p>
            <Button size="sm" icon={f.status === 'running' ? 'pause' : 'play'} onClick={() => void call('focus:toggle')}>
              {t(f.status === 'running' ? 'focus.pause' : 'focus.resume')}
            </Button>
          </div>
        );
      }
      case 'shoutout':
        return (
          <div className="monitor-stack">
            {state.shoutout.current ? (
              <>
                <strong>{state.shoutout.current.displayName}</strong>
                <Button size="sm" icon="x" onClick={() => void call('shoutout:skip')}>{t('shoutout.hide')}</Button>
              </>
            ) : (
              <p className="muted small">{t('shoutout.idle')}</p>
            )}
            {state.shoutout.queue.length > 0 && <p className="muted small">{t('shoutout.queue', { n: state.shoutout.queue.length })}</p>}
            {state.shoutout.history.slice(0, 3).map((c) => (
              <p key={c.id} className="muted small">{c.displayName}{c.viewers ? ` · ${c.viewers}` : ''}</p>
            ))}
          </div>
        );
      case 'tts':
        return (
          <div className="monitor-stack">
            {!s.tts.enabled ? (
              <p className="muted small">{t('workspace.disabled')}</p>
            ) : state.tts.current ? (
              <>
                <strong>{t('tts.speaking', { name: state.tts.current.userName })}</strong>
                <p className="muted small">{state.tts.current.text}</p>
                <Button size="sm" icon="skip" onClick={() => void call('tts:skip')}>{t('tts.skip')}</Button>
              </>
            ) : (
              <p className="muted small">{t('tts.idle')}</p>
            )}
            {state.tts.queue.length > 0 && <p className="muted small">{t('tts.queue', { n: state.tts.queue.length })}</p>}
          </div>
        );
      case 'captions':
        return (
          <div className="monitor-stack">
            {!s.captions.enabled ? (
              <p className="muted small">{t('workspace.disabled')}</p>
            ) : (
              <>
                <StatusText status={state.captions.listening ? 'connected' : 'disconnected'} />
                {state.captions.lines.slice(-2).map((l) => (
                  <p key={l.id}>{l.text}</p>
                ))}
                {state.captions.interim && <p className="muted small">{state.captions.interim}…</p>}
              </>
            )}
          </div>
        );
      default:
        return <p className="muted small">{t('workspace.sources', { n: state.overlayKinds[id as OverlayKind] ?? 0 })}</p>;
    }
  };

  const order = narrow ? sortedCards(rects) : sortedCards(preview);
  const rows = gridBottom(preview) + (drag?.active ? 8 : 0);

  const q = editQuery.trim().toLowerCase();
  const editGroups = MODULE_GROUPS_ORDER.map((group) => ({
    group,
    items: installed.filter((id) => moduleDef(id).group === group && (!q || name(id).toLowerCase().includes(q))),
  })).filter((g) => g.items.length > 0);

  const applyLayoutPreset = (preset: 'classic' | 'chatControl' | 'compact') => {
    const next: MonitorRects = {};
    let curY = 0;
    if (preset === 'classic') {
      const chatCard = cards.includes('chat');
      const eventsCard = cards.includes('events');
      const rightCol: WorkspaceCard[] = [];
      const midCol: WorkspaceCard[] = [];
      const rest: WorkspaceCard[] = [];
      if (chatCard) next.chat = { x: 0, y: 0, w: 4, h: 16 };
      if (eventsCard) next.events = { x: chatCard ? 4 : 0, y: 0, w: 4, h: 10 };
      for (const id of cards) {
        if (id === 'chat' || id === 'events') continue;
        if (['alerts', 'song', 'poll', 'wheel'].includes(id) && midCol.length < 2) midCol.push(id);
        else if (['stream', 'obs', 'actions', 'goal'].includes(id) && rightCol.length < 3) rightCol.push(id);
        else rest.push(id);
      }
      let my = eventsCard ? 10 : 0;
      const mx = chatCard ? 4 : 0;
      for (const id of midCol) { next[id] = { x: mx, y: my, w: 4, h: 5 }; my += 5; }
      let ry = 0;
      const rx = chatCard ? 8 : eventsCard ? 4 : 0;
      for (const id of rightCol) { next[id] = { x: rx, y: ry, w: 4, h: 5 }; ry += 5; }
      curY = Math.max(chatCard ? 16 : 0, my, ry);
      rest.forEach((id, i) => { next[id] = { x: (i % 3) * 4, y: curY + Math.floor(i / 3) * 5, w: 4, h: 5 }; });
    } else if (preset === 'chatControl') {
      const chatCard = cards.includes('chat');
      if (chatCard) next.chat = { x: 0, y: 0, w: 6, h: 18 };
      const others = cards.filter((id) => id !== 'chat');
      others.forEach((id, i) => {
        if (chatCard && i < 6) next[id] = { x: 6 + (i % 2) * 3, y: Math.floor(i / 2) * 6, w: 3, h: 6 };
        else {
          const j = chatCard ? i - 6 : i;
          next[id] = { x: (j % 3) * 4, y: (chatCard ? 18 : 0) + Math.floor(j / 3) * 5, w: 4, h: 5 };
        }
      });
    } else {
      cards.forEach((id, i) => {
        next[id] = { x: (i % 3) * 4, y: Math.floor(i / 3) * 5, w: 4, h: id === 'chat' ? 10 : 5 };
      });
    }
    savePositions(compactRects(next));
  };

  return (
    <div className="workspace monitor">
      <header className="workspace-header">
        <div>
          <h1>{t('workspace.monitor')}</h1>
          <p className="muted small">{t('monitor.hint')}</p>
        </div>
        <div className="row-gap">
          {installed.length > 0 && (
            <Button data-monitor-edit variant={editing ? 'primary' : 'secondary'} icon="sliders" onClick={() => setEditing(!editing)}>
              {t(editing ? 'workspace.done' : 'monitor.edit')}
            </Button>
          )}
        </div>
      </header>

      {installed.length > 0 && (
        <div className="live-topbar" data-testid="live-topbar">
          <div className="live-topbar-stream">
            <span className={`live-status-pill ${state.stream.live ? 'live' : ''}`}>
              <i />
              {state.stream.live ? t('dash.live') : t('dash.offline')}
            </span>
            {state.twitch.status === 'connected' && (
              <span className="live-viewers">
                <Icon name="users" size={14} />
                <b>{state.stream.viewers}</b>
              </span>
            )}
            <div className="live-topbar-meta">
              <strong title={state.stream.title || undefined}>{state.stream.title || t('monitor.streamNoTitle')}</strong>
              {state.stream.categoryName && <span className="muted small">{state.stream.categoryName}</span>}
            </div>
            {state.twitch.status === 'connected' && (
              <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditStream((v) => !v)}>
                {t(editStream ? 'workspace.done' : 'monitor.streamEdit')}
              </Button>
            )}
          </div>
          <div className="live-topbar-obs">
            {state.obs.status === 'connected' ? (
              <>
                <span className="live-obs-scene" title="OBS">
                  <Icon name="video" size={14} />
                  <span>{state.obs.currentScene || 'OBS'}</span>
                </span>
                <Button size="sm" variant={state.obs.streaming ? 'danger' : 'secondary'} icon="broadcast" onClick={() => void call('obs:stream', 'toggle')}>
                  {state.obs.streaming ? t('obs.stopStream') : t('obs.startStream')}
                </Button>
                <Button size="sm" variant={state.obs.recording ? 'danger' : 'secondary'} icon="record" onClick={() => void call('obs:record', 'toggle')}>
                  {state.obs.recording ? t('obs.stopRecord') : t('obs.startRecord')}
                </Button>
              </>
            ) : !remote ? (
              <Button size="sm" variant="ghost" icon="video" onClick={() => navigate('connections', 'obs')}>
                {t('prereq.connectObs')}
              </Button>
            ) : (
              <span className="muted small">{t('monitor.obsDisconnected')}</span>
            )}
          </div>
        </div>
      )}

      {editStream && (
        <div className="live-stream-editor">
          <StreamCard />
        </div>
      )}

      {editing && (
        <aside className="monitor-customize" aria-label={t('monitor.edit')}>
          <div className="monitor-customize-top">
            <div className="module-search">
              <Icon name="search" size={14} />
              <TextInput value={editQuery} onChange={setEditQuery} placeholder={t('monitor.customizeSearch')} />
            </div>
            <div className="row-gap wrap">
              <Button size="sm" variant="ghost" onClick={() => saveLayout({ hidden: [] })}>
                {t('monitor.showAll')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => saveLayout({ hidden: installed.filter((id) => !ESSENTIAL_CARDS.includes(id)) })}>
                {t('monitor.hideExtra')}
              </Button>
              <Button size="sm" icon="layers" onClick={() => savePositions(compactRects(rects))}>
                {t('monitor.compact')}
              </Button>
              <Button size="sm" icon="replay" onClick={() => saveLayout({ order: [], hidden: [], sizes: {}, positions: {} })}>
                {t('monitor.reset')}
              </Button>
            </div>
          </div>

          <div className="monitor-presets-row">
            <span className="monitor-customize-label">{t('monitor.presets')}</span>
            <div className="row-gap wrap">
              <Button size="sm" variant="secondary" onClick={() => applyLayoutPreset('classic')}>{t('monitor.preset.classic')}</Button>
              <Button size="sm" variant="secondary" onClick={() => applyLayoutPreset('chatControl')}>{t('monitor.preset.chatControl')}</Button>
              <Button size="sm" variant="secondary" onClick={() => applyLayoutPreset('compact')}>{t('monitor.preset.compact')}</Button>
            </div>
          </div>

          <p className="muted small">{t('monitor.customizeHint')}</p>

          <div className="monitor-customize-groups">
            {editGroups.map(({ group, items }) => (
              <div key={group} className="monitor-customize-group">
                <span className="monitor-customize-label">{t(`workspace.group.${group}`)}</span>
                <div className="row-gap wrap">
                  {items.map((id) => (
                    <Toggle
                      key={id}
                      label={name(id)}
                      checked={!layout.hidden.includes(id)}
                      onChange={(show) => saveLayout({ hidden: show ? layout.hidden.filter((item) => item !== id) : [...layout.hidden, id] })}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}

      {!cards.length ? (
        <div className="monitor-empty-wrap">
          <Empty icon="dashboard" title={t('workspace.monitorEmpty')}>
            {t('workspace.monitorEmptyHint')}
          </Empty>
          <Button variant="primary" icon="rocket" onClick={() => navigate('workspace')}>
            {t('monitor.startSetup')}
          </Button>
        </div>
      ) : (
        <div
          ref={grid}
          className={`monitor-grid ${drag?.active ? 'dragging' : ''} ${narrow ? 'stacked' : ''}`}
          style={narrow ? undefined : { gridTemplateRows: `repeat(${rows}, ${ROW}px)`, gap: GAP }}
        >
          {drag?.active && drag.mode === 'move' && <div className="monitor-placeholder" style={gridArea(preview[drag.id]!)} />}
          {order.map((id) => {
            const r = preview[id]!;
            const moving = !!drag?.active && drag.id === id;
            const style: CSSProperties = narrow ? {} : moving && drag!.mode === 'move' ? { ...gridArea(drag!.origin), transform: `translate(${drag!.dx}px, ${drag!.dy}px)` } : gridArea(r);
            return (
              <section
                key={id}
                data-monitor-card={id}
                data-x={r.x}
                data-y={r.y}
                data-w={r.w}
                data-h={r.h}
                className={`monitor-slot ${moving ? 'moving' : ''}`}
                style={style}
                onPointerDown={(e) => {
                  const el = e.target as Element;
                  if (el.closest('.card-head') && !el.closest('button:not(.monitor-drag), a, input, select')) begin(id, 'move', e);
                }}
              >
                <Card
                  className={`monitor-card monitor-${id}`}
                  icon={moduleDef(id).icon}
                  title={name(id)}
                  actions={
                    <>
                      <IconButton className="monitor-drag" icon="grip" label={`${t('monitor.drag')}. ${t('monitor.keysHint')}`} onKeyDown={(e) => onKey(id, e)} />
                      <IconButton icon="external" label={t('workspace.openModule')} onClick={() => openModule(id)} />
                    </>
                  }
                >
                  {liveCardBody(id)}
                </Card>
                {!narrow && (
                  <span
                    className="monitor-resize"
                    title={t('monitor.resize')}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      begin(id, 'resize', e);
                    }}
                  />
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
