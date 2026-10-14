import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { IpcPush } from '@shared/types';
import { DEFAULT_REMOTE_PORT, normalizePermissions, type RemoteLogEntry, type RemoteModerator, type RemotePermission } from '@shared/remote';
import type { AppContext } from '../core/context';
import { errorMessage } from '../core/context';
import type { SecretsData } from '../core/secrets';
import { CLOSE_UNAUTHORIZED, RemoteServer } from './server';

type Config = NonNullable<SecretsData['remoteAccess']>;
type StoredModerator = Config['moderators'][number];

const LOG_LIMIT = 50;
const newKey = () => randomBytes(24).toString('base64url');

/** IPv4 addresses of this computer on its local networks. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  }
  return out;
}

/** `host` as typed by the streamer (address, host:port or a full https origin of a tunnel) → link base. */
export function linkBase(host: string, port: number): string {
  const value = host.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(value)) return value;
  // host:port (one colon) or [ipv6]:port; a bare IPv6 address has several colons.
  if (/^[^:]+:\d+$/.test(value) || /^\[.*\]:\d+$/.test(value)) return `http://${value}`;
  return `http://${value.includes(':') ? `[${value}]` : value}:${port}`;
}

export interface RemoteDeps {
  rendererDir: string;
  overlayPort: () => number;
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
}

/** Remote access for moderators: settings (in the encrypted secret store), the server and its runtime state. */
export class RemoteAccessService {
  private server: RemoteServer | null = null;
  private log: RemoteLogEntry[] = [];
  private changes: Promise<void> = Promise.resolve();

  constructor(private ctx: AppContext, private deps: RemoteDeps) {}

  private get config(): Config {
    const stored = this.ctx.secrets.get('remoteAccess');
    return { enabled: !!stored?.enabled, port: stored?.port || DEFAULT_REMOTE_PORT, moderators: stored?.moderators ?? [] };
  }

  private save(config: Config): void {
    this.ctx.secrets.set('remoteAccess', config);
    this.publish();
  }

  start(): Promise<void> {
    this.publish();
    return this.apply();
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }

  push<K extends keyof IpcPush>(channel: K, payload: IpcPush[K]): void {
    this.server?.push(channel, payload);
  }

  configure(enabled: boolean, port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
    if (port === this.ctx.settings.get('overlayPort')) throw new Error(this.ru ? 'Этот порт занят сервером оверлеев' : 'This port is used by the overlay server');
    this.save({ ...this.config, enabled, port });
    return this.apply();
  }

  addModerator(name: string, permissions: RemotePermission[]): RemoteModerator {
    const moderator: StoredModerator = { id: `mod_${randomBytes(6).toString('hex')}`, name: cleanName(name), permissions: normalizePermissions(permissions), createdAt: Date.now(), key: newKey() };
    const config = this.config;
    this.save({ ...config, moderators: [...config.moderators, moderator] });
    return publicModerator(moderator);
  }

  updateModerator(id: string, patch: { name?: string; permissions?: RemotePermission[] }): void {
    const config = this.config;
    const current = config.moderators.find((m) => m.id === id);
    if (!current) throw new Error('Unknown moderator');
    const next: StoredModerator = {
      ...current,
      ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
      ...(patch.permissions !== undefined ? { permissions: normalizePermissions(patch.permissions) } : {}),
    };
    this.save({ ...config, moderators: config.moderators.map((m) => (m.id === id ? next : m)) });
    this.server?.reloadModerator(id);
  }

  removeModerator(id: string): void {
    const config = this.config;
    this.save({ ...config, moderators: config.moderators.filter((m) => m.id !== id) });
    this.server?.disconnectModerator(id);
  }

  resetKey(id: string): void {
    const config = this.config;
    if (!config.moderators.some((m) => m.id === id)) throw new Error('Unknown moderator');
    this.save({ ...config, moderators: config.moderators.map((m) => (m.id === id ? { ...m, key: newKey() } : m)) });
    this.server?.disconnectModerator(id, CLOSE_UNAUTHORIZED);
  }

  kick(clientId: string): void {
    this.server?.kick(clientId);
  }

  link(id: string, host?: string): string {
    const config = this.config;
    const moderator = config.moderators.find((m) => m.id === id);
    if (!moderator) throw new Error('Unknown moderator');
    const base = linkBase(host?.trim() || lanAddresses()[0] || '127.0.0.1', config.port);
    return `${base}/?key=${encodeURIComponent(moderator.key)}`;
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  /** Bring the server in line with the settings (serialized: toggling fast must not race). */
  private apply(): Promise<void> {
    const run = this.changes.then(async () => {
      const { enabled, port } = this.config;
      if (this.server && (!enabled || this.server.port !== port)) await this.stop();
      if (!enabled) { this.ctx.state.patch('remote', { status: 'off', error: null, clients: [] }); return; }
      if (this.server) return;
      const server = new RemoteServer({
        port,
        rendererDir: this.deps.rendererDir,
        overlayPort: this.deps.overlayPort,
        moderators: () => this.config.moderators,
        invoke: this.deps.invoke,
        onClientsChanged: (clients) => this.ctx.state.patch('remote', { clients }),
        onAction: (entry) => {
          this.log = [entry, ...this.log].slice(0, LOG_LIMIT);
          this.ctx.state.patch('remote', { log: this.log });
        },
        snapshot: () => ({ state: this.ctx.state.current, settings: this.ctx.settings.all }),
      });
      try {
        await server.start();
        this.server = server;
        this.ctx.state.patch('remote', { status: 'running', port, addresses: lanAddresses(), error: null });
      } catch (err) {
        const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        this.ctx.state.patch('remote', { status: 'error', port, error: busy ? (this.ru ? `Порт ${port} занят другой программой` : `Port ${port} is used by another program`) : errorMessage(err) });
      }
    });
    this.changes = run.catch(() => undefined);
    return run;
  }

  private publish(): void {
    const { port, moderators } = this.config;
    this.ctx.state.patch('remote', { port, moderators: moderators.map(publicModerator), addresses: lanAddresses() });
  }
}

function publicModerator({ key: _key, ...moderator }: StoredModerator): RemoteModerator {
  return moderator;
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Moderator';
}
