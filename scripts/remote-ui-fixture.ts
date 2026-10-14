import { join } from 'node:path';
import type { RemoteModerator } from '../src/shared/remote';
import type { AppContext } from '../src/main/core/context';
import type { SecretsData } from '../src/main/core/secrets';
import { RemoteServer } from '../src/main/remote/server';
import { RemoteAccessService } from '../src/main/remote/service';
import { createFixture } from './ui-fixture';

/** The UI fixture behind the remote access server, as a moderator's browser sees it. */
export async function createRemoteFixture(root: string, dataDir: string) {
  let remote: RemoteServer | null = null;
  let service: RemoteAccessService | null = null;
  let streamerPush: (channel: string, value: unknown) => void = () => undefined;
  const fixture = await createFixture(root, dataDir, (channel, value) => {
    remote?.push(channel as never, value as never);
    service?.push(channel as never, value as never);
    streamerPush(channel, value);
  });
  const overlayPort = () => Number(new URL(fixture.state.current.overlayUrl).port);
  const moderators: (RemoteModerator & { key: string })[] = [{ id: 'm1', name: 'Анна', permissions: ['alerts', 'settings'], createdAt: 0, key: 'qa-key-anna' }];
  const clients: { id: string }[][] = [];
  remote = new RemoteServer({
    port: 0,
    rendererDir: join(root, 'out/renderer'),
    overlayPort,
    moderators: () => moderators,
    invoke: (channel, args) => fixture.invoke(channel, ...(args as never[])),
    onClientsChanged: (list) => clients.push(list),
    onAction: () => undefined,
    snapshot: () => ({ state: fixture.state.current, settings: fixture.settings.all }),
  });
  await remote.start();
  const server = remote;

  // The streamer's side: the real service, with secrets kept in memory.
  const secrets: SecretsData = {};
  const ctx = {
    secrets: { get: (k: keyof SecretsData) => secrets[k], set: (k: keyof SecretsData, v: unknown) => { (secrets as Record<string, unknown>)[k] = v; } },
    settings: fixture.settings,
    state: fixture.state,
    toast: () => undefined,
  } as unknown as AppContext;
  service = new RemoteAccessService(ctx, { rendererDir: join(root, 'out/renderer'), overlayPort, invoke: (channel, args) => fixture.invoke(channel, ...(args as never[])) });
  await service.start();
  const svc = service;
  const links: string[] = [];

  /** What the streamer's window calls: remote access goes to the service, the rest to the fixture. */
  async function streamerInvoke(channel: string, ...args: any[]) {
    switch (channel) {
      case 'remote:configure': return svc.configure(args[0], args[1]);
      case 'remote:addModerator': return svc.addModerator(args[0], args[1]);
      case 'remote:updateModerator': return svc.updateModerator(args[0], args[1]);
      case 'remote:removeModerator': return svc.removeModerator(args[0]);
      case 'remote:link': { const link = svc.link(args[0], args[1]); links.push(link); return link; }
      case 'remote:resetKey': return svc.resetKey(args[0]);
      case 'remote:kick': return svc.kick(args[0]);
      default: return fixture.invoke(channel, ...args);
    }
  }

  return {
    fixture, server, moderators, clients, secrets, links, streamerInvoke,
    onStreamerPush(fn: (channel: string, value: unknown) => void) { streamerPush = fn; },
    url: `http://127.0.0.1:${server.port}`,
    async stop() { await svc.stop(); await server.stop(); await fixture.stop(); },
  };
}
