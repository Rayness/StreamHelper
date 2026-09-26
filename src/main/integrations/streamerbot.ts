import type { AppContext } from '../core/context';

/** Talks to Streamer.bot's local HTTP server. The host is deliberately fixed to loopback. */
export class StreamerBotService {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private ctx: AppContext) {}

  private endpoint(path: string): string {
    const port = this.ctx.settings.get('streamerbot').port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Streamer.bot port');
    return `http://127.0.0.1:${port}/${path}`;
  }

  async refresh(): Promise<void> {
    if (!this.ctx.settings.get('streamerbot').enabled) return;
    const generation = this.generation;
    try {
      const response = await fetch(this.endpoint('GetActions'), { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { actions?: { id: string; name: string }[] };
      if (!Array.isArray(data.actions)) throw new Error('Invalid action list');
      if (generation !== this.generation) return;
      this.ctx.state.replace('streamerbot', {
        status: 'connected',
        actions: data.actions.filter((a) => typeof a.id === 'string' && typeof a.name === 'string'),
      });
    } catch (err) {
      if (generation !== this.generation) return;
      this.ctx.state.patch('streamerbot', { status: 'error', error: err instanceof Error ? err.message : String(err), actions: [] });
    }
  }

  async run(actionId: string): Promise<void> {
    if (!this.ctx.settings.get('streamerbot').enabled) throw new Error('Streamer.bot is disabled');
    if (!actionId) throw new Error('Select a Streamer.bot action');
    const response = await fetch(this.endpoint('DoAction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: { id: actionId } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Streamer.bot HTTP ${response.status}`);
  }

  connect(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Streamer.bot port');
    this.stop();
    this.ctx.settings.set('streamerbot', { enabled: true, port });
    this.ctx.state.patch('streamerbot', { status: 'connecting', error: undefined });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 15_000);
  }

  start(): void {
    if (this.ctx.settings.get('streamerbot').enabled) this.connect(this.ctx.settings.get('streamerbot').port);
  }

  disconnect(): void {
    this.stop();
    this.ctx.settings.set('streamerbot', { ...this.ctx.settings.get('streamerbot'), enabled: false });
  }

  stop(): void {
    ++this.generation;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ctx.state.replace('streamerbot', { status: 'disconnected', actions: [] });
  }
}
