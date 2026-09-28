import { useEffect, useMemo, useRef, useState } from 'react';
import { ALERT_TYPES } from '@shared/types';
import { useT, type TFn } from '../i18n';
import { OVERLAYS } from '../overlayCatalog';
import { call, getData, navigate, saveSettings, type Page } from '../store';
import { Icon, type IconName } from './icons';

interface Command {
  id: string;
  label: string;
  group: string;
  icon: IconName;
  /** Extra words that should match (English page names, synonyms). */
  keywords?: string;
  run: () => void;
}

const PAGES: { page: Page; icon: IconName; key: Parameters<TFn>[0]; kw: string }[] = [
  { page: 'dashboard', icon: 'dashboard', key: 'nav.dashboard', kw: 'dashboard главная' },
  { page: 'interactive', icon: 'sparkle', key: 'nav.interactive', kw: 'interactive игры' },
  { page: 'profiles', icon: 'users', key: 'nav.profiles', kw: 'profiles профили сцены' },
  { page: 'alerts', icon: 'alert', key: 'nav.alerts', kw: 'alerts' },
  { page: 'overlays', icon: 'layers', key: 'nav.overlays', kw: 'overlays obs' },
  { page: 'bot', icon: 'bot', key: 'nav.bot', kw: 'bot commands команды' },
  { page: 'obs', icon: 'video', key: 'nav.obs', kw: 'obs actions hotkeys хоткеи' },
  { page: 'kawaki', icon: 'tv', key: 'nav.kawaki', kw: 'kawaki аниме anime' },
  { page: 'connections', icon: 'plug', key: 'nav.connections', kw: 'connections twitch donationalerts' },
  { page: 'settings', icon: 'settings', key: 'nav.settings', kw: 'settings' },
];

function buildCommands(t: TFn): Command[] {
  const { settings, state } = getData();
  if (!settings || !state) return [];
  const go = t('palette.go');
  const out: Command[] = PAGES.map((p) => ({ id: `page:${p.page}`, label: t(p.key), group: go, icon: p.icon, keywords: p.kw, run: () => navigate(p.page) }));
  for (const o of OVERLAYS) {
    out.push({ id: `ov:${o.kind}`, label: `${t('palette.overlay')}: ${t(`ov.${o.kind}`)}`, group: go, icon: o.icon, keywords: o.kind, run: () => navigate('overlays', o.kind) });
  }
  const fun = t('nav.interactive');
  for (const w of settings.wheels) out.push({ id: `wheel:${w.id}`, label: `${t('wheel.spin')}: ${w.name}`, group: fun, icon: 'wheel', keywords: 'wheel spin колесо', run: () => void call('wheel:spin', w.id) });
  if (state.poll?.status === 'running') out.push({ id: 'poll:end', label: t('poll.end'), group: fun, icon: 'poll', keywords: 'poll', run: () => void call('poll:end') });
  else out.push({ id: 'poll:start', label: `${t('poll.start')}: ${settings.poll.question}`, group: fun, icon: 'poll', keywords: 'poll vote голосование', run: () => void call('poll:start') });
  const g = state.giveaway.status;
  if (g === 'idle' || g === 'done') out.push({ id: 'give:open', label: t('give.open'), group: fun, icon: 'gift', keywords: 'giveaway розыгрыш', run: () => void call('giveaway:open') });
  if (g === 'open') out.push({ id: 'give:close', label: t('give.close'), group: fun, icon: 'gift', keywords: 'giveaway', run: () => void call('giveaway:close') });
  if ((g === 'open' || g === 'closed') && state.giveaway.entrants.length)
    out.push({ id: 'give:roll', label: t('give.roll'), group: fun, icon: 'trophy', keywords: 'giveaway winner победитель', run: () => void call('giveaway:roll') });
  if (['idle', 'finished', 'error'].includes(state.quiz.status)) out.push({ id: 'quiz:start', label: t('quiz.start'), group: fun, icon: 'quiz', keywords: 'quiz квиз anime', run: () => void call('quiz:start') });
  else out.push({ id: 'quiz:stop', label: t('quiz.stop'), group: fun, icon: 'quiz', keywords: 'quiz', run: () => void call('quiz:stop') });
  const q = state.viewerQueue;
  out.push({ id: 'queue:open', label: q.open ? t('queue.close') : t('queue.open'), group: fun, icon: 'users', keywords: 'queue очередь join', run: () => void call('queue:open', !q.open) });
  if (q.entries.length) out.push({ id: 'queue:next', label: `${t('queue.next')}: ${q.entries[0].userName}`, group: fun, icon: 'users', keywords: 'queue next очередь следующий', run: () => void call('queue:next') });
  if (state.guess.status === 'running') out.push({ id: 'guess:stop', label: t('guess.stop'), group: fun, icon: 'hash', keywords: 'guess number число', run: () => void call('guess:stop') });
  else out.push({ id: 'guess:start', label: `${t('fun.guess')}: ${t('guess.start')}`, group: fun, icon: 'hash', keywords: 'guess number угадай число', run: () => void call('guess:start') });
  if (state.boss.status !== 'running') out.push({ id: 'boss:start', label: `${t('fun.boss')}: ${t('boss.start')}`, group: fun, icon: 'target', keywords: 'boss босс', run: () => void call('boss:start') });
  for (const c of settings.counterOverlays) {
    out.push({ id: `counter+:${c.id}`, label: `${c.title} +1`, group: t('dash.counters'), icon: 'hash', keywords: `counter счётчик ${c.counter}`, run: () => void call('counter:add', c.counter, 1) });
    out.push({ id: `counter-:${c.id}`, label: `${c.title} −1`, group: t('dash.counters'), icon: 'hash', keywords: `counter счётчик ${c.counter}`, run: () => void call('counter:add', c.counter, -1) });
  }
  out.push({ id: 'emotes', label: t('emotes.test'), group: fun, icon: 'smile', keywords: 'emotes rain дождь', run: () => void call('emotes:test') });

  const screen = t('ovGroup.screen');
  for (const b of settings.banners) {
    out.push({
      id: `banner:${b.id}`,
      label: `${b.visible ? t('palette.hideBanner') : t('palette.showBanner')}: ${b.name}`,
      group: screen,
      icon: 'banner',
      keywords: 'ticker строка бегущая banner',
      run: () => {
        const list = getData().settings!.banners;
        saveSettings('banners', list.map((x) => (x.id === b.id ? { ...x, visible: !x.visible } : x)));
      },
    });
  }

  const quick = t('dash.quick');
  for (const a of settings.actions) out.push({ id: `act:${a.id}`, label: a.label, group: quick, icon: 'zap', keywords: a.hotkey, run: () => void call('actions:run', a.id) });
  out.push({
    id: 'alerts:pause',
    label: state.alerts.paused ? t('dash.alertsResume') : t('dash.alertsPause'),
    group: quick,
    icon: state.alerts.paused ? 'play' : 'pause',
    keywords: 'alerts алерты',
    run: () => void call('alerts:pause', !state.alerts.paused),
  });
  if (state.alerts.current) out.push({ id: 'alerts:skip', label: t('dash.alertsSkip'), group: quick, icon: 'skip', keywords: 'alerts', run: () => void call('alerts:skip') });
  for (const ty of ALERT_TYPES) out.push({ id: `test:${ty}`, label: `${t('alerts.test')}: ${t(`alertType.${ty}`)}`, group: t('nav.alerts'), icon: 'alert', keywords: `test ${ty}`, run: () => void call('alerts:test', ty) });
  if (state.obs.status === 'connected') {
    for (const sc of state.obs.scenes) out.push({ id: `scene:${sc}`, label: `${t('palette.scene')}: ${sc}`, group: 'OBS', icon: 'video', keywords: 'obs scene', run: () => void call('obs:setScene', sc) });
  }
  return out;
}

function matches(c: Command, q: string): boolean {
  const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase().replace(/ё/g, 'е');
  return q
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Ctrl+K: jump anywhere or run anything without leaving the keyboard. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const all = useMemo(() => (open ? buildCommands(t) : []), [open, t]);
  const shown = useMemo(() => (q.trim() ? all.filter((c) => matches(c, q)) : all).slice(0, 60), [all, q]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIndex(0);
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={t('palette.title')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            placeholder={t('palette.placeholder')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(shown.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(shown[index]);
              } else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" ref={list} role="listbox">
          {shown.length === 0 && <li className="palette-empty">{t('palette.empty')}</li>}
          {shown.map((c, i) => (
            <li
              key={c.id}
              data-i={i}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'active' : ''}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(c)}
            >
              <Icon name={c.icon} size={16} />
              <span className="palette-label">{c.label}</span>
              <span className="palette-group">{c.group}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
