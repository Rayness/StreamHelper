import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { OverlayServer } from '../src/main/overlay/server';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'streamhelper-media-'));
  writeFileSync(join(dir,'sample.mp3'),'0123456789');
  const clients: number[] = [];
  const server = new OverlayServer({ port:0, mediaDir:dir, overlaysDir:resolve('resources/overlays'), initialMessages:() => [{type:'profileVisibility', visible:true}], onClientsChanged:(count)=>clients.push(count) });
  cleanups.push(async () => { await server.stop(); rmSync(dir, { recursive:true, force:true }); });
  await server.start();
  return { server, clients, url:`http://127.0.0.1:${server.port}` };
}

describe('overlay server restart and media', () => {
  it.each([['bytes=2-5','2345','bytes 2-5/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=7-','789','bytes 7-9/10'],['bytes=-50','0123456789','bytes 0-9/10']])('serves correct audio/video range %s', async (range, text, contentRange) => {
    const h = await setup();
    const response = await fetch(h.url+'/media/sample.mp3', { headers:{Range:range} });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(await response.text()).toBe(text);
  });

  it.each(['bytes=-0','bytes=10-','bytes=8-2','bytes=-','bytes=invalid','bytes=0-2,4-6'])('rejects unusable range %s without throwing', async (range) => {
    const h = await setup();
    const response = await fetch(h.url+'/media/sample.mp3', { headers:{Range:range} });
    expect(response.status).toBe(416);
    expect(await response.text()).toBe('');
  });

  it('serves HEAD metadata without a file body', async () => {
    const h = await setup();
    const response = await fetch(h.url+'/media/sample.mp3', { method:'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(await response.text()).toBe('');
  });

  it('excludes previews from OBS counts and drops old clients on restart', async () => {
    const h = await setup();
    const sockets = [new WebSocket(h.url.replace('http:','ws:')+'/ws?kind=chat'), new WebSocket(h.url.replace('http:','ws:')+'/ws?kind=alerts&preview=1')];
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve,reject) => { socket.on('open',resolve); socket.on('error',reject); })));
    expect(h.clients.at(-1)).toBe(1);
    await h.server.restart(0);
    expect(h.clients.at(-1)).toBe(0);
    const response = await fetch(`http://127.0.0.1:${h.server.port}/overlay/chat`);
    expect(response.status).toBe(200);
    await response.text();
  });
});
