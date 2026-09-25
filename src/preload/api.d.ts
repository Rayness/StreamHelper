import type { IpcInvoke, IpcPush } from '../shared/types';

declare global {
  interface Window {
    api: {
      invoke<K extends keyof IpcInvoke>(channel: K, ...args: Parameters<IpcInvoke[K]>): Promise<Awaited<ReturnType<IpcInvoke[K]>>>;
      on<K extends keyof IpcPush>(channel: K, listener: (payload: IpcPush[K]) => void): () => void;
    };
  }
}

export {};
