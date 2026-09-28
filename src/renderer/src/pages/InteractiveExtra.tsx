import type { GuessSettings, Permission, ViewerQueueSettings } from '@shared/types';
import { OverlayBar, OverlayPreview } from '../components/overlay';
import { Button, Card, ColorInput, Empty, Field, IconButton, NumberInput, Select, TextInput, Toggle } from '../components/ui';
import { useClock, useNow } from '../hooks';
import { useT } from '../i18n';
import { call, callOk, saveSettings, useApp } from '../store';

const PERMISSIONS: Permission[] = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];

/** Command input with the bot prefix shown in front, like the boss and wheel commands. */
function CommandInput({ value, onChange, prefix }: { value: string; onChange: (v: string) => void; prefix: string }) {
  return (
    <div className="trigger">
      <span className="prefix">{prefix}</span>
      <input className="input mono" value={value} onChange={(e) => onChange(e.target.value.replace(/\s+/g, '').replace(prefix, ''))} />
    </div>
  );
}

// ---------- viewer queue ----------

export function QueueTab() {
  const t = useT();
  const clock = useClock();
  const cfg = useApp((d) => d.settings!.viewerQueue);
  const q = useApp((d) => d.state!.viewerQueue);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const set = (patch: Partial<ViewerQueueSettings>) => saveSettings('viewerQueue', { ...cfg, ...patch });
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            <Button variant={q.open ? 'secondary' : 'primary'} icon={q.open ? 'pause' : 'play'} className="btn-hero" onClick={() => void call('queue:open', !q.open)}>
              {q.open ? t('queue.close') : t('queue.open')}
            </Button>
            <div className="control-status">
              <span className="muted small">{q.open ? t('queue.isOpen') : t('queue.isClosed')}</span>
              <b>{t('queue.count', { n: q.entries.length })}</b>
            </div>
            <div className="row-gap">
              <Button icon="skip" disabled={!q.entries.length} onClick={() => void callOk('queue:next')}>{t('queue.next')}</Button>
              <Button icon="shuffle" disabled={!q.entries.length} onClick={() => void callOk('queue:next', true)}>{t('queue.random')}</Button>
            </div>
          </div>
          <p className="muted small">{t('queue.howto', { join: `${prefix}${cfg.joinCommand}`, leave: `${prefix}${cfg.leaveCommand}` })}</p>
          {q.picked[0] && (
            <div className="queue-now">
              <span className="muted small">{t('queue.upNow')}</span>
              <b>{q.picked[0].userName}</b>
              {q.picked.length > 1 && <span className="muted small">{t('queue.before', { names: q.picked.slice(1, 4).map((p) => p.userName).join(', ') })}</span>}
            </div>
          )}
        </Card>
        <Card
          title={t('queue.list')}
          actions={q.entries.length > 0 || q.picked.length > 0 ? <Button size="sm" icon="trash" onClick={() => confirm(t('queue.clearConfirm')) && void call('queue:clear')}>{t('queue.clear')}</Button> : undefined}
        >
          {q.entries.length === 0 ? (
            <Empty icon="users" title={t('queue.empty')}>{q.open ? t('queue.emptyOpen', { join: `${prefix}${cfg.joinCommand}` }) : t('queue.emptyClosed')}</Empty>
          ) : (
            <ol className="queue-list">
              {q.entries.map((e, i) => (
                <li key={`${e.platform}:${e.userId}`}>
                  <span className="queue-n">{i + 1}</span>
                  <span className="queue-name">{e.userName}{e.sub && <span className="pill">{t('queue.sub')}</span>}</span>
                  <span className="muted small">{clock(e.joinedAt)}</span>
                  <IconButton icon="x" label={t('common.delete')} onClick={() => void call('queue:remove', e.userId)} />
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title={t('queue.settings')}>
          <div className="form">
            <Field label={t('queue.title')}><TextInput value={cfg.title} onChange={(title) => set({ title })} /></Field>
            <Field label={t('give.eligible')}><Select value={cfg.eligible} onChange={(eligible) => set({ eligible })} options={PERMISSIONS.map((p) => ({ value: p, label: t(`perm.${p}`) }))} /></Field>
            <Field label={t('queue.joinCommand')}><CommandInput prefix={prefix} value={cfg.joinCommand} onChange={(joinCommand) => set({ joinCommand })} /></Field>
            <Field label={t('queue.leaveCommand')}><CommandInput prefix={prefix} value={cfg.leaveCommand} onChange={(leaveCommand) => set({ leaveCommand })} /></Field>
            <Field label={t('queue.maxSize')} hint={t('queue.maxSizeHint')}><NumberInput value={cfg.maxSize} min={0} max={1000} onChange={(maxSize) => set({ maxSize })} /></Field>
            <Field label={t('queue.showCount')}><NumberInput value={cfg.showCount} min={1} max={20} onChange={(showCount) => set({ showCount })} /></Field>
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.subPriority} onChange={(subPriority) => set({ subPriority })} label={t('queue.subPriority')} />
                <Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('queue.announce')} />
              </div>
            </Field>
            <Field label={t('common.accent')}><ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
            <Field label={t('common.font')} hint={t('common.fontHint')}><TextInput value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="queue" maxHeight={420} />
        <OverlayBar kind="queue" name={t('ov.queue')} />
      </aside>
    </div>
  );
}

// ---------- guess the number ----------

export function GuessTab() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.guess);
  const g = useApp((d) => d.state!.guess);
  const now = useNow(500);
  const set = (patch: Partial<GuessSettings>) => saveSettings('guess', { ...cfg, ...patch });
  const running = g.status === 'running';
  const left = running && g.endsAt ? Math.max(0, Math.ceil((g.endsAt - now) / 1000)) : null;
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            {running ? (
              <Button variant="danger" icon="x" className="btn-hero" onClick={() => void call('guess:stop')}>{t('guess.stop')}</Button>
            ) : (
              <Button variant="primary" icon="play" className="btn-hero" onClick={() => void callOk('guess:start')}>{g.status === 'idle' ? t('guess.start') : t('guess.again')}</Button>
            )}
            <div className="control-status">
              <span className="muted small">
                {running ? t('guess.running') : g.status === 'won' ? t('guess.won', { name: g.winner ?? '' }) : g.status === 'ended' ? t('guess.ended') : t('guess.idle')}
              </span>
              <b>
                {running ? `${g.low} — ${g.high}` : g.answer !== null ? g.answer : '—'}
                {left !== null && <span className="muted small"> · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>}
              </b>
            </div>
            {!running && g.status !== 'idle' && <Button size="sm" icon="x" onClick={() => void call('guess:stop')}>{t('guess.hide')}</Button>}
          </div>
          <p className="muted small">
            {running && g.lastGuess
              ? t('guess.last', { user: g.lastGuess.user, value: g.lastGuess.value, hint: g.lastGuess.hint === 'higher' ? t('guess.higher') : g.lastGuess.hint === 'lower' ? t('guess.lower') : '✓' })
              : t('guess.howto')}
            {g.status !== 'idle' && ` · ${t('guess.attempts', { n: g.attempts })}`}
          </p>
        </Card>
        <Card title={t('guess.settings')}>
          <div className="form">
            <Field label={t('guess.min')}><NumberInput value={cfg.min} min={-1000000} max={1000000} onChange={(min) => set({ min })} /></Field>
            <Field label={t('guess.max')}><NumberInput value={cfg.max} min={-1000000} max={1000000} onChange={(max) => set({ max })} /></Field>
            <Field label={t('guess.duration')} hint={t('guess.durationHint')}><NumberInput value={cfg.durationSec} min={0} max={3600} onChange={(durationSec) => set({ durationSec })} /></Field>
            <Field label={t('guess.cooldown')} hint={t('guess.cooldownHint')}><NumberInput value={cfg.cooldownSec} min={0} max={600} onChange={(cooldownSec) => set({ cooldownSec })} /></Field>
            <Field label={t('overlays.options')} wide><Toggle checked={cfg.announce} onChange={(announce) => set({ announce })} label={t('guess.announce')} /></Field>
            <Field label={t('common.accent')}><ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
            <Field label={t('common.font')} hint={t('common.fontHint')}><TextInput value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="guess" maxHeight={300} />
        <OverlayBar kind="guess" name={t('ov.guess')} />
      </aside>
    </div>
  );
}
