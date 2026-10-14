import { useState } from 'react';
import type { TtsRoles, TtsSettings, TtsVoiceId } from '@shared/types';
import { TTS_VOICES, voiceAlias } from '@shared/tts';
import { OverlayBar } from '../components/overlay';
import { Button, Card, Empty, Field, IconButton, LinesInput, Select, TextInput, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { call, saveSettings, useApp } from '../store';
import { CommandInput } from './FeaturesFun';

const ROLES: (keyof TtsRoles)[] = ['broadcaster', 'moderator', 'vip', 'subscriber', 'viewer'];

function clockAt(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A labelled range slider; the label shows the current value. */
function Slider({ label, hint, value, min, max, step, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return <Field label={label} hint={hint}><input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} /></Field>;
}

export function TtsModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.tts);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const ru = useApp((d) => d.settings!.language) === 'ru';
  const s = useApp((d) => d.state!.tts);
  const [refreshing, setRefreshing] = useState(false);
  const set = (patch: Partial<TtsSettings>) => saveSettings('tts', { ...cfg, ...patch });
  const toggleVoice = (id: TtsVoiceId, on: boolean) => set({ voices: on ? [...new Set([...cfg.voices, id])] : cfg.voices.filter((v) => v !== id) });
  const systemOptions = (gender: 'female' | 'male', current: string) => [
    { value: '', label: t('tts.autoVoice') },
    ...s.voices.filter((v) => v.gender === gender || v.name === current).map((v) => ({ value: v.name, label: `${v.name} · ${v.lang}` })),
  ];
  const alias = (id: TtsVoiceId) => voiceAlias(id, ru);
  const pick = `${prefix}${cfg.command || 'tts'}`;
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            <div className="control-status">
              <span className="muted small">{s.queue.length ? t('tts.queue', { n: s.queue.length }) : ' '}</span>
              <b>{s.current ? t('tts.speaking', { name: s.current.userName }) : t('tts.idle')}</b>
              {s.current && <span className="muted small">{s.current.text}</span>}
            </div>
            <Toggle checked={cfg.enabled} onChange={(enabled) => set({ enabled })} label={t('tts.enabled')} />
          </div>
          <div className="row-gap wrap">
            <Button size="sm" icon="play" onClick={() => void call('tts:test')}>{t('tts.test')}</Button>
            <Button size="sm" icon="skip" disabled={!s.current} onClick={() => void call('tts:skip')}>{t('tts.skip')}</Button>
            <Button size="sm" icon="trash" disabled={!s.queue.length} onClick={() => void call('tts:clear')}>{t('tts.clear')}</Button>
          </div>
          {s.error && <p className="error small">{s.error}</p>}
          <p className="muted small">{t('tts.obsHint')}</p>
        </Card>
        <Card title={t('tts.who')}>
          <div className="stack">
            {ROLES.map((role) => <Toggle key={role} checked={cfg.roles[role]} onChange={(on) => set({ roles: { ...cfg.roles, [role]: on } })} label={t(`tts.role.${role}`)} />)}
          </div>
          <p className="muted small">{t('tts.whoHint')}</p>
        </Card>
        <Card title={t('tts.trigger')}>
          <div className="form">
            <Field label={t('tts.mode')} hint={t(`ttsModeHint.${cfg.mode}`, { trigger: cfg.trigger || '!!!' })}><Select value={cfg.mode} onChange={(mode) => set({ mode })} options={(['prefix', 'all'] as const).map((v) => ({ value: v, label: t(`ttsMode.${v}`, { trigger: cfg.trigger || '!!!' }) }))} /></Field>
            {cfg.mode === 'prefix' && <Field label={t('tts.triggerField')} hint={t('tts.triggerHint', { example: `${cfg.trigger || '!!!'} ${t('tts.sample')}` })}><TextInput value={cfg.trigger} onChange={(trigger) => set({ trigger: trigger.trim() })} placeholder="!!!" /></Field>}
            <Field label={t('tts.reward')} hint={t('tts.rewardHint')} wide><TextInput value={cfg.rewardTitle} onChange={(rewardTitle) => set({ rewardTitle })} /></Field>
          </div>
        </Card>
        <Card title={t('tts.voices')}>
          <div className="form">
            <Field label={t('tts.command')} hint={t('tts.commandHint', { example: `${pick} ${alias('lich')}`, reset: `${pick} ${ru ? 'сброс' : 'reset'}` })}><CommandInput value={cfg.command} onChange={(command) => set({ command })} /></Field>
            <Field label={t('tts.voice')}><Select value={cfg.voice} onChange={(voice) => set({ voice, voices: [...new Set([...cfg.voices, voice])] })} options={TTS_VOICES.map((v) => ({ value: v.id, label: t(`ttsVoice.${v.id}`) }))} /></Field>
            <Field label={t('tts.voices')} hint={t('tts.voicesHint')} wide>
              <div className="stack">
                {TTS_VOICES.map((v) => (
                  <div key={v.id} className="row-gap">
                    <IconButton icon="play" label={t('tts.test')} onClick={() => void call('tts:test', v.id)} />
                    <Toggle checked={cfg.voices.includes(v.id) || cfg.voice === v.id} disabled={cfg.voice === v.id} onChange={(on) => toggleVoice(v.id, on)} label={<>{t(`ttsVoice.${v.id}`)} <span className="muted small mono">{alias(v.id)}</span></>} />
                  </div>
                ))}
              </div>
            </Field>
            <Field label={t('tts.femaleVoice')}><Select value={cfg.femaleVoice} onChange={(femaleVoice) => set({ femaleVoice })} options={systemOptions('female', cfg.femaleVoice)} /></Field>
            <Field label={t('tts.maleVoice')}><Select value={cfg.maleVoice} onChange={(maleVoice) => set({ maleVoice })} options={systemOptions('male', cfg.maleVoice)} /></Field>
          </div>
          <div className="row-gap wrap">
            <p className="muted small">{t('tts.remembered', { n: s.remembered })}</p>
            <Button size="sm" icon="trash" disabled={!s.remembered} onClick={() => { if (window.confirm(t('tts.forgetConfirm'))) void call('tts:forgetVoices'); }}>{t('tts.forget')}</Button>
          </div>
          <div className="row-gap wrap">
            <p className="muted small">{s.voices.length ? t('tts.systemHint', { n: s.voices.length }) : t('tts.noVoices')}</p>
            <Button size="sm" icon="refresh" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await call('tts:voices'); } finally { setRefreshing(false); } }}>{t('tts.refresh')}</Button>
          </div>
        </Card>
        <Card title={t('tts.sound')}>
          <div className="form">
            <Slider label={t('tts.volume', { n: cfg.volume })} value={cfg.volume} min={0} max={100} step={5} onChange={(volume) => set({ volume })} />
            <Slider label={t('tts.rate', { n: cfg.ratePercent })} value={cfg.ratePercent} min={50} max={200} step={10} onChange={(ratePercent) => set({ ratePercent })} />
            <Slider label={t('tts.maxLength', { n: cfg.maxLength })} value={cfg.maxLength} min={20} max={300} step={10} onChange={(maxLength) => set({ maxLength })} />
            <Slider label={t('tts.cooldown', { n: cfg.cooldownSec })} hint={t('tts.cooldownHint')} value={cfg.cooldownSec} min={0} max={120} step={5} onChange={(cooldownSec) => set({ cooldownSec })} />
            <Slider label={t('tts.queueMax', { n: cfg.queueMax })} value={cfg.queueMax} min={1} max={20} step={1} onChange={(queueMax) => set({ queueMax })} />
          </div>
        </Card>
        <Card title={t('tts.options')}>
          <div className="form">
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.readNames} onChange={(readNames) => set({ readNames })} label={t('tts.readNames')} />
                <Toggle checked={cfg.skipEmotes} onChange={(skipEmotes) => set({ skipEmotes })} label={t('tts.skipEmotes')} />
                <Toggle checked={cfg.skipLinks} onChange={(skipLinks) => set({ skipLinks })} label={t('tts.skipLinks')} />
              </div>
            </Field>
            <Field label={t('tts.filters')} wide>
              <div className="stack">
                <Toggle checked={cfg.profanityFilter} onChange={(profanityFilter) => set({ profanityFilter })} label={t('tts.profanity')} />
                <Toggle checked={cfg.useBotWords} onChange={(useBotWords) => set({ useBotWords })} label={t('tts.botWords')} />
              </div>
            </Field>
            <Field label={t('tts.blocked')} hint={t('tts.blockedHint')} wide><LinesInput value={cfg.blockedWords} onChange={(blockedWords) => set({ blockedWords })} rows={3} /></Field>
          </div>
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayBar kind="tts" name={t('ov.tts')} />
        <Card title={t('tts.recent')}>
          {s.history.length === 0 ? <Empty icon="mic" title={t('tts.none')} /> : (
            <div className="stack">
              {s.history.map((h) => <p key={h.id} className="small"><span className="muted">{clockAt(h.at)} · {t(`ttsVoice.${h.voice}`)}</span> <b>{h.userName}</b>: {h.text}</p>)}
            </div>
          )}
        </Card>
      </aside>
    </div>
  );
}
