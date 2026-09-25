import { BrowserWindow, ipcMain } from 'electron';
import type { IpcInvoke, IpcPush } from '@shared/types';

type Handlers = { [K in keyof IpcInvoke]: (...args: Parameters<IpcInvoke[K]>) => ReturnType<IpcInvoke[K]> | Promise<ReturnType<IpcInvoke[K]>> };

export function registerIpc(handlers: Handlers): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args));
  }
}

export function push<K extends keyof IpcPush>(channel: K, payload: IpcPush[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
