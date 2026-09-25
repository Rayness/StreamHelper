import { useState } from 'react';
import { defaultGoal, defaultTimer, uid } from '@shared/defaults';
import { timerValue } from '@shared/timer';
import { formatClock } from '@shared/template';
import type { Goal, GoalKind, OverlayTimer } from '@shared/types';
import { Icon } from '../components/icons';
import { Button, Card, ColorInput, CopyField, Empty, Field, IconButton, LinesInput, NumberInput, PageHeader, Select, Tabs, TextInput, Toggle } from '../components/ui';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { call, saveSettings, useApp } from '../store';

type Tab = 'links' | 'chat' | 'goals' | 'timers';

export function Overlays() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('links');
  return (
    <div className="page">
      <PageHeader title={t('nav.overlays')} subtitle={t('overlays.subtitle')} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'links', label: t('overlays.tabLinks') },
          { id: 'chat', label: t('overlays.tabChat') },
          { id: 'goals', label: t('overlays.tabGoals') },
          { id: 'timers', label: t('overlays.tabTimers') },
        ]}
      />
      {tab === 'links' && <Links />}
      {tab === 'chat' && <ChatOverlay />}
      {tab === 'goals' && <Goals />}
      {tab === 'timers' && <Timers />}
    </div>
  );
}

function Links() {
  const t = useT();
  const url = useApp((d) => d.state!.overlayUrl);
  const clients = useApp((d) => d.state!.overlayClients);
  const goals = useApp((d) => d.settings!.goals);
  const timers = useApp((d) => d.settings!.timers);
  if (!url) return <Empty icon="layers" title={t('overlays.serverDown')}>{t('overlays.serverDownHint')}</Empty>;
  return (
    <>
      <Card>
        <div className="howto">
          <Icon name="video" size={20} />
          <div>
            <b>{t('overlays.howTitle')}</b>
            <p className="muted">{t('overlays.howText')}</p>
          </div>
          <span className="pill">{t('overlays.clients', { n: clients })}</span>
        </div>
      </Card>
      <div className="link-list">
        <OverlayLink title={t('overlays.alerts')} hint={t('overlays.alertsHint')} url={`${url}/overlay/alerts`} size="1920×1080" />
        <OverlayLink title={t('overlays.chat')} hint={t('overlays.chatHint')} url={`${url}/overlay/chat`} size="400×600" />
        <OverlayLink title={t('overlays.events')} hint={t('overlays.eventsHint')} url={`${url}/overlay/events?limit=5`} size="400×300" />
        {goals.map((g) => (
          <OverlayLink key={g.id} title={`${t('overlays.goal')}: ${g.title}`} url={`${url}/overlay/goal?id=${g.id}`} size="600×90" />
        ))}
        {timers.map((tm) => (
          <OverlayLink key={tm.id} title={`${t('overlays.timer')}: ${tm.title}`} url={`${url}/overlay/timer?id=${tm.id}`} size="500×150" />
        ))}
      </div>
    </>
  );
}

function OverlayLink({ title, hint, url, size }: { title: string; hint?: string; url: string; size: string }) {
  const t = useT();
  return (
    <Card>
      <div className="link-head">
        <div>
          <b>{title}</b>
          {hint && <p className="muted small">{hint}</p>}
        </div>
        <span className="pill" title={t('overlays.sizeHint')}>
          {size}
        </span>
        <IconButton icon="external" label={t('overlays.open')} onClick={() => void call('shell:openExternal', url)} />
      </div>
      <CopyField value={url} />
    </Card>
  );
}

function ChatOverlay() {
  const t = useT();
  const c = useApp((d) => d.settings!.chatOverlay);
  const url = useApp((d) => d.state!.overlayUrl);
  const set = (patch: Partial<typeof c>) => saveSettings('chatOverlay', { ...c, ...patch });
  return (
    <div className="two-col">
      <Card title={t('overlays.chatSettings')}>
        <div className="form">
          <Field label={t('common.font')} hint={t('common.fontHint')}>
            <TextInput value={c.fontFamily} onChange={(fontFamily) => set({ fontFamily })} />
          </Field>
          <Field label={t('common.fontSize')}>
            <NumberInput value={c.fontSize} min={10} max={72} onChange={(fontSize) => set({ fontSize })} />
          </Field>
          <Field label={t('common.textColor')}>
            <ColorInput value={c.textColor} onChange={(textColor) => set({ textColor })} />
          </Field>
          <Field label={t('overlays.chatBg')} hint={t('overlays.chatBgHint')}>
            <TextInput value={c.background} onChange={(background) => set({ background })} mono />
          </Field>
          <Field label={t('overlays.maxMessages')}>
            <NumberInput value={c.maxMessages} min={1} max={200} onChange={(maxMessages) => set({ maxMessages })} />
          </Field>
          <Field label={t('overlays.hideAfter')} hint={t('overlays.hideAfterHint')}>
            <NumberInput value={c.hideAfterSec} min={0} max={3600} onChange={(hideAfterSec) => set({ hideAfterSec })} />
          </Field>
          <Field label={t('overlays.direction')}>
            <Select
              value={c.direction}
              onChange={(direction) => set({ direction })}
              options={[
                { value: 'up', label: t('overlays.dirUp') },
                { value: 'down', label: t('overlays.dirDown') },
              ]}
            />
          </Field>
          <Field label={t('overlays.options')} wide>
            <div className="stack">
              <Toggle checked={c.showBadges} onChange={(showBadges) => set({ showBadges })} label={t('overlays.showBadges')} />
              <Toggle checked={c.showPlatform} onChange={(showPlatform) => set({ showPlatform })} label={t('overlays.showPlatform')} />
              <Toggle checked={c.hideCommands} onChange={(hideCommands) => set({ hideCommands })} label={t('overlays.hideCommands')} />
            </div>
          </Field>
          <Field label={t('overlays.hideBots')} hint={t('overlays.hideBotsHint')} wide>
            <LinesInput value={c.hideBots} onChange={(hideBots) => set({ hideBots })} rows={3} />
          </Field>
        </div>
      </Card>
      <Card
        title={t('alerts.preview')}
        actions={
          <Button size="sm" icon="send" onClick={() => void call('chat:test')}>
            {t('overlays.testMessage')}
          </Button>
        }
      >
        {url ? (
          <div className="preview-frame chat-preview checker">
            <iframe src={`${url}/overlay/chat`} title="chat preview" />
          </div>
        ) : (
          <p className="muted">{t('overlays.serverDown')}</p>
        )}
      </Card>
    </div>
  );
}

function Goals() {
  const t = useT();
  const goals = useApp((d) => d.settings!.goals);
  const lang = useApp((d) => d.settings!.language);
  const currency = useApp((d) => d.settings!.currency);
  const update = (id: string, patch: Partial<Goal>) => saveSettings('goals', goals.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const kinds: GoalKind[] = ['followers', 'subs', 'bits', 'donations', 'manual'];
  return (
    <>
      <div className="toolbar">
        <Button variant="primary" icon="plus" onClick={() => saveSettings('goals', [...goals, { ...defaultGoal(lang), currency }])}>
          {t('goals.add')}
        </Button>
      </div>
      {goals.length === 0 && <Empty icon="target" title={t('goals.empty')} />}
      {goals.map((g) => {
        const pct = g.target > 0 ? Math.min(100, (g.current / g.target) * 100) : 0;
        return (
          <Card
            key={g.id}
            title={g.title || t('goals.untitled')}
            actions={<IconButton icon="trash" label={t('common.delete')} variant="danger" onClick={() => confirm(t('common.confirmDelete')) && saveSettings('goals', goals.filter((x) => x.id !== g.id))} />}
          >
            <div className="goal-bar" style={{ '--c': g.barColor } as React.CSSProperties}>
              <div style={{ width: `${pct}%` }} />
              <span>
                {g.current} / {g.target} {g.kind === 'donations' ? g.currency : ''} · {Math.floor(pct)}%
              </span>
            </div>
            <div className="form">
              <Field label={t('goals.title')}>
                <TextInput value={g.title} onChange={(title) => update(g.id, { title })} />
              </Field>
              <Field label={t('goals.kind')} hint={t('goals.kindHint')}>
                <Select<GoalKind> value={g.kind} onChange={(kind) => update(g.id, { kind })} options={kinds.map((k) => ({ value: k, label: t(`goalKind.${k}`) }))} />
              </Field>
              <Field label={t('goals.target')}>
                <NumberInput value={g.target} min={1} onChange={(target) => update(g.id, { target })} />
              </Field>
              <Field label={t('goals.current')}>
                <NumberInput value={g.current} min={0} onChange={(current) => update(g.id, { current })} />
              </Field>
              {g.kind === 'donations' && (
                <Field label={t('settings.currency')}>
                  <TextInput value={g.currency} onChange={(c) => update(g.id, { currency: c.toUpperCase() })} />
                </Field>
              )}
              <Field label={t('goals.barColor')}>
                <ColorInput value={g.barColor} onChange={(barColor) => update(g.id, { barColor })} />
              </Field>
              <Field label={t('common.textColor')}>
                <ColorInput value={g.textColor} onChange={(textColor) => update(g.id, { textColor })} />
              </Field>
            </div>
          </Card>
        );
      })}
    </>
  );
}

function Timers() {
  const t = useT();
  const timers = useApp((d) => d.settings!.timers);
  const lang = useApp((d) => d.settings!.language);
  const now = useNow(500);
  const update = (id: string, patch: Partial<OverlayTimer>) => saveSettings('timers', timers.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  return (
    <>
      <div className="toolbar">
        <Button variant="primary" icon="plus" onClick={() => saveSettings('timers', [...timers, { ...defaultTimer(lang), id: uid('timer_') }])}>
          {t('timers.add')}
        </Button>
      </div>
      {timers.length === 0 && <Empty icon="clock" title={t('timers.empty')} />}
      {timers.map((tm) => (
        <Card
          key={tm.id}
          title={tm.title || t('timers.untitled')}
          actions={<IconButton icon="trash" label={t('common.delete')} variant="danger" onClick={() => confirm(t('common.confirmDelete')) && saveSettings('timers', timers.filter((x) => x.id !== tm.id))} />}
        >
          <div className="timer-ctl">
            <span className="timer-clock">{formatClock(timerValue(tm, now))}</span>
            <Button variant={tm.running ? 'secondary' : 'primary'} icon={tm.running ? 'pause' : 'play'} onClick={() => void call('timer:control', tm.id, tm.running ? 'pause' : 'start')}>
              {tm.running ? t('timers.pause') : t('timers.start')}
            </Button>
            <Button icon="replay" onClick={() => void call('timer:control', tm.id, 'reset')}>
              {t('timers.reset')}
            </Button>
            {[-60, 60, 300, 600].map((s) => (
              <Button key={s} size="sm" onClick={() => void call('timer:control', tm.id, 'add', s)}>
                {s > 0 ? '+' : '−'}
                {Math.abs(s) / 60} {t('timers.min')}
              </Button>
            ))}
          </div>
          <div className="form">
            <Field label={t('timers.title')}>
              <TextInput value={tm.title} onChange={(title) => update(tm.id, { title })} />
            </Field>
            <Field label={t('timers.mode')}>
              <Select
                value={tm.mode}
                onChange={(mode) => update(tm.id, { mode, running: false, anchorAt: null, pausedMs: mode === 'countdown' ? tm.durationSec * 1000 : 0 })}
                options={[
                  { value: 'countdown', label: t('timers.countdown') },
                  { value: 'stopwatch', label: t('timers.stopwatch') },
                ]}
              />
            </Field>
            {tm.mode === 'countdown' && (
              <Field label={t('timers.duration')} hint={t('timers.durationHint')}>
                <NumberInput
                  value={Math.round(tm.durationSec / 60)}
                  min={1}
                  onChange={(m) =>
                    // An untouched timer shows the new duration right away.
                    update(tm.id, { durationSec: m * 60, ...(!tm.running && tm.pausedMs === tm.durationSec * 1000 ? { pausedMs: m * 60_000 } : {}) })
                  }
                />
              </Field>
            )}
            <Field label={t('common.font')}>
              <TextInput value={tm.fontFamily} onChange={(fontFamily) => update(tm.id, { fontFamily })} />
            </Field>
            <Field label={t('common.fontSize')}>
              <NumberInput value={tm.fontSize} min={12} max={300} onChange={(fontSize) => update(tm.id, { fontSize })} />
            </Field>
            <Field label={t('common.textColor')}>
              <ColorInput value={tm.textColor} onChange={(textColor) => update(tm.id, { textColor })} />
            </Field>
          </div>
          {tm.mode === 'countdown' && (
            <>
              <h4 className="sub-head">{t('timers.subathon')}</h4>
              <p className="muted small">{t('timers.subathonHint')}</p>
              <div className="form">
                {(
                  [
                    ['sub', t('timers.perSub')],
                    ['giftsubPerSub', t('timers.perGift')],
                    ['bitsPer100', t('timers.perBits')],
                    ['donationPerUnit', t('timers.perDonation')],
                    ['follow', t('timers.perFollow')],
                  ] as const
                ).map(([k, label]) => (
                  <Field key={k} label={label}>
                    <NumberInput value={tm.addSec[k]} min={0} onChange={(v) => update(tm.id, { addSec: { ...tm.addSec, [k]: v } })} />
                  </Field>
                ))}
              </div>
            </>
          )}
        </Card>
      ))}
    </>
  );
}
