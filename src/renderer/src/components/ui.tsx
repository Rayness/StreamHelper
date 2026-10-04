import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ConnectionStatus } from '@shared/types';
import { useT } from '../i18n';
import { call } from '../store';
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

export function Field({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
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
