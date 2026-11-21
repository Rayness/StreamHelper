import { useState } from 'react';
import type { TtsRoles, TtsSettings, TtsVoiceId } from '@shared/types';
import { TTS_VOICES, voiceAlias } from '@shared/tts';
import { OverlayBar } from '../components/overlay';
import { Button, Card, Empty, Field, IconButton, LinesInput, Select, SettingList, SettingRow, Tabs, TextInput, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { askConfirm, call, saveSettings, useApp } from '../store';
import { CommandInput } from './FeaturesFun';

const ROLES: (keyof TtsRoles)[] = ['broadcaster', 'moderator', 'vip', 'subscriber', 'viewer'];

function clockAt(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Slider({ label, hint, value, min, max, step, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return <Field label={label} hint={hint}><input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} /></Field>;
}

export function TtsModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.tts);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const ru = useApp((d) => d.settings!.language) === 'ru';
  const s = useApp((d) => d.state!.tts);
  const [tab, setTab] = useState<'main' | 'sound' | 'queue'>('main');
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
    <div className="module-tabbed">
      <OverlayBar kind="tts" name={t('ov.tts')} />

      <Card className="control-card">
        <div className="control-row">
          <div className="control-status">
            <span className="muted small">{s.queue.length ? t('tts.queue', { n: s.queue.length }) : t('tts.obsHint')}</span>
            <b>{s.current ? t('tts.speaking', { name: s.current.userName }) : t('tts.idle')}</b>
            {s.current && <span className="muted small">{s.current.text}</span>}
          </div>
          <div className="row-gap wrap">
            <Button size="sm" icon="play" onClick={() => void call('tts:test')}>{t('tts.test')}</Button>
            <Button size="sm" icon="skip" disabled={!s.current} onClick={() => void call('tts:skip')}>{t('tts.skip')}</Button>
            <Button size="sm" icon="trash" disabled={!s.queue.length} onClick={() => void call('tts:clear')}>{t('tts.clear')}</Button>
            <Toggle checked={cfg.enabled} onChange={(enabled) => set({ enabled })} label={t('tts.enabled')} />
          </div>
        </div>
        {s.error && <p className="error small">{s.error}</p>}
      </Card>

      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'main', label: t('tts.tab.main') },
        { id: 'sound', label: t('tts.tab.sound') },
        { id: 'queue', label: s.history.length ? `${t('tts.tab.queue')} (${s.history.length})` : t('tts.tab.queue') },
      ]} />

      {tab === 'main' && (
        <div className="module-flow-wide">
          <div className="two-col">
            <Card title={t('tts.trigger')} icon="zap">
              <div className="form">
                <Field label={t('tts.mode')} hint={t(`ttsModeHint.${cfg.mode}`, { trigger: cfg.trigger || '!!!' })} wide>
                  <Select value={cfg.mode} onChange={(mode) => set({ mode })} options={(['prefix', 'all'] as const).map((v) => ({ value: v, label: t(`ttsMode.${v}`, { trigger: cfg.trigger || '!!!' }) }))} />
                </Field>
                {cfg.mode === 'prefix' && (
                  <Field label={t('tts.triggerField')} hint={t('tts.triggerHint', { example: `${cfg.trigger || '!!!'} ${t('tts.sample')}` })} wide>
                    <TextInput value={cfg.trigger} onChange={(trigger) => set({ trigger: trigger.trim() })} placeholder="!!!" />
                  </Field>
                )}
                <Field label={t('tts.reward')} hint={t('tts.rewardHint')} wide>
                  <TextInput value={cfg.rewardTitle} onChange={(rewardTitle) => set({ rewardTitle })} />
                </Field>
              </div>
              <div style={{ marginTop: 14 }}>
                <span className="field-label">{t('tts.who')}</span>
                <p className="muted small" style={{ marginTop: 4 }}>{t('tts.whoHint')}</p>
                <SettingList>
                  {ROLES.map((role) => (
                    <SettingRow key={role} label={t(`tts.role.${role}`)}>
                      <Toggle checked={cfg.roles[role]} onChange={(on) => set({ roles: { ...cfg.roles, [role]: on } })} />
                    </SettingRow>
                  ))}
                </SettingList>
              </div>
            </Card>

            <Card title={t('tts.voices')} icon="mic">
              <div className="form">
                <Field label={t('tts.voice')}>
                  <Select value={cfg.voice} onChange={(voice) => set({ voice, voices: [...new Set([...cfg.voices, voice])] })} options={TTS_VOICES.map((v) => ({ value: v.id, label: t(`ttsVoice.${v.id}`) }))} />
                </Field>
                <Field label={t('tts.command')} hint={t('tts.commandHint', { example: `${pick} ${alias('lich')}`, reset: `${pick} ${ru ? 'сброс' : 'reset'}` })}>
                  <CommandInput value={cfg.command} onChange={(command) => set({ command })} />
                </Field>
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
              <div className="row-gap wrap" style={{ marginTop: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>{t('tts.remembered', { n: s.remembered })}</p>
                <Button size="sm" icon="trash" disabled={!s.remembered} onClick={() => void askConfirm({ message: t('tts.forgetConfirm'), danger: true }).then((ok) => ok && void call('tts:forgetVoices'))}>{t('tts.forget')}</Button>
              </div>
              <div className="row-gap wrap" style={{ marginTop: 8 }}>
                <p className="muted small" style={{ margin: 0 }}>{s.voices.length ? t('tts.systemHint', { n: s.voices.length }) : t('tts.noVoices')}</p>
                <Button size="sm" icon="refresh" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await call('tts:voices'); } finally { setRefreshing(false); } }}>{t('tts.refresh')}</Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === 'sound' && (
        <div className="module-flow">
          <Card title={t('tts.sound')} icon="volume">
            <div className="form">
              <Slider label={t('tts.volume', { n: cfg.volume })} value={cfg.volume} min={0} max={100} step={5} onChange={(volume) => set({ volume })} />
              <Slider label={t('tts.rate', { n: cfg.ratePercent })} value={cfg.ratePercent} min={50} max={200} step={10} onChange={(ratePercent) => set({ ratePercent })} />
              <Slider label={t('tts.maxLength', { n: cfg.maxLength })} value={cfg.maxLength} min={20} max={300} step={10} onChange={(maxLength) => set({ maxLength })} />
              <Slider label={t('tts.cooldown', { n: cfg.cooldownSec })} hint={t('tts.cooldownHint')} value={cfg.cooldownSec} min={0} max={120} step={5} onChange={(cooldownSec) => set({ cooldownSec })} />
              <Slider label={t('tts.queueMax', { n: cfg.queueMax })} value={cfg.queueMax} min={1} max={20} step={1} onChange={(queueMax) => set({ queueMax })} />
            </div>
          </Card>

          <Card title={t('tts.options')} icon="shield">
            <SettingList>
              <SettingRow label={t('tts.readNames')}><Toggle checked={cfg.readNames} onChange={(readNames) => set({ readNames })} /></SettingRow>
              <SettingRow label={t('tts.skipEmotes')}><Toggle checked={cfg.skipEmotes} onChange={(skipEmotes) => set({ skipEmotes })} /></SettingRow>
              <SettingRow label={t('tts.skipLinks')}><Toggle checked={cfg.skipLinks} onChange={(skipLinks) => set({ skipLinks })} /></SettingRow>
              <SettingRow label={t('tts.profanity')}><Toggle checked={cfg.profanityFilter} onChange={(profanityFilter) => set({ profanityFilter })} /></SettingRow>
              <SettingRow label={t('tts.botWords')}><Toggle checked={cfg.useBotWords} onChange={(useBotWords) => set({ useBotWords })} /></SettingRow>
            </SettingList>
            <div className="form" style={{ marginTop: 14 }}>
              <Field label={t('tts.blocked')} hint={t('tts.blockedHint')} wide>
                <LinesInput value={cfg.blockedWords} onChange={(blockedWords) => set({ blockedWords })} rows={3} />
              </Field>
            </div>
          </Card>
        </div>
      )}

      {tab === 'queue' && (
        <div className="module-flow">
          <Card title={t('tts.recent')} icon="clock">
            {s.history.length === 0 ? <Empty icon="mic" title={t('tts.none')} /> : (
              <div className="stack">
                {s.history.map((h) => <p key={h.id} className="small"><span className="muted">{clockAt(h.at)} · {t(`ttsVoice.${h.voice}`)}</span> <b>{h.userName}</b>: {h.text}</p>)}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
