import { useState } from 'react';
import { useT } from '../i18n';
import { IconButton } from './ui';

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

/** KeyboardEvent -> Electron accelerator ("Ctrl+Shift+F5"), or null for modifier-only presses. */
export function toAccelerator(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = e.code;
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = 'num' + code.slice(6);
  else key = KEY_NAMES[code];
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  // Bare letters/digits as *global* shortcuts would swallow normal typing everywhere.
  if (mods.length === 0 && !/^F\d+$/.test(key) && !key.startsWith('num')) return null;
  return [...mods, key].join('+');
}

export function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  return (
    <div className="hotkey">
      <input
        className={`input mono ${recording ? 'recording' : ''}`}
        readOnly
        value={recording ? t('hotkey.press') : value || t('hotkey.none')}
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          e.preventDefault();
          if (e.key === 'Escape') return (e.target as HTMLInputElement).blur();
          const acc = toAccelerator(e);
          if (acc) {
            onChange(acc);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {value && <IconButton icon="x" label={t('hotkey.clear')} onClick={() => onChange('')} />}
    </div>
  );
}
