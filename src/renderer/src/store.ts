import { useSyncExternalStore } from 'react';
import type { ChatMessage, IpcInvoke, IpcPush, RuntimeState, Settings, SettingsKey, StreamEvent } from '@shared/types';
import { reconcile } from '@shared/reconcile';
import { variantDiff, withVariant } from '@shared/variants';
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
  /** Windows can draw Mica / Acrylic behind the window. */
  windowMaterial: boolean;
  settings: Settings | null;
  state: RuntimeState | null;
  chat: ChatMessage[];
  events: StreamEvent[];
  toasts: Toast[];
}

const CHAT_LIMIT = 500;

let data: AppData = { ready: false, version: '', windowMaterial: false, settings: null, state: null, chat: [], events: [], toasts: [] };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function set(patch: Partial<AppData>): void {
  data = { ...data, ...patch };
  listeners.forEach((l) => l());
}

// ---------- per-scene variant editing ----------

/**
 * While a module editor edits the settings of one OBS scene, every form reads that scene's
 * version of the section and `saveSettings` stores only the differences in `overlayVariants`.
 * The forms themselves don't know about scenes.
 */
export interface VariantScope { key: SettingsKey; variantId: string }
let scope: VariantScope | null = null;
const scopeListeners = new Set<() => void>();
let viewCache: { data: AppData; scope: VariantScope | null; view: AppData } | null = null;

function view(): AppData {
  if (!scope || !data.settings) return data;
  if (viewCache && viewCache.data === data && viewCache.scope === scope) return viewCache.view;
  const variant = data.settings.overlayVariants?.find((v) => v.id === scope!.variantId);
  const settings = variant ? { ...data.settings, [scope.key]: withVariant(data.settings[scope.key], variant.overrides) } as Settings : data.settings;
  viewCache = { data, scope, view: { ...data, settings } };
  return viewCache.view;
}

export function setVariantScope(next: VariantScope | null): void {
  if (scope?.key === next?.key && scope?.variantId === next?.variantId) return;
  scope = next;
  scopeListeners.forEach((l) => l());
  listeners.forEach((l) => l());
}

export function useVariantScope(): VariantScope | null {
  return useSyncExternalStore((l) => { scopeListeners.add(l); return () => scopeListeners.delete(l); }, () => scope);
}

export function useApp<T>(select: (d: AppData) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(view()),
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
    if (channel === 'alerts:test' || channel === 'overlays:test' || channel === 'chat:test') {
      const profileId = data.settings?.activeProfileId;
      flushSaves();
      await settingsWrite;
      if (data.settings?.activeProfileId !== profileId) return undefined;
    }
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
  if (scope && scope.key === key) {
    const id = scope.variantId;
    const variants = data.settings.overlayVariants ?? [];
    if (!variants.some((v) => v.id === id)) return;
    const overrides = variantDiff(data.settings[key], value);
    saveSettings('overlayVariants', variants.map((v) => (v.id === id ? { ...v, overrides } : v)));
    return;
  }
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

export type Page = 'workspace' | 'dashboard' | 'interactive' | 'alerts' | 'overlays' | 'profiles' | 'bot' | 'obs' | 'kawaki' | 'connections' | 'settings' | 'variables' | 'designer';
type TopPage = 'workspace' | 'dashboard' | 'connections' | 'variables' | 'designer';
const TOP_PAGES: readonly TopPage[] = ['connections', 'variables', 'designer'];

interface NavState {
  page: TopPage;
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
      if (['twitch','donationalerts','streamlabs','streamelements','streamerbot','discord','subforstream'].includes(raw.module)) return { page:'connections',sub:{...sub,connections:raw.module} };
      if (TOP_PAGES.includes(raw.page)) return { page: raw.page, sub };
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
  if (page === 'connections' || page === 'variables' || page === 'designer') { setNav({ page, sub: remembered }); return; }
  const target = workspaceTarget(page, sub ?? remembered[page]);
  setNav({ page: page === 'dashboard' ? 'dashboard' : 'workspace', sub: remembered,
    ...resolveModuleAccess(target, data.settings?.workspace.cards) });
}

export function openModule(module: WorkspaceCard): void {
  if (['twitch','donationalerts','streamlabs','streamelements','streamerbot','discord','subforstream'].includes(module)) { navigate('connections', module); return; }
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
