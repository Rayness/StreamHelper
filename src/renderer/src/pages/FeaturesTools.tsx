import { useState } from 'react';
import type { ClipperSettings, DuckingSettings, Permission, ReportSettings, ReportSummary, ShieldSettings } from '@shared/types';
import { Icon } from '../components/icons';
import { Button, Card, ColorInput, Empty, Field, IconButton, LinesInput, NumberInput, Select, TextInput, Toggle } from '../components/ui';
import { useClock, useNow } from '../hooks';
import { useT } from '../i18n';
import { call, callOk, navigate, saveSettings, useApp } from '../store';

const PERMISSIONS: Permission[] = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];
/** Stable empty list: a fresh `[]` from a store selector re-renders forever. */
const NONE: string[] = [];

/** Shown when the saved Twitch login predates a permission this module needs. */
function ScopeCallout({ scopes }: { scopes: string[] }) {
  const t = useT();
  const missing = useApp((d) => d.state!.twitch.missingScopes ?? NONE);
  const connected = useApp((d) => d.state!.twitch.status === 'connected');
  const lacking = scopes.filter((s) => missing.includes(s));
  if (!connected) {
    return <Card className="callout"><Icon name="broadcast" size={20} /><div><b>{t('feat.needTwitch')}</b><p className="muted small">{t('feat.needTwitchHint')}</p></div><Button variant="primary" onClick={() => navigate('connections', 'twitch')}>{t('nav.connections')}</Button></Card>;
  }
  if (!lacking.length) return null;
  return <Card className="callout"><Icon name="shield" size={20} /><div><b>{t('feat.reconnect')}</b><p className="muted small">{t('feat.reconnectHint')}</p></div><Button variant="primary" onClick={() => void call('twitch:login', 'broadcaster')}>{t('feat.reconnectBtn')}</Button></Card>;
}

function Meter({ value, max, mark, label }: { value: number; max: number; mark?: number; label: string }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / Math.max(1, max)) * 100))}%`;
  return (
    <div className="feat-meter" title={label}>
      <div className="feat-meter-fill" style={{ width: pct(value) }} />
      {mark !== undefined && <div className="feat-meter-mark" style={{ left: pct(mark) }} />}
    </div>
  );
}

// ---------- auto clipper ----------

export function ClipperModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.clipper);
  const s = useApp((d) => d.state!.clipper);
  const live = useApp((d) => d.state!.stream.live);
  const discordOn = useApp((d) => d.state!.discord.status === 'connected');
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const clock = useClock();
  const set = (patch: Partial<ClipperSettings>) => saveSettings('clipper', { ...cfg, ...patch });
  const need = Math.max(cfg.minMessages, cfg.sensitivity * Math.max(1, s.baseline));
  const reason = (r: string) => t(`clipReason.${r as 'burst'}`);
  return (
    <div className="stack-lg">
      <ScopeCallout scopes={['clips:edit']} />
      <Card className="control-card">
        <div className="control-row">
          <Toggle checked={cfg.enabled} onChange={(enabled) => set({ enabled })} label={<b>{t('clipper.enabled')}</b>} />
          <div className="control-status">
            <span className="muted small">{t('clipper.speed')}</span>
            <b>{cfg.enabled ? t('clipper.rate', { n: s.rate, base: s.baseline }) : '—'}</b>
          </div>
          <Button variant="primary" icon="scissors" className="btn-hero" disabled={s.busy} onClick={() => void callOk('clipper:clip')}>{s.busy ? '…' : t('clipper.clipNow')}</Button>
        </div>
        {cfg.enabled && <Meter value={s.rate} max={Math.max(need * 1.3, s.rate)} mark={need} label={t('clipper.meterHint')} />}
        <p className="muted small">{cfg.onlyWhenLive && !live ? t('clipper.offline') : t('clipper.howto', { command: `${prefix}${cfg.voteCommand}`, n: cfg.voteThreshold })}</p>
        {s.lastError && <p className="error small">{s.lastError}</p>}
      </Card>
      <Card title={t('clipper.moments', { n: s.moments.length })}>
        {s.moments.length === 0 ? <Empty icon="scissors" title={t('clipper.none')}>{t('clipper.noneHint')}</Empty> : (
          <ul className="moment-list">
            {s.moments.map((m) => (
              <li key={m.id}>
                <div className="moment-head">
                  <b>{clock(m.at)}</b>
                  <span className="pill">{reason(m.reason)}</span>
                  <span className="muted small">×{m.score} · {t('clipper.msgs', { n: m.messages })}{m.markerSec !== undefined ? ` · ${t('clipper.marker')} ${Math.floor(m.markerSec / 60)}:${String(m.markerSec % 60).padStart(2, '0')}` : ''}</span>
                  <span className="row-gap">
                    {m.clipUrl && <IconButton icon="external" label={t('clipper.open')} onClick={() => void call('shell:openExternal', m.clipUrl!)} />}
                    {m.editUrl && <IconButton icon="edit" label={t('clipper.edit')} onClick={() => void call('shell:openExternal', m.editUrl!)} />}
                    {m.clipUrl && <IconButton icon="copy" label={t('common.copy')} onClick={() => void call('clipboard:write', m.clipUrl!)} />}
                  </span>
                </div>
                {m.sample.length > 0 && <p className="muted small moment-sample">{m.sample.map((x) => `${x.user}: ${x.text}`).join(' · ')}</p>}
                {m.error && <p className="error small">{m.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('clipper.settings')}>
        <div className="form">
          <Field label={t('clipper.window')}><NumberInput value={cfg.windowSec} min={5} max={120} onChange={(windowSec) => set({ windowSec })} /></Field>
          <Field label={t('clipper.sensitivity')} hint={t('clipper.sensitivityHint')}><NumberInput value={cfg.sensitivity} min={1.2} max={20} step={0.1} onChange={(sensitivity) => set({ sensitivity })} /></Field>
          <Field label={t('clipper.minMessages')} hint={t('clipper.minMessagesHint')}><NumberInput value={cfg.minMessages} min={2} max={500} onChange={(minMessages) => set({ minMessages })} /></Field>
          <Field label={t('clipper.cooldown')}><NumberInput value={cfg.cooldownSec} min={10} max={3600} onChange={(cooldownSec) => set({ cooldownSec })} /></Field>
          <Field label={t('clipper.keywords')} hint={t('clipper.keywordsHint')} wide><LinesInput value={cfg.keywords} onChange={(keywords) => set({ keywords })} rows={4} /></Field>
          <Field label={t('clipper.keywordHits')} hint={t('clipper.keywordHitsHint')}><NumberInput value={cfg.keywordHits} min={0} max={200} onChange={(keywordHits) => set({ keywordHits })} /></Field>
          <Field label={t('clipper.voteCommand')}><div className="trigger"><span className="prefix">{prefix}</span><input className="input mono" value={cfg.voteCommand} onChange={(e) => set({ voteCommand: e.target.value.replace(/\s+/g, '').replace(prefix, '') })} /></div></Field>
          <Field label={t('clipper.voteThreshold')} hint={t('clipper.voteThresholdHint')}><NumberInput value={cfg.voteThreshold} min={0} max={100} onChange={(voteThreshold) => set({ voteThreshold })} /></Field>
          <Field label={t('overlays.options')} wide>
            <div className="stack">
              <Toggle checked={cfg.createClip} onChange={(createClip) => set({ createClip })} label={t('clipper.createClip')} />
              <Toggle checked={cfg.createMarker} onChange={(createMarker) => set({ createMarker })} label={t('clipper.createMarker')} />
              <Toggle checked={cfg.onlyWhenLive} onChange={(onlyWhenLive) => set({ onlyWhenLive })} label={t('clipper.onlyLive')} />
              <Toggle checked={cfg.sendToDiscord} disabled={!discordOn} onChange={(sendToDiscord) => set({ sendToDiscord })} label={discordOn ? t('feat.toDiscord') : t('feat.toDiscordOff')} />
            </div>
          </Field>
          <Field label={t('clipper.announce')} hint={t('clipper.announceHint')} wide><TextInput value={cfg.announce} onChange={(announce) => set({ announce })} /></Field>
        </div>
      </Card>
    </div>
  );
}

// ---------- ducking ----------

export function DuckingModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.ducking);
  const s = useApp((d) => d.state!.ducking);
  const obs = useApp((d) => d.state!.obs);
  const set = (patch: Partial<DuckingSettings>) => saveSettings('ducking', { ...cfg, ...patch });
  const inputs = obs.inputs.map((i) => i.name);
  const level = Math.max(-60, s.levelDb);
  const ready = !!cfg.micInput && cfg.targets.length > 0;
  return (
    <div className="stack-lg">
      {obs.status !== 'connected' && <Card className="callout"><Icon name="video" size={20} /><div><b>{t('ducking.needObs')}</b><p className="muted small">{t('ducking.needObsHint')}</p></div><Button variant="primary" onClick={() => navigate('connections', 'obs')}>OBS</Button></Card>}
      <Card className="control-card">
        <div className="control-row">
          <Toggle checked={cfg.enabled} disabled={!ready} onChange={(enabled) => set({ enabled })} label={<b>{t('ducking.enabled')}</b>} />
          <div className="control-status">
            <span className="muted small">{s.listening ? t('ducking.listening') : ready ? t('ducking.off') : t('ducking.setup')}</span>
            <b className={s.ducked ? 'ducked' : ''}>{s.ducked ? (s.reason === 'alert' ? t('ducking.duckedAlert') : t('ducking.ducked')) : t('ducking.normal')}</b>
          </div>
        </div>
        {s.listening && (
          <div className="duck-level">
            <Meter value={level + 60} max={60} mark={cfg.thresholdDb + 60} label={t('ducking.meterHint')} />
            <span className="muted small mono">{s.levelDb <= -100 ? '−∞' : s.levelDb} dB</span>
          </div>
        )}
        <p className="muted small">{t('ducking.howto')}</p>
        {s.error && <p className="error small">{s.error}</p>}
      </Card>
      <Card title={t('ducking.sources')}>
        <div className="form">
          <Field label={t('ducking.mic')} hint={t('ducking.micHint')} wide>
            <Select value={cfg.micInput} onChange={(micInput) => set({ micInput, targets: cfg.targets.filter((x) => x !== micInput) })} options={[{ value: '', label: t('step.pickInput') }, ...(cfg.micInput && !inputs.includes(cfg.micInput) ? [cfg.micInput] : []).concat(inputs).map((x) => ({ value: x, label: x }))]} />
          </Field>
          <Field label={t('ducking.targets')} hint={t('ducking.targetsHint')} wide>
            <div className="stack">
              {inputs.filter((x) => x !== cfg.micInput).map((name) => <Toggle key={name} checked={cfg.targets.includes(name)} label={name} onChange={(on) => set({ targets: on ? [...cfg.targets, name] : cfg.targets.filter((x) => x !== name) })} />)}
              {cfg.targets.filter((x) => !inputs.includes(x)).map((name) => <Toggle key={name} checked label={`${name} (${t('ducking.missing')})`} onChange={() => set({ targets: cfg.targets.filter((x) => x !== name) })} />)}
              {!inputs.length && <span className="muted small">{t('ducking.noInputs')}</span>}
            </div>
          </Field>
        </div>
      </Card>
      <Card title={t('ducking.settings')}>
        <div className="form">
          <Field label={t('ducking.threshold', { db: cfg.thresholdDb })} hint={t('ducking.thresholdHint')}><input type="range" min={-60} max={-5} step={1} value={cfg.thresholdDb} onChange={(e) => set({ thresholdDb: Number(e.target.value) })} /></Field>
          <Field label={t('ducking.percent', { n: cfg.duckPercent })} hint={t('ducking.percentHint')}><input type="range" min={0} max={90} step={5} value={cfg.duckPercent} onChange={(e) => set({ duckPercent: Number(e.target.value) })} /></Field>
          <Field label={t('ducking.attack')} hint={t('ducking.attackHint')}><NumberInput value={cfg.attackMs} min={0} max={2000} step={10} onChange={(attackMs) => set({ attackMs })} /></Field>
          <Field label={t('ducking.release')} hint={t('ducking.releaseHint')}><NumberInput value={cfg.releaseMs} min={100} max={10000} step={50} onChange={(releaseMs) => set({ releaseMs })} /></Field>
          <Field label={t('ducking.fade')}><NumberInput value={cfg.fadeMs} min={0} max={3000} step={50} onChange={(fadeMs) => set({ fadeMs })} /></Field>
          <Field label={t('overlays.options')}><Toggle checked={cfg.duckOnAlerts} onChange={(duckOnAlerts) => set({ duckOnAlerts })} label={t('ducking.alerts')} /></Field>
        </div>
      </Card>
    </div>
  );
}

// ---------- raid shield ----------

export function ShieldModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.shield);
  const s = useApp((d) => d.state!.shield);
  const clock = useClock();
  const now = useNow(1000);
  const set = (patch: Partial<ShieldSettings>) => saveSettings('shield', { ...cfg, ...patch });
  const active = s.status === 'active';
  const rows: { key: 'newChatters' | 'similar' | 'young'; limit: number }[] = [
    { key: 'similar', limit: cfg.similar },
    { key: 'newChatters', limit: cfg.newChatters },
    ...(cfg.youngDays > 0 ? [{ key: 'young' as const, limit: cfg.young }] : []),
  ];
  return (
    <div className="stack-lg">
      <ScopeCallout scopes={['moderator:manage:chat_settings', ...(cfg.shieldMode ? ['moderator:manage:shield_mode'] : [])]} />
      <Card className={`control-card ${active ? 'shield-active' : ''}`}>
        <div className="control-row">
          {active
            ? <Button variant="primary" icon="check" className="btn-hero" onClick={() => void callOk('shield:release')}>{t('shield.release')}</Button>
            : <Button variant="danger" icon="shield" className="btn-hero" onClick={() => void callOk('shield:activate')}>{t('shield.panic')}</Button>}
          <div className="control-status">
            <span className="muted small">{t(`shieldStatus.${s.status}`)}</span>
            <b>{active ? (s.reason ?? '') : cfg.enabled ? t('shield.calm') : t('shield.disabled')}{active && s.releaseAt ? ` · ${Math.max(0, Math.ceil((s.releaseAt - now) / 60000))} ${t('curse.min')}` : ''}</b>
          </div>
          <Toggle checked={cfg.enabled} onChange={(enabled) => set({ enabled })} label={t('shield.auto')} />
        </div>
        {cfg.enabled && (
          <div className="shield-readings">
            {rows.map((r) => (
              <div key={r.key} className="shield-reading">
                <span className="small">{t(`shieldReading.${r.key}`)}</span>
                <Meter value={s.readings[r.key]} max={Math.max(1, r.limit)} mark={r.limit} label={`${s.readings[r.key]} / ${r.limit}`} />
                <span className="muted small mono">{s.readings[r.key]} / {r.limit}</span>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">{t('shield.howto')}</p>
        {s.error && <p className="error small">{s.error}</p>}
      </Card>
      {(s.suspects.length > 0 || s.history.length > 0) && (
        <Card title={t('shield.log')}>
          {s.suspects.length > 0 && <ul className="portal-log">{s.suspects.slice(0, 30).map((x, i) => <li key={`${x.userId}:${i}`}><span className="muted small">{clock(x.at)}</span> <b>{x.userName}</b> {x.text}</li>)}</ul>}
          {s.history.length > 0 && <ol className="leaderboard">{s.history.map((h) => <li key={h.at}><span>{clock(h.at)} · {h.reason}</span><b>{h.manual ? '✋' : t('shield.suspects', { n: h.suspects })}</b></li>)}</ol>}
        </Card>
      )}
      <Card title={t('shield.detect')}>
        <div className="form">
          <Field label={t('shield.window')}><NumberInput value={cfg.windowSec} min={5} max={300} onChange={(windowSec) => set({ windowSec })} /></Field>
          <Field label={t('shield.similar')} hint={t('shield.similarHint')}><NumberInput value={cfg.similar} min={0} max={500} onChange={(similar) => set({ similar })} /></Field>
          <Field label={t('shield.newChatters')} hint={t('shield.newChattersHint')}><NumberInput value={cfg.newChatters} min={0} max={1000} onChange={(newChatters) => set({ newChatters })} /></Field>
          <Field label={t('shield.youngDays')} hint={t('shield.youngDaysHint')}><NumberInput value={cfg.youngDays} min={0} max={365} onChange={(youngDays) => set({ youngDays })} /></Field>
          <Field label={t('shield.young')}><NumberInput value={cfg.young} min={0} max={500} onChange={(young) => set({ young })} /></Field>
          <Field label={t('shield.grace')} hint={t('shield.graceHint')}><NumberInput value={cfg.raidGraceSec} min={0} max={1800} onChange={(raidGraceSec) => set({ raidGraceSec })} /></Field>
          <Field label={t('shield.exempt')}><Select value={cfg.exempt} onChange={(exempt) => set({ exempt })} options={PERMISSIONS.map((p) => ({ value: p, label: t(`perm.${p}`) }))} /></Field>
        </div>
      </Card>
      <Card title={t('shield.actions')}>
        <div className="form">
          <Field label={t('overlays.options')} wide>
            <div className="stack">
              <Toggle checked={cfg.followersOnly} onChange={(followersOnly) => set({ followersOnly })} label={t('shield.followers')} />
              <Toggle checked={cfg.slowMode} onChange={(slowMode) => set({ slowMode })} label={t('shield.slow')} />
              <Toggle checked={cfg.emoteOnly} onChange={(emoteOnly) => set({ emoteOnly })} label={t('shield.emote')} />
              <Toggle checked={cfg.shieldMode} onChange={(shieldMode) => set({ shieldMode })} label={t('shield.twitchShield')} />
              <Toggle checked={cfg.deleteMessages} onChange={(deleteMessages) => set({ deleteMessages })} label={t('shield.delete')} />
            </div>
          </Field>
          <Field label={t('shield.followersMin')}><NumberInput value={cfg.followersMinutes} min={0} max={129600} onChange={(followersMinutes) => set({ followersMinutes })} /></Field>
          <Field label={t('shield.slowSec')}><NumberInput value={cfg.slowSec} min={3} max={120} onChange={(slowSec) => set({ slowSec })} /></Field>
          <Field label={t('shield.timeout')} hint={t('shield.timeoutHint')}><NumberInput value={cfg.timeoutSec} min={0} max={1209600} onChange={(timeoutSec) => set({ timeoutSec })} /></Field>
          <Field label={t('shield.autoRelease')} hint={t('shield.autoReleaseHint')}><NumberInput value={cfg.autoReleaseMin} min={0} max={720} onChange={(autoReleaseMin) => set({ autoReleaseMin })} /></Field>
          <Field label={t('shield.announce')} hint={t('shield.announceHint')} wide><TextInput value={cfg.announce} onChange={(announce) => set({ announce })} /></Field>
        </div>
      </Card>
    </div>
  );
}

// ---------- stream report ----------

function duration(ms: number, t: ReturnType<typeof useT>): string {
  const min = Math.max(0, Math.round(ms / 60000));
  return t('report.duration', { h: Math.floor(min / 60), m: min % 60 });
}

function SummaryGrid({ s }: { s: ReportSummary }) {
  const t = useT();
  const now = useNow(30_000);
  const cells: [string, string | number][] = [
    [t('report.length'), duration((s.endedAt ?? now) - s.startedAt, t)],
    [t('report.peak'), s.peakViewers],
    [t('report.avg'), s.avgViewers],
    [t('report.messages'), s.messages],
    [t('report.chatters'), s.chatters],
    [t('report.follows'), s.follows],
    [t('report.subs'), s.subs + s.gifts],
    [t('report.moments'), s.clips],
  ];
  return (
    <>
      <div className="report-grid">{cells.map(([k, v]) => <div key={k}><span className="muted small">{k}</span><b>{v}</b></div>)}</div>
      <div className="report-highlights small">
        {s.mvp[0] && <span>🏅 MVP: <b>{s.mvp.map((m) => `${m.name} (${m.messages})`).join(', ')}</b></span>}
        {s.topWord && <span>💬 {t('report.word')}: <b>«{s.topWord.word}»</b> ×{s.topWord.count}</span>}
        {s.topEmote && <span>😀 {t('report.emote')}: <img src={s.topEmote.url} alt="" /> <b>{s.topEmote.name}</b> ×{s.topEmote.count}</span>}
        {s.drama && <span>🔥 {t('report.drama')}: <b>{new Date(s.drama.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>{s.drama.quote ? ` — «${s.drama.quote.text}»` : ''}</span>}
      </div>
    </>
  );
}

export function ReportModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.report);
  const r = useApp((d) => d.state!.report);
  const discordOn = useApp((d) => d.state!.discord.status === 'connected');
  const clock = useClock();
  const [open, setOpen] = useState<string | null>(null);
  const set = (patch: Partial<ReportSettings>) => saveSettings('report', { ...cfg, ...patch });
  return (
    <div className="stack-lg">
      <Card className="control-card" title={t('report.current')}>
        <SummaryGrid s={r.live} />
        <div className="row-gap wrap">
          <Button variant="primary" icon="report" disabled={r.busy} onClick={() => void callOk('report:generate')}>{r.busy ? '…' : t('report.generate')}</Button>
          <Button icon="replay" onClick={() => confirm(t('report.resetConfirm')) && void call('report:reset')}>{t('report.reset')}</Button>
          <Button icon="external" onClick={() => void call('report:open')}>{t('report.folder')}</Button>
        </div>
        <p className="muted small">{t('report.howto')}</p>
      </Card>
      <Card title={t('report.saved', { n: r.reports.length })}>
        {r.reports.length === 0 ? <Empty icon="report" title={t('report.none')}>{t('report.noneHint')}</Empty> : (
          <div className="report-gallery">
            {r.reports.map((x) => (
              <figure key={x.id} className={open === x.id ? 'open' : ''}>
                <img src={x.imageUrl} alt={x.summary.title} loading="lazy" onClick={() => setOpen(open === x.id ? null : x.id)} />
                <figcaption>
                  <span className="small"><b>{new Date(x.summary.startedAt).toLocaleDateString()}</b> · {clock(x.summary.startedAt)} · {x.summary.title || '—'}</span>
                  <span className="row-gap">
                    <IconButton icon="copy" label={t('report.copy')} onClick={() => void callOk('report:copy', x.id)} />
                    <IconButton icon="external" label={t('report.show')} onClick={() => void call('report:open', x.id)} />
                    {discordOn && <IconButton icon="send" label={t('report.discord')} onClick={() => void callOk('report:discord', x.id)} />}
                    <IconButton icon="trash" label={t('common.delete')} onClick={() => confirm(t('common.confirmDelete')) && void call('report:delete', x.id)} />
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
      <Card title={t('report.settings')}>
        <div className="form">
          <Field label={t('overlays.options')} wide>
            <div className="stack">
              <Toggle checked={cfg.autoGenerate} onChange={(autoGenerate) => set({ autoGenerate })} label={t('report.auto')} />
              <Toggle checked={cfg.postToChat} onChange={(postToChat) => set({ postToChat })} label={t('report.chat')} />
              <Toggle checked={cfg.sendToDiscord} disabled={!discordOn} onChange={(sendToDiscord) => set({ sendToDiscord })} label={discordOn ? t('feat.toDiscord') : t('feat.toDiscordOff')} />
            </div>
          </Field>
          <Field label={t('common.accent')}><ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
          <Field label={t('report.stopWords')} hint={t('report.stopWordsHint')} wide><LinesInput value={cfg.stopWords} onChange={(stopWords) => set({ stopWords })} rows={3} /></Field>
        </div>
      </Card>
    </div>
  );
}
