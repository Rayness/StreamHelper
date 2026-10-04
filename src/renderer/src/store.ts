import { useSyncExternalStore } from 'react';
import type { ChatMessage, IpcInvoke, IpcPush, RuntimeState, Settings, SettingsKey, StreamEvent } from '@shared/types';
import { reconcile } from '@shared/reconcile';
import { resolveModuleAccess, workspaceTarget, isWorkspaceModule } from '@shared/workspace';
import type { WorkspaceCard } from '@shared/types';

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
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function set(patch: Partial<AppData>): void {
  data = { ...data, ...patch };
  listeners.forEach((l) => l());
}

export function useApp<T>(select: (d: AppData) => T): T {
  return useSyncExternalStore(
    subscribe,
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
let settingsWrite: Promise<unknown> = Promise.resolve();
/** Last settings received from main: what the open forms are based on (see `settings:set`). */
let confirmed: Settings | null = null;
let deferredSettings: Settings | null = null;
const queuedSaves = new Map<string, () => Promise<void>>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function applySettings(settings: Settings): void {
  confirmed = settings;
  set({ settings: data.settings ? reconcile(data.settings, settings) : settings });
}

function flushSaves(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const jobs = [...queuedSaves.values()];
  queuedSaves.clear();
  for (const job of jobs) settingsWrite = settingsWrite.then(job);
}

/** Optimistically update a settings section and persist it. */
export function saveSettings<K extends SettingsKey>(key: K, value: Settings[K]): void {
  if (!data.settings) return;
  const profileId = data.settings.activeProfileId;
  const base = confirmed?.activeProfileId === profileId ? confirmed[key] : undefined;
  set({ settings: { ...data.settings, [key]: value } });
  const id = `${profileId}:${key}`;
  if (!queuedSaves.has(id)) pendingSaves++;
  queuedSaves.set(id, async () => {
    try {
      const saved = await call('settings:set', key, value, profileId, base);
      if (saved) { confirmed = saved; deferredSettings = saved; }
    } finally {
      pendingSaves--;
      if (pendingSaves === 0 && deferredSettings) { applySettings(deferredSettings); deferredSettings = null; }
    }
  });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 120);
}

/** Serialize profile operations and section resets after pending form writes. */
export async function profileAction<K extends 'profiles:create' | 'profiles:rename' | 'profiles:activate' | 'profiles:delete' | 'profiles:overlay' | 'settings:reset'>(
  channel: K,
  ...args: Parameters<IpcInvoke[K]>
): Promise<boolean> {
  flushSaves();
  pendingSaves++;
  const operation = settingsWrite.then(async () => {
    const settings = await call(channel, ...args);
    if (!settings) return false;
    deferredSettings = null;
    applySettings(settings);
    return true;
  });
  settingsWrite = operation.finally(() => pendingSaves--);
  return operation;
}

// ---------- navigation ----------

export type Page = 'workspace' | 'dashboard' | 'interactive' | 'alerts' | 'overlays' | 'profiles' | 'bot' | 'obs' | 'kawaki' | 'connections' | 'settings';

interface NavState {
  page: 'workspace' | 'dashboard';
  module?: WorkspaceCard;
  catalog?: true | WorkspaceCard;
  dialog?: 'profiles' | 'settings';
  /** Last open tab / item per page, so coming back lands where you left. */
  sub: Partial<Record<Page, string>>;
}

function readNav(): NavState {
  try {
    const raw = JSON.parse(localStorage.getItem('nav') ?? 'null');
    if (raw && typeof raw.page === 'string') {
      const sub = raw.sub && typeof raw.sub === 'object' ? raw.sub : {};
      return { page: raw.version === 2 && raw.page === 'dashboard' ? 'dashboard' : 'workspace', sub,
        module: isWorkspaceModule(raw.module) ? raw.module : workspaceTarget(raw.page, sub[raw.page]) };
    }
  } catch {
    /* private mode, corrupted value */
  }
  return { page: 'workspace', sub: {} };
}

let nav: NavState = readNav();
const navListeners = new Set<() => void>();

function setNav(next: NavState): void {
  nav = next;
  try {
    localStorage.setItem('nav', JSON.stringify({ ...nav, version: 2 }));
  } catch {
    /* ignore */
  }
  navListeners.forEach((l) => l());
}

export function navigate(page: Page, sub?: string): void {
  flushSaves();
  const remembered = sub === undefined ? nav.sub : { ...nav.sub, [page]: sub };
  if (page === 'profiles' || page === 'settings') { setNav({ ...nav, dialog: page, sub: remembered }); return; }
  const target = workspaceTarget(page, sub ?? remembered[page]);
  setNav({ page: page === 'dashboard' ? 'dashboard' : 'workspace', sub: remembered,
    ...resolveModuleAccess(target, data.settings?.workspace.cards) });
}

export function openModule(module: WorkspaceCard): void {
  flushSaves();
  setNav({ page: 'workspace', sub: nav.sub, ...resolveModuleAccess(module, data.settings?.workspace.cards) });
}

export function openCatalog(): void { flushSaves(); setNav({ page: 'workspace', sub: nav.sub, catalog: true }); }
export function closeDialog(): void { setNav({ ...nav, dialog: undefined }); }

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
  window.addEventListener('beforeunload', flushSaves);
  window.api.on('state', (state) => set({ state: data.state ? reconcile(data.state, state) : state }));
  window.api.on('settings', (settings) => {
    if (pendingSaves === 0) applySettings(settings);
    else deferredSettings = settings;
  });
  let incoming: ChatMessage[] = [];
  let chatTimer: ReturnType<typeof setTimeout> | null = null;
  const flushChat = () => {
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = null;
    if (!incoming.length) return;
    set({ chat: [...data.chat, ...incoming].slice(-CHAT_LIMIT) });
    incoming = [];
  };
  window.api.on('chat:message', (m) => {
    incoming.push(m);
    if (incoming.length > CHAT_LIMIT) incoming = incoming.slice(-CHAT_LIMIT);
    if (!chatTimer) chatTimer = setTimeout(flushChat, document.hidden ? 500 : 50);
  });
  window.api.on('chat:delete', ({ id }) => { flushChat(); set({ chat: data.chat.map((m) => (m.id === id ? { ...m, deleted: true } : m)) as ChatMessage[] }); });
  window.api.on('chat:clearUser', ({ userId }) =>
    { flushChat(); set({ chat: data.chat.map((m) => (m.userId === userId ? { ...m, deleted: true } : m)) as ChatMessage[] }); },
  );
  window.api.on('chat:clear', () => { incoming = []; set({ chat: [] }); });
  window.api.on('event', (e) => set({ events: [e, ...data.events].slice(0, 200) }));
  window.api.on('toast', (t) => toast(t.kind, t.key, t.params));

  const initial = await window.api.invoke('app:init');
  confirmed = initial.settings;
  set({ ready: true, ...initial });
}
