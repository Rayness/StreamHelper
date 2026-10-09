import { useState } from 'react';
import { defaultCounterOverlay } from '@shared/defaults';
import type { CounterOverlay, DonationsOverlaySettings, DonationsPage, HypeSettings, LeadersOverlaySettings } from '@shared/types';
import { InstancePicker, OverlayBar, OverlayPreview, pickInstance } from '../components/overlay';
import { Button, Card, ColorInput, Field, LinesInput, NumberInput, Select, TextInput, Toggle } from '../components/ui';
import { FontPicker } from '../components/FontPicker';
import { useT } from '../i18n';
import { call, saveSettings, useApp } from '../store';
import { DeleteInstance, Split } from './Overlays';

// ---------- counter ----------

export function CounterDetail() {
  const t = useT();
  const list = useApp((d) => d.settings!.counterOverlays);
  const counters = useApp((d) => d.settings!.bot.counters);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const lang = useApp((d) => d.settings!.language);
  const [sel, setSel] = useState<string>();
  const c = pickInstance(list, sel);
  const update = (patch: Partial<CounterOverlay>) => c && saveSettings('counterOverlays', list.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
  const add = () => {
    const nc = { ...defaultCounterOverlay(lang, `counter${list.length + 1}`), title: t('counter.new') };
    saveSettings('counterOverlays', [...list, nc]);
    setSel(nc.id);
  };
  const value = c ? (counters[c.counter] ?? 0) : 0;
  return (
    <>
      <InstancePicker items={list} value={c?.id} onChange={setSel} label={(x) => x.title} onAdd={add} addLabel={t('counter.add')} />
      {c && (
        <>
          <OverlayBar kind="counter" id={c.id} name={c.title} />
          <Split
            stacked
            settings={
              <>
                <Card className="control-card">
                  <div className="control-row">
                    <Button icon="minus" onClick={() => void call('counter:add', c.counter, -1)}>1</Button>
                    <div className="control-status">
                      <span className="muted small">{c.title}</span>
                      <b className="counter-value">{value}</b>
                    </div>
                    <Button variant="primary" icon="plus" onClick={() => void call('counter:add', c.counter, 1)}>1</Button>
                    <Button size="sm" icon="replay" onClick={() => confirm(t('counter.resetConfirm')) && void call('counter:add', c.counter, -value)}>{t('counter.reset')}</Button>
                  </div>
                  <p className="muted small">{t('counter.hint', { prefix, name: c.counter })}</p>
                </Card>
                <Card>
                  <div className="form">
                    <Field label={t('counter.title')}><TextInput value={c.title} onChange={(title) => update({ title })} /></Field>
                    <Field label={t('counter.name')} hint={t('counter.nameHint')}>
                      <TextInput mono value={c.counter} onChange={(counter) => update({ counter: counter.replace(/\s+/g, '') })} />
                    </Field>
                    <Field label={t('counter.style')}>
                      <Select value={c.style} onChange={(style) => update({ style })} options={(['card', 'minimal', 'badge'] as const).map((v) => ({ value: v, label: t(`counter.style_${v}`) }))} />
                    </Field>
                    <Field label={t('common.fontSize')}><NumberInput value={c.fontSize} min={12} max={200} onChange={(fontSize) => update({ fontSize })} /></Field>
                    <Field label={t('common.textColor')}><ColorInput value={c.textColor} onChange={(textColor) => update({ textColor })} /></Field>
                    <Field label={t('common.accent')}><ColorInput value={c.accentColor} onChange={(accentColor) => update({ accentColor })} /></Field>
                    <Field label={t('common.font')} hint={t('common.fontHint')}><FontPicker value={c.fontFamily} onChange={(fontFamily) => update({ fontFamily })} /></Field>
                  </div>
                </Card>
                <DeleteInstance onDelete={() => saveSettings('counterOverlays', list.filter((x) => x.id !== c.id))} />
              </>
            }
            preview={<OverlayPreview kind="counter" id={c.id} maxHeight={140} />}
          />
        </>
      )}
    </>
  );
}

// ---------- hype meter ----------

export function HypeDetail() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.hype);
  const hype = useApp((d) => d.state!.hype);
  const set = (patch: Partial<HypeSettings>) => saveSettings('hype', { ...cfg, ...patch });
  const setPoints = (patch: Partial<HypeSettings['points']>) => set({ points: { ...cfg.points, ...patch } });
  return (
    <>
      <OverlayBar kind="hype" name={t('ov.hype')} />
      <Split
        settings={
          <>
            <Card className="control-card">
              <div className="control-row">
                <div className="control-status">
                  <span className="muted small">{hype.level ? t('hype.level', { n: hype.level }) : t('hype.calm')}</span>
                  <b>{Math.round(hype.points)} / {cfg.levelPoints * cfg.maxLevel}</b>
                </div>
                <Button icon="zap" onClick={() => void call('hype:add', cfg.levelPoints / 2)}>{t('hype.test')}</Button>
                <Button size="sm" icon="replay" onClick={() => void call('hype:reset')}>{t('hype.reset')}</Button>
              </div>
              <div className="meter"><span style={{ width: `${hype.level ? hype.progress * 100 : 0}%` }} /></div>
            </Card>
            <Card title={t('hype.points')}>
              <p className="muted small">{t('hype.pointsHint')}</p>
              <div className="form">
                <Field label={t('alertType.follow')}><NumberInput value={cfg.points.follow} min={0} max={10000} step={0.5} onChange={(follow) => setPoints({ follow })} /></Field>
                <Field label={t('hype.sub')}><NumberInput value={cfg.points.sub} min={0} max={10000} step={0.5} onChange={(sub) => setPoints({ sub })} /></Field>
                <Field label={t('hype.bits')}><NumberInput value={cfg.points.bitsPer100} min={0} max={10000} step={0.5} onChange={(bitsPer100) => setPoints({ bitsPer100 })} /></Field>
                <Field label={t('hype.donation')}><NumberInput value={cfg.points.donationPerUnit} min={0} max={10000} step={0.05} onChange={(donationPerUnit) => setPoints({ donationPerUnit })} /></Field>
                <Field label={t('hype.raid')}><NumberInput value={cfg.points.raidPerViewer} min={0} max={1000} step={0.1} onChange={(raidPerViewer) => setPoints({ raidPerViewer })} /></Field>
                <Field label={t('hype.redemption')}><NumberInput value={cfg.points.redemption} min={0} max={10000} step={0.5} onChange={(redemption) => setPoints({ redemption })} /></Field>
                <Field label={t('hype.chat')}><NumberInput value={cfg.points.chatMessage} min={0} max={100} step={0.1} onChange={(chatMessage) => setPoints({ chatMessage })} /></Field>
              </div>
            </Card>
            <Card title={t('hype.look')}>
              <div className="form">
                <Field label={t('counter.title')}><TextInput value={cfg.title} onChange={(title) => set({ title })} /></Field>
                <Field label={t('hype.levelPoints')}><NumberInput value={cfg.levelPoints} min={1} max={1000000} onChange={(levelPoints) => set({ levelPoints })} /></Field>
                <Field label={t('hype.maxLevel')}><NumberInput value={cfg.maxLevel} min={1} max={10} onChange={(maxLevel) => set({ maxLevel })} /></Field>
                <Field label={t('hype.decay')} hint={t('hype.decayHint')}><NumberInput value={cfg.decayPerMin} min={0} max={100} onChange={(decayPerMin) => set({ decayPerMin })} /></Field>
                <Field label={t('overlays.options')} wide><Toggle checked={cfg.hideWhenEmpty} onChange={(hideWhenEmpty) => set({ hideWhenEmpty })} label={t('hype.hideWhenEmpty')} /></Field>
                <Field label={t('common.accent')}><ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
                <Field label={t('common.font')} hint={t('common.fontHint')}><FontPicker value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
              </div>
            </Card>
          </>
        }
        preview={<OverlayPreview kind="hype" maxHeight={180} />}
      />
    </>
  );
}

// ---------- top chatters ----------

export function LeadersDetail() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.leadersOverlay);
  const leaders = useApp((d) => d.state!.chatLeaders);
  const set = (patch: Partial<LeadersOverlaySettings>) => saveSettings('leadersOverlay', { ...cfg, ...patch });
  return (
    <>
      <OverlayBar kind="leaders" name={t('ov.leaders')} />
      <Split
        settings={
          <>
            <Card title={t('leaders.now')} actions={<Button size="sm" icon="replay" onClick={() => confirm(t('leaders.resetConfirm')) && void call('leaders:reset')}>{t('leaders.reset')}</Button>}>
              {leaders.length === 0 ? (
                <p className="muted small">{t('leaders.empty')}</p>
              ) : (
                <ol className="leaderboard">
                  {leaders.slice(0, 10).map((l) => (
                    <li key={l.userId}><span>{l.userName}</span><b>{l.messages}</b></li>
                  ))}
                </ol>
              )}
            </Card>
            <Card>
              <div className="form">
                <Field label={t('counter.title')}><TextInput value={cfg.title} onChange={(title) => set({ title })} /></Field>
                <Field label={t('leaders.count')}><NumberInput value={cfg.count} min={1} max={20} onChange={(count) => set({ count })} /></Field>
                <Field label={t('leaders.exclude')} hint={t('leaders.excludeHint')} wide><LinesInput value={cfg.exclude} onChange={(exclude) => set({ exclude })} rows={3} /></Field>
                <Field label={t('overlays.options')} wide><Toggle checked={cfg.showCounts} onChange={(showCounts) => set({ showCounts })} label={t('leaders.showCounts')} /></Field>
                <Field label={t('common.accent')}><ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
                <Field label={t('common.font')} hint={t('common.fontHint')}><FontPicker value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
              </div>
            </Card>
          </>
        }
        preview={<OverlayPreview kind="leaders" maxHeight={380} />}
      />
    </>
  );
}

// ---------- donation board ----------

const DONATION_PAGES: DonationsPage[] = ['latest', 'top', 'all', 'total'];

export function DonationsDetail() {
  const t = useT();
  const cfg = useApp((d) => d.settings!.donationsOverlay);
  const log = useApp((d) => d.settings!.donationLog);
  const since = useApp((d) => d.settings!.stats.since);
  const currency = useApp((d) => d.settings!.currency);
  const set = (patch: Partial<DonationsOverlaySettings>) => saveSettings('donationsOverlay', { ...cfg, ...patch });
  const togglePage = (page: DonationsPage, on: boolean) => set({ pages: on ? DONATION_PAGES.filter((p) => p === page || cfg.pages.includes(p)) : cfg.pages.filter((p) => p !== page) });
  const session = log.filter((d) => d.at >= since);
  return (
    <>
      <OverlayBar kind="donations" name={t('ov.donations')} />
      <Split
        stacked
        settings={<>
          <Card title={t('donations.pages')}>
            <p className="muted small">{t('donations.pagesHint')}</p>
            <div className="donation-pages">
              {DONATION_PAGES.map((page) => (
                <div key={page} className={`donation-page ${cfg.pages.includes(page) ? 'on' : ''}`}>
                  <Toggle checked={cfg.pages.includes(page)} onChange={(on) => togglePage(page, on)} label={t(`donations.page_${page}`)} />
                  <TextInput value={cfg.titles[page]} onChange={(title) => set({ titles: { ...cfg.titles, [page]: title } })} placeholder={t('donations.pageTitle')} />
                </div>
              ))}
            </div>
            <div className="form">
              <Field label={t('donations.layout')}>
                <Select value={cfg.layout} onChange={(layout) => set({ layout })} options={(['list', 'single', 'ticker'] as const).map((v) => ({ value: v, label: t(`donations.layout_${v}`) }))} />
              </Field>
              <Field label={t('donations.period')}>
                <Select value={cfg.period} onChange={(period) => set({ period })} options={(['session', 'all'] as const).map((v) => ({ value: v, label: t(`donations.period_${v}`) }))} />
              </Field>
              <Field label={t('donations.count')}><NumberInput value={cfg.count} min={1} max={50} onChange={(count) => set({ count })} /></Field>
              {cfg.layout !== 'ticker' && <Field label={t('donations.pageSec')}><NumberInput value={cfg.pageSec} min={3} max={600} onChange={(pageSec) => set({ pageSec })} /></Field>}
              {cfg.layout === 'single' && <Field label={t('donations.itemSec')}><NumberInput value={cfg.itemSec} min={2} max={120} onChange={(itemSec) => set({ itemSec })} /></Field>}
              {cfg.layout === 'ticker' && <Field label={t('banners.speed')}><NumberInput value={cfg.tickerSpeed} min={10} max={600} step={10} onChange={(tickerSpeed) => set({ tickerSpeed })} /></Field>}
              <Field label={t('overlays.options')} wide><div className="stack">
                <Toggle checked={cfg.showTitle} onChange={(showTitle) => set({ showTitle })} label={t('donations.showTitle')} />
                <Toggle checked={cfg.showMessage} onChange={(showMessage) => set({ showMessage })} label={t('donations.showMessage')} />
              </div></Field>
            </div>
          </Card>
          <Card title={t('banners.look')}>
            <div className="form">
              <Field label={t('common.font')} hint={t('common.fontHint')}><FontPicker value={cfg.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
              <Field label={t('common.fontSize')}><NumberInput value={cfg.fontSize} min={10} max={120} onChange={(fontSize) => set({ fontSize })} /></Field>
              <Field label={t('common.textColor')}><ColorInput value={cfg.textColor} onChange={(textColor) => set({ textColor })} /></Field>
              <Field label={t('common.accent')}><ColorInput value={cfg.accentColor} onChange={(accentColor) => set({ accentColor })} /></Field>
              <Field label={t('common.background')} hint={t('overlays.chatBgHint')}><TextInput value={cfg.background} onChange={(background) => set({ background })} mono /></Field>
              <Field label={t('banners.align')}><Select value={cfg.align} onChange={(align) => set({ align })} options={(['left', 'center', 'right'] as const).map((a) => ({ value: a, label: t(`align.${a}`) }))} /></Field>
            </div>
          </Card>
          <Card title={t('donations.history')} actions={<Button size="sm" icon="trash" disabled={!log.length} onClick={() => confirm(t('donations.clearConfirm')) && void call('donations:clear')}>{t('donations.clear')}</Button>}>
            <p className="muted small">{t('donations.historyHint', { session: session.length, all: log.length })}</p>
            {log.length > 0 && <ol className="donation-log">
              {log.slice(0, 8).map((d) => <li key={d.id}><b>{d.name}</b><span>{d.amount} {d.currency}</span>{d.amountMain === null && <span className="muted small" title={t('donations.noConversion', { currency })}>≠ {currency}</span>}</li>)}
            </ol>}
            <p className="muted small">{t('donations.varsHint')}</p>
          </Card>
        </>}
        preview={<OverlayPreview kind="donations" maxHeight={360} />}
      />
    </>
  );
}
