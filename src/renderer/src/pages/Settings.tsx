import { useState, type ReactNode } from 'react';
import { defaultAppearance } from '@shared/defaults';
import type { AppearanceSettings, Language } from '@shared/types';
import { ACCENTS, saveAppearance, THEMES, useAppearance } from '../appearance';
import { Icon, type IconName } from '../components/icons';
import { Button, Card, Field, NumberInput, PageHeader, Select, TextInput, Toggle } from '../components/ui';
import { useT, type TKey } from '../i18n';
import { call, saveSettings, useApp, useSub } from '../store';

const TABS = ['look', 'general', 'server', 'updates', 'keys'] as const;
type Tab = typeof TABS[number];
const TAB_ICON: Record<Tab, IconName> = { look: 'palette', general: 'settings', server: 'layers', updates: 'refresh', keys: 'keyboard' };

export function Settings() {
  const t = useT();
  const version = useApp((d) => d.version);
  const [tab, setTab] = useSub<Tab>('settings', 'look', TABS);
  return (
    <div className="page">
      <PageHeader title={t('workspace.preferences')} subtitle={`StreamHelper ${version}`} />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('workspace.preferences')}>
          {TABS.map((id) => (
            <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              <Icon name={TAB_ICON[id]} size={16} />
              {t(`settings.tab.${id}`)}
            </button>
          ))}
        </nav>
        <div className="settings-section">
          {tab === 'look' && <Appearance />}
          {tab === 'general' && <General />}
          {tab === 'server' && <Server />}
          {tab === 'updates' && <Updates />}
          {tab === 'keys' && <Shortcuts />}
        </div>
      </div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Caption + control without the <label> wrapper (these controls are groups of buttons). */
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field field-wide">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function Appearance() {
  const t = useT();
  const look = useAppearance();
  const materialSupported = useApp((d) => d.windowMaterial);
  const set = (patch: Partial<AppearanceSettings>) => saveAppearance(look, patch);
  const customAccent = !ACCENTS.includes(look.accent.toLowerCase());
  return (
    <>
      <Card title={t('look.theme')} icon="palette" actions={<Button size="sm" icon="replay" onClick={() => saveSettings('appearance', defaultAppearance())}>{t('look.reset')}</Button>}>
        <p className="muted small">{t('look.hint')}</p>
        <div className="theme-grid" role="radiogroup" aria-label={t('look.theme')}>
          {THEMES.map((theme) => (
            <button key={theme.id} type="button" role="radio" aria-checked={look.theme === theme.id} className={`theme-card ${look.theme === theme.id ? 'active' : ''}`} onClick={() => set({ theme: theme.id })}>
              <span className="theme-sample" style={{ background: theme.bg }} aria-hidden>
                <i style={{ background: theme.side }} />
                <span>
                  <b style={{ background: look.accent, width: '55%' }} />
                  <b style={{ background: theme.panel, border: `1px solid ${theme.line}`, height: 18 }} />
                  <b style={{ background: theme.line, width: '75%' }} />
                </span>
              </span>
              <span className="theme-name">{t(`look.theme.${theme.id}`)}{look.theme === theme.id && <Icon name="check" size={14} />}</span>
            </button>
          ))}
        </div>
        <div className="form" style={{ marginTop: 16 }}>
          <Row label={t('look.accent')}>
            <div className="accent-row" role="radiogroup" aria-label={t('look.accent')}>
              {ACCENTS.map((color) => (
                <button key={color} type="button" role="radio" aria-checked={look.accent.toLowerCase() === color} aria-label={color} title={color} className={`accent-swatch ${look.accent.toLowerCase() === color ? 'active' : ''}`} style={{ background: color }} onClick={() => set({ accent: color })}>
                  {look.accent.toLowerCase() === color && <Icon name="check" size={14} />}
                </button>
              ))}
              <span className={`accent-custom ${customAccent ? 'active' : ''}`} title={t('look.accentCustom')} style={customAccent ? { background: look.accent, borderStyle: 'solid' } : undefined}>
                <Icon name="plus" size={14} />
                <input type="color" aria-label={t('look.accentCustom')} value={look.accent} onChange={(e) => set({ accent: e.target.value })} />
              </span>
            </div>
          </Row>
        </div>
      </Card>

      <Card title={t('look.glass')} icon="sparkle" actions={<Toggle checked={look.glass} onChange={(glass) => set({ glass })} label={look.glass ? t('common.on') : t('common.off')} />}>
        <p className="muted small">{t('look.glassHint')}</p>
        {look.glass && (
          <div className="form">
            <Row label={t('look.glassStrength')}>
              <div className="range-row">
                <input type="range" min={0} max={100} step={5} value={look.glassStrength} aria-label={t('look.glassStrength')} onChange={(e) => set({ glassStrength: Number(e.target.value) })} />
                <output>{look.glassStrength}%</output>
              </div>
            </Row>
            <Row label={t('look.material')} hint={materialSupported ? t('look.materialHint') : t('look.materialUnsupported')}>
              <Segmented
                label={t('look.material')}
                value={materialSupported ? look.windowMaterial : 'none'}
                onChange={(windowMaterial) => set({ windowMaterial })}
                options={(materialSupported ? ['none', 'mica', 'acrylic'] as const : ['none'] as const).map((value) => ({ value, label: t(`look.material.${value}`) }))}
              />
            </Row>
          </div>
        )}
      </Card>

      <Card title={t('look.layout')} icon="layers">
        <div className="form">
          <Row label={t('look.density')}>
            <Segmented label={t('look.density')} value={look.density} onChange={(density) => set({ density })} options={(['comfortable', 'compact'] as const).map((value) => ({ value, label: t(`look.density.${value}`) }))} />
          </Row>
          <Row label={t('look.corners')}>
            <Segmented label={t('look.corners')} value={look.corners} onChange={(corners) => set({ corners })} options={(['sharp', 'normal', 'round'] as const).map((value) => ({ value, label: t(`look.corners.${value}`) }))} />
          </Row>
          <Row label={t('look.scale')}>
            <div className="range-row">
              <input type="range" min={80} max={130} step={5} value={look.scale} aria-label={t('look.scale')} onChange={(e) => set({ scale: Number(e.target.value) })} />
              <output>{look.scale}%</output>
            </div>
          </Row>
          <Row label={t('look.animations')} hint={t('look.animationsHint')}>
            <Toggle checked={look.animations} onChange={(animations) => set({ animations })} label={look.animations ? t('common.on') : t('common.off')} />
          </Row>
        </div>
      </Card>
    </>
  );
}

function General() {
  const t = useT();
  const s = useApp((d) => d.settings!);
  return (
    <Card title={t('settings.general')}>
      <div className="form">
        <Field label={t('settings.language')}>
          <Select<Language> value={s.language} onChange={(language) => saveSettings('language', language)} options={[{ value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }]} />
        </Field>
        <Field label={t('settings.currency')} hint={t('settings.currencyHint')}>
          <TextInput value={s.currency} onChange={(c) => saveSettings('currency', c.toUpperCase().slice(0, 3))} />
        </Field>
        <Field label={t('settings.tray')} hint={t('settings.trayHint')} wide>
          <Toggle checked={s.minimizeToTray} onChange={(v) => saveSettings('minimizeToTray', v)} />
        </Field>
      </div>
    </Card>
  );
}

function Server() {
  const t = useT();
  const current = useApp((d) => d.settings!.overlayPort);
  const [port, setPort] = useState(current);
  return (
    <Card title={t('settings.overlayServer')}>
      <div className="form">
        <Field label={t('settings.port')} hint={t('settings.portHint')}>
          <NumberInput value={port} min={1024} max={65535} onChange={setPort} />
        </Field>
        <Field label={' '}>
          <Button disabled={port === current} onClick={() => saveSettings('overlayPort', port)}>{t('settings.applyPort')}</Button>
        </Field>
      </div>
    </Card>
  );
}

function Updates() {
  const t = useT();
  const update = useApp((d) => d.state!.update);
  return (
    <Card title={t('updates.title')}>
      <p className="muted small">{t(`updates.${update.status}`)}{update.version ? ` · ${update.version}` : ''}{update.status === 'downloading' ? ` · ${update.progress}%` : ''}</p>
      {update.error && <p className="error small">{update.error}</p>}
      <div className="row-gap wrap">
        <Button disabled={['checking', 'downloading', 'ready', 'unsupported'].includes(update.status)} onClick={() => void call('update:check')}>{t('updates.check')}</Button>
        {update.status === 'ready' && <Button variant="primary" onClick={() => void call('update:install')}>{t('updates.install')}</Button>}
      </div>
      <p className="muted small">{t('updates.source')}</p>
    </Card>
  );
}

export const SHORTCUTS: { keys: string; label: TKey }[] = [
  { keys: 'Ctrl K', label: 'keys.palette' },
  { keys: 'Ctrl 1', label: 'keys.workspace' },
  { keys: 'Ctrl 2', label: 'keys.monitor' },
  { keys: 'Ctrl 3', label: 'keys.connections' },
  { keys: 'Ctrl ,', label: 'keys.settings' },
  { keys: 'Ctrl Shift L', label: 'keys.theme' },
  { keys: 'Esc', label: 'keys.close' },
];

function Shortcuts() {
  const t = useT();
  return (
    <Card title={t('settings.tab.keys')} icon="keyboard">
      <p className="muted small">{t('keys.hint')}</p>
      <dl className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.keys}>
            <dt>{s.keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</dt>
            <dd>{t(s.label)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
