import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ConnectionStatus } from '@shared/types';
import { useT } from '../i18n';
import { call, resolveConfirm, useConfirm } from '../store';
import { Icon, type IconName } from './icons';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: { variant?: Variant; size?: 'sm' | 'md'; icon?: IconName } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  active,
  className = '',
  ...rest
}: { icon: IconName; label: string; variant?: Variant; active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`icon-btn btn-${variant} ${active ? 'active' : ''} ${className}`} title={label} aria-label={label} {...rest}>
      <Icon name={icon} size={17} />
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

/**
 * A click on a <label> activates its first control. For fields holding several controls
 * (a list of toggles, color + hex, media picker) a click on empty space or the caption
 * flipped an unrelated setting, so only a lone control is activated from the caption.
 */
function guardFieldClick(e: React.MouseEvent<HTMLLabelElement>) {
  const target = e.target as Element;
  if (target.closest('input, select, textarea, button, a, summary, .toggle')) return;
  const controls = e.currentTarget.querySelectorAll('input, select, textarea, button');
  if (!target.closest('.field-label') || controls.length !== 1) e.preventDefault();
}

export function Field({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`} onClick={guardFieldClick}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono,
  ...rest
}: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; mono?: boolean; autoFocus?: boolean; onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void }) {
  return (
    <input
      className={`input ${mono ? 'mono' : ''}`}
      type={type}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

/** Keeps the raw text while typing so "", "-" and "1." don't get clobbered. */
export function NumberInput({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(value));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // A partial number ("1" while entering "100") must not be replaced by a
    // clamped setting push: that reset moved the caret and the whole form.
    if (document.activeElement !== input.current) setText(String(value));
  }, [value]);
  return (
    <input
      ref={input}
      className="input input-number"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(',', '.'));
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n === clamp(n, min, max)) onChange(n);
      }}
      onBlur={() => {
        const n = Number(text.replace(',', '.'));
        if (text.trim() !== '' && Number.isFinite(n)) {
          const next = clamp(n, min, max);
          if (next !== value) onChange(next);
          setText(String(next));
        } else setText(String(value));
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const next = clamp(value + (e.key === 'ArrowUp' ? step : -step), min, max);
          setText(String(next));
          onChange(next);
        }
      }}
    />
  );
}

function clamp(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

export function TextArea({ value, onChange, rows = 3, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <textarea className="input textarea" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** Edits a string[] as one item per line. */
export function LinesInput({ value, onChange, rows = 4, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(value.join('\n'));
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (document.activeElement === input.current) return;
    if (text.split('\n').filter((l) => l.trim()).join('\n') !== value.join('\n')) setText(value.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <textarea
      ref={input}
      className="input textarea"
      rows={rows}
      value={text}
      placeholder={placeholder}
      onBlur={() => setText(value.join('\n'))}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean));
      }}
    />
  );
}

export function Select<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <select className="input select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
  return (
    <div className="color-input">
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} />
      <input className="input mono" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </div>
  );
}

function parseRgba(raw: string): { hex: string; alpha: number; transparent: boolean } {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent') return { hex: '#14121c', alpha: 0, transparent: true };
  const hex6 = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex6) return { hex: `#${hex6[1]}`, alpha: 100, transparent: false };
  const hex8 = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(trimmed);
  if (hex8) {
    const alpha = Math.round((parseInt(hex8[2], 16) / 255) * 100);
    return { hex: `#${hex8[1]}`, alpha, transparent: alpha === 0 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgba) {
    const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    const alpha = rgba[4] === undefined ? 100 : Math.round(Math.max(0, Math.min(1, Number(rgba[4]))) * 100);
    return { hex: `#${toHex(rgba[1])}${toHex(rgba[2])}${toHex(rgba[3])}`, alpha, transparent: alpha === 0 };
  }
  return { hex: '#14121c', alpha: 80, transparent: false };
}

function formatRgba(hex: string, alpha: number): string {
  if (alpha <= 0) return 'transparent';
  const clean = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!clean) return hex;
  const n = parseInt(clean[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  if (alpha >= 100) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${Number((alpha / 100).toFixed(2))})`;
}

/** Visual color + opacity picker that stores standard CSS rgba(...) / transparent strings. */
export function RgbaColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const parsed = parseRgba(value);
  return (
    <div className="rgba-input">
      <div className="rgba-top">
        <label className="rgba-swatch" title={t('ui.pickColor')}>
          <span className="rgba-swatch-preview" style={{ background: parsed.transparent ? 'transparent' : value }} />
          <input
            type="color"
            value={parsed.hex}
            onChange={(e) => onChange(formatRgba(e.target.value, parsed.alpha || 75))}
          />
        </label>
        <div className="rgba-slider">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={parsed.alpha}
            aria-label={t('ui.opacity')}
            onChange={(e) => onChange(formatRgba(parsed.hex, Number(e.target.value)))}
          />
          <output>{parsed.alpha}%</output>
        </div>
        <button
          type="button"
          className={`btn btn-ghost btn-sm rgba-clear ${parsed.transparent ? 'active' : ''}`}
          onClick={() => onChange(parsed.transparent ? formatRgba(parsed.hex, 75) : 'transparent')}
        >
          {t('ui.transparent')}
        </button>
      </div>
    </div>
  );
}

/** Horizontal setting row: title + hint on the left, control aligned on the right. */
export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-info">
        <span className="setting-row-label">{label}</span>
        {hint && <span className="setting-row-hint">{hint}</span>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

/** Stacked SettingRow items with clean hairline dividers. */
export function SettingList({ children }: { children: ReactNode }) {
  return <div className="setting-list">{children}</div>;
}

/** Progressive-disclosure block for secondary / technical settings. */
export function AdvancedSection({ title, children, defaultOpen = false }: { title?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const t = useT();
  return (
    <details className="advanced-section" open={defaultOpen || undefined}>
      <summary>
        <Icon name="sliders" size={14} />
        <span>{title ?? t('ui.advanced')}</span>
        <Icon name="chevronDown" size={14} className="advanced-chevron" />
      </summary>
      <div className="advanced-body">{children}</div>
    </details>
  );
}

/** In-app confirmation modal replacing native window.confirm(). */
export function ConfirmModal() {
  const t = useT();
  const req = useConfirm();
  const confirmBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false); }
    };
    window.addEventListener('keydown', onKey);
    const id = setTimeout(() => confirmBtn.current?.focus(), 0);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(id); };
  }, [req]);
  if (!req) return null;
  return (
    <div className="confirm-backdrop" onMouseDown={() => resolveConfirm(false)}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={req.title ?? t('ui.confirmTitle')} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{req.title ?? t('ui.confirmTitle')}</h3>
        <p>{req.message}</p>
        <div className="confirm-actions">
          <Button variant="secondary" onClick={() => resolveConfirm(false)}>{req.cancelLabel ?? t('common.cancel')}</Button>
          <button
            ref={confirmBtn}
            type="button"
            className={`btn btn-${req.danger ? 'danger' : 'primary'} btn-md`}
            data-confirm-accept
            onClick={() => resolveConfirm(true)}
          >
            {req.confirmLabel ?? t('ui.confirmOk')}
          </button>
        </div>
      </section>
    </div>
  );
}

export function Card({ title, actions, children, className = '', icon }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; icon?: IconName }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <h3>
            {icon && <Icon name={icon} size={16} />}
            {title}
          </h3>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function StatusDot({ status }: { status: ConnectionStatus }) {
  return <span className={`status-dot status-${status}`} />;
}

export function StatusText({ status, error }: { status: ConnectionStatus; error?: string }) {
  const t = useT();
  return (
    <span className={`status-text status-${status}`} title={error}>
      <StatusDot status={status} />
      {t(`status.${status}`)}
    </span>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      {label && <span className="copy-label">{label}</span>}
      <input className="input mono" readOnly value={value} onFocus={(e) => e.target.select()} />
      <Button
        size="sm"
        icon={copied ? 'check' : 'copy'}
        onClick={() => {
          void call('clipboard:write', value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Row({ children, gap = 12, wrap, align }: { children: ReactNode; gap?: number; wrap?: boolean; align?: 'center' | 'end' | 'start' }) {
  return <div style={{ display: 'flex', gap, flexWrap: wrap ? 'wrap' : undefined, alignItems: align ?? 'center' }}>{children}</div>;
}

export function Grid({ children, min = 220 }: { children: ReactNode; min?: number }) {
  return <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>{children}</div>;
}
