import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { monitorCards, normalizeMonitorLayout, workspaceCards } from '@shared/workspace';
import { compactRects, gridBottom, monitorRects, MONITOR_COLS, placeCard, sortedCards, type MonitorRects } from '@shared/monitorGrid';
import { timerValue } from '@shared/timer';
import { formatClock } from '@shared/template';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Button, Card, Empty, IconButton, StatusText, Toggle } from '../components/ui';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { moduleDef } from '../workspaceModules';
import { call, navigate, openModule, saveSettings, useApp } from '../store';
import type { ConnectionState, MonitorLayout, MonitorRect, OverlayKind, WorkspaceCard } from '@shared/types';

const ROW = 24;
const GAP = 12;
/** Pointer travel before a press on a header becomes a drag (keeps clicks working). */
const DRAG_THRESHOLD = 4;

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
  const [drag, setDrag] = useState<Drag | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const layout = normalizeMonitorLayout(s.workspace.monitor);
  const installed = workspaceCards(s.workspace.cards);
  const cards = monitorCards(installed, layout);
  const layoutKey = JSON.stringify([cards, layout]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rects = useMemo(() => monitorRects(cards, layout), [layoutKey]);
  const saveLayout = (patch: Partial<MonitorLayout>) => saveSettings('workspace', { ...s.workspace, monitor: { ...layout, ...patch } });
  // Saving freezes every visible card where it is; hidden cards keep their last spot.
  const savePositions = (next: MonitorRects) => saveLayout({ positions: { ...layout.positions, ...next } });
  const now = useNow(cards.includes('timer') && s.timers.some((timer) => timer.running) ? 1000 : 60_000);

  /** One grid step in pixels, measured from the live grid width. */
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

  // Window listeners instead of pointer capture: the drag survives leaving the card.
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

  const connection = (id: WorkspaceCard): ConnectionState | undefined => ({ twitch:state.twitch, obs:state.obs, donationalerts:state.donationalerts, streamlabs:state.streamlabs, streamelements:state.streamelements, streamerbot:state.streamerbot, discord:state.discord, subforstream:state.subForStream, kawaki:state.kawaki })[id as 'twitch'];
  const name = (id: WorkspaceCard) => { const m = moduleDef(id); return m.title ? t(m.title) : m.name!; };
  const observation = (id: WorkspaceCard) => {
    const conn = connection(id);
    if (conn) return <><StatusText status={conn.status} error={conn.error} />{conn.account && <strong>{conn.account.displayName}</strong>}{id === 'obs' && <p className="muted">{state.obs.currentScene || '—'} · {state.obs.streaming ? 'LIVE' : t('dash.offline')}</p>}</>;
    switch (id) {
      case 'chat': return <ChatView readOnly />;
      case 'events': return <EventFeed readOnly limit={25} />;
      case 'stream': return <><strong>{state.stream.live ? t('dash.live') : t('dash.offline')}</strong><p>{state.stream.title || '—'}</p><p className="muted">{state.stream.categoryName} · {t('dash.viewers')}: {state.stream.viewers}</p></>;
      case 'alerts': return <><strong>{state.alerts.current || t(state.alerts.paused ? 'dash.alertsPaused' : 'workspace.alertIdle')}</strong><p className="muted">{t('dash.alertQueue',{n:state.alerts.queueLength})}</p></>;
      case 'goal': return s.goals.length ? s.goals.map((g) => <div key={g.id} className="monitor-progress"><strong>{g.title}</strong><progress max={Math.max(1,g.target)} value={Math.min(g.current,Math.max(1,g.target))} /><span>{g.current} / {g.target}</span></div>) : <p className="muted">{t('workspace.noProgress')}</p>;
      case 'timer': return s.timers.map((timer) => <div key={timer.id} className="monitor-number"><span>{timer.title}</span><strong>{formatClock(timerValue(timer,now))}</strong></div>);
      case 'counter': return s.counterOverlays.map((c) => <div key={c.id} className="monitor-number"><span>{c.title}</span><strong>{s.bot.counters[c.counter] ?? 0}</strong></div>);
      case 'song': return <><strong>{state.songRequests.current?.videoId || t('song.empty')}</strong><p className="muted">{state.songRequests.queue.length} · {t(state.songRequests.playerConnected ? 'song.playerReady' : 'song.playerMissing')}</p>{state.songRequests.lastError && <p className="error">{state.songRequests.lastError}</p>}</>;
      case 'music': return <p>{state.music.track?.title || t('workspace.noProgress')}</p>;
      case 'bot': return <><strong>{t(s.bot.enabled ? 'workspace.ready' : 'workspace.disabled')}</strong><p className="muted">{t('workspace.botSender',{name:state.twitchBot.account?.displayName ?? state.twitch.account?.displayName ?? '—'})}</p></>;
      case 'wheel': return <><strong>{state.wheel.spinning ? t('fun.running') : t('workspace.ready')}</strong>{state.wheel.lastResult && <p>{state.wheel.lastResult.label}</p>}</>;
      case 'leaders': return state.chatLeaders.slice(0,s.leadersOverlay.count).map((row) => <div className="monitor-number" key={row.userId}><span>{row.userName}</span><strong>{row.messages}</strong></div>);
      case 'banner': return <p>{state.bannersShown.length} / {s.banners.length}</p>;
      case 'ad': return <p>{state.ad.activeId ? s.ads.find((a) => a.id === state.ad.activeId)?.name : t('workspace.noProgress')}</p>;
      case 'spotlight': return <p>{state.spotlight ? `${state.spotlight.userName}: ${state.spotlight.text}` : t('workspace.noProgress')}</p>;
      case 'poll': return <><strong>{s.poll.question}</strong><p>{state.poll?.status === 'running' ? t('fun.running') : t('workspace.ready')}</p></>;
      case 'giveaway': return <p>{state.giveaway.entrants.length} · {state.giveaway.status === 'open' ? t('fun.running') : t('workspace.ready')}</p>;
      case 'queue': return <p>{state.viewerQueue.entries.length} · {state.viewerQueue.open ? t('fun.running') : t('workspace.ready')}</p>;
      case 'guess': return <><p>{state.guess.status === 'running' ? t('fun.running') : t('workspace.ready')}</p><p>{state.guess.low} — {state.guess.high}</p>{state.guess.winner && <strong>{state.guess.winner}</strong>}</>;
      case 'quiz': return <><p>{state.quiz.round} / {state.quiz.rounds} · {['loading','question','reveal'].includes(state.quiz.status) ? t('fun.running') : t('workspace.ready')}</p>{state.quiz.leaderboard.slice(0,5).map((row) => <div className="monitor-number" key={row.userName}><span>{row.userName}</span><strong>{row.points}</strong></div>)}{state.quiz.error && <p className="error">{state.quiz.error}</p>}</>;
      case 'boss': return <div className="monitor-progress"><strong>{s.boss.name}</strong><progress value={state.boss.hp} max={Math.max(1,state.boss.maxHp)} /><span>{state.boss.hp} / {state.boss.maxHp}</span></div>;
      case 'hype': return <div className="monitor-progress"><strong>{state.hype.level}</strong><progress value={state.hype.progress} max={1} /></div>;
      case 'clipper': return <><strong>{s.clipper.enabled ? t('clipper.rate',{n:state.clipper.rate,base:state.clipper.baseline}) : t('workspace.disabled')}</strong>{state.clipper.moments.slice(0,3).map((m) => <p key={m.id} className="muted">{new Date(m.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })} · {t(`clipReason.${m.reason}`)}{m.clipUrl ? ' 🎬' : ''}</p>)}</>;
      case 'shield': return <><strong className={state.shield.status === 'active' ? 'error' : ''}>{t(`shieldStatus.${state.shield.status}`)}</strong>{state.shield.status === 'active' ? <><p>{state.shield.reason}</p><Button size="sm" onClick={() => void call('shield:release')}>{t('shield.release')}</Button></> : <Button size="sm" variant="danger" icon="shield" onClick={() => void call('shield:activate')}>{t('shield.panic')}</Button>}</>;
      case 'ducking': return <><strong>{!s.ducking.enabled ? t('workspace.disabled') : state.ducking.ducked ? t('ducking.ducked') : t('ducking.normal')}</strong><p className="muted">{s.ducking.micInput || '—'}</p></>;
      case 'report': return <><div className="monitor-number"><span>{t('report.messages')}</span><strong>{state.report.live.messages}</strong></div><div className="monitor-number"><span>{t('report.peak')}</span><strong>{state.report.live.peakViewers}</strong></div>{state.report.live.mvp[0] && <p className="muted">MVP: {state.report.live.mvp[0].name}</p>}</>;
      case 'curse': return <><strong>{state.curse.active?.name ?? t(`curseStatus.${state.curse.status}`)}</strong>{state.curse.status === 'idle' ? <Button size="sm" icon="skull" onClick={() => void call('curse:vote')}>{t('curse.vote')}</Button> : state.curse.status === 'active' ? <Button size="sm" onClick={() => void call('curse:lift')}>{t('curse.lift')}</Button> : <p className="muted">{t('curse.votes',{n:state.curse.total})}</p>}</>;
      case 'duel': return <><strong>{t(`duelStatus.${state.duel.status}`)}</strong>{state.duel.a && state.duel.b && <p>{state.duel.a.votes} : {state.duel.b.votes}</p>}</>;
      case 'melody': return <><strong>{t(`melodyStatus.${state.melody.status}`)}</strong>{state.melody.round > 0 && <p className="muted">{state.melody.round} / {state.melody.rounds}</p>}{state.melody.leaderboard.slice(0,3).map((r) => <div className="monitor-number" key={r.userName}><span>{r.userName}</span><strong>{r.points}</strong></div>)}</>;
      case 'stocks': return state.market.quotes.length ? state.market.quotes.slice(0,5).map((q) => <div className="monitor-number" key={q.userId}><span>${q.name}</span><strong className={q.change >= 0 ? 'up' : 'down'}>{q.price} <small>{q.change > 0 ? '+' : ''}{q.change}%</small></strong></div>) : <p className="muted">{t('market.empty')}</p>;
      case 'portal': return <><StatusText status={state.portal.status} error={state.portal.error} />{state.portal.channel && <strong>{state.portal.channel}</strong>}{state.portal.messages.slice(0,3).map((m) => <p key={m.id} className="muted">{m.direction === 'in' ? '⬅' : '➡'} {m.userName}: {m.text}</p>)}</>;
      default: return <p className="muted">{t('workspace.sources',{n:state.overlayKinds[id as OverlayKind] ?? 0})}</p>;
    }
  };
  const order = narrow ? sortedCards(rects) : sortedCards(preview);
  const rows = gridBottom(preview) + (drag?.active ? 8 : 0);
  return <div className="workspace monitor"><header className="workspace-header"><div><h1>{t('workspace.monitor')}</h1><p className="muted small">{t('monitor.hint')}</p></div><div className="row-gap"><Button data-monitor-edit icon="settings" onClick={() => setEditing(!editing)}>{t(editing ? 'workspace.done' : 'monitor.edit')}</Button><Button icon="layers" onClick={() => navigate('workspace')}>{t('workspace.title')}</Button></div></header>
    {editing && <div className="monitor-customize"><p className="muted small">{t('monitor.customizeHint')}</p><div className="row-gap wrap">{installed.map((id) => <Toggle key={id} label={name(id)} checked={!layout.hidden.includes(id)} onChange={(show) => saveLayout({ hidden: show ? layout.hidden.filter((item) => item !== id) : [...layout.hidden, id] })} />)}</div><div className="row-gap wrap"><Button size="sm" icon="layers" onClick={() => savePositions(compactRects(rects))}>{t('monitor.compact')}</Button><Button size="sm" icon="replay" onClick={() => saveLayout({ order: [], hidden: [], sizes: {}, positions: {} })}>{t('monitor.reset')}</Button></div></div>}
    {!cards.length ? <Empty icon="dashboard" title={t('workspace.monitorEmpty')}>{t('workspace.monitorEmptyHint')}</Empty> : <div ref={grid} className={`monitor-grid ${drag?.active ? 'dragging' : ''} ${narrow ? 'stacked' : ''}`} style={narrow ? undefined : { gridTemplateRows: `repeat(${rows}, ${ROW}px)`, gap: GAP }}>
      {drag?.active && drag.mode === 'move' && <div className="monitor-placeholder" style={gridArea(preview[drag.id]!)} />}
      {order.map((id) => {
        const r = preview[id]!;
        const moving = !!drag?.active && drag.id === id;
        // The dragged card follows the pointer from where it started; the placeholder shows where it lands.
        const style: CSSProperties = narrow ? {} : moving && drag!.mode === 'move' ? { ...gridArea(drag!.origin), transform: `translate(${drag!.dx}px, ${drag!.dy}px)` } : gridArea(r);
        return <section key={id} data-monitor-card={id} data-x={r.x} data-y={r.y} data-w={r.w} data-h={r.h} className={`monitor-slot ${moving ? 'moving' : ''}`} style={style}
          onPointerDown={(e) => { const el = e.target as Element; if (el.closest('.card-head') && !el.closest('button:not(.monitor-drag), a, input, select')) begin(id, 'move', e); }}>
          <Card className={`monitor-card monitor-${id}`} icon={moduleDef(id).icon} title={name(id)} actions={<><IconButton className="monitor-drag" icon="grip" label={`${t('monitor.drag')}. ${t('monitor.keysHint')}`} onKeyDown={(e) => onKey(id, e)} /><IconButton icon="external" label={t('workspace.openModule')} onClick={() => openModule(id)} /></>}>{observation(id)}</Card>
          {!narrow && <span className="monitor-resize" title={t('monitor.resize')} onPointerDown={(e) => { e.stopPropagation(); begin(id, 'resize', e); }} />}
        </section>;
      })}
    </div>}
  </div>;
}
