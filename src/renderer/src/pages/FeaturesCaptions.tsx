import type { CaptionsSettings } from '@shared/types';
import { OverlayBar, OverlayPreview } from '../components/overlay';
import { Button, Card, ColorInput, CopyField, Empty, Field, NumberInput, Select, StatusDot, Toggle } from '../components/ui';
import { FontPicker } from '../components/FontPicker';
import { useT } from '../i18n';
import { call, saveSettings, useApp } from '../store';

/** Languages Chrome and Edge recognize well; named in their own language. */
const SPOKEN: { value: string; label: string }[] = [
  { value: 'ru-RU', label: 'Русский' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'uk-UA', label: 'Українська' },
  { value: 'be-BY', label: 'Беларуская' },
  { value: 'kk-KZ', label: 'Қазақ тілі' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'es-ES', label: 'Español' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'pl-PL', label: 'Polski' },
  { value: 'tr-TR', label: 'Türkçe' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'zh-CN', label: '中文' },
];

const TARGETS = ['en', 'ru', 'uk', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'tr', 'ja', 'ko', 'zh'];

export function CaptionsModule() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.captions);
  const s = useApp((d) => d.state!.captions);
  const set = (patch: Partial<CaptionsSettings>) => saveSettings('captions', { ...cfg, ...patch });
  const targetName = (code: string) => SPOKEN.find((l) => l.value.startsWith(`${code}-`))?.label.replace(/ \(.*\)$/, '') ?? code;
  return (
    <div className="fun-split">
      <div className="fun-main">
        <Card className="control-card">
          <div className="control-row">
            <div className="control-status">
              <span className="muted small"><StatusDot status={s.listening ? 'connected' : 'disconnected'} /> {s.listening ? t('captions.listening') : t('captions.notListening')}</span>
              <Toggle checked={cfg.enabled} onChange={(enabled) => set({ enabled })} label={t('captions.enabled')} />
            </div>
            <div className="row-gap">
              <Button size="sm" icon="sparkle" onClick={() => void call('captions:test')}>{t('captions.test')}</Button>
              <Button size="sm" icon="trash" disabled={!s.lines.length && !s.interim} onClick={() => void call('captions:clear')}>{t('captions.clear')}</Button>
            </div>
          </div>
          {s.error && <p className="error small">{s.error}</p>}
        </Card>
        <Card title={t('captions.mic')}>
          <p className="muted small">{t('captions.micHint')}</p>
          {s.micUrl && <>
            <CopyField value={s.micUrl} />
            <div className="row-gap"><Button variant="primary" icon="mic" onClick={() => void call('shell:openExternal', s.micUrl)}>{t('captions.open')}</Button></div>
          </>}
          <p className="muted small">{t('captions.privacy')}</p>
        </Card>
        <Card title={t('captions.recognition')}>
          <div className="form">
            <Field label={t('captions.language')}><Select value={cfg.language} onChange={(language) => set({ language })} options={SPOKEN} /></Field>
            <Field label={t('captions.translateTo')} hint={t('captions.translateHint')}>
              <Select value={cfg.translateTo} onChange={(translateTo) => set({ translateTo })} options={[{ value: '', label: t('captions.noTranslation') }, ...TARGETS.filter((c) => !cfg.language.startsWith(`${c}-`)).map((c) => ({ value: c, label: targetName(c) }))]} />
            </Field>
            <Field label={t('overlays.options')} wide>
              <div className="stack">
                <Toggle checked={cfg.translationOnly} disabled={!cfg.translateTo} onChange={(translationOnly) => set({ translationOnly })} label={t('captions.translationOnly')} />
                <Toggle checked={cfg.profanityFilter} onChange={(profanityFilter) => set({ profanityFilter })} label={t('captions.profanity')} />
              </div>
            </Field>
          </div>
        </Card>
        <Card title={t('captions.look')}>
          <div className="form">
            <Field label={t('captions.maxLines')}><NumberInput value={cfg.maxLines} min={1} max={6} onChange={(maxLines) => set({ maxLines })} /></Field>
            <Field label={t('captions.hideAfter')}><NumberInput value={cfg.hideAfterSec} min={1} max={60} onChange={(hideAfterSec) => set({ hideAfterSec })} /></Field>
            <Field label={t('captions.fontSize')}><NumberInput value={cfg.fontSize} min={12} max={120} onChange={(fontSize) => set({ fontSize })} /></Field>
            <Field label={t('common.font')} hint={t('common.fontHint')}><FontPicker value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
            <Field label={t('captions.textColor')}><ColorInput value={cfg.textColor} onChange={(textColor) => set({ textColor })} /></Field>
            <Field label={t('captions.translationColor')}><ColorInput value={cfg.translationColor} onChange={(translationColor) => set({ translationColor })} /></Field>
            <Field label={t('captions.bgColor')}><ColorInput value={cfg.bgColor} onChange={(bgColor) => set({ bgColor })} /></Field>
            <Field label={t('captions.bgOpacity')}><NumberInput value={Math.round(cfg.bgOpacity * 100)} min={0} max={100} step={5} onChange={(v) => set({ bgOpacity: v / 100 })} /></Field>
            <Field label={t('captions.align')}><Select value={cfg.align} onChange={(align) => set({ align })} options={(['center', 'left'] as const).map((v) => ({ value: v, label: t(`captionsAlign.${v}`) }))} /></Field>
          </div>
        </Card>
        <Card title={t('captions.heard')}>
          {!s.lines.length && !s.interim ? <Empty icon="captions" title={t('captions.quiet')} /> : (
            <ul className="portal-log">
              {s.lines.map((l) => <li key={l.id}>{l.text}{l.translation && <span className="muted"> · {l.translation}</span>}</li>)}
              {s.interim && <li className="muted">{s.interim}…</li>}
            </ul>
          )}
        </Card>
      </div>
      <aside className="fun-side">
        <OverlayPreview kind="captions" maxHeight={220} />
        <OverlayBar kind="captions" name={t('ov.captions')} />
      </aside>
    </div>
  );
}
