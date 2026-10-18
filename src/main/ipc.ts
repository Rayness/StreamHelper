import { BrowserWindow, ipcMain } from 'electron';
import type { IpcInvoke, IpcPush } from '@shared/types';

type Handlers = { [K in keyof IpcInvoke]: (...args: Parameters<IpcInvoke[K]>) => ReturnType<IpcInvoke[K]> | Promise<ReturnType<IpcInvoke[K]>> };

let registered: Partial<Handlers> = {};
const pushListeners = new Set<<K extends keyof IpcPush>(channel: K, payload: IpcPush[K]) => void>();

export function registerIpc(handlers: Handlers): void {
  registered = handlers;
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args));
  }
}

/** Run a registered handler outside Electron IPC (remote access). Permission checks are the caller's job. */
export async function invokeHandler(channel: string, args: unknown[]): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(registered, channel)) throw new Error(`Unknown channel ${channel}`);
  return (registered[channel as keyof IpcInvoke] as (...a: unknown[]) => unknown)(...args);
}

/** Also deliver pushes elsewhere (remote access browsers). */
export function onPush(listener: <K extends keyof IpcPush>(channel: K, payload: IpcPush[K]) => void): () => void {
  pushListeners.add(listener);
  return () => pushListeners.delete(listener);
}

export function push<K extends keyof IpcPush>(channel: K, payload: IpcPush[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
  for (const listener of pushListeners) {
    try {
      listener(channel, payload);
    } catch (err) {
      console.error('[ipc] push listener failed', err);
    }
  }
}
