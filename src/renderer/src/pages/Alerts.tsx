import { useState } from 'react';
import { ALERT_TYPES, type AlertAnimation, type AlertType, type AlertVariant } from '@shared/types';
import { uid } from '@shared/defaults';
import { EVENT_ICON } from '../components/EventFeed';
import { Icon } from '../components/icons';
import { MediaPicker } from '../components/MediaPicker';
import { Button, Card, ColorInput, CopyField, Field, IconButton, NumberInput, PageHeader, Select, TextInput, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { call, saveSettings, useApp, useSub } from '../store';

const VARS: Record<AlertType, string> = {
  follow: '{user}',
  sub: '{user} {tier}',
  resub: '{user} {months} {streak} {tier} {message}',
  giftsub: '{user} {count} {total} {tier}',
  cheer: '{user} {amount} {message}',
  raid: '{user} {amount}',
  donation: '{user} {amount} {currency} {message}',
  redemption: '{user} {reward} {cost} {message}',
};

export function Alerts() {
  const t = useT();
  const alerts = useApp((d) => d.settings!.alerts);
  const overlayUrl = useApp((d) => d.state!.overlayUrl);
  const [selected, setSelected] = useSub<AlertType>('alerts', 'follow', ALERT_TYPES);
  const [tierId, setTierId] = useState<string>('');
  const [previewKey, setPreviewKey] = useState(0);
  const tier = selected === 'donation' ? alerts.donationTiers?.find((item) => item.id === tierId) : undefined;
  const v = tier?.variant ?? alerts.types[selected];
  const style = tier?.style ?? alerts.style;

  const setVariant = (patch: Partial<AlertVariant>) => saveSettings('alerts', tier
    ? { ...alerts, donationTiers: alerts.donationTiers.map((item) => item.id === tier.id ? { ...item, variant: { ...v, ...patch } } : item) }
    : { ...alerts, types: { ...alerts.types, [selected]: { ...v, ...patch } } });
  const setStyle = (patch: Partial<typeof alerts.style>) => saveSettings('alerts', tier
    ? { ...alerts, donationTiers: alerts.donationTiers.map((item) => item.id === tier.id ? { ...item, style: { ...style, ...patch } } : item) }
    : { ...alerts, style: { ...alerts.style, ...patch } });

  const minLabel: Partial<Record<AlertType, string>> = {
    resub: t('alerts.minMonths'),
    giftsub: t('alerts.minGifts'),
    cheer: t('alerts.minBits'),
    raid: t('alerts.minViewers'),
    donation: t('alerts.minDonation'),
    redemption: t('alerts.minCost'),
  };

  return (
    <div className="page">
      <PageHeader title={t('nav.alerts')} subtitle={t('alerts.subtitle')} />
      <div className="alerts-layout">
        <Card className="alert-types">
          <ul className="type-list">
            {ALERT_TYPES.map((type) => (
              <li key={type} className={type === selected ? 'active' : ''}>
                <button type="button" className="type-main" onClick={() => setSelected(type)}>
                  <Icon name={EVENT_ICON[type]} size={16} />
                  <span>{t(`alertType.${type}`)}</span>
                </button>
                <Toggle
                  checked={alerts.types[type].enabled}
                  onChange={(enabled) => saveSettings('alerts', { ...alerts, types: { ...alerts.types, [type]: { ...alerts.types[type], enabled } } })}
                />
              </li>
            ))}
          </ul>
        </Card>

        <div className="alert-editor">
          <Card
            title={t(`alertType.${selected}`)}
            actions={
              <Button size="sm" variant="primary" icon="play" onClick={() => void call('alerts:test', selected, tier ? tier.minAmount : undefined)}>
                {t('alerts.test')}
              </Button>
            }
          >
            {selected === 'donation' && <div className="stack" style={{ marginBottom: 16 }}>
              <p className="muted small">{t('alerts.tiersHint')}</p>
              <div className="row-gap wrap">
                <Button size="sm" variant={!tier ? 'primary' : 'secondary'} onClick={() => setTierId('')}>{t('alerts.defaultTier')}</Button>
                {(alerts.donationTiers ?? []).slice().sort((a, b) => a.minAmount - b.minAmount).map((item) =>
                  <Button key={item.id} size="sm" variant={tierId === item.id ? 'primary' : 'secondary'} onClick={() => setTierId(item.id)}>≥ {item.minAmount}</Button>)}
                <Button size="sm" icon="plus" onClick={() => { const id = uid('donation_tier_'); saveSettings('alerts', { ...alerts, donationTiers: [...(alerts.donationTiers ?? []), { id, minAmount: 1000, variant: { ...alerts.types.donation, minAmount: 0 }, style: { ...alerts.style } }] }); setTierId(id); }}>{t('alerts.addTier')}</Button>
              </div>
              {tier && <div className="row-gap">
                <Field label={t('alerts.tierFrom')}><NumberInput value={tier.minAmount} min={0} onChange={(minAmount) => saveSettings('alerts', { ...alerts, donationTiers: alerts.donationTiers.map((item) => item.id === tier.id ? { ...item, minAmount } : item) })} /></Field>
                <Toggle checked={v.enabled} onChange={(enabled) => setVariant({ enabled })} label={t('common.on')} />
                <IconButton icon="x" label={t('common.delete')} onClick={() => { saveSettings('alerts', { ...alerts, donationTiers: alerts.donationTiers.filter((item) => item.id !== tier.id) }); setTierId(''); }} />
              </div>}
            </div>}
            <div className="form">
              <Field label={t('alerts.titleTpl')} hint={`${t('alerts.vars')}: ${VARS[selected]}`} wide>
                <TextInput value={v.title} onChange={(title) => setVariant({ title })} />
              </Field>
              <Field label={t('alerts.messageTpl')} wide>
                <TextInput value={v.message} onChange={(message) => setVariant({ message })} />
              </Field>
              <Field label={t('alerts.duration')}>
                <NumberInput value={v.durationSec} min={1} max={120} onChange={(durationSec) => setVariant({ durationSec })} />
              </Field>
              {minLabel[selected] && !tier && (
                <Field label={minLabel[selected]} hint={t('alerts.minHint')}>
                  <NumberInput value={v.minAmount} min={0} onChange={(minAmount) => setVariant({ minAmount })} />
                </Field>
              )}
              <Field label={t('alerts.animation')}>
                <Select<AlertAnimation>
                  value={v.animation}
                  onChange={(animation) => setVariant({ animation })}
                  options={(['fade', 'slide', 'zoom', 'bounce'] as const).map((a) => ({ value: a, label: t(`anim.${a}`) }))}
                />
              </Field>
              <Field label={t('alerts.volume')}>
                <input type="range" min={0} max={1} step={0.05} value={v.volume} onChange={(e) => setVariant({ volume: Number(e.target.value) })} />
              </Field>
              <Field label={t('alerts.sound')} wide>
                <MediaPicker kind="audio" value={v.sound} onChange={(sound) => setVariant({ sound })} />
              </Field>
              <Field label={t('alerts.image')} hint={t('alerts.imageHint')} wide>
                <MediaPicker kind="visual" value={v.image} onChange={(image) => setVariant({ image })} />
              </Field>
              <Field label={t('alerts.tts')} hint={t('alerts.ttsHint')} wide>
                <Toggle checked={v.tts} onChange={(tts) => setVariant({ tts })} />
              </Field>
            </div>
          </Card>

          <Card title={tier ? `${t('alerts.style')} · ≥ ${tier.minAmount}` : t('alerts.style')}>
            <div className="form">
              <Field label={t('common.font')} hint={t('common.fontHint')}>
                <TextInput value={style.fontFamily} onChange={(fontFamily) => setStyle({ fontFamily })} />
              </Field>
              <Field label={t('common.fontSize')}>
                <NumberInput value={style.fontSize} min={12} max={160} onChange={(fontSize) => setStyle({ fontSize })} />
              </Field>
              <Field label={t('common.textColor')}>
                <ColorInput value={style.textColor} onChange={(textColor) => setStyle({ textColor })} />
              </Field>
              <Field label={t('alerts.accent')}>
                <ColorInput value={style.accentColor} onChange={(accentColor) => setStyle({ accentColor })} />
              </Field>
              <Field label={t('alerts.layout')}>
                <Select
                  value={style.layout}
                  onChange={(layout) => setStyle({ layout })}
                  options={[
                    { value: 'stacked', label: t('alerts.layoutStacked') },
                    { value: 'side', label: t('alerts.layoutSide') },
                  ]}
                />
              </Field>
              <Field label={t('alerts.gap')}>
                <NumberInput value={alerts.gapSec} min={0} max={30} onChange={(gapSec) => saveSettings('alerts', { ...alerts, gapSec })} />
              </Field>
            </div>
          </Card>
          <Card title={t('alerts.position')}>
            <div className="form">
              <Field label={t('alerts.anchor')}>
                <Select value={style.anchor} onChange={(anchor) => setStyle({ anchor })} options={(['center', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const).map((anchor) => ({ value: anchor, label: t(`alerts.anchor_${anchor}`) }))} />
              </Field>
              <Field label={t('alerts.width')}><NumberInput value={style.width} min={10} max={100} onChange={(width) => setStyle({ width })} /></Field>
              <Field label={t('alerts.x')}><NumberInput value={style.x} min={0} max={100} onChange={(x) => setStyle({ x })} /></Field>
              <Field label={t('alerts.y')}><NumberInput value={style.y} min={0} max={100} onChange={(y) => setStyle({ y })} /></Field>
            </div>
          </Card>
        </div>

        <div className="alert-preview-col">
          <Card
            title={t('alerts.preview')}
            actions={<Button size="sm" icon="replay" onClick={() => setPreviewKey((k) => k + 1)}>{t('common.reload')}</Button>}
          >
            {overlayUrl ? (
              <>
                <div className="preview-frame checker">
                  <iframe key={previewKey} src={`${overlayUrl}/overlay/alerts`} title="alerts preview" />
                </div>
                <p className="muted small">{t('alerts.previewHint')}</p>
                <CopyField value={`${overlayUrl}/overlay/alerts`} />
              </>
            ) : (
              <p className="muted">{t('overlays.serverDown')}</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
