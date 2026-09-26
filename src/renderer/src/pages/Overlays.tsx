import { useState, type ReactNode } from 'react';
import { defaultAd, defaultBanner, defaultGoal, defaultLabel, defaultTimer, uid } from '@shared/defaults';
import { timerValue } from '@shared/timer';
import { formatClock } from '@shared/template';
import type { AdCampaign, AdEntrance, AlertType, Banner, BannerLayout, ChatBackgroundStyle, ChatEnterAnimation, ChatExitAnimation, EmoteRainStyle, Goal, GoalKind, Label, OverlayKind, OverlayTimer } from '@shared/types';
import { Icon } from '../components/icons';
import { MediaPicker } from '../components/MediaPicker';
import { InstancePicker, OverlayBar, OverlayPreview, pickInstance } from '../components/overlay';
import { Button, Card, ColorInput, Field, IconButton, LinesInput, NumberInput, PageHeader, Select, TextInput, Toggle } from '../components/ui';
import { useNow } from '../hooks';
import { useT, type TKey } from '../i18n';
import { OVERLAYS, type OverlayGroup } from '../overlayCatalog';
import { call, navigate, saveSettings, useApp, useSub } from '../store';

const KINDS = OVERLAYS.map((o) => o.kind);
const GROUPS: OverlayGroup[] = ['main', 'screen', 'fun'];

export function Overlays() {
  const t = useT();
  const [kind, setKind] = useSub<OverlayKind>('overlays', 'alerts', KINDS);
  const url = useApp((d) => d.state!.overlayUrl);
  const clients = useApp((d) => d.state!.overlayClients);
  const perKind = useApp((d) => d.state!.overlayKinds);
  const def = OVERLAYS.find((o) => o.kind === kind)!;
  return (
    <div className="page page-wide">
      <PageHeader
        title={t('nav.overlays')}
        subtitle={t('overlays.subtitle')}
        actions={<span className={`ov-state ${clients ? 'on' : ''}`}><span className="ov-state-dot" />{t('overlays.clients', { n: clients })}</span>}
      />
      {!url ? (
        <Card>
          <p className="error">{t('overlays.serverDown')}</p>
          <p className="muted small">{t('overlays.serverDownHint')}</p>
        </Card>
      ) : (
        <div className="ov-layout">
          <nav className="ov-list" aria-label={t('nav.overlays')}>
            {GROUPS.map((g) => (
              <div key={g} className="ov-group">
                <span className="ov-group-title">{t(`ovGroup.${g}`)}</span>
                {OVERLAYS.filter((o) => o.group === g).map((o) => (
                  <button key={o.kind} type="button" className={`ov-item ${o.kind === kind ? 'active' : ''}`} onClick={() => setKind(o.kind)}>
                    <Icon name={o.icon} size={17} />
                    <span>{t(`ov.${o.kind}`)}</span>
                    {(perKind[o.kind] ?? 0) > 0 && <span className="ov-live" title={t('overlays.inObs', { n: perKind[o.kind] ?? 0 })} />}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <section className="ov-detail" key={kind}>
            <header className="ov-head">
              <span className="ov-head-icon">
                <Icon name={def.icon} size={20} />
              </span>
              <div>
                <h2>{t(`ov.${kind}`)}</h2>
                <p className="muted">{t(`ovDesc.${kind}`)}</p>
              </div>
            </header>
            <OverlayDetail kind={kind} />
          </section>
        </div>
      )}
    </div>
  );
}

/** Settings on the left, the live preview on the right. */
function Split({ settings, preview, stacked }: { settings: ReactNode; preview: ReactNode; stacked?: boolean }) {
  return (
    <div className={`ov-split ${stacked ? 'stacked' : ''}`}>
      <div className="ov-settings">{settings}</div>
      <div className="ov-side">{preview}</div>
    </div>
  );
}

function OverlayDetail({ kind }: { kind: OverlayKind }) {
  const t = useT();
  switch (kind) {
    case 'alerts':
      return <AlertsDetail />;
    case 'chat':
      return <ChatDetail />;
    case 'events':
      return (
        <>
          <OverlayBar kind="events" name={t('ov.events')} />
          <Split
            settings={
              <Card>
                <p className="muted small">{t('overlays.eventsHint')}</p>
              </Card>
            }
            preview={<OverlayPreview kind="events" children={<TestAlertButtons types={['follow', 'sub', 'donation']} />} />}
          />
        </>
      );
    case 'banner':
      return <BannersDetail />;
    case 'ad':
      return <AdsDetail />;
    case 'live':
      return <SimpleDetail kind="live" />;
    case 'spotlight':
      return <SimpleDetail kind="spotlight" />;
    case 'label':
      return <LabelsDetail />;
    case 'goal':
      return <GoalsDetail />;
    case 'timer':
      return <TimersDetail />;
    case 'kawaki':
      return <KawakiDetail />;
    case 'emotes':
      return <EmotesDetail />;
    case 'wheel':
    case 'poll':
    case 'giveaway':
    case 'quiz':
    case 'boss':
      return <InteractiveDetail kind={kind} />;
  }
}

function SimpleDetail({ kind }: { kind: 'live' | 'spotlight' }) {
  const t = useT();
  const spotlight = useApp((d) => d.state!.spotlight);
  return <>
    <OverlayBar kind={kind} name={t(`ov.${kind}`)} />
    <Split settings={<Card><p className="muted">{t(`simple.${kind}`)}</p>{kind === 'spotlight' && spotlight && <Button onClick={() => void call('spotlight:clear')}>{t('spotlight.clear')}</Button>}</Card>} preview={<OverlayPreview kind={kind} />} />
  </>;
}

function TestAlertButtons({ types }: { types: AlertType[] }) {
  const t = useT();
  return (
    <>
      {types.map((ty) => (
        <Button key={ty} size="sm" icon="play" onClick={() => void call('alerts:test', ty)}>
          {t(`alertType.${ty}`)}
        </Button>
      ))}
    </>
  );
}

function AlertsDetail() {
  const t = useT();
  return (
    <>
      <OverlayBar kind="alerts" name={t('ov.alerts')} />
      <Split
        settings={
          <Card>
            <p className="muted">{t('overlays.alertsManage')}</p>
            <Button icon="chevron" onClick={() => navigate('alerts')}>
              {t('overlays.openAlerts')}
            </Button>
          </Card>
        }
        preview={<OverlayPreview kind="alerts" children={<TestAlertButtons types={['follow', 'sub', 'donation', 'raid']} />} />}
      />
    </>
  );
}

function ChatDetail() {
  const t = useT();
  const c = useApp((d) => d.settings!.chatOverlay);
  const set = (patch: Partial<typeof c>) => saveSettings('chatOverlay', { ...c, ...patch });
  return (
    <>
      <OverlayBar kind="chat" name={t('ov.chat')} />
      <Split
        settings={<>
          <Card title={t('chatSettings.appearance')}>
            <div className="form">
              <Field label={t('common.font')} hint={t('common.fontHint')}><TextInput value={c.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
              <Field label={t('common.fontSize')}><NumberInput value={c.fontSize} min={10} max={72} onChange={(fontSize) => set({ fontSize })} /></Field>
              <Field label={t('common.textColor')}><ColorInput value={c.textColor} onChange={(textColor) => set({ textColor })} /></Field>
              <Field label={t('common.accent')}><ColorInput value={c.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
              <Field label={t('chatSettings.nameColor')}>
                <Select value={c.nameColor} onChange={(nameColor) => set({ nameColor })} options={(['user', 'accent', 'text'] as const).map((x) => ({ value: x, label: t(`chatSettings.name_${x}`) }))} />
              </Field>
              <Field label={t('chatSettings.backgroundStyle')}>
                <Select<ChatBackgroundStyle> value={c.backgroundStyle} onChange={(backgroundStyle) => set({ backgroundStyle })} options={(['card', 'glass', 'gradient', 'outline', 'none'] as const).map((x) => ({ value: x, label: t(`chatSettings.bg_${x}`) }))} />
              </Field>
              <Field label={t('overlays.chatBg')} hint={t('overlays.chatBgHint')}><TextInput value={c.background} onChange={(background) => set({ background })} mono /></Field>
              <Field label={t('chatSettings.backgroundMedia')} hint={t('chatSettings.backgroundMediaHint')} wide><MediaPicker kind="image" value={c.backgroundMedia} onChange={(backgroundMedia) => set({ backgroundMedia })} /></Field>
              {c.backgroundMedia && <Field label={t('chatSettings.mediaOpacity')}><NumberInput value={c.backgroundMediaOpacity} min={0} max={100} step={5} onChange={(backgroundMediaOpacity) => set({ backgroundMediaOpacity })} /></Field>}
              <Field label={t('chatSettings.shadow')}><Toggle checked={c.shadow} onChange={(shadow) => set({ shadow })} /></Field>
              <Field label={t('chatSettings.radius')}><NumberInput value={c.borderRadius} min={0} max={48} onChange={(borderRadius) => set({ borderRadius })} /></Field>
            </div>
          </Card>
          <Card title={t('chatSettings.animation')}>
            <div className="form">
              <Field label={t('chatSettings.enter')}>
                <Select<ChatEnterAnimation> value={c.enterAnimation} onChange={(enterAnimation) => set({ enterAnimation })} options={(['none', 'fade', 'slideUp', 'slideSide', 'zoom', 'bounce', 'blur'] as const).map((x) => ({ value: x, label: t(`chatSettings.enter_${x}`) }))} />
              </Field>
              <Field label={t('chatSettings.enterMs')}><NumberInput value={c.enterMs} min={100} max={2000} step={50} onChange={(enterMs) => set({ enterMs })} /></Field>
              <Field label={t('chatSettings.exit')}>
                <Select<ChatExitAnimation> value={c.exitAnimation} onChange={(exitAnimation) => set({ exitAnimation })} options={(['none', 'fade', 'slideSide', 'slideUp', 'shrink'] as const).map((x) => ({ value: x, label: t(`chatSettings.exit_${x}`) }))} />
              </Field>
              <Field label={t('chatSettings.exitMs')}><NumberInput value={c.exitMs} min={100} max={2000} step={50} onChange={(exitMs) => set({ exitMs })} /></Field>
            </div>
          </Card>
          <Card title={t('chatSettings.layout')}>
            <div className="form">
              <Field label={t('chatSettings.align')}><Select value={c.align} onChange={(align) => set({ align })} options={[{ value: 'left', label: t('chatSettings.align_left') }, { value: 'right', label: t('chatSettings.align_right') }]} /></Field>
              <Field label={t('chatSettings.width')}><NumberInput value={c.messageWidth} min={40} max={100} step={5} onChange={(messageWidth) => set({ messageWidth })} /></Field>
              <Field label={t('chatSettings.gap')}><NumberInput value={c.gap} min={0} max={40} onChange={(gap) => set({ gap })} /></Field>
              <Field label={t('chatSettings.paddingX')}><NumberInput value={c.paddingX} min={0} max={48} onChange={(paddingX) => set({ paddingX })} /></Field>
              <Field label={t('chatSettings.paddingY')}><NumberInput value={c.paddingY} min={0} max={48} onChange={(paddingY) => set({ paddingY })} /></Field>
              <Field label={t('overlays.maxMessages')}><NumberInput value={c.maxMessages} min={1} max={200} onChange={(maxMessages) => set({ maxMessages })} /></Field>
              <Field label={t('overlays.hideAfter')} hint={t('overlays.hideAfterHint')}><NumberInput value={c.hideAfterSec} min={0} max={3600} onChange={(hideAfterSec) => set({ hideAfterSec })} /></Field>
              <Field label={t('overlays.direction')}><Select value={c.direction} onChange={(direction) => set({ direction })} options={[{ value: 'up', label: t('overlays.dirUp') }, { value: 'down', label: t('overlays.dirDown') }]} /></Field>
            </div>
          </Card>
          <Card title={t('overlays.options')}>
            <div className="form">
              <Field label={t('overlays.options')} wide><div className="stack">
                <Toggle checked={c.showBadges} onChange={(showBadges) => set({ showBadges })} label={t('overlays.showBadges')} />
                <Toggle checked={c.showPlatform} onChange={(showPlatform) => set({ showPlatform })} label={t('overlays.showPlatform')} />
                <Toggle checked={c.showTimestamp} onChange={(showTimestamp) => set({ showTimestamp })} label={t('chatSettings.timestamp')} />
                <Toggle checked={c.showReply} onChange={(showReply) => set({ showReply })} label={t('chatSettings.reply')} />
                <Toggle checked={c.hideCommands} onChange={(hideCommands) => set({ hideCommands })} label={t('overlays.hideCommands')} />
              </div></Field>
              <Field label={t('overlays.hideBots')} hint={t('overlays.hideBotsHint')} wide><LinesInput value={c.hideBots} onChange={(hideBots) => set({ hideBots })} rows={3} /></Field>
            </div>
          </Card>
        </>}
        preview={
          <OverlayPreview kind="chat" maxHeight={520}>
            <Button size="sm" icon="send" onClick={() => void call('chat:test')}>
              {t('overlays.testMessage')}
            </Button>
          </OverlayPreview>
        }
      />
    </>
  );
}

// ---------- banners ----------

function AdsDetail() {
  const t = useT();
  const ads = useApp((d) => d.settings!.ads);
  const lang = useApp((d) => d.settings!.language);
  const active = useApp((d) => d.state!.ad.activeId);
  const [sel, setSel] = useState<string>();
  const ad = pickInstance(ads, sel);
  const update = (patch: Partial<AdCampaign>) => ad && saveSettings('ads', ads.map((x) => x.id === ad.id ? { ...x, ...patch } : x));
  const add = () => { const next = defaultAd(lang); saveSettings('ads', [...ads, next]); setSel(next.id); };
  return <>
    <InstancePicker items={ads} value={ad?.id} onChange={setSel} label={(x) => x.name} onAdd={add} addLabel={t('ads.add')} />
    <OverlayBar kind="ad" name={t('ov.ad')} />
    <Split stacked settings={<>
      {ad && <>
        <Card title={t('ads.content')}>
          <div className="form">
            <Field label={t('ads.name')}><TextInput value={ad.name} onChange={(name) => update({ name })} /></Field>
            <Field label={t('ads.media')} hint={t('ads.mediaHint')} wide><MediaPicker kind="visual" value={ad.media} onChange={(media) => update({ media })} /></Field>
            <Field label={t('ads.headline')}><TextInput value={ad.headline} onChange={(headline) => update({ headline })} /></Field>
            <Field label={t('ads.caption')}><TextInput value={ad.caption} onChange={(caption) => update({ caption })} /></Field>
            <Field label={t('common.accent')}><ColorInput value={ad.accentColor} onChange={(accentColor) => update({ accentColor })} /></Field>
            <Field label={t('ads.position')}><Select value={ad.position} onChange={(position) => update({ position })} options={(['bottomRight','bottomLeft','topRight','topLeft'] as const).map((x) => ({ value:x, label:t(`ads.pos_${x}`) }))} /></Field>
            <Field label={t('ads.entrance')}><Select<AdEntrance> value={ad.entrance ?? 'slideUp'} onChange={(entrance) => update({ entrance })} options={(['fade','slideUp','slideDown','slideSide','zoom','bounce','flip','blur','wipe'] as const).map((x) => ({ value: x, label: t(`ads.fx_${x}`) }))} /></Field>
            <Field label={t('ads.entranceMs')}><NumberInput value={ad.entranceMs ?? 550} min={150} max={2500} step={50} onChange={(entranceMs) => update({ entranceMs })} /></Field>
            <Field label={t('ads.width')}><NumberInput value={ad.width} min={200} max={1600} step={20} onChange={(width) => update({ width })} /></Field>
          </div>
        </Card>
        <Card title={t('ads.schedule')}>
          <div className="form">
            <Field label={t('ads.enabled')}><Toggle checked={ad.enabled} onChange={(enabled) => update({ enabled })} /></Field>
            <Field label={t('ads.onlyLive')}><Toggle checked={ad.onlyWhenLive} onChange={(onlyWhenLive) => update({ onlyWhenLive })} /></Field>
            <Field label={t('ads.duration')}><NumberInput value={ad.durationSec} min={3} max={600} onChange={(durationSec) => update({ durationSec })} /></Field>
            <Field label={t('ads.every')} hint={t('ads.everyHint')}><NumberInput value={ad.everyMin} min={0} max={240} onChange={(everyMin) => update({ everyMin })} /></Field>
          </div>
          <div className="row-gap wrap">
            <Button variant="primary" disabled={!ad.media} onClick={() => void call('ad:show', ad.id)}>{t('ads.show')}</Button>
            <Button disabled={!active} onClick={() => void call('ad:hide')}>{t('ads.hide')}</Button>
          </div>
          <p className="muted small">{t('ads.status', { name: ads.find((x) => x.id === active)?.name ?? '—' })}</p>
        </Card>
        <DeleteInstance onDelete={() => saveSettings('ads', ads.filter((x) => x.id !== ad.id))} />
      </>}
    </>} preview={<OverlayPreview kind="ad" id={ad?.id} />} />
  </>;
}

function VarsHelp() {
  const t = useT();
  return <p className="muted small vars-help">{t('overlays.varsHelp')}</p>;
}

function BannersDetail() {
  const t = useT();
  const banners = useApp((d) => d.settings!.banners);
  const lang = useApp((d) => d.settings!.language);
  const shown = useApp((d) => d.state!.bannersShown);
  const [sel, setSel] = useState<string>();
  const b = pickInstance(banners, sel);
  const update = (patch: Partial<Banner>) => b && saveSettings('banners', banners.map((x) => (x.id === b.id ? { ...x, ...patch } : x)));
  const add = () => {
    const nb = defaultBanner(lang);
    saveSettings('banners', [...banners, nb]);
    setSel(nb.id);
  };
  return (
    <>
      <InstancePicker items={banners} value={b?.id} onChange={setSel} label={(x) => x.name} onAdd={add} addLabel={t('banners.add')} />
      {!b ? null : (
        <>
          <OverlayBar kind="banner" id={b.id} name={b.name} />
          <Split
            settings={
              <>
                <Card
                  title={t('banners.show')}
                  actions={
                    <span className={`ov-state ${shown.includes(b.id) ? 'on' : ''}`}>
                      <span className="ov-state-dot" />
                      {shown.includes(b.id) ? t('banners.onScreen') : t('banners.hidden')}
                    </span>
                  }
                >
                  <div className="form">
                    <Field label={t('banners.visible')} hint={b.scheduleEveryMin > 0 ? t('banners.visibleScheduledHint') : t('banners.visibleHint')}>
                      <Toggle checked={b.visible} onChange={(visible) => update({ visible })} label={b.visible ? t('common.on') : t('common.off')} />
                    </Field>
                    <Field label={t('banners.everyMin')} hint={t('banners.everyMinHint')}>
                      <NumberInput value={b.scheduleEveryMin} min={0} max={240} onChange={(scheduleEveryMin) => update({ scheduleEveryMin })} />
                    </Field>
                    <Field label={t('banners.showSec')}>
                      <NumberInput value={b.scheduleShowSec} min={3} max={600} onChange={(scheduleShowSec) => update({ scheduleShowSec })} />
                    </Field>
                    <Field label=" ">
                      <Button icon="play" onClick={() => void call('banner:showNow', b.id)}>
                        {t('banners.showNow')}
                      </Button>
                    </Field>
                  </div>
                </Card>
                <Card title={t('banners.content')}>
                  <VarsHelp />
                  <ol className="slide-list">
                    {b.slides.map((sl, i) => (
                      <li key={sl.id}>
                        <span className="step-num">{i + 1}</span>
                        <div className="slide-fields">
                          <TextInput
                            value={sl.text}
                            onChange={(text) => update({ slides: b.slides.map((x) => (x.id === sl.id ? { ...x, text } : x)) })}
                            placeholder={t('banners.slidePh')}
                          />
                          <MediaPicker kind="visual" value={sl.image} onChange={(image) => update({ slides: b.slides.map((x) => (x.id === sl.id ? { ...x, image } : x)) })} />
                        </div>
                        <IconButton icon="x" label={t('common.delete')} onClick={() => update({ slides: b.slides.filter((x) => x.id !== sl.id) })} />
                      </li>
                    ))}
                  </ol>
                  <Button size="sm" icon="plus" onClick={() => update({ slides: [...b.slides, { id: uid('slide_'), text: '', image: null }] })}>
                    {t('banners.addSlide')}
                  </Button>
                </Card>
                <Card title={t('banners.look')}>
                  <div className="form">
                    <Field label={t('banners.name')}>
                      <TextInput value={b.name} onChange={(name) => update({ name })} />
                    </Field>
                    <Field label={t('banners.layout')}>
                      <Select<BannerLayout>
                        value={b.layout}
                        onChange={(layout) => update({ layout })}
                        options={(['ticker', 'card', 'lowerThird'] as const).map((l) => ({ value: l, label: t(`bannerLayout.${l}`) }))}
                      />
                    </Field>
                    {b.layout === 'ticker' ? (
                      <Field label={t('banners.speed')}>
                        <NumberInput value={b.tickerSpeed} min={10} max={600} step={10} onChange={(tickerSpeed) => update({ tickerSpeed })} />
                      </Field>
                    ) : (
                      <>
                        <Field label={t('banners.interval')}>
                          <NumberInput value={b.intervalSec} min={2} max={600} onChange={(intervalSec) => update({ intervalSec })} />
                        </Field>
                        <Field label={t('banners.align')}>
                          <Select
                            value={b.align}
                            onChange={(align) => update({ align })}
                            options={(['left', 'center', 'right'] as const).map((a) => ({ value: a, label: t(`align.${a}`) }))}
                          />
                        </Field>
                      </>
                    )}
                    <Field label={t('common.font')} hint={t('common.fontHint')}>
                      <TextInput value={b.fontFamily} onChange={(fontFamily) => update({ fontFamily })} />
                    </Field>
                    <Field label={t('common.fontSize')}>
                      <NumberInput value={b.fontSize} min={10} max={120} onChange={(fontSize) => update({ fontSize })} />
                    </Field>
                    <Field label={t('common.textColor')}>
                      <ColorInput value={b.textColor} onChange={(textColor) => update({ textColor })} />
                    </Field>
                    <Field label={t('common.accent')}>
                      <ColorInput value={b.accentColor} onChange={(accentColor) => update({ accentColor })} />
                    </Field>
                    <Field label={t('common.background')} hint={t('overlays.chatBgHint')}>
                      <TextInput value={b.background} onChange={(background) => update({ background })} mono />
                    </Field>
                  </div>
                </Card>
                <DeleteInstance onDelete={() => saveSettings('banners', banners.filter((x) => x.id !== b.id))} />
              </>
            }
            stacked
            preview={<OverlayPreview kind="banner" id={b.id} />}
          />
        </>
      )}
    </>
  );
}

function DeleteInstance({ onDelete }: { onDelete: () => void }) {
  const t = useT();
  return (
    <div className="danger-row">
      <Button variant="danger" size="sm" icon="trash" onClick={() => confirm(t('common.confirmDelete')) && onDelete()}>
        {t('common.delete')}
      </Button>
    </div>
  );
}

// ---------- labels ----------

function LabelsDetail() {
  const t = useT();
  const labels = useApp((d) => d.settings!.labels);
  const lang = useApp((d) => d.settings!.language);
  const stats = useApp((d) => d.settings!.stats);
  const [sel, setSel] = useState<string>();
  const l = pickInstance(labels, sel);
  const update = (patch: Partial<Label>) => l && saveSettings('labels', labels.map((x) => (x.id === l.id ? { ...x, ...patch } : x)));
  const add = () => {
    const nl = defaultLabel(lang, '{lastsub}', t('labels.new'));
    saveSettings('labels', [...labels, nl]);
    setSel(nl.id);
  };
  return (
    <>
      <InstancePicker items={labels} value={l?.id} onChange={setSel} label={(x) => x.name} onAdd={add} addLabel={t('labels.add')} />
      {l && (
        <>
          <OverlayBar kind="label" id={l.id} name={l.name} />
          <Split
            settings={
              <>
                <Card>
                  <div className="form">
                    <Field label={t('banners.name')}>
                      <TextInput value={l.name} onChange={(name) => update({ name })} />
                    </Field>
                    <Field label={t('labels.template')} wide>
                      <TextInput value={l.template} onChange={(template) => update({ template })} />
                    </Field>
                    <Field label=" " wide>
                      <VarsHelp />
                    </Field>
                    <Field label={t('common.font')} hint={t('common.fontHint')}>
                      <TextInput value={l.fontFamily} onChange={(fontFamily) => update({ fontFamily })} />
                    </Field>
                    <Field label={t('common.fontSize')}>
                      <NumberInput value={l.fontSize} min={10} max={160} onChange={(fontSize) => update({ fontSize })} />
                    </Field>
                    <Field label={t('common.textColor')}>
                      <ColorInput value={l.textColor} onChange={(textColor) => update({ textColor })} />
                    </Field>
                    <Field label={t('banners.align')}>
                      <Select value={l.align} onChange={(align) => update({ align })} options={(['left', 'center', 'right'] as const).map((a) => ({ value: a, label: t(`align.${a}`) }))} />
                    </Field>
                  </div>
                </Card>
                <Card
                  title={t('labels.stats')}
                  actions={
                    <Button size="sm" icon="replay" onClick={() => confirm(t('labels.resetConfirm')) && void call('stats:reset')}>
                      {t('labels.reset')}
                    </Button>
                  }
                >
                  <dl className="stat-list">
                    <dt>{t('labels.lastFollower')}</dt>
                    <dd>{stats.lastFollower || '—'}</dd>
                    <dt>{t('labels.lastSub')}</dt>
                    <dd>{stats.lastSubscriber || '—'}</dd>
                    <dt>{t('labels.topDonation')}</dt>
                    <dd>{stats.topDonation ? `${stats.topDonation.name} · ${stats.topDonation.amount} ${stats.topDonation.currency ?? ''}` : '—'}</dd>
                    <dt>{t('labels.session')}</dt>
                    <dd>{t('labels.sessionValue', { follows: stats.follows, subs: stats.subs, bits: stats.bits, donations: stats.donations })}</dd>
                  </dl>
                </Card>
                <DeleteInstance onDelete={() => saveSettings('labels', labels.filter((x) => x.id !== l.id))} />
              </>
            }
            stacked
            preview={<OverlayPreview kind="label" id={l.id} maxHeight={160} />}
          />
        </>
      )}
    </>
  );
}

// ---------- goals ----------

function GoalsDetail() {
  const t = useT();
  const goals = useApp((d) => d.settings!.goals);
  const lang = useApp((d) => d.settings!.language);
  const currency = useApp((d) => d.settings!.currency);
  const [sel, setSel] = useState<string>();
  const g = pickInstance(goals, sel);
  const update = (patch: Partial<Goal>) => g && saveSettings('goals', goals.map((x) => (x.id === g.id ? { ...x, ...patch } : x)));
  const kinds: GoalKind[] = ['followers', 'subs', 'bits', 'donations', 'manual'];
  const add = () => {
    const ng = { ...defaultGoal(lang), currency };
    saveSettings('goals', [...goals, ng]);
    setSel(ng.id);
  };
  const pct = g && g.target > 0 ? Math.min(100, (g.current / g.target) * 100) : 0;
  return (
    <>
      <InstancePicker items={goals} value={g?.id} onChange={setSel} label={(x) => x.title} onAdd={add} addLabel={t('goals.add')} />
      {g && (
        <>
          <OverlayBar kind="goal" id={g.id} name={g.title} />
          <Split
            settings={
              <>
                <Card>
                  <div className="goal-bar" style={{ '--c': g.barColor } as React.CSSProperties}>
                    <div style={{ width: `${pct}%` }} />
                    <span>
                      {g.current} / {g.target} {g.kind === 'donations' ? g.currency : ''} · {Math.floor(pct)}%
                    </span>
                  </div>
                  <div className="form">
                    <Field label={t('goals.title')}>
                      <TextInput value={g.title} onChange={(title) => update({ title })} />
                    </Field>
                    <Field label={t('goals.kind')} hint={t('goals.kindHint')}>
                      <Select<GoalKind> value={g.kind} onChange={(kind) => update({ kind })} options={kinds.map((k) => ({ value: k, label: t(`goalKind.${k}`) }))} />
                    </Field>
                    <Field label={t('goals.target')}>
                      <NumberInput value={g.target} min={1} onChange={(target) => update({ target })} />
                    </Field>
                    <Field label={t('goals.current')}>
                      <NumberInput value={g.current} min={0} onChange={(current) => update({ current })} />
                    </Field>
                    {g.kind === 'donations' && (
                      <Field label={t('settings.currency')}>
                        <TextInput value={g.currency} onChange={(c) => update({ currency: c.toUpperCase() })} />
                      </Field>
                    )}
                    <Field label={t('goals.barColor')}>
                      <ColorInput value={g.barColor} onChange={(barColor) => update({ barColor })} />
                    </Field>
                    <Field label={t('common.textColor')}>
                      <ColorInput value={g.textColor} onChange={(textColor) => update({ textColor })} />
                    </Field>
                  </div>
                </Card>
                <DeleteInstance onDelete={() => saveSettings('goals', goals.filter((x) => x.id !== g.id))} />
              </>
            }
            stacked
            preview={<OverlayPreview kind="goal" id={g.id} maxHeight={140} />}
          />
        </>
      )}
    </>
  );
}

// ---------- timers ----------

function TimersDetail() {
  const t = useT();
  const timers = useApp((d) => d.settings!.timers);
  const lang = useApp((d) => d.settings!.language);
  const now = useNow(500);
  const [sel, setSel] = useState<string>();
  const tm = pickInstance(timers, sel);
  const update = (patch: Partial<OverlayTimer>) => tm && saveSettings('timers', timers.map((x) => (x.id === tm.id ? { ...x, ...patch } : x)));
  const add = () => {
    const nt = { ...defaultTimer(lang), id: uid('timer_') };
    saveSettings('timers', [...timers, nt]);
    setSel(nt.id);
  };
  return (
    <>
      <InstancePicker items={timers} value={tm?.id} onChange={setSel} label={(x) => x.title} onAdd={add} addLabel={t('timers.add')} />
      {tm && (
        <>
          <OverlayBar kind="timer" id={tm.id} name={tm.title} />
          <Split
            settings={
              <>
                <Card>
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
                      <TextInput value={tm.title} onChange={(title) => update({ title })} />
                    </Field>
                    <Field label={t('timers.mode')}>
                      <Select
                        value={tm.mode}
                        onChange={(mode) => update({ mode, running: false, anchorAt: null, pausedMs: mode === 'countdown' ? tm.durationSec * 1000 : 0 })}
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
                          onChange={(m) => update({ durationSec: m * 60, ...(!tm.running && tm.pausedMs === tm.durationSec * 1000 ? { pausedMs: m * 60_000 } : {}) })}
                        />
                      </Field>
                    )}
                    <Field label={t('common.font')}>
                      <TextInput value={tm.fontFamily} onChange={(fontFamily) => update({ fontFamily })} />
                    </Field>
                    <Field label={t('common.fontSize')}>
                      <NumberInput value={tm.fontSize} min={12} max={300} onChange={(fontSize) => update({ fontSize })} />
                    </Field>
                    <Field label={t('common.textColor')}>
                      <ColorInput value={tm.textColor} onChange={(textColor) => update({ textColor })} />
                    </Field>
                  </div>
                </Card>
                {tm.mode === 'countdown' && (
                  <Card title={t('timers.subathon')}>
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
                          <NumberInput value={tm.addSec[k]} min={0} onChange={(v) => update({ addSec: { ...tm.addSec, [k]: v } })} />
                        </Field>
                      ))}
                    </div>
                  </Card>
                )}
                <DeleteInstance onDelete={() => saveSettings('timers', timers.filter((x) => x.id !== tm.id))} />
              </>
            }
            stacked
            preview={<OverlayPreview kind="timer" id={tm.id} maxHeight={200} />}
          />
        </>
      )}
    </>
  );
}

// ---------- kawaki, emotes ----------

function KawakiDetail() {
  const t = useT();
  return (
    <>
      <OverlayBar kind="kawaki" name="Kawaki" />
      <Split settings={<KawakiStyleCard />} preview={<OverlayPreview kind="kawaki" maxHeight={220} children={
        <Button size="sm" icon="chevron" onClick={() => navigate('kawaki')}>
          {t('overlays.openKawaki')}
        </Button>
      } />} />
    </>
  );
}

export function KawakiStyleCard() {
  const t = useT();
  const k = useApp((d) => d.settings!.kawaki);
  const set = (patch: Partial<typeof k>) => saveSettings('kawaki', { ...k, ...patch });
  return (
    <Card title={t('banners.look')}>
      <div className="form">
        <Field label={t('overlays.options')} wide>
          <div className="stack">
            <Toggle checked={k.showPoster} onChange={(showPoster) => set({ showPoster })} label={t('kawaki.showPoster')} />
            <Toggle checked={k.showProgress} onChange={(showProgress) => set({ showProgress })} label={t('kawaki.showProgress')} />
            <Toggle checked={k.keepLast} onChange={(keepLast) => set({ keepLast })} label={t('kawaki.keepLast')} />
          </div>
        </Field>
        <Field label={t('common.accent')}>
          <ColorInput value={k.accentColor} onChange={(accentColor) => set({ accentColor })} />
        </Field>
        <Field label={t('common.font')} hint={t('common.fontHint')}>
          <TextInput value={k.fontFamily} onChange={(fontFamily) => set({ fontFamily })} />
        </Field>
      </div>
    </Card>
  );
}

function EmotesDetail() {
  const t = useT();
  const e = useApp((d) => d.settings!.emoteRain);
  const set = (patch: Partial<typeof e>) => saveSettings('emoteRain', { ...e, ...patch });
  return (
    <>
      <OverlayBar kind="emotes" name={t('ov.emotes')} />
      <Split
        settings={
          <Card>
            <div className="form">
              <Field label={t('overlays.options')} wide>
                <div className="stack">
                  <Toggle checked={e.fromChat} onChange={(fromChat) => set({ fromChat })} label={t('emotes.fromChat')} />
                  <Toggle checked={e.burstOnEvents} onChange={(burstOnEvents) => set({ burstOnEvents })} label={t('emotes.burstOnEvents')} />
                </div>
              </Field>
              <Field label={t('emotes.style')}>
                <Select<EmoteRainStyle> value={e.style} onChange={(style) => set({ style })} options={(['rain', 'rise', 'bounce'] as const).map((s) => ({ value: s, label: t(`emoteStyle.${s}`) }))} />
              </Field>
              <Field label={t('emotes.size')}>
                <NumberInput value={e.size} min={16} max={256} onChange={(size) => set({ size })} />
              </Field>
              <Field label={t('emotes.duration')}>
                <NumberInput value={e.durationSec} min={1} max={30} onChange={(durationSec) => set({ durationSec })} />
              </Field>
              <Field label={t('emotes.perMessage')}>
                <NumberInput value={e.maxPerMessage} min={1} max={30} onChange={(maxPerMessage) => set({ maxPerMessage })} />
              </Field>
              <Field label={t('emotes.burstCount')}>
                <NumberInput value={e.burstCount} min={5} max={150} onChange={(burstCount) => set({ burstCount })} />
              </Field>
            </div>
          </Card>
        }
        preview={
          <OverlayPreview kind="emotes">
            <Button size="sm" icon="sparkle" onClick={() => void call('emotes:test')}>
              {t('emotes.test')}
            </Button>
          </OverlayPreview>
        }
      />
    </>
  );
}

// ---------- interactive overlays point to their control page ----------

const INTERACTIVE_TAB: Partial<Record<OverlayKind, string>> = { wheel: 'wheel', poll: 'poll', giveaway: 'giveaway', quiz: 'quiz', boss: 'boss' };

function InteractiveDetail({ kind }: { kind: OverlayKind }) {
  const t = useT();
  const wheels = useApp((d) => d.settings!.wheels);
  const [sel, setSel] = useState<string>();
  const w = kind === 'wheel' ? pickInstance(wheels, sel) : undefined;
  return (
    <>
      {kind === 'wheel' && (
        <div className="chips">
          {wheels.map((x) => (
            <button key={x.id} type="button" className={`chip ${x.id === w?.id ? 'active' : ''}`} onClick={() => setSel(x.id)}>
              {x.name}
            </button>
          ))}
        </div>
      )}
      <OverlayBar kind={kind} id={w?.id} name={w?.name ?? t(`ov.${kind}` as TKey)} />
      <Split
        settings={
          <Card>
            <p className="muted">{t('overlays.interactiveManage')}</p>
            <Button icon="chevron" onClick={() => navigate('interactive', INTERACTIVE_TAB[kind])}>
              {t('overlays.openInteractive')}
            </Button>
          </Card>
        }
        preview={<OverlayPreview kind={kind} id={w?.id} />}
      />
    </>
  );
}
