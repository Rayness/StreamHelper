import { useEffect, useMemo, useRef, useState } from 'react';
import { BUNDLED_FONTS, type FontCategory } from '@shared/fonts';
import { useT } from '../i18n';
import { call, useApp } from '../store';
import { Icon } from './icons';

let systemList: Promise<string[]> | null = null;
/** Installed fonts, asked from the app once per session. */
function loadSystemFonts(): Promise<string[]> {
  systemList ??= call('fonts:system').then((list) => list ?? []);
  return systemList;
}

/** Makes the bundled fonts usable in the app itself (font picker, designer), served by the overlay server. */
export function useBundledFonts(): void {
  const base = useApp((d) => d.state!.overlayUrl);
  useEffect(() => {
    if (!base) return;
    const href = `${base}/overlay/assets/fonts/fonts.css`;
    let link = document.getElementById('sh-bundled-fonts') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = 'sh-bundled-fonts';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.href !== href) link.href = href;
  }, [base]);
}

const CATEGORIES: FontCategory[] = ['sans', 'display', 'serif', 'handwriting', 'pixel', 'mono'];
const fontCss = (family: string) => `"${family.replace(/"/g, '')}", system-ui, sans-serif`;

/**
 * Font choice: fonts bundled with StreamHelper (work offline, in every OBS), fonts installed on
 * this PC, or any Google Fonts family typed by name.
 */
export function FontPicker({ value, onChange }: { value: string; onChange: (family: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [system, setSystem] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    void loadSystemFonts().then(setSystem);
    setQuery('');
    requestAnimationFrame(() => search.current?.focus());
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const q = query.trim().toLowerCase();
  const match = (family: string) => !q || family.toLowerCase().includes(q);
  const bundled = BUNDLED_FONTS.filter((f) => match(f.family));
  const bundledNames = useMemo(() => new Set(BUNDLED_FONTS.map((f) => f.family.toLowerCase())), []);
  const installed = system.filter((f) => !bundledNames.has(f.toLowerCase()) && match(f));
  const exact = [...BUNDLED_FONTS.map((f) => f.family), ...system].some((f) => f.toLowerCase() === q);
  const pick = (family: string) => { onChange(family); setOpen(false); };
  const first = bundled[0]?.family ?? installed[0] ?? (query.trim() || undefined);
  const kind = bundledNames.has(value.trim().toLowerCase()) ? t('font.bundled') : system.some((f) => f.toLowerCase() === value.trim().toLowerCase()) ? t('font.system') : value.trim() ? 'Google Fonts' : '';
  return (
    <div className="font-picker" ref={root}>
      <button type="button" className="input font-picker-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="font-picker-name" style={{ fontFamily: fontCss(value || 'Inter') }}>{value || t('font.default')}</span>
        {kind && <span className="font-picker-kind">{kind}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="font-picker-pop" role="listbox" aria-label={t('common.font')}>
          <div className="font-picker-search">
            <Icon name="search" size={15} />
            <input ref={search} value={query} placeholder={t('font.search')} spellCheck={false} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && first) { e.preventDefault(); pick(first); } }} />
          </div>
          <div className="font-picker-list">
            {q && !exact && <button type="button" className="font-option custom" onClick={() => pick(query.trim())}>
              <span style={{ fontFamily: fontCss(query.trim()) }}>{query.trim()}</span><small>{t('font.useGoogle')}</small>
            </button>}
            {CATEGORIES.map((cat) => {
              const list = bundled.filter((f) => f.category === cat);
              if (!list.length) return null;
              return <div key={cat} className="font-group">
                <span className="font-group-label">{t('font.bundled')} · {t(`font.cat.${cat}`)}</span>
                {list.map((f) => <button key={f.family} type="button" role="option" aria-selected={f.family === value} className={`font-option ${f.family === value ? 'active' : ''}`} onClick={() => pick(f.family)}>
                  <span style={{ fontFamily: fontCss(f.family) }}>{f.family}</span><small style={{ fontFamily: fontCss(f.family) }}>Аа Bb 123</small>
                </button>)}
              </div>;
            })}
            {installed.length > 0 && <div className="font-group">
              <span className="font-group-label">{t('font.system')} · {installed.length}</span>
              {installed.slice(0, 400).map((f) => <button key={f} type="button" role="option" aria-selected={f === value} className={`font-option ${f === value ? 'active' : ''}`} onClick={() => pick(f)}>
                <span style={{ fontFamily: fontCss(f) }}>{f}</span>
              </button>)}
            </div>}
            {!bundled.length && !installed.length && !q && <p className="muted small">…</p>}
          </div>
          <p className="font-picker-hint muted small">{t('font.hint')}</p>
        </div>
      )}
    </div>
  );
}
