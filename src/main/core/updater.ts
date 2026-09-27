import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { AppContext } from './context';

/** Check GitHub Releases and download updates in the background. Installation is user initiated. */
export class UpdateService {
  private updater = electronUpdater.autoUpdater;
  private timer: NodeJS.Timeout | null = null;

  constructor(private ctx: AppContext) {
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.on('checking-for-update', () => this.set('checking'));
    this.updater.on('update-available', (info) => {
      this.ctx.state.patch('update', { status: 'available', version: info.version, progress: 0, error: null });
    });
    this.updater.on('update-not-available', () => this.set('upToDate'));
    this.updater.on('download-progress', ({ percent }) => {
      this.ctx.state.patch('update', { status: 'downloading', progress: Math.round(percent) });
    });
    this.updater.on('update-downloaded', (info) => {
      this.ctx.state.patch('update', { status: 'ready', version: info.version, progress: 100, error: null });
    });
    this.updater.on('error', (error) => {
      console.warn('[updater]', error);
      this.ctx.state.patch('update', { status: 'error', error: error.message });
    });
  }

  start(): void {
    if (!app.isPackaged || process.platform !== 'win32') {
      this.set('unsupported');
      return;
    }
    setTimeout(() => void this.check(), 15_000);
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (!app.isPackaged || process.platform !== 'win32') {
      this.set('unsupported');
      return;
    }
    const status = this.ctx.state.current.update.status;
    if (status === 'checking' || status === 'downloading' || status === 'ready') return;
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.ctx.state.patch('update', { status: 'error', error: String((error as Error).message ?? error) });
    }
  }

  install(): void {
    if (this.ctx.state.current.update.status !== 'ready') throw new Error('No downloaded update is ready');
    this.ctx.settings.flush();
    this.updater.quitAndInstall(false, true);
  }

  private set(status: 'checking' | 'upToDate' | 'unsupported'): void {
    this.ctx.state.patch('update', { status, version: null, progress: 0, error: null });
  }
}
