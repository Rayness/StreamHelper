import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { initialRuntimeState } from '../src/main/core/state';
import { createDockRoutes } from '../src/main/overlay/dock';

describe('OBS dock', () => {
  it('requires its token for state and actions and only forwards authorized actions', async () => {
    const action = vi.fn();
    const route = createDockRoutes({
      token: 'a'.repeat(64),
      htmlPath: join(process.cwd(), 'resources', 'overlays', 'dock.html'),
      snapshot: () => ({ state: initialRuntimeState(), settings: defaultSettings('en') }),
      action,
    });
    const server = createServer((req, res) => {
      void route(req, res, new URL(req.url ?? '/', 'http://localhost'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/dock/state`)).status).toBe(403);
      expect((await fetch(`${base}/dock/state?token=${'a'.repeat(64)}`)).status).toBe(200);
      const denied = await fetch(`${base}/dock/action`, { method: 'POST', body: JSON.stringify({ name: 'stream' }) });
      expect(denied.status).toBe(403);
      expect(action).not.toHaveBeenCalled();
      const allowed = await fetch(`${base}/dock/action`, {
        method: 'POST',
        headers: { 'X-StreamHelper-Dock-Token': 'a'.repeat(64) },
        body: JSON.stringify({ name: 'scene', id: 'Main' }),
      });
      expect(allowed.status).toBe(204);
      expect(action).toHaveBeenCalledWith('scene', 'Main');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
