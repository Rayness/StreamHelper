import { useSyncExternalStore } from 'react';
import type { ChatMessage, IpcInvoke, IpcPush, RuntimeState, Settings, SettingsKey, StreamEvent } from '@shared/types';

export interface Toast {
  id: number;
  kind: IpcPush['toast']['kind'];
  key: string;
  params?: Record<string, string | number>;
}

export interface AppData {
  ready: boolean;
  version: string;
  settings: Settings | null;
  state: RuntimeState | null;
  chat: ChatMessage[];
  events: StreamEvent[];
  toasts: Toast[];
}

const CHAT_LIMIT = 500;

let data: AppData = { ready: false, version: '', settings: null, state: null, chat: [], events: [], toasts: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<AppData>): void {
  data = { ...data, ...patch };
  listeners.forEach((l) => l());
}

export function useApp<T>(select: (d: AppData) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(data),
  );
}

export const getData = () => data;

let toastSeq = 0;
export function toast(kind: Toast['kind'], key: string, params?: Toast['params']): void {
  const t: Toast = { id: ++toastSeq, kind, key, params };
  set({ toasts: [...data.toasts, t].slice(-4) });
  setTimeout(() => set({ toasts: data.toasts.filter((x) => x.id !== t.id) }), kind === 'error' ? 7000 : 4000);
}

export function dismissToast(id: number): void {
  set({ toasts: data.toasts.filter((x) => x.id !== id) });
}

/** Call the main process; failures become an error toast and resolve to undefined. */
export async function call<K extends keyof IpcInvoke>(
  channel: K,
  ...args: Parameters<IpcInvoke[K]>
): Promise<Awaited<ReturnType<IpcInvoke[K]>> | undefined> {
  try {
    return await window.api.invoke(channel, ...args);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast('error', 'toast.actionError', { error: msg });
    return undefined;
  }
}

/** Like `call`, but reports success for void calls. */
export async function callOk<K extends keyof IpcInvoke>(channel: K, ...args: Parameters<IpcInvoke[K]>): Promise<boolean> {
  try {
    await window.api.invoke(channel, ...args);
    return true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast('error', 'toast.actionError', { error: msg });
    return false;
  }
}

/**
 * Saves in flight. While > 0 we ignore settings pushes from main: they may predate our latest
 * keystroke and would make inputs jump. Main always pushes again ~50ms after the last save lands.
 */
let pendingSaves = 0;

/** Optimistically update a settings section and persist it. */
export function saveSettings<K extends SettingsKey>(key: K, value: Settings[K]): void {
  if (!data.settings) return;
  set({ settings: { ...data.settings, [key]: value } });
  pendingSaves++;
  void call('settings:set', key, value).finally(() => pendingSaves--);
}

// ---------- navigation ----------

export type Page = 'dashboard' | 'interactive' | 'alerts' | 'overlays' | 'bot' | 'obs' | 'kawaki' | 'connections' | 'settings';

interface NavState {
  page: Page;
  /** Last open tab / item per page, so coming back lands where you left. */
  sub: Partial<Record<Page, string>>;
}

function readNav(): NavState {
  try {
    const raw = JSON.parse(localStorage.getItem('nav') ?? 'null');
    if (raw && typeof raw.page === 'string') return { page: raw.page, sub: raw.sub ?? {} };
  } catch {
    /* private mode, corrupted value */
  }
  return { page: 'dashboard', sub: {} };
}

let nav: NavState = readNav();
const navListeners = new Set<() => void>();

function setNav(next: NavState): void {
  nav = next;
  try {
    localStorage.setItem('nav', JSON.stringify(nav));
  } catch {
    /* ignore */
  }
  navListeners.forEach((l) => l());
}

export function navigate(page: Page, sub?: string): void {
  setNav({ page, sub: sub === undefined ? nav.sub : { ...nav.sub, [page]: sub } });
}

export function useNav(): NavState {
  return useSyncExternalStore(
    (l) => {
      navListeners.add(l);
      return () => navListeners.delete(l);
    },
    () => nav,
  );
}

/** A page's remembered tab. Unknown stored values fall back to `fallback`. */
export function useSub<T extends string>(page: Page, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const n = useNav();
  const raw = n.sub[page] as T | undefined;
  const value = raw && (!allowed || allowed.includes(raw)) ? raw : fallback;
  return [value, (v: T) => setNav({ ...nav, sub: { ...nav.sub, [page]: v } })];
}

export async function init(): Promise<void> {
  window.api.on('state', (state) => set({ state }));
  window.api.on('settings', (settings) => {
    if (pendingSaves === 0) set({ settings });
  });
  window.api.on('chat:message', (m) => {
    const chat = data.chat.length >= CHAT_LIMIT ? data.chat.slice(-CHAT_LIMIT + 1) : data.chat.slice();
    chat.push(m);
    set({ chat });
  });
  window.api.on('chat:delete', ({ id }) => set({ chat: data.chat.map((m) => (m.id === id ? { ...m, deleted: true } : m)) as ChatMessage[] }));
  window.api.on('chat:clearUser', ({ userId }) =>
    set({ chat: data.chat.map((m) => (m.userId === userId ? { ...m, deleted: true } : m)) as ChatMessage[] }),
  );
  window.api.on('chat:clear', () => set({ chat: [] }));
  window.api.on('event', (e) => set({ events: [e, ...data.events].slice(0, 200) }));
  window.api.on('toast', (t) => toast(t.kind, t.key, t.params));

  const initial = await window.api.invoke('app:init');
  set({ ready: true, ...initial });
}
