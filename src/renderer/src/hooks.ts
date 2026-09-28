import { useCallback, useEffect, useState } from 'react';
import { useApp } from './store';

/** Current time, re-rendering every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Clock time in the app's language (the system locale could turn a Russian UI into "03:58 PM"). */
export function useClock(): (ts: number) => string {
  const lang = useApp((d) => d.settings?.language ?? 'ru');
  return useCallback((ts: number) => new Date(ts).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' }), [lang]);
}
