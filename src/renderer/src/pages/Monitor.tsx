import { useRef, useState } from 'react';
import { monitorCards, normalizeMonitorLayout, reorderCards, workspaceCards } from '@shared/workspace';
import { timerValue } from '@shared/timer';
import { formatClock } from '@shared/template';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Button, Card, Empty, IconButton, Select, StatusText, Toggle } from '../components/ui';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { moduleDef } from '../workspaceModules';
import { navigate, openModule, saveSettings, useApp } from '../store';
import type { ConnectionState, MonitorLayout, OverlayKind, WorkspaceCard } from '@shared/types';

export function Monitor() {
  const t = useT();
  const s = useApp((d) => d.settings!);
  const state = useApp((d) => d.state!);
  const [editing, setEditing] = useState(false);
  const [dropTarget, setDropTarget] = useState<WorkspaceCard>();
  const dragging = useRef<WorkspaceCard | undefined>(undefined);
  const layout = normalizeMonitorLayout(s.workspace.monitor);
  const installed = workspaceCards(s.workspace.cards);
  const cards = monitorCards(installed, layout);
  const saveLayout = (patch: Partial<MonitorLayout>) => saveSettings('workspace', { ...s.workspace, monitor: { ...layout, ...patch } });
  const move = (from: WorkspaceCard, to: WorkspaceCard) => saveLayout({ order: reorderCards(cards, from, to) });
  const now = useNow(cards.includes('timer') && s.timers.some((timer) => timer.running) ? 1000 : 60_000);
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
      default: return <p className="muted">{t('workspace.sources',{n:state.overlayKinds[id as OverlayKind] ?? 0})}</p>;
    }
  };
  return <div className="workspace monitor"><header className="workspace-header"><div><h1>{t('workspace.monitor')}</h1><p className="muted small">{t('monitor.hint')}</p></div><div className="row-gap"><Button data-monitor-edit icon="settings" onClick={() => setEditing(!editing)}>{t(editing ? 'workspace.done' : 'monitor.edit')}</Button><Button icon="layers" onClick={() => navigate('workspace')}>{t('workspace.title')}</Button></div></header>
    {editing && <div className="monitor-customize"><p className="muted small">{t('monitor.customizeHint')}</p><div className="row-gap wrap">{installed.map((id) => <Toggle key={id} label={name(id)} checked={!layout.hidden.includes(id)} onChange={(show) => saveLayout({ hidden: show ? layout.hidden.filter((item) => item !== id) : [...layout.hidden, id] })} />)}</div><Button size="sm" onClick={() => saveLayout({order:[],hidden:[],sizes:{}})}>{t('monitor.reset')}</Button></div>}
    {!cards.length ? <Empty icon="dashboard" title={t('workspace.monitorEmpty')}>{t('workspace.monitorEmptyHint')}</Empty> : <div className="monitor-grid">{cards.map((id, index) => {
      const size = layout.sizes[id] ?? { width: 1, height: 'compact' };
      return <section key={id} data-monitor-card={id} data-width={size.width} data-height={size.height} className={`monitor-slot ${dropTarget === id ? 'drop-target' : ''}`} style={{ gridColumn:`span ${size.width}` }}
        onDragOver={(e) => { if (dragging.current) { e.preventDefault(); e.dataTransfer.dropEffect='move'; setDropTarget(id); } }}
        onDrop={(e) => { e.preventDefault(); if (dragging.current) move(dragging.current,id); dragging.current=undefined; setDropTarget(undefined); }}>
        <Card className={`monitor-card monitor-${id}`} icon={moduleDef(id).icon} title={name(id)} actions={<><IconButton className="monitor-drag" icon="layers" label={t('monitor.drag')} draggable onDragStart={(e) => { dragging.current=id; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',id); }} onDragEnd={() => { dragging.current=undefined; setDropTarget(undefined); }} /><IconButton icon="external" label={t('workspace.openModule')} onClick={() => openModule(id)} /></>}>{observation(id)}</Card>
        {editing && <div className="monitor-card-options"><IconButton icon="chevron" label={t('workspace.moveLeft')} disabled={!index} onClick={() => move(id,cards[index-1])} /><IconButton icon="chevron" label={t('workspace.moveRight')} disabled={index === cards.length-1} onClick={() => move(id,cards[index+1])} />
          <Select value={String(size.width)} onChange={(width) => saveLayout({ sizes:{...layout.sizes,[id]:{...size,width:Number(width) as 1|2|3}} })} options={(['1','2','3']).map((value) => ({value,label:t('monitor.columns',{n:value})}))} />
          <Select value={size.height} onChange={(height) => saveLayout({ sizes:{...layout.sizes,[id]:{...size,height}} })} options={(['compact','normal','tall'] as const).map((value) => ({value,label:t(`monitor.height.${value}`)}))} />
        </div>}
      </section>;
    })}</div>}
  </div>;
}
