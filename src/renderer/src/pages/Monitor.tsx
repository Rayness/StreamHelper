import { normalizeWorkspaceCards } from '@shared/workspace';
import { timerValue } from '@shared/timer';
import { formatClock } from '@shared/template';
import { ChatView } from '../components/ChatView';
import { EventFeed } from '../components/EventFeed';
import { Button, Card, Empty, StatusText } from '../components/ui';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { moduleDef } from '../workspaceModules';
import { navigate, openModule, useApp } from '../store';
import type { ConnectionState, OverlayKind, WorkspaceCard } from '@shared/types';

export function Monitor() {
  const t = useT();
  const s = useApp((d) => d.settings!);
  const state = useApp((d) => d.state!);
  const cards = normalizeWorkspaceCards(s.workspace.cards);
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
  return <div className="workspace monitor"><header className="workspace-header"><div><h1>{t('workspace.monitor')}</h1><p className="muted small">{t('workspace.monitorHint')}</p></div><Button icon="layers" onClick={() => navigate('workspace')}>{t('workspace.title')}</Button></header>
    {!cards.length ? <Empty icon="dashboard" title={t('workspace.monitorEmpty')}>{t('workspace.monitorEmptyHint')}</Empty> : <div className="monitor-grid">{cards.map((id) => <Card key={id} className={`monitor-card monitor-${id}`} icon={moduleDef(id).icon} title={name(id)} actions={<Button size="sm" onClick={() => openModule(id)}>{t('workspace.openModule')}</Button>}>{observation(id)}</Card>)}</div>}
  </div>;
}
