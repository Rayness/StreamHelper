import { uid } from '@shared/defaults';
import type { ActionStep, QuickAction } from '@shared/types';
import { HotkeyInput } from '../components/HotkeyInput';
import { Icon } from '../components/icons';
import { Button, Card, ColorInput, Empty, Field, IconButton, NumberInput, PageHeader, Select, StatusText, TextInput, Toggle } from '../components/ui';
import { useT, type TFn } from '../i18n';
import { call, saveSettings, useApp } from '../store';

export function Obs() {
  const t = useT();
  const obs = useApp((d) => d.state!.obs);
  const connected = obs.status === 'connected';
  return (
    <div className="page">
      <PageHeader
        title={t('nav.obs')}
        subtitle={t('obs.subtitle')}
        actions={
          <>
            <StatusText status={obs.status} error={obs.error} />
            {connected ? (
              <Button icon="logout" onClick={() => void call('obs:disconnect')}>
                {t('common.disconnect')}
              </Button>
            ) : (
              <Button variant="primary" icon="plug" onClick={() => void call('obs:connect')}>
                {t('common.connect')}
              </Button>
            )}
          </>
        }
      />
      {!connected ? (
        <Card>
          <Empty icon="video" title={t('obs.notConnected')}>
            {t('obs.notConnectedHint')}
          </Empty>
        </Card>
      ) : (
        <div className="obs-layout">
          <Card
            icon="layers"
            title={t('obs.scenes')}
            actions={
              <>
                <Button size="sm" icon="broadcast" variant={obs.streaming ? 'danger' : 'secondary'} onClick={() => void call('obs:stream', 'toggle')}>
                  {obs.streaming ? t('obs.stopStream') : t('obs.startStream')}
                </Button>
                <Button size="sm" icon="record" variant={obs.recording ? 'danger' : 'secondary'} onClick={() => void call('obs:record', 'toggle')}>
                  {obs.recording ? t('obs.stopRecord') : t('obs.startRecord')}
                </Button>
              </>
            }
          >
            <div className="scene-grid big">
              {obs.scenes.map((s) => (
                <button key={s} type="button" className={`scene-btn ${s === obs.currentScene ? 'active' : ''}`} onClick={() => void call('obs:setScene', s)}>
                  {s}
                </button>
              ))}
            </div>
          </Card>
          <Card icon="eye" title={t('obs.sources', { scene: obs.currentScene })}>
            {obs.sceneItems.length === 0 && <p className="muted">{t('obs.noSources')}</p>}
            <ul className="source-list">
              {obs.sceneItems.map((i) => (
                <li key={i.id} className={i.enabled ? '' : 'off'}>
                  <span>{i.name}</span>
                  <IconButton icon={i.enabled ? 'eye' : 'eyeOff'} label={t('obs.toggleVisibility')} onClick={() => void call('obs:toggleSource', obs.currentScene, i.id)} />
                </li>
              ))}
            </ul>
          </Card>
          <Card icon="mic" title={t('obs.audio')}>
            {obs.inputs.length === 0 && <p className="muted">{t('obs.noAudio')}</p>}
            <ul className="source-list">
              {obs.inputs.map((i) => (
                <li key={i.name} className={i.muted ? 'off' : ''}>
                  <span>{i.name}</span>
                  <IconButton icon={i.muted ? 'micOff' : 'mic'} label={t('obs.toggleMute')} variant={i.muted ? 'danger' : 'ghost'} onClick={() => void call('obs:toggleMute', i.name)} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
      <Actions />
    </div>
  );
}

const STEP_TYPES: ActionStep['type'][] = [
  'obsScene',
  'obsToggleSource',
  'obsToggleMute',
  'obsStream',
  'obsRecord',
  'chat',
  'alertsPause',
  'alertsSkip',
  'counter',
  'timerToggle',
  'timerAdd',
  'goalAdd',
  'wait',
];

function newStep(type: ActionStep['type']): ActionStep {
  switch (type) {
    case 'obsScene':
      return { type, scene: '' };
    case 'obsToggleSource':
      return { type, scene: '', source: '' };
    case 'obsToggleMute':
      return { type, input: '' };
    case 'obsStream':
    case 'obsRecord':
      return { type, mode: 'toggle' };
    case 'chat':
      return { type, text: '' };
    case 'counter':
      return { type, name: '', delta: 1 };
    case 'timerToggle':
      return { type, timerId: '' };
    case 'timerAdd':
      return { type, timerId: '', seconds: 60 };
    case 'goalAdd':
      return { type, goalId: '', amount: 1 };
    case 'wait':
      return { type, ms: 1000 };
    default:
      return { type } as ActionStep;
  }
}

function StepEditor({ step, onChange, t }: { step: ActionStep; onChange: (s: ActionStep) => void; t: TFn }) {
  const obs = useApp((d) => d.state!.obs);
  const timers = useApp((d) => d.settings!.timers);
  const goals = useApp((d) => d.settings!.goals);
  const counters = useApp((d) => d.settings!.bot.counters);
  const withCurrent = (list: string[], v: string) => (v && !list.includes(v) ? [v, ...list] : list);
  const opts = (list: string[], v: string, placeholder: string) => [{ value: '', label: placeholder }, ...withCurrent(list, v).map((x) => ({ value: x, label: x }))];
  const modes = (['toggle', 'start', 'stop'] as const).map((m) => ({ value: m, label: t(`stepMode.${m}`) }));

  switch (step.type) {
    case 'obsScene':
      return <Select value={step.scene} onChange={(scene) => onChange({ ...step, scene })} options={opts(obs.scenes, step.scene, t('step.pickScene'))} />;
    case 'obsToggleSource':
      return (
        <>
          <Select value={step.scene} onChange={(scene) => onChange({ ...step, scene })} options={[{ value: '', label: t('step.currentScene') }, ...withCurrent(obs.scenes, step.scene).map((x) => ({ value: x, label: x }))]} />
          <TextInput value={step.source} onChange={(source) => onChange({ ...step, source })} placeholder={t('step.sourceName')} />
        </>
      );
    case 'obsToggleMute':
      return <Select value={step.input} onChange={(input) => onChange({ ...step, input })} options={opts(obs.inputs.map((i) => i.name), step.input, t('step.pickInput'))} />;
    case 'obsStream':
    case 'obsRecord':
      return <Select value={step.mode} onChange={(mode) => onChange({ ...step, mode })} options={modes} />;
    case 'chat':
      return <TextInput value={step.text} onChange={(text) => onChange({ ...step, text })} placeholder={t('step.chatText')} />;
    case 'counter':
      return (
        <>
          <Select value={step.name} onChange={(name) => onChange({ ...step, name })} options={opts(Object.keys(counters), step.name, t('step.pickCounter'))} />
          <NumberInput value={step.delta} onChange={(delta) => onChange({ ...step, delta })} />
        </>
      );
    case 'timerToggle':
    case 'timerAdd':
      return (
        <>
          <Select
            value={step.timerId}
            onChange={(timerId) => onChange({ ...step, timerId })}
            options={[{ value: '', label: t('step.pickTimer') }, ...timers.map((x) => ({ value: x.id, label: x.title }))]}
          />
          {step.type === 'timerAdd' && <NumberInput value={step.seconds} onChange={(seconds) => onChange({ ...step, seconds })} />}
        </>
      );
    case 'goalAdd':
      return (
        <>
          <Select value={step.goalId} onChange={(goalId) => onChange({ ...step, goalId })} options={[{ value: '', label: t('step.pickGoal') }, ...goals.map((g) => ({ value: g.id, label: g.title }))]} />
          <NumberInput value={step.amount} onChange={(amount) => onChange({ ...step, amount })} />
        </>
      );
    case 'wait':
      return <NumberInput value={step.ms} min={0} max={60000} step={100} onChange={(ms) => onChange({ ...step, ms })} />;
    default:
      return null;
  }
}

function Actions() {
  const t = useT();
  const actions = useApp((d) => d.settings!.actions);
  const update = (id: string, patch: Partial<QuickAction>) => saveSettings('actions', actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  return (
    <>
      <PageHeader
        title={t('actions.title')}
        subtitle={t('actions.subtitle')}
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => saveSettings('actions', [...actions, { id: uid('act_'), label: t('actions.newLabel'), color: '#9b6bff', hotkey: '', showOnDashboard: true, steps: [] }])}
          >
            {t('actions.add')}
          </Button>
        }
      />
      {actions.length === 0 && <Empty icon="keyboard" title={t('actions.empty')} />}
      <div className="two-col">
        {actions.map((a) => (
          <Card
            key={a.id}
            actions={
              <>
                <Button size="sm" icon="play" onClick={() => void call('actions:run', a.id)}>
                  {t('actions.run')}
                </Button>
                <IconButton icon="trash" label={t('common.delete')} variant="danger" onClick={() => confirm(t('common.confirmDelete')) && saveSettings('actions', actions.filter((x) => x.id !== a.id))} />
              </>
            }
            title={
              <span className="action-title">
                <span className="swatch" style={{ background: a.color }} />
                {a.label}
              </span>
            }
          >
            <div className="form compact">
              <Field label={t('actions.label')}>
                <TextInput value={a.label} onChange={(label) => update(a.id, { label })} />
              </Field>
              <Field label={t('actions.color')}>
                <ColorInput value={a.color} onChange={(color) => update(a.id, { color })} />
              </Field>
              <Field label={t('actions.hotkey')} hint={t('actions.hotkeyHint')}>
                <HotkeyInput value={a.hotkey} onChange={(hotkey) => update(a.id, { hotkey })} />
              </Field>
              <Field label={t('actions.onDashboard')}>
                <Toggle checked={a.showOnDashboard} onChange={(showOnDashboard) => update(a.id, { showOnDashboard })} />
              </Field>
            </div>
            <h4 className="sub-head">{t('actions.steps')}</h4>
            <ol className="steps">
              {a.steps.map((s, i) => (
                <li key={i}>
                  <span className="step-num">{i + 1}</span>
                  <Select<ActionStep['type']>
                    value={s.type}
                    onChange={(type) => update(a.id, { steps: a.steps.map((x, j) => (j === i ? newStep(type) : x)) })}
                    options={STEP_TYPES.map((st) => ({ value: st, label: t(`stepType.${st}`) }))}
                  />
                  <StepEditor step={s} t={t} onChange={(ns) => update(a.id, { steps: a.steps.map((x, j) => (j === i ? ns : x)) })} />
                  <IconButton icon="x" label={t('common.delete')} onClick={() => update(a.id, { steps: a.steps.filter((_, j) => j !== i) })} />
                </li>
              ))}
            </ol>
            <Button size="sm" icon="plus" onClick={() => update(a.id, { steps: [...a.steps, newStep('obsScene')] })}>
              {t('actions.addStep')}
            </Button>
          </Card>
        ))}
      </div>
      <p className="muted small hint-line">
        <Icon name="keyboard" size={14} /> {t('actions.globalHint')}
      </p>
    </>
  );
}
