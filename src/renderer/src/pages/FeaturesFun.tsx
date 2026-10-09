import { useEffect, useState } from 'react';
import { defaultCurse } from '@shared/defaults';
import type { Curse, CurseSettings, CurseStep, DuelSettings, MarketSettings, MelodySettings, MelodyTrack, PortalSettings } from '@shared/types';
import { OverlayBar, OverlayPreview } from '../components/overlay';
import { Button, Card, ColorInput, Empty, Field, IconButton, LinesInput, NumberInput, Select, StatusText, TextArea, TextInput, Toggle } from '../components/ui';
import { useClock, useNow } from '../hooks';
import { FontPicker } from '../components/FontPicker';
import { useT, type TFn } from '../i18n';
import { call, callOk, saveSettings, useApp } from '../store';

function left(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Command input with the bot prefix in front. */
function CommandInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const prefix = useApp((d) => d.settings!.bot.prefix);
  return (
    <div className="trigger">
      <span className="prefix">{prefix}</span>
      <input className="input mono" value={value} onChange={(e) => onChange(e.target.value.replace(/\s+/g, '').replace(prefix, ''))} />
    </div>
  );
}

/** Accent + font: the same pair every overlay has. */
function LookFields({ accent, font, onAccent, onFont }: { accent: string; font: string; onAccent: (v: string) => void; onFont: (v: string) => void }) {
  const t = useT();
  return (
    <>
      <Field label={t('common.accent')}><ColorInput value={accent} onChange={onAccent} /></Field>
      <Field label={t('common.font')} hint={t('common.fontHint')}><FontPicker value={font} onChange={onFont} /></Field>
    </>
  );
}

// ---------- OBS pickers (curses) ----------

/** Every OBS input and scene, refreshed when OBS connects. */
function useObsSources(): string[] {
  const connected = useApp((d) => d.state!.obs.status === 'connected');
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    if (!connected) { setList([]); return; }
    let alive = true;
    window.api.invoke('obs:sources').then((r) => alive && setList(r)).catch(() => undefined);
    return () => { alive = false; };
  }, [connected]);
  return list;
}

function withValue(list: string[], v: string): string[] {
  return v && !list.includes(v) ? [v, ...list] : list;
}

function FilterSelect({ source, value, onChange }: { source: string; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const connected = useApp((d) => d.state!.obs.status === 'connected');
  const [filters, setFilters] = useState<string[]>([]);
  useEffect(() => {
    if (!connected || !source) { setFilters([]); return; }
    let alive = true;
    window.api.invoke('obs:filters', source).then((r) => alive && setFilters(r)).catch(() => alive && setFilters([]));
    return () => { alive = false; };
  }, [connected, source]);
  return <Select value={value} onChange={onChange} options={[{ value: '', label: t('curse.pickFilter') }, ...withValue(filters, value).map((f) => ({ value: f, label: f }))]} />;
}

function StepEditor({ step, onChange, onRemove, sources }: { step: CurseStep; onChange: (s: CurseStep) => void; onRemove: () => void; sources: string[] }) {
  const t = useT();
  const obs = useApp((d) => d.state!.obs);
  const kinds = (['mute', 'filter', 'source'] as const).map((k) => ({ value: k, label: t(`curseStep.${k}`) }));
  const change = (type: CurseStep['type']) => onChange(type === 'filter' ? { type, source: '', filter: '' } : type === 'source' ? { type, scene: '', source: '', show: false } : { type, input: '' });
  return (
    <li className="curse-step">
      <Select value={step.type} onChange={change} options={kinds} />
      {step.type === 'mute' && <Select value={step.input} onChange={(input) => onChange({ ...step, input })} options={[{ value: '', label: t('step.pickInput') }, ...withValue(obs.inputs.map((i) => i.name), step.input).map((x) => ({ value: x, label: x }))]} />}
      {step.type === 'filter' && (
        <>
          <Select value={step.source} onChange={(source) => onChange({ ...step, source, filter: '' })} options={[{ value: '', label: t('curse.pickSource') }, ...withValue(sources, step.source).map((x) => ({ value: x, label: x }))]} />
          <FilterSelect source={step.source} value={step.filter} onChange={(filter) => onChange({ ...step, filter })} />
        </>
      )}
      {step.type === 'source' && (
        <>
          <Select value={step.scene} onChange={(scene) => onChange({ ...step, scene })} options={[{ value: '', label: t('step.currentScene') }, ...withValue(obs.scenes, step.scene).map((x) => ({ value: x, label: x }))]} />
          <Select value={step.source} onChange={(source) => onChange({ ...step, source })} options={[{ value: '', label: t('curse.pickSource') }, ...withValue(obs.sceneItems.map((i) => i.name), step.source).map((x) => ({ value: x, label: x }))]} />
          <Select value={step.show ? 'show' : 'hide'} onChange={(v) => onChange({ ...step, show: v === 'show' })} options={[{ value: 'hide', label: t('curse.hide') }, { value: 'show', label: t('curse.show') }]} />
        </>
      )}
      <IconButton icon="x" label={t('common.delete')} onClick={onRemove} />
    </li>
  );
}

function CurseEditor({ curse, onChange, onRemove, sources }: { curse: Curse; onChange: (c: Curse) => void; onRemove: () => void; sources: string[] }) {
  const t = useT();
  const active = useApp((d) => d.state!.curse.status === 'active');
  const set = (patch: Partial<Curse>) => onChange({ ...curse, ...patch });
  return (
    <details className="curse-item">
      <summary>
        <Toggle checked={curse.enabled} onChange={(enabled) => set({ enabled })} />
        <b>{curse.name || '—'}</b>
        <span className="muted small">{Math.round(curse.durationSec / 6) / 10} {t('curse.min')} · {curse.steps.length ? t('curse.steps', { n: curse.steps.length }) : t('curse.challenge')}</span>
      </summary>
      <div className="form">
        <Field label={t('curse.name')}><TextInput value={curse.name} onChange={(name) => set({ name })} /></Field>
        <Field label={t('curse.duration')}><NumberInput value={curse.durationSec} min={10} max={3600} onChange={(durationSec) => set({ durationSec })} /></Field>
        <Field label={t('curse.description')} wide><TextInput value={curse.description} onChange={(description) => set({ description })} /></Field>
        <Field label={t('curse.obsSteps')} hint={t('curse.obsStepsHint')} wide>
          <div className="stack">
            {curse.steps.length > 0 && <ol className="curse-steps">{curse.steps.map((s, i) => <StepEditor key={i} step={s} sources={sources} onChange={(next) => set({ steps: curse.steps.map((x, j) => (j === i ? next : x)) })} onRemove={() => set({ steps: curse.steps.filter((_, j) => j !== i) })} />)}</ol>}
            <div className="row-gap"><Button size="sm" icon="plus" onClick={() => set({ steps: [...curse.steps, { type: 'mute', input: '' }] })}>{t('curse.addStep')}</Button></div>
          </div>
        </Field>
      </div>
      <div className="row-gap">
        <Button size="sm" icon="play" disabled={active || !curse.name.trim()} onClick={() => void callOk('curse:apply', curse.id)}>{t('curse.applyNow')}</Button>
        <Button size="sm" variant="danger" icon="trash" onClick={() => confirm(t('common.confirmDelete')) && onRemove()}>{t('common.delete')}</Button>
      </div>
    </details>
  );
}

export function CurseModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.curses);
  const lang = useApp((d) => d.settings!.language);
  const c = useApp((d) => d.state!.curse);
  const obsOn = useApp((d) => d.state!.obs.status === 'connected');
  const now = useNow(500);
  const sources = useObsSources();
  const set = (patch: Partial<CurseSettings>) => saveSettings('curses', { ...cfg, ...patch });
  const setCurse = (id: string, next: Curse) => set({ curses: cfg.curses.map((x) => (x.id === id ? next : x)) });
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            {c.status === 'voting' ? <Button variant="secondary" icon="x" className="btn-hero" onClick={() => void call('curse:cancel')}>{t('curse.cancel')}</Button>
              : c.status === 'active' ? <Button variant="danger" icon="sparkle" className="btn-hero" onClick={() => void call('curse:lift')}>{t('curse.lift')}</Button>
              : <Button variant="primary" icon="skull" className="btn-hero" onClick={() => void callOk('curse:vote')}>{t('curse.vote')}</Button>}
            <div className="control-status">
              <span className="muted small">{t(`curseStatus.${c.status}`)}</span>
              <b>{c.status === 'active' && c.active ? c.active.name : c.status === 'voting' ? t('curse.votes', { n: c.total }) : '—'}{c.endsAt && c.status !== 'idle' ? ` · ${left(c.endsAt - now)}` : ''}</b>
            </div>
          </div>
          {c.status === 'voting' && (
            <div className="poll-live">
              {c.options.map((o, i) => {
                const pct = c.total ? Math.round((o.votes / c.total) * 100) : 0;
                return <div key={o.id} className="poll-row"><div className="poll-fill" style={{ width: `${pct}%` }} /><span className="poll-num">{i + 1}</span><span className="poll-label">{o.name}</span><span className="poll-pct">{pct}% · {o.votes}</span></div>;
              })}
            </div>
          )}
          {c.lastError && <p className="error small">{c.lastError}</p>}
          <p className="muted small">{t('curse.howto')}</p>
          {!obsOn && <p className="muted small">{t('curse.noObs')}</p>}
        </Card>
        <Card title={t('curse.list')} actions={<Button size="sm" icon="plus" onClick={() => set({ curses: [...cfg.curses, defaultCurse(lang)] })}>{t('curse.add')}</Button>}>
          {cfg.curses.length === 0 ? <Empty icon="skull" title={t('curse.empty')} /> : <div className="curse-list">{cfg.curses.map((x) => <CurseEditor key={x.id} curse={x} sources={sources} onChange={(next) => setCurse(x.id, next)} onRemove={() => set({ curses: cfg.curses.filter((y) => y.id !== x.id) })} />)}</div>}
        </Card>
        <Card title={t('curse.settings')}>
          <div className="form">
            <Field label={t('curse.choices')}><NumberInput value={cfg.choices} min={1} max={5} onChange={(choices) => set({ choices })} /></Field>
            <Field label={t('curse.voteSec')}><NumberInput value={cfg.voteSec} min={5} max={600} onChange={(voteSec) => set({ voteSec })} /></Field>
            <Field label={t('curse.auto')} hint={t('curse.autoHint')}><NumberInput value={cfg.autoEveryMin} min={0} max={600} onChange={(autoEveryMin) => set({ autoEveryMin })} /></Field>
            <Field label={t('actions.redemption')} hint={t('curse.redemptionHint')}><TextInput value={cfg.redemptionTitle} onChange={(redemptionTitle) => set({ redemptionTitle })} placeholder={t('actions.redemptionPh')} /></Field>
            <Field label={t('overlays.options')} wide><Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('feat.announce')} /></Field>
            <LookFields accent={cfg.accentColor} font={cfg.fontFamily} onAccent={(accentColor) => set({ accentColor })} onFont={(fontFamily) => set({ fontFamily })} />
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="curse" maxHeight={320} />
        <OverlayBar kind="curse" name={t('ov.curse')} />
      </aside>
    </div>
  );
}

// ---------- music duel ----------

export function DuelModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.duel);
  const duel = useApp((d) => d.state!.duel);
  const queue = useApp((d) => d.state!.songRequests.queue);
  const now = useNow(500);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const set = (patch: Partial<DuelSettings>) => saveSettings('duel', { ...cfg, ...patch });
  const running = duel.status !== 'idle' && duel.status !== 'done';
  const options = [{ value: '', label: t('duel.auto') }, ...queue.map((r) => ({ value: r.id, label: `${r.userName} · ${r.title ?? r.url}` }))];
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            {running ? <Button variant="danger" icon="x" className="btn-hero" onClick={() => void call('duel:stop')}>{t('duel.stop')}</Button>
              : <Button variant="primary" icon="swords" className="btn-hero" disabled={queue.length < 2} onClick={() => void callOk('duel:start', a || undefined, b || undefined)}>{t('duel.start')}</Button>}
            <div className="control-status">
              <span className="muted small">{t(`duelStatus.${duel.status}`)}</span>
              <b>{duel.a && duel.b ? `${duel.a.votes} : ${duel.b.votes}` : t('duel.inQueue', { n: queue.length })}{running && duel.endsAt ? ` · ${left(duel.endsAt - now)}` : ''}</b>
            </div>
          </div>
          {duel.a && duel.b && (
            <div className="duel-now">
              {(['a', 'b'] as const).map((k, i) => (
                <div key={k} className={`duel-side ${duel.winner === k ? 'win' : ''}`}>
                  <span className="pill">{i + 1}</span>
                  <b>{duel[k]!.title}</b>
                  <span className="muted small">{duel[k]!.userName} · {t('duel.votes', { n: duel[k]!.votes })}</span>
                </div>
              ))}
            </div>
          )}
          {duel.error && <p className="error small">{duel.error}</p>}
          <p className="muted small">{queue.length < 2 ? t('duel.needTwo') : t('duel.howto')}</p>
        </Card>
        <Card title={t('duel.pick')}>
          <div className="form">
            <Field label={t('duel.trackA')}><Select value={a} onChange={setA} options={options} /></Field>
            <Field label={t('duel.trackB')}><Select value={b} onChange={setB} options={options} /></Field>
          </div>
        </Card>
        <Card title={t('duel.settings')}>
          <div className="form">
            <Field label={t('duel.snippet')}><NumberInput value={cfg.snippetSec} min={5} max={120} onChange={(snippetSec) => set({ snippetSec })} /></Field>
            <Field label={t('duel.offset')} hint={t('duel.offsetHint')}><NumberInput value={cfg.startOffsetSec} min={0} max={600} onChange={(startOffsetSec) => set({ startOffsetSec })} /></Field>
            <Field label={t('duel.voteSec')}><NumberInput value={cfg.voteSec} min={5} max={300} onChange={(voteSec) => set({ voteSec })} /></Field>
            <Field label={t('duel.winner')}><Select value={cfg.winnerAction} onChange={(winnerAction) => set({ winnerAction })} options={(['playNext', 'playNow', 'none'] as const).map((v) => ({ value: v, label: t(`duelWin.${v}`) }))} /></Field>
            <Field label={t('duel.loser')}><Select value={cfg.loserAction} onChange={(loserAction) => set({ loserAction })} options={(['remove', 'keep'] as const).map((v) => ({ value: v, label: t(`duelLose.${v}`) }))} /></Field>
            <Field label={t('feat.volume')}><input type="range" min={0} max={100} step={5} value={cfg.volume} onChange={(e) => set({ volume: Number(e.target.value) })} /></Field>
            <Field label={t('overlays.options')} wide><Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('feat.announce')} /></Field>
            <LookFields accent={cfg.accentColor} font={cfg.fontFamily} onAccent={(accentColor) => set({ accentColor })} onFont={(fontFamily) => set({ fontFamily })} />
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="duel" maxHeight={260} />
        <OverlayBar kind="duel" name={t('ov.duel')} />
        <p className="muted small">{t('feat.audioHint')}</p>
      </aside>
    </div>
  );
}

// ---------- guess the melody ----------

function TrackRow({ track, onChange, onRemove }: { track: MelodyTrack; onChange: (t: MelodyTrack) => void; onRemove: () => void }) {
  const t = useT();
  const [answers, setAnswers] = useState(track.answers.join(', '));
  useEffect(() => setAnswers(track.answers.join(', ')), [track.answers]);
  return (
    <li className="melody-track">
      <img src={`https://i.ytimg.com/vi/${encodeURIComponent(track.videoId)}/default.jpg`} alt="" />
      <div className="melody-track-body">
        <span className="small" title={track.title}>{track.title === track.videoId ? <span className="error">{t('melody.unnamed')}</span> : track.title}</span>
        <div className="row-gap">
          <input className="input" value={answers} placeholder={t('melody.answers')} title={t('melody.answersHint')} onChange={(e) => setAnswers(e.target.value)} onBlur={() => onChange({ ...track, answers: answers.split(',').map((x) => x.trim()).filter(Boolean) })} />
          <input className="input" value={track.artist} placeholder={t('melody.artist')} onChange={(e) => onChange({ ...track, artist: e.target.value })} />
        </div>
      </div>
      <IconButton icon="x" label={t('common.delete')} onClick={onRemove} />
    </li>
  );
}

export function MelodyModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.melody);
  const m = useApp((d) => d.state!.melody);
  const songs = useApp((d) => d.state!.songRequests.queue.length + (d.state!.songRequests.current ? 1 : 0));
  const now = useNow(500);
  const [links, setLinks] = useState('');
  const [adding, setAdding] = useState(false);
  const set = (patch: Partial<MelodySettings>) => saveSettings('melody', { ...cfg, ...patch });
  const running = m.status === 'playing' || m.status === 'reveal';
  const add = async () => {
    setAdding(true);
    const n = await call('melody:add', links.split(/\s+/).filter(Boolean));
    setAdding(false);
    if (n !== undefined) setLinks('');
  };
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            {running ? (
              <>
                <Button variant="primary" icon="skip" className="btn-hero" onClick={() => void call('melody:skip')}>{m.status === 'playing' ? t('melody.reveal') : t('melody.next')}</Button>
                <Button variant="danger" icon="x" onClick={() => void call('melody:stop')}>{t('melody.stop')}</Button>
              </>
            ) : <Button variant="primary" icon="play" className="btn-hero" disabled={!cfg.playlist.length} onClick={() => void callOk('melody:start')}>{m.status === 'finished' ? t('melody.again') : t('melody.start')}</Button>}
            <div className="control-status">
              <span className="muted small">{t(`melodyStatus.${m.status}`)}</span>
              <b>{m.round ? `${m.round} / ${m.rounds}` : t('melody.tracks', { n: cfg.playlist.length })}{m.status === 'playing' && m.endsAt ? ` · ${left(m.endsAt - now)}` : ''}</b>
            </div>
            {m.status === 'finished' && <Button size="sm" icon="x" onClick={() => void call('melody:stop')}>{t('poll.clear')}</Button>}
          </div>
          {running && <p className="small"><span className="muted">{t('melody.secret')}</span> <b>{m.status === 'reveal' ? m.answer?.title : m.hint}</b>{m.winner && <> · {t('quiz.guessedBy', { name: m.winner })}</>}</p>}
          {m.leaderboard.length > 0 && <ol className="leaderboard">{m.leaderboard.map((r) => <li key={r.userName}><span>{r.userName}</span><b>{r.points}</b></li>)}</ol>}
          {m.error && <p className="error small">{m.error}</p>}
          <p className="muted small">{t('melody.howto')}</p>
        </Card>
        <Card title={t('melody.playlist', { n: cfg.playlist.length })} actions={cfg.playlist.length > 0 ? <Button size="sm" icon="trash" onClick={() => confirm(t('melody.clearConfirm')) && set({ playlist: [] })}>{t('melody.clear')}</Button> : undefined}>
          <div className="stack">
            <TextArea value={links} onChange={setLinks} rows={3} placeholder={t('melody.linksPh')} />
            <div className="row-gap wrap">
              <Button size="sm" variant="primary" icon="plus" disabled={!links.trim() || adding} onClick={() => void add()}>{adding ? '…' : t('melody.addLinks')}</Button>
              <Button size="sm" icon="music" disabled={!songs} onClick={() => void call('melody:fromSongs')}>{t('melody.fromSongs', { n: songs })}</Button>
            </div>
            {cfg.playlist.length === 0 ? <Empty icon="disc" title={t('melody.empty')}>{t('melody.emptyHint')}</Empty>
              : <ol className="melody-list">{cfg.playlist.map((tr) => <TrackRow key={tr.id} track={tr} onChange={(next) => set({ playlist: cfg.playlist.map((x) => (x.id === tr.id ? next : x)) })} onRemove={() => set({ playlist: cfg.playlist.filter((x) => x.id !== tr.id) })} />)}</ol>}
          </div>
        </Card>
        <Card title={t('melody.settings')}>
          <div className="form">
            <Field label={t('quiz.rounds')}><NumberInput value={cfg.rounds} min={1} max={50} onChange={(rounds) => set({ rounds })} /></Field>
            <Field label={t('melody.snippet')}><NumberInput value={cfg.snippetSec} min={3} max={30} onChange={(snippetSec) => set({ snippetSec })} /></Field>
            <Field label={t('quiz.roundSec')}><NumberInput value={cfg.roundSec} min={10} max={180} onChange={(roundSec) => set({ roundSec })} /></Field>
            <Field label={t('melody.hintAfter')} hint={t('melody.hintAfterHint')}><NumberInput value={cfg.hintAfterSec} min={0} max={170} onChange={(hintAfterSec) => set({ hintAfterSec })} /></Field>
            <Field label={t('quiz.revealSec')}><NumberInput value={cfg.revealSec} min={3} max={60} onChange={(revealSec) => set({ revealSec })} /></Field>
            <Field label={t('feat.volume')}><input type="range" min={0} max={100} step={5} value={cfg.volume} onChange={(e) => set({ volume: Number(e.target.value) })} /></Field>
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.acceptArtist} onChange={(acceptArtist) => set({ acceptArtist })} label={t('melody.acceptArtist')} />
                <Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('feat.announce')} />
              </div>
            </Field>
            <LookFields accent={cfg.accentColor} font={cfg.fontFamily} onAccent={(accentColor) => set({ accentColor })} onFont={(fontFamily) => set({ fontFamily })} />
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="melody" maxHeight={240} />
        <OverlayBar kind="melody" name={t('ov.melody')} />
        <p className="muted small">{t('feat.audioHint')}</p>
      </aside>
    </div>
  );
}

// ---------- viewer stock exchange ----------

const COMMAND_KEYS = ['market', 'buy', 'sell', 'portfolio', 'balance', 'price'] as const;

function commandHelp(t: TFn, prefix: string, c: MarketSettings['commands']): { cmd: string; text: string }[] {
  return [
    { cmd: `${prefix}${c.buy} @nick 5`, text: t('market.helpBuy') },
    { cmd: `${prefix}${c.sell} @nick 5`, text: t('market.helpSell') },
    { cmd: `${prefix}${c.portfolio}`, text: t('market.helpPortfolio') },
    { cmd: `${prefix}${c.balance}`, text: t('market.helpBalance') },
    { cmd: `${prefix}${c.price} @nick`, text: t('market.helpPrice') },
    { cmd: `${prefix}${c.market}`, text: t('market.helpMarket') },
  ];
}

export function StocksModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.market);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const market = useApp((d) => d.state!.market);
  const clock = useClock();
  const [login, setLogin] = useState('');
  const [amount, setAmount] = useState(500);
  const set = (patch: Partial<MarketSettings>) => saveSettings('market', { ...cfg, ...patch });
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            <Toggle checked={cfg.enabled} onChange={(enabled) => set({ enabled })} label={<b>{t('market.enabled')}</b>} />
            <div className="control-status">
              <span className="muted small">{t('market.listed')}</span>
              <b>{market.quotes.length} · {t('market.traders', { n: market.traders })}</b>
            </div>
          </div>
          <p className="muted small">{t('market.howto', { n: cfg.listMinMessages, currency: cfg.currencyName })}</p>
          <ul className="command-help">{commandHelp(t, prefix, cfg.commands).map((h) => <li key={h.cmd}><code>{h.cmd}</code><span className="muted small">{h.text}</span></li>)}</ul>
          {market.lastTrade && <p className="small">{market.lastTrade.side === 'buy' ? '🟢' : '🔴'} {clock(market.lastTrade.at)} · {market.lastTrade.user} {t(market.lastTrade.side === 'buy' ? 'market.bought' : 'market.sold')} {market.lastTrade.qty} ${market.lastTrade.stock} @ {market.lastTrade.price}</p>}
        </Card>
        <Card title={t('market.board')}>
          {market.quotes.length === 0 ? <Empty icon="trend" title={t('market.empty')}>{t('market.emptyHint')}</Empty> : (
            <table className="market-table">
              <thead><tr><th>{t('market.stock')}</th><th>{t('market.price')}</th><th>{t('market.change')}</th><th>{t('market.holders')}</th></tr></thead>
              <tbody>{market.quotes.slice(0, 15).map((q) => <tr key={q.userId}><td>${q.name}</td><td>{q.price}</td><td className={q.change > 0 ? 'up' : q.change < 0 ? 'down' : ''}>{q.change > 0 ? '+' : ''}{q.change}%</td><td>{q.holders}</td></tr>)}</tbody>
            </table>
          )}
          {market.richest.length > 0 && <><h4 className="muted small">{t('market.richest')}</h4><ol className="leaderboard">{market.richest.map((r) => <li key={r.name}><span>{r.name}</span><b>{r.worth} {cfg.currencyName}</b></li>)}</ol></>}
        </Card>
        <Card title={t('market.admin')}>
          <div className="form">
            <Field label={t('market.grantWho')}><TextInput value={login} onChange={setLogin} placeholder="@nick" /></Field>
            <Field label={t('market.grantAmount')} hint={t('market.grantHint')}><NumberInput value={amount} min={-1000000} max={1000000} onChange={setAmount} /></Field>
          </div>
          <div className="row-gap">
            <Button size="sm" icon="coin" disabled={!login.trim()} onClick={() => void callOk('market:grant', login, amount).then((ok) => ok && setLogin(''))}>{t('market.grant')}</Button>
            <Button size="sm" variant="danger" icon="trash" onClick={() => confirm(t('market.resetConfirm')) && void call('market:reset')}>{t('market.reset')}</Button>
          </div>
        </Card>
        <Card title={t('market.settings')}>
          <div className="form">
            <Field label={t('market.currency')}><TextInput value={cfg.currencyName} onChange={(currencyName) => set({ currencyName })} /></Field>
            <Field label={t('market.startBalance')}><NumberInput value={cfg.startBalance} min={0} max={1000000} onChange={(startBalance) => set({ startBalance })} /></Field>
            <Field label={t('market.earn')} hint={t('market.earnHint')}><NumberInput value={cfg.earnPerMessage} min={0} max={10000} onChange={(earnPerMessage) => set({ earnPerMessage })} /></Field>
            <Field label={t('market.earnCooldown')}><NumberInput value={cfg.earnCooldownSec} min={0} max={3600} onChange={(earnCooldownSec) => set({ earnCooldownSec })} /></Field>
            <Field label={t('market.income')} hint={t('market.incomeHint')}><NumberInput value={cfg.activeIncome} min={0} max={10000} onChange={(activeIncome) => set({ activeIncome })} /></Field>
            <Field label={t('market.listMin')}><NumberInput value={cfg.listMinMessages} min={1} max={10000} onChange={(listMinMessages) => set({ listMinMessages })} /></Field>
            <Field label={t('market.ipo')}><NumberInput value={cfg.ipoPrice} min={1} max={100000} onChange={(ipoPrice) => set({ ipoPrice })} /></Field>
            <Field label={t('market.tick')}><NumberInput value={cfg.tickSec} min={15} max={3600} onChange={(tickSec) => set({ tickSec })} /></Field>
            <Field label={t('market.volatility')} hint={t('market.volatilityHint')}><NumberInput value={cfg.volatility} min={0} max={50} step={0.5} onChange={(volatility) => set({ volatility })} /></Field>
            <Field label={t('market.decay')} hint={t('market.decayHint')}><NumberInput value={cfg.decayPct} min={0} max={50} step={0.5} onChange={(decayPct) => set({ decayPct })} /></Field>
            <Field label={t('market.impact')} hint={t('market.impactHint')}><NumberInput value={cfg.impactPct} min={0} max={20} step={0.1} onChange={(impactPct) => set({ impactPct })} /></Field>
            <Field label={t('market.dividend')} hint={t('market.dividendHint')}><NumberInput value={cfg.dividendPct} min={0} max={20} step={0.1} onChange={(dividendPct) => set({ dividendPct })} /></Field>
            {COMMAND_KEYS.map((k) => <Field key={k} label={t(`marketCmd.${k}`)}><CommandInput value={cfg.commands[k]} onChange={(v) => set({ commands: { ...cfg.commands, [k]: v } })} /></Field>)}
            <Field label={t('market.exclude')} hint={t('market.excludeHint')} wide><LinesInput value={cfg.exclude} onChange={(exclude) => set({ exclude })} rows={3} /></Field>
            <Field label={t('market.tickerCount')}><NumberInput value={cfg.tickerCount} min={1} max={40} onChange={(tickerCount) => set({ tickerCount })} /></Field>
            <Field label={t('overlays.options')}><Toggle checked={cfg.announceNews} onChange={(announceNews) => set({ announceNews })} label={t('market.news')} /></Field>
            <LookFields accent={cfg.accentColor} font={cfg.fontFamily} onAccent={(accentColor) => set({ accentColor })} onFont={(fontFamily) => set({ fontFamily })} />
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="stocks" maxHeight={80} />
        <OverlayBar kind="stocks" name={t('ov.stocks')} />
      </aside>
    </div>
  );
}

// ---------- portal ----------

export function PortalModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.portal);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const portal = useApp((d) => d.state!.portal);
  const clock = useClock();
  const set = (patch: Partial<PortalSettings>) => saveSettings('portal', { ...cfg, ...patch });
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            <Toggle checked={cfg.enabled} onChange={(enabled) => set({ enabled })} label={<b>{t('portal.open')}</b>} />
            <div className="control-status">
              <span className="muted small">{portal.channel ? `twitch.tv/${portal.channel}` : t('portal.noPartner')}</span>
              <b><StatusText status={portal.status} error={portal.error} /></b>
            </div>
            <Button size="sm" icon="sparkle" onClick={() => void call('portal:test')}>{t('portal.test')}</Button>
          </div>
          <div className="form">
            <Field label={t('portal.partner')} hint={t('portal.partnerHint')} wide><TextInput value={cfg.partner} onChange={(partner) => set({ partner })} placeholder="twitch.tv/…" /></Field>
          </div>
          <p className="muted small">{t('portal.howto', { command: `${prefix}${cfg.command}` })}</p>
        </Card>
        <Card title={t('portal.recent')}>
          {portal.messages.length === 0 ? <Empty icon="portal" title={t('portal.quiet')} /> : (
            <ul className="portal-log">
              {portal.messages.map((m) => <li key={m.id}><span className="muted small">{clock(m.at)} {m.direction === 'in' ? '⬅' : '➡'}</span> <b style={m.color ? { color: m.color } : undefined}>{m.userName}</b> {m.text}</li>)}
            </ul>
          )}
        </Card>
        <Card title={t('portal.settings')}>
          <div className="form">
            <Field label={t('portal.mode')}><Select value={cfg.mode} onChange={(mode) => set({ mode })} options={(['command', 'all'] as const).map((v) => ({ value: v, label: t(`portalMode.${v}`) }))} /></Field>
            <Field label={t('portal.command')}><CommandInput value={cfg.command} onChange={(command) => set({ command })} /></Field>
            <Field label={t('portal.rate')}><NumberInput value={cfg.maxPerMinute} min={1} max={120} onChange={(maxPerMinute) => set({ maxPerMinute })} /></Field>
            <Field label={t('portal.duration')}><NumberInput value={cfg.durationSec} min={3} max={60} onChange={(durationSec) => set({ durationSec })} /></Field>
            <Field label={t('portal.side')}><Select value={cfg.side} onChange={(side) => set({ side })} options={(['left', 'right'] as const).map((v) => ({ value: v, label: t(`portalSide.${v}`) }))} /></Field>
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.showOutgoing} onChange={(showOutgoing) => set({ showOutgoing })} label={t('portal.outgoing')} />
                <Toggle checked={cfg.relayToChat} onChange={(relayToChat) => set({ relayToChat })} label={t('portal.relay')} />
              </div>
            </Field>
            <LookFields accent={cfg.accentColor} font={cfg.fontFamily} onAccent={(accentColor) => set({ accentColor })} onFont={(fontFamily) => set({ fontFamily })} />
          </div>
          <p className="muted small">{t('portal.safety')}</p>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="portal" maxHeight={300} />
        <OverlayBar kind="portal" name={t('ov.portal')} />
      </aside>
    </div>
  );
}

