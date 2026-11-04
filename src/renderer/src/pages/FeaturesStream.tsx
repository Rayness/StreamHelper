import { useState } from 'react';
import type { FocusPhase, FocusSettings, ShoutoutSettings } from '@shared/types';
import { formatDuration } from '@shared/template';
import { OverlayBar, OverlayPreview } from '../components/overlay';
import { Button, Card, ColorInput, Empty, Field, NumberInput, Select, TextArea, TextInput, Toggle } from '../components/ui';
import { useClock, useNow } from '../hooks';
import { useT } from '../i18n';
import { call, callOk, saveSettings, useApp } from '../store';
import { CommandInput, LookFields } from './FeaturesFun';
import { ScopeCallout } from './FeaturesTools';

const PHASES: FocusPhase[] = ['focus', 'break', 'long'];

function clock(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ---------- focus timer ----------

export function FocusModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.focus);
  const lang = useApp((d) => d.settings!.language);
  const f = useApp((d) => d.state!.focus);
  const obs = useApp((d) => d.state!.obs);
  const now = useNow(500);
  const set = (patch: Partial<FocusSettings>) => saveSettings('focus', { ...cfg, ...patch });
  const left = f.status === 'running' && f.endsAt ? f.endsAt - now : f.status === 'paused' ? f.leftMs : 0;
  const label = cfg.labels[f.phase] || t(`focusPhase.${f.phase}`);
  const waiting = f.status === 'paused' && f.leftMs >= f.durationMs;
  const toggleLabel = f.status === 'idle' ? t('focus.start') : f.status === 'running' ? t('focus.pause') : waiting ? t('focus.startPhase', { phase: label }) : t('focus.resume');
  const scenes = obs.scenes.filter((s) => !(obs.containers ?? []).includes(s));
  const sceneOptions = [{ value: '', label: t('focus.noScene') }, ...(cfg.breakScene && !scenes.includes(cfg.breakScene) ? [cfg.breakScene] : []).concat(scenes).map((s) => ({ value: s, label: s }))];
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            <div className="control-status">
              <span className="muted small">{f.status === 'idle' ? t('focus.idle') : f.status === 'paused' ? `${label} · ${t('focus.paused')}` : label}</span>
              <b className="focus-clock">{clock(f.status === 'idle' ? cfg.focusMin * 60_000 : left)}</b>
            </div>
            <Button variant="primary" icon={f.status === 'running' ? 'pause' : 'play'} className="btn-hero" onClick={() => void callOk('focus:toggle')}>{toggleLabel}</Button>
          </div>
          <div className="row-gap wrap">
            <Button size="sm" icon="skip" disabled={f.status === 'idle'} onClick={() => void call('focus:skip')}>{t('focus.skip')}</Button>
            <Button size="sm" disabled={f.status === 'idle'} onClick={() => void call('focus:add', -1)}>−1</Button>
            <Button size="sm" disabled={f.status === 'idle'} onClick={() => void call('focus:add', 1)}>+1</Button>
            <Button size="sm" disabled={f.status === 'idle'} onClick={() => void call('focus:add', 5)}>+5</Button>
            <Button size="sm" variant="danger" disabled={f.status === 'idle'} onClick={() => void call('focus:stop')}>{t('focus.stop')}</Button>
          </div>
          <p className="muted small">
            {t('focus.sessions', { n: f.done })} · {t('focus.total', { time: formatDuration(f.focusMs, lang) })}
            {f.extendedMin > 0 && <> · {t('focus.extended', { n: f.extendedMin })}</>}
          </p>
          <div className="form">
            <Field label={t('focus.task')} hint={t('focus.taskHint')} wide><TextInput value={cfg.task} onChange={(task) => set({ task })} /></Field>
          </div>
        </Card>
        <Card title={t('focus.schedule')}>
          <div className="form">
            <Field label={t('focus.focusMin')}><NumberInput value={cfg.focusMin} min={1} max={240} onChange={(focusMin) => set({ focusMin })} /></Field>
            <Field label={t('focus.breakMin')}><NumberInput value={cfg.breakMin} min={1} max={120} onChange={(breakMin) => set({ breakMin })} /></Field>
            <Field label={t('focus.longBreakMin')}><NumberInput value={cfg.longBreakMin} min={1} max={180} onChange={(longBreakMin) => set({ longBreakMin })} /></Field>
            <Field label={t('focus.longEvery')} hint={t('focus.longEveryHint')}><NumberInput value={cfg.longEvery} min={0} max={12} onChange={(longEvery) => set({ longEvery })} /></Field>
            <Field label={t('overlays.options')} hint={t('focus.autoContinueHint')} wide><Toggle checked={cfg.autoContinue} onChange={(autoContinue) => set({ autoContinue })} label={t('focus.autoContinue')} /></Field>
          </div>
        </Card>
        <Card title={t('focus.chat')}>
          <div className="form">
            <Field label={t('focus.reward')} hint={t('focus.rewardHint')} wide><TextInput value={cfg.rewardTitle} onChange={(rewardTitle) => set({ rewardTitle })} /></Field>
            <Field label={t('focus.rewardMinutes')}><NumberInput value={cfg.rewardMinutes} min={1} max={60} onChange={(rewardMinutes) => set({ rewardMinutes })} /></Field>
            <Field label={t('focus.maxExtend')}><NumberInput value={cfg.maxExtendMin} min={0} max={240} onChange={(maxExtendMin) => set({ maxExtendMin })} /></Field>
            <Field label={t('focus.command')} hint={t('focus.commandHint')}><CommandInput value={cfg.command} onChange={(command) => set({ command })} /></Field>
            <Field label={t('overlays.options')} wide><Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('focus.announce')} /></Field>
          </div>
        </Card>
        <Card title={t('focus.obs')}>
          <div className="form">
            <Field label={t('focus.breakScene')} hint={t('focus.breakSceneHint')} wide><Select value={cfg.breakScene} onChange={(breakScene) => set({ breakScene })} options={sceneOptions} /></Field>
          </div>
        </Card>
        <Card title={t('focus.look')}>
          <div className="form">
            <Field label={t('focus.layout')}><Select value={cfg.layout} onChange={(layout) => set({ layout })} options={(['ring', 'bar'] as const).map((v) => ({ value: v, label: t(`focusLayout.${v}`) }))} /></Field>
            {PHASES.map((p) => <Field key={p} label={t(`focus.label.${p}`)}><TextInput value={cfg.labels[p]} onChange={(v) => set({ labels: { ...cfg.labels, [p]: v } })} /></Field>)}
            <LookFields accent={cfg.accentColor} font={cfg.fontFamily} onAccent={(accentColor) => set({ accentColor })} onFont={(fontFamily) => set({ fontFamily })} />
            <Field label={t('focus.breakColor')}><ColorInput value={cfg.breakColor} onChange={(breakColor) => set({ breakColor })} /></Field>
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.showCycles} onChange={(showCycles) => set({ showCycles })} label={t('focus.showCycles')} />
                <Toggle checked={cfg.chime} onChange={(chime) => set({ chime })} label={t('focus.chime')} />
              </div>
            </Field>
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="focus" maxHeight={320} />
        <OverlayBar kind="focus" name={t('ov.focus')} />
      </aside>
    </div>
  );
}

// ---------- shoutout ----------

export function ShoutoutModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.shoutout);
  const s = useApp((d) => d.state!.shoutout);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const soCommand = useApp((d) => d.settings!.bot.builtins.find((b) => b.id === 'shoutout'));
  const clockAt = useClock();
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ShoutoutSettings>) => saveSettings('shoutout', { ...cfg, ...patch });
  const go = async () => {
    if (!who.trim() || busy) return;
    setBusy(true);
    if (await callOk('shoutout:show', who.trim())) setWho('');
    setBusy(false);
  };
  return (
    <div className="fun-split">
      <div className="fun-main">
        <ScopeCallout scopes={['moderator:manage:shoutouts']} />
        <Card className="control-card">
          <div className="control-row">
            <div className="control-status">
              <span className="muted small">{s.queue.length ? t('shoutout.queue', { n: s.queue.length }) : ' '}</span>
              <b>{s.current ? t('shoutout.onScreen', { name: s.current.displayName }) : t('shoutout.idle')}</b>
            </div>
            {s.current ? <Button size="sm" icon="x" onClick={() => void call('shoutout:skip')}>{t('shoutout.hide')}</Button>
              : <Button size="sm" icon="sparkle" onClick={() => void call('shoutout:test')}>{t('shoutout.test')}</Button>}
          </div>
          <form className="row-gap" onSubmit={(e) => { e.preventDefault(); void go(); }}>
            <TextInput value={who} onChange={setWho} placeholder={t('shoutout.whoPlaceholder')} />
            <Button variant="primary" icon="megaphone" disabled={busy || !who.trim()} type="submit">{busy ? '…' : t('shoutout.go')}</Button>
          </form>
          {s.nativeQueue.length > 0 && <p className="muted small">{t('shoutout.nativeQueue', { n: s.nativeQueue.length, names: s.nativeQueue.join(', ') })}{s.nativeNextAt ? ` · ${t('shoutout.nativeNext', { time: clockAt(s.nativeNextAt) })}` : ''}</p>}
          {s.error && <p className="error small">{s.error}</p>}
        </Card>
        <Card title={t('shoutout.when')}>
          <div className="form">
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.onRaid} onChange={(onRaid) => set({ onRaid })} label={t('shoutout.onRaid')} />
                <Toggle checked={cfg.onCommand} onChange={(onCommand) => set({ onCommand })} label={t('shoutout.onCommand', { command: `${prefix}${soCommand?.trigger ?? 'so'}` })} />
                <Toggle checked={cfg.onChatter} onChange={(onChatter) => set({ onChatter })} label={t('shoutout.onChatter')} />
              </div>
            </Field>
            <Field label={t('shoutout.minViewers')}><NumberInput value={cfg.minViewers} min={0} max={100000} onChange={(minViewers) => set({ minViewers })} /></Field>
            <Field label={t('shoutout.delay')} hint={t('shoutout.delayHint')}><NumberInput value={cfg.delaySec} min={0} max={120} onChange={(delaySec) => set({ delaySec })} /></Field>
            <Field label={t('shoutout.minFollowers')} hint={t('shoutout.minFollowersHint')}><NumberInput value={cfg.minFollowers} min={1} max={10000000} onChange={(minFollowers) => set({ minFollowers })} /></Field>
          </div>
        </Card>
        <Card title={t('shoutout.chatTwitch')}>
          <div className="form">
            <Field label={t('shoutout.message')} hint={t('shoutout.messageHint')} wide><TextArea value={cfg.chatMessage} rows={2} onChange={(chatMessage) => set({ chatMessage })} /></Field>
            <Field label={t('shoutout.chatterMessage')} hint={t('shoutout.chatterMessageHint')} wide><TextArea value={cfg.chatterMessage} rows={2} onChange={(chatterMessage) => set({ chatterMessage })} /></Field>
            <Field label={t('overlays.options')} hint={t('shoutout.nativeHint')} wide><Toggle checked={cfg.nativeShoutout} onChange={(nativeShoutout) => set({ nativeShoutout })} label={t('shoutout.native')} /></Field>
          </div>
        </Card>
        <Card title={t('shoutout.card')}>
          <div className="form">
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.showCard} onChange={(showCard) => set({ showCard })} label={t('shoutout.showCard')} />
                <Toggle checked={cfg.playClip} onChange={(playClip) => set({ playClip })} label={t('shoutout.playClip')} />
                <Toggle checked={cfg.clipMuted} onChange={(clipMuted) => set({ clipMuted })} label={t('shoutout.clipMuted')} />
              </div>
            </Field>
            <Field label={t('shoutout.clipPick')}><Select value={cfg.clipPick} onChange={(clipPick) => set({ clipPick })} options={(['top', 'recent', 'random'] as const).map((v) => ({ value: v, label: t(`shoutoutPick.${v}`) }))} /></Field>
            <Field label={t('shoutout.clipMax')}><NumberInput value={cfg.clipMaxSec} min={5} max={60} onChange={(clipMaxSec) => set({ clipMaxSec })} /></Field>
            <Field label={t('shoutout.cardSec')}><NumberInput value={cfg.cardSec} min={3} max={60} onChange={(cardSec) => set({ cardSec })} /></Field>
            <LookFields accent={cfg.accentColor} font={cfg.fontFamily} onAccent={(accentColor) => set({ accentColor })} onFont={(fontFamily) => set({ fontFamily })} />
          </div>
          <p className="muted small">{t('shoutout.clipNote')}</p>
        </Card>
        <Card title={t('shoutout.recent')}>
          {s.history.length === 0 ? <Empty icon="megaphone" title={t('shoutout.none')} /> : (
            <ul className="portal-log">
              {s.history.map((c) => (
                <li key={c.id}>
                  <span className="muted small">{clockAt(c.at)} · {t(`shoutoutReason.${c.reason}`, { n: c.reason === 'chatter' ? c.followers ?? 0 : c.viewers ?? 0 })}</span> <b>{c.displayName}</b>
                  {c.game && <span className="muted"> · {c.game}</span>}
                  {c.clip && <> · <a href={`https://clips.twitch.tv/${c.clip.id}`} target="_blank" rel="noreferrer">🎬 {c.clip.title || c.clip.id}</a></>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="shoutout" maxHeight={300} />
        <OverlayBar kind="shoutout" name={t('ov.shoutout')} />
      </aside>
    </div>
  );
}
