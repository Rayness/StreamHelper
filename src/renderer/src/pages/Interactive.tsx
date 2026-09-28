import { useState } from 'react';
import { defaultWheel, uid, WHEEL_COLORS } from '@shared/defaults';
import type { GiveawaySettings, Permission, PollSettings, QuizDifficulty, QuizSettings, Wheel, WheelSegment } from '@shared/types';
import { Icon } from '../components/icons';
import { MediaPicker } from '../components/MediaPicker';
import { InstancePicker, OverlayBar, OverlayPreview, pickInstance } from '../components/overlay';
import { Button, Card, ColorInput, Empty, Field, IconButton, LinesInput, NumberInput, PageHeader, Select, Tabs, TextInput, Toggle } from '../components/ui';
import { useClock, useNow } from '../hooks';
import { useT, type TFn } from '../i18n';
import { call, callOk, navigate, saveSettings, useApp, useSub } from '../store';

type Tab = 'wheel' | 'poll' | 'giveaway' | 'quiz' | 'boss';
const TABS: Tab[] = ['wheel', 'poll', 'giveaway', 'quiz', 'boss'];
const PERMISSIONS: Permission[] = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];
const permOptions = (t: TFn) => PERMISSIONS.map((p) => ({ value: p, label: t(`perm.${p}`) }));

export function Interactive() {
  const t = useT();
  const [tab, setTab] = useSub<Tab>('interactive', 'wheel', TABS);
  const pollLive = useApp((d) => d.state!.poll?.status === 'running');
  const giveawayLive = useApp((d) => d.state!.giveaway.status === 'open');
  const quizLive = useApp((d) => ['question', 'reveal', 'loading'].includes(d.state!.quiz.status));
  const bossLive = useApp((d) => d.state!.boss.status === 'running');
  return (
    <div className="page page-wide">
      <PageHeader title={t('nav.interactive')} subtitle={t('fun.subtitle')} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'wheel', label: <TabLabel icon="wheel" text={t('fun.wheel')} /> },
          { id: 'poll', label: <TabLabel icon="poll" text={t('fun.poll')} live={pollLive} /> },
          { id: 'giveaway', label: <TabLabel icon="gift" text={t('fun.giveaway')} live={giveawayLive} /> },
          { id: 'quiz', label: <TabLabel icon="quiz" text={t('fun.quiz')} live={quizLive} /> },
          { id: 'boss', label: <TabLabel icon="target" text={t('fun.boss')} live={bossLive} /> },
        ]}
      />
      {tab === 'wheel' && <WheelTab />}
      {tab === 'poll' && <PollTab />}
      {tab === 'giveaway' && <GiveawayTab />}
      {tab === 'quiz' && <QuizTab />}
      {tab === 'boss' && <BossTab />}
    </div>
  );
}

function TabLabel({ icon, text, live }: { icon: 'wheel' | 'poll' | 'gift' | 'quiz' | 'target'; text: string; live?: boolean }) {
  return (
    <span className="tab-label">
      <Icon name={icon} size={15} />
      {text}
      {live && <span className="tab-live" />}
    </span>
  );
}

// ---------- wheel ----------

function WheelTab() {
  const t = useT();
  const wheels = useApp((d) => d.settings!.wheels);
  const lang = useApp((d) => d.settings!.language);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const spin = useApp((d) => d.state!.wheel);
  const [sel, setSel] = useState<string>();
  const w = pickInstance(wheels, sel);
  const update = (patch: Partial<Wheel>) => w && saveSettings('wheels', wheels.map((x) => (x.id === w.id ? { ...x, ...patch } : x)));
  const setSeg = (id: string, patch: Partial<WheelSegment>) => w && update({ segments: w.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const add = () => {
    const nw = { ...defaultWheel(lang), name: `${t('fun.wheel')} ${wheels.length + 1}` };
    saveSettings('wheels', [...wheels, nw]);
    setSel(nw.id);
  };
  const totalWeight = w ? w.segments.reduce((s, x) => s + Math.max(0, x.weight), 0) : 0;
  const last = spin.lastResult && w && spin.lastResult.wheelId === w.id ? spin.lastResult : null;
  return (
    <>
      <InstancePicker items={wheels} value={w?.id} onChange={setSel} label={(x) => x.name} onAdd={add} addLabel={t('wheel.add')} />
      {!w ? (
        <Empty icon="wheel" title={t('wheel.empty')} />
      ) : (
        <div className="fun-split">
          <div className="fun-main">
            <Card className="control-card">
              <div className="control-row">
                <Button variant="primary" icon="wheel" className="btn-hero" disabled={w.segments.length === 0} onClick={() => void call('wheel:spin', w.id)}>
                  {spin.spinning && spin.wheelId === w.id ? t('wheel.spinning') : t('wheel.spin')}
                </Button>
                <div className="control-status">
                  <span className="muted small">{t('wheel.lastResult')}</span>
                  <b>{last ? last.label : '—'}</b>
                </div>
              </div>
              <p className="muted small">{t('wheel.triggersHint', { prefix })}</p>
            </Card>
            <Card
              title={t('wheel.segments')}
              actions={
                <Button
                  size="sm"
                  icon="shuffle"
                  onClick={() => update({ segments: w.segments.map((s, i) => ({ ...s, color: WHEEL_COLORS[(i + Math.floor(Math.random() * 8)) % WHEEL_COLORS.length] })) })}
                >
                  {t('wheel.recolor')}
                </Button>
              }
            >
              <ol className="seg-list">
                {w.segments.map((s) => (
                  <li key={s.id}>
                    <input type="color" className="seg-color" value={s.color} onChange={(e) => setSeg(s.id, { color: e.target.value })} aria-label={t('wheel.color')} />
                    <TextInput value={s.label} onChange={(label) => setSeg(s.id, { label })} placeholder={t('wheel.segmentPh')} />
                    <div className="seg-weight" title={t('wheel.weightHint')}>
                      <NumberInput value={s.weight} min={0} max={100} onChange={(weight) => setSeg(s.id, { weight })} />
                      <span className="muted small">{totalWeight ? Math.round((Math.max(0, s.weight) / totalWeight) * 100) : 0}%</span>
                    </div>
                    <IconButton icon="x" label={t('common.delete')} onClick={() => update({ segments: w.segments.filter((x) => x.id !== s.id) })} />
                  </li>
                ))}
              </ol>
              <div className="row-gap">
                <Button
                  size="sm"
                  icon="plus"
                  onClick={() => update({ segments: [...w.segments, { id: uid('seg_'), label: '', color: WHEEL_COLORS[w.segments.length % WHEEL_COLORS.length], weight: 1 }] })}
                >
                  {t('wheel.addSegment')}
                </Button>
                <BulkSegments wheel={w} onApply={(segments) => update({ segments })} />
              </div>
            </Card>
            <Card title={t('wheel.behaviour')}>
              <div className="form">
                <Field label={t('banners.name')}>
                  <TextInput value={w.name} onChange={(name) => update({ name })} />
                </Field>
                <Field label={t('wheel.spinSec')}>
                  <NumberInput value={w.spinSec} min={2} max={30} onChange={(spinSec) => update({ spinSec })} />
                </Field>
                <Field label={t('wheel.hideAfter')} hint={t('wheel.hideAfterHint')}>
                  <NumberInput value={w.hideAfterSec} min={0} max={600} onChange={(hideAfterSec) => update({ hideAfterSec })} />
                </Field>
                <Field label={t('overlays.options')}>
                  <div className="stack">
                    <Toggle checked={w.removeWinner} onChange={(removeWinner) => update({ removeWinner })} label={t('wheel.removeWinner')} />
                    <Toggle checked={w.tickSound} onChange={(tickSound) => update({ tickSound })} label={t('wheel.tickSound')} />
                  </div>
                </Field>
                <Field label={t('wheel.announce')} hint={t('wheel.announceHint')} wide>
                  <TextInput value={w.announce} onChange={(announce) => update({ announce })} />
                </Field>
                <Field label={t('wheel.command')} hint={t('wheel.commandHint')}>
                  <div className="trigger">
                    <span className="prefix">{prefix}</span>
                    <input className="input mono" value={w.command} placeholder={t('wheel.commandPh')} onChange={(e) => update({ command: e.target.value.replace(/\s+/g, '').replace(prefix, '') })} />
                  </div>
                </Field>
                <Field label={t('bot.permission')}>
                  <Select<Permission> value={w.commandPermission} onChange={(commandPermission) => update({ commandPermission })} options={permOptions(t)} />
                </Field>
                <Field label={t('bot.cooldown')}>
                  <NumberInput value={w.commandCooldownSec} min={0} onChange={(commandCooldownSec) => update({ commandCooldownSec })} />
                </Field>
                <Field label={t('actions.redemption')} hint={t('wheel.redemptionHint')}>
                  <TextInput value={w.redemptionTitle} onChange={(redemptionTitle) => update({ redemptionTitle })} placeholder={t('actions.redemptionPh')} />
                </Field>
                <Field label={t('wheel.winSound')} wide>
                  <MediaPicker kind="audio" value={w.winSound} onChange={(winSound) => update({ winSound })} />
                </Field>
                <Field label={t('alerts.volume')}>
                  <input type="range" min={0} max={1} step={0.05} value={w.volume} onChange={(e) => update({ volume: Number(e.target.value) })} />
                </Field>
                <Field label={t('common.font')} hint={t('common.fontHint')}>
                  <TextInput value={w.fontFamily} onChange={(fontFamily) => update({ fontFamily })} />
                </Field>
              </div>
            </Card>
            <div className="danger-row">
              <Button variant="danger" size="sm" icon="trash" onClick={() => confirm(t('common.confirmDelete')) && saveSettings('wheels', wheels.filter((x) => x.id !== w.id))}>
                {t('common.delete')}
              </Button>
            </div>
          </div>
          <aside className="fun-side">
            <OverlayPreview kind="wheel" id={w.id} maxHeight={420} />
            <OverlayBar kind="wheel" id={w.id} name={w.name} />
          </aside>
        </div>
      )}
    </>
  );
}

/** Paste a list of options, one per line — faster than adding segments one by one. */
function BulkSegments({ wheel, onApply }: { wheel: Wheel; onApply: (s: WheelSegment[]) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  if (!open)
    return (
      <Button
        size="sm"
        icon="edit"
        onClick={() => {
          setLines(wheel.segments.map((s) => s.label));
          setOpen(true);
        }}
      >
        {t('wheel.bulk')}
      </Button>
    );
  return (
    <div className="bulk">
      <LinesInput value={lines} onChange={setLines} rows={6} placeholder={t('wheel.bulkPh')} />
      <div className="row-gap">
        <Button
          size="sm"
          variant="primary"
          icon="check"
          onClick={() => {
            onApply(
              lines.map((label, i) => {
                const existing = wheel.segments.find((s) => s.label === label);
                return existing ?? { id: uid('seg_'), label, color: WHEEL_COLORS[i % WHEEL_COLORS.length], weight: 1 };
              }),
            );
            setOpen(false);
          }}
        >
          {t('common.apply')}
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ---------- poll ----------

function PollTab() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.poll);
  const poll = useApp((d) => d.state!.poll);
  const now = useNow(500);
  const set = (patch: Partial<PollSettings>) => saveSettings('poll', { ...cfg, ...patch });
  const running = poll?.status === 'running';
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            {running ? (
              <Button variant="danger" icon="check" className="btn-hero" onClick={() => void call('poll:end')}>
                {t('poll.end')}
              </Button>
            ) : (
              <Button variant="primary" icon="play" className="btn-hero" onClick={() => void call('poll:start')}>
                {t('poll.start')}
              </Button>
            )}
            <div className="control-status">
              <span className="muted small">{running ? t('poll.running') : poll ? t('poll.ended') : t('poll.idle')}</span>
              <b>
                {running && poll?.endsAt ? formatLeft(poll.endsAt - now) : poll ? t('poll.votes', { n: poll.total }) : '—'}
              </b>
            </div>
            {poll && !running && (
              <Button size="sm" icon="x" onClick={() => void call('poll:clear')}>
                {t('poll.clear')}
              </Button>
            )}
          </div>
          {poll && (
            <div className="poll-live">
              <b>{poll.question}</b>
              {poll.options.map((o, i) => {
                const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
                return (
                  <div key={i} className={`poll-row ${poll.leaders.includes(i) ? 'lead' : ''}`}>
                    <div className="poll-fill" style={{ width: `${pct}%` }} />
                    <span className="poll-num">{i + 1}</span>
                    <span className="poll-label">{o.label}</span>
                    <span className="poll-pct">
                      {pct}% · {o.votes}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        <Card title={t('poll.setup')}>
          <div className="form">
            <Field label={t('poll.question')} wide>
              <TextInput value={cfg.question} onChange={(question) => set({ question })} />
            </Field>
            <Field label={t('poll.options')} hint={t('poll.optionsHint')} wide>
              <LinesInput value={cfg.options} onChange={(options) => set({ options })} rows={4} />
            </Field>
            <Field label={t('poll.duration')} hint={t('poll.durationHint')}>
              <NumberInput value={cfg.durationSec} min={0} max={3600} onChange={(durationSec) => set({ durationSec })} />
            </Field>
            <Field label={t('poll.resultSec')} hint={t('poll.resultSecHint')}>
              <NumberInput value={cfg.resultSec} min={0} max={3600} onChange={(resultSec) => set({ resultSec })} />
            </Field>
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.allowChange} onChange={(allowChange) => set({ allowChange })} label={t('poll.allowChange')} />
                <Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('poll.announce')} />
              </div>
            </Field>
            <Field label={t('goals.barColor')}>
              <ColorInput value={cfg.barColor} onChange={(barColor) => set({ barColor })} />
            </Field>
            <Field label={t('common.textColor')}>
              <ColorInput value={cfg.textColor} onChange={(textColor) => set({ textColor })} />
            </Field>
            <Field label={t('common.font')} hint={t('common.fontHint')}>
              <TextInput value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} />
            </Field>
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="poll" maxHeight={340} />
        <OverlayBar kind="poll" name={t('fun.poll')} />
      </aside>
    </div>
  );
}

function formatLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- giveaway ----------

function GiveawayTab() {
  const t = useT();
  const clock = useClock();
  const cfg = useApp((d) => d.settings!.giveaway);
  const g = useApp((d) => d.state!.giveaway);
  const [filter, setFilter] = useState('');
  const set = (patch: Partial<GiveawaySettings>) => saveSettings('giveaway', { ...cfg, ...patch });
  const tickets = g.entrants.reduce((s, e) => s + e.tickets, 0);
  const shown = filter ? g.entrants.filter((e) => e.userName.toLowerCase().includes(filter.toLowerCase())) : g.entrants;
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            {g.status === 'idle' || g.status === 'done' ? (
              <Button variant="primary" icon="gift" className="btn-hero" onClick={() => void call('giveaway:open')}>
                {g.status === 'done' ? t('give.new') : t('give.open')}
              </Button>
            ) : g.status === 'open' ? (
              <Button variant="secondary" icon="pause" className="btn-hero" onClick={() => void call('giveaway:close')}>
                {t('give.close')}
              </Button>
            ) : null}
            {(g.status === 'open' || g.status === 'closed' || g.status === 'done') && (
              <Button variant={g.status === 'done' ? 'secondary' : 'primary'} icon="trophy" className="btn-hero" disabled={g.entrants.length === 0 || (g.status === 'done' && g.entrants.length < 2)} onClick={() => void callOk('giveaway:roll')}>
                {g.status === 'done' ? t('give.reroll') : t('give.roll')}
              </Button>
            )}
            <div className="control-status">
              <span className="muted small">{t(`giveStatus.${g.status}`)}</span>
              <b>{t('give.entrants', { n: g.entrants.length })}</b>
            </div>
            {g.status !== 'idle' && (
              <Button size="sm" icon="x" onClick={() => confirm(t('give.resetConfirm')) && void call('giveaway:reset')}>
                {t('give.reset')}
              </Button>
            )}
          </div>
          {g.status === 'open' && <p className="muted small">{t('give.openHint', { keyword: cfg.keyword })}</p>}
        </Card>
        {g.winner && (g.status === 'done' || g.status === 'rolling') && (
          <Card className="winner-card">
            <div className="winner-head">
              <Icon name="trophy" size={22} />
              <div>
                <span className="muted small">{g.status === 'rolling' ? t('give.rolling') : t('give.winner')}</span>
                <b>{g.status === 'rolling' ? '…' : g.winner.userName}</b>
              </div>
              {g.status === 'done' && (
                <span className="muted small">
                  {t('give.chance', { pct: tickets ? Math.round((g.winner.tickets / tickets) * 100) : 0 })}
                </span>
              )}
            </div>
            {g.status === 'done' && (
              <div className="winner-msgs">
                {g.winnerMessages.length === 0 ? (
                  <p className="muted small">{t('give.waitingWinner')}</p>
                ) : (
                  g.winnerMessages.map((m, i) => (
                    <p key={i}>
                      <span className="muted small">{clock(m.at)}</span> {m.text}
                    </p>
                  ))
                )}
              </div>
            )}
          </Card>
        )}
        {g.entrants.length > 0 && (
          <Card title={t('give.list', { n: g.entrants.length })} actions={<input className="input input-search" placeholder={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />}>
            <ul className="entrants">
              {shown.slice(0, 500).map((e) => (
                <li key={`${e.platform}:${e.userId}`}>
                  {e.userName}
                  {e.tickets > 1 && <span className="pill">×{e.tickets}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card title={t('give.setup')}>
          <div className="form">
            <Field label={t('give.title')}>
              <TextInput value={cfg.title} onChange={(title) => set({ title })} />
            </Field>
            <Field label={t('give.keyword')} hint={t('give.keywordHint')}>
              <TextInput value={cfg.keyword} onChange={(keyword) => set({ keyword })} mono />
            </Field>
            <Field label={t('give.eligible')}>
              <Select<Permission> value={cfg.eligible} onChange={(eligible) => set({ eligible })} options={permOptions(t)} />
            </Field>
            <Field label={t('give.subLuck')} hint={t('give.subLuckHint')}>
              <NumberInput value={cfg.subLuck} min={1} max={10} onChange={(subLuck) => set({ subLuck })} />
            </Field>
            <Field label={t('give.announceOpen')} hint={t('give.announceHint')} wide>
              <TextInput value={cfg.announceOpen} onChange={(announceOpen) => set({ announceOpen })} />
            </Field>
            <Field label={t('give.announceWinner')} wide>
              <TextInput value={cfg.announceWinner} onChange={(announceWinner) => set({ announceWinner })} />
            </Field>
            <Field label={t('common.accent')}>
              <ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} />
            </Field>
            <Field label={t('common.font')} hint={t('common.fontHint')}>
              <TextInput value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} />
            </Field>
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="giveaway" maxHeight={260} />
        <OverlayBar kind="giveaway" name={t('fun.giveaway')} />
      </aside>
    </div>
  );
}

// ---------- quiz ----------

function QuizTab() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.quiz);
  const q = useApp((d) => d.state!.quiz);
  const kawaki = useApp((d) => d.state!.kawaki.status === 'connected' || !!d.state!.kawaki.account);
  const now = useNow(500);
  const set = (patch: Partial<QuizSettings>) => saveSettings('quiz', { ...cfg, ...patch });
  const active = q.status === 'question' || q.status === 'reveal' || q.status === 'loading';
  return (
    <div className="fun-split">
      <div className="fun-main">
        {!kawaki && (
          <Card className="callout">
            <Icon name="tv" size={20} />
            <div>
              <b>{t('quiz.needKawaki')}</b>
              <p className="muted small">{t('quiz.needKawakiHint')}</p>
            </div>
            <Button variant="primary" onClick={() => navigate('kawaki')}>
              {t('quiz.connect')}
            </Button>
          </Card>
        )}
        <Card className="control-card">
          <div className="control-row">
            {active ? (
              <>
                <Button variant="primary" icon="skip" className="btn-hero" disabled={q.status !== 'question'} onClick={() => void call('quiz:skip')}>
                  {t('quiz.skip')}
                </Button>
                <Button variant="danger" icon="x" onClick={() => void call('quiz:stop')}>
                  {t('quiz.stop')}
                </Button>
              </>
            ) : (
              <Button variant="primary" icon="play" className="btn-hero" disabled={!kawaki} onClick={() => void callOk('quiz:start')}>
                {q.status === 'finished' ? t('quiz.again') : t('quiz.start')}
              </Button>
            )}
            <div className="control-status">
              <span className="muted small">{t(`quizStatus.${q.status}`)}</span>
              <b>
                {q.round ? `${q.round} / ${q.rounds}` : '—'}
                {q.status === 'question' && q.endsAt ? ` · ${formatLeft(q.endsAt - now)}` : ''}
              </b>
            </div>
            {q.status === 'finished' && (
              <Button size="sm" icon="x" onClick={() => void call('quiz:stop')}>
                {t('poll.clear')}
              </Button>
            )}
          </div>
          {q.error && <p className="error small">{q.error}</p>}
          {(q.status === 'question' || q.status === 'reveal') && (
            <div className="quiz-now">
              {q.imageUrl && <img src={q.imageUrl} alt="" />}
              <div>
                <span className="muted small">{t('quiz.answer')}</span>
                <b>{q.answer?.title ?? q.hint}</b>
                {q.status === 'reveal' && <span className="small">{q.winner ? t('quiz.guessedBy', { name: q.winner }) : t('quiz.nobody')}</span>}
                {q.status === 'question' && <span className="muted small">{t('quiz.streamerHint')}</span>}
              </div>
            </div>
          )}
          {q.leaderboard.length > 0 && (
            <ol className="leaderboard">
              {q.leaderboard.map((r) => (
                <li key={r.userName}>
                  <span>{r.userName}</span>
                  <b>{r.points}</b>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title={t('quiz.setup')}>
          <p className="muted small">{t('quiz.howto')}</p>
          <div className="form">
            <Field label={t('quiz.rounds')}>
              <NumberInput value={cfg.rounds} min={1} max={50} onChange={(rounds) => set({ rounds })} />
            </Field>
            <Field label={t('quiz.roundSec')}>
              <NumberInput value={cfg.roundSec} min={10} max={180} onChange={(roundSec) => set({ roundSec })} />
            </Field>
            <Field label={t('quiz.revealSec')}>
              <NumberInput value={cfg.revealSec} min={3} max={60} onChange={(revealSec) => set({ revealSec })} />
            </Field>
            <Field label={t('quiz.difficulty')} hint={t('quiz.difficultyHint')}>
              <Select<QuizDifficulty> value={cfg.difficulty} onChange={(difficulty) => set({ difficulty })} options={(['easy', 'normal', 'hard'] as const).map((d) => ({ value: d, label: t(`quizDiff.${d}`) }))} />
            </Field>
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.hints} onChange={(hints) => set({ hints })} label={t('quiz.hints')} />
                <Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('quiz.announce')} />
              </div>
            </Field>
            <Field label={t('common.accent')}>
              <ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} />
            </Field>
            <Field label={t('common.font')} hint={t('common.fontHint')}>
              <TextInput value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} />
            </Field>
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="quiz" maxHeight={300} />
        <OverlayBar kind="quiz" name={t('fun.quiz')} />
      </aside>
    </div>
  );
}

function BossTab() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.boss);
  const boss = useApp((d) => d.state!.boss);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const set = (patch: Partial<typeof cfg>) => saveSettings('boss', { ...cfg, ...patch });
  return <div className="fun-split">
    <div className="fun-main">
      <Card title={t('boss.control')}>
        <p className="muted">{t('boss.howto', { command: `${prefix}${cfg.command}` })}</p>
        <div className="control-row">
          <Button variant="primary" icon="target" onClick={() => void call('boss:start')}>{t('boss.start')}</Button>
          <Button disabled={boss.status !== 'running'} onClick={() => void call('boss:hit')}>{t('boss.hit')}</Button>
          <Button onClick={() => void call('boss:reset')}>{t('boss.reset')}</Button>
          <strong>{boss.hp} / {boss.maxHp} HP</strong>
        </div>
        {boss.top.length > 0 && <ol className="leaderboard">{boss.top.map((x) => <li key={x.user}><span>{x.user}</span><b>{x.damage}</b></li>)}</ol>}
      </Card>
      <Card title={t('boss.settings')}>
        <div className="form">
          <Field label={t('boss.name')}><TextInput value={cfg.name} onChange={(name) => set({ name })} /></Field>
          <Field label={t('boss.maxHp')}><NumberInput value={cfg.maxHp} min={1} max={1000000} onChange={(maxHp) => set({ maxHp })} /></Field>
          <Field label={t('boss.damage')}><NumberInput value={cfg.damage} min={1} max={100000} onChange={(damage) => set({ damage })} /></Field>
          <Field label={t('boss.cooldown')}><NumberInput value={cfg.cooldownSec} min={0} max={3600} onChange={(cooldownSec) => set({ cooldownSec })} /></Field>
          <Field label={t('boss.command')}><div className="trigger"><span className="prefix">{prefix}</span><input className="input mono" value={cfg.command} onChange={(e) => set({ command: e.target.value.replace(/\s+/g, '').replace(prefix, '') })} /></div></Field>
          <Field label={t('actions.redemption')}><TextInput value={cfg.redemptionTitle} onChange={(redemptionTitle) => set({ redemptionTitle })} placeholder={t('actions.redemptionPh')} /></Field>
          <Field label={t('common.accent')}><ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
          <Field label={t('boss.announce')}><Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} /></Field>
        </div>
      </Card>
    </div>
    <aside className="fun-side"><OverlayPreview kind="boss" maxHeight={260} /><OverlayBar kind="boss" name={t('fun.boss')} /></aside>
  </div>;
}
