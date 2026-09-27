import type { AppContext } from '../core/context';

/** Connects to the local HTTP API exposed by SubForStream without altering its files. */
export class SubForStreamService {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private ctx: AppContext) {
    ctx.bus.on('settings:changed', (key) => { if (key === 'subForStream') void this.check(); });
  }

  start(): void {
    void this.check();
    if (!this.timer) this.timer = setInterval(() => void this.check(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private base(): string {
    const port = this.ctx.settings.get('subForStream').port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid SubForStream port');
    return `http://127.0.0.1:${port}`;
  }

  async check(): Promise<void> {
    if (!this.ctx.settings.get('subForStream').enabled) {
      this.ctx.state.patch('subForStream', { status: 'disconnected', overlayUrl: '', error: undefined });
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      const base = this.base();
      const response = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json() as { port?: unknown; language?: unknown; subtitle_theme?: unknown };
      if (typeof config.port !== 'number' || typeof config.language !== 'string' || typeof config.subtitle_theme !== 'string') throw new Error('Unexpected SubForStream response');
      if (!this.ctx.settings.get('subForStream').enabled || this.base() !== base) return;
      this.ctx.state.patch('subForStream', { status: 'connected', overlayUrl: `${base}/`, error: undefined });
    } catch (error) {
      if (this.ctx.settings.get('subForStream').enabled) this.ctx.state.patch('subForStream', { status: 'error', overlayUrl: '', error: String((error as Error).message ?? error) });
    } finally {
      this.busy = false;
    }
  }

  async clear(): Promise<void> {
    if (this.ctx.state.current.subForStream.status !== 'connected') throw new Error('SubForStream is not connected');
    const response = await fetch(`${this.base()}/api/clear`, { method: 'POST', signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`SubForStream returned HTTP ${response.status}`);
  }
}
