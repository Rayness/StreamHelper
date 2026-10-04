import { useState } from 'react';
import type { Language } from '@shared/types';
import { Button, Card, Field, NumberInput, PageHeader, Select, TextInput, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { call, saveSettings, useApp } from '../store';

export function Settings() {
  const t = useT();
  const s = useApp((d) => d.settings!);
  const version = useApp((d) => d.version);
  const update = useApp((d) => d.state!.update);
  const [port, setPort] = useState(s.overlayPort);
  return (
    <div className="page">
      <PageHeader title={t('workspace.preferences')} subtitle={`StreamHelper ${version}`} />
      <div className="two-col">
        <Card title={t('settings.general')}>
          <div className="form">
            <Field label={t('settings.language')}>
              <Select<Language>
                value={s.language}
                onChange={(language) => saveSettings('language', language)}
                options={[
                  { value: 'ru', label: 'Русский' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </Field>
            <Field label={t('settings.currency')} hint={t('settings.currencyHint')}>
              <TextInput value={s.currency} onChange={(c) => saveSettings('currency', c.toUpperCase().slice(0, 3))} />
            </Field>
            <Field label={t('settings.tray')} hint={t('settings.trayHint')} wide>
              <Toggle checked={s.minimizeToTray} onChange={(v) => saveSettings('minimizeToTray', v)} />
            </Field>
          </div>
        </Card>
        <Card title={t('settings.overlayServer')}>
          <div className="form">
            <Field label={t('settings.port')} hint={t('settings.portHint')}>
              <NumberInput value={port} min={1024} max={65535} onChange={setPort} />
            </Field>
            <Field label={' '}>
              <Button disabled={port === s.overlayPort} onClick={() => saveSettings('overlayPort', port)}>
                {t('settings.applyPort')}
              </Button>
            </Field>
          </div>
        </Card>
        <Card title={t('updates.title')}>
          <p className="muted small">{t(`updates.${update.status}`)}{update.version ? ` · ${update.version}` : ''}{update.status === 'downloading' ? ` · ${update.progress}%` : ''}</p>
          {update.error && <p className="error small">{update.error}</p>}
          <div className="row-gap wrap">
            <Button disabled={['checking','downloading','ready','unsupported'].includes(update.status)} onClick={() => void call('update:check')}>{t('updates.check')}</Button>
            {update.status === 'ready' && <Button variant="primary" onClick={() => void call('update:install')}>{t('updates.install')}</Button>}
          </div>
          <p className="muted small">{t('updates.source')}</p>
        </Card>
      </div>
    </div>
  );
}
