import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatMessage, RuntimeState, Settings } from '@shared/types';

export interface DockOptions {
  token: string;
  htmlPath: string;
  snapshot: () => { state: RuntimeState; settings: Settings; chat?: ChatMessage[] };
  action: (name: string, id?: string) => void | Promise<void>;
}

function authorized(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Authenticated localhost control surface for an OBS Custom Browser Dock. */
export function createDockRoutes(opts: DockOptions) {
  const html = readFileSync(opts.htmlPath, 'utf8');
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/dock')) return false;
    const token = url.searchParams.get('token') ?? (req.headers['x-streamhelper-dock-token'] as string | undefined) ?? null;
    if (!authorized(token, opts.token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return true;
    }
    if (url.pathname === '/dock' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(html);
      return true;
    }
    if (url.pathname === '/dock/state' && req.method === 'GET') {
      const { state, settings, chat = [] } = opts.snapshot();
      const body = JSON.stringify({
        obs: state.obs,
        stream: state.stream,
        alerts: state.alerts,
        profiles: settings.profiles.map((p) => ({ id: p.id, name: p.name })),
        activeProfileId: settings.activeProfileId,
        overlayKinds: state.overlayKinds,
        wheel: state.wheel,
        wheels: settings.wheels.map((w) => ({ id: w.id, name: w.name, segments: w.segments.length })),
        poll: state.poll,
        giveaway: { status: state.giveaway.status, count: state.giveaway.entrants.length, winner: state.giveaway.winner?.userName },
        boss: state.boss,
        quiz: state.quiz,
        ad: state.ad,
        songRequests: state.songRequests,
        songDisplay: { videoLayout: settings.songRequests.videoLayout, volume: settings.songRequests.volume },
        music: { track: state.music.track, sources: state.music.sources },
        musicDisplay: { showArtwork: settings.musicOverlay.showArtwork },
        goals: settings.goals.map((goal) => ({ id: goal.id, title: goal.title, current: goal.current, target: goal.target, currency: goal.kind === 'donations' ? goal.currency : '' })),
        timers: settings.timers.map((timer) => ({ id: timer.id, title: timer.title, running: timer.running })),
        banners: settings.banners.map((banner) => ({ id: banner.id, name: banner.name, visible: banner.visible })),
        subForStream: state.subForStream,
        kawaki: { status: state.kawaki.status, nowWatching: state.kawaki.nowWatching },
        spotlight: state.spotlight && { userName: state.spotlight.userName, text: state.spotlight.text },
        chat: chat.filter((m) => !m.deleted).slice(-15).reverse().map((m) => ({ id: m.id, userName: m.userName, text: m.text.slice(0, 180) })),
        actions: settings.actions.filter((a) => a.showOnDashboard).map((a) => ({ id: a.id, label: a.label, color: a.color })),
        ads: settings.ads.map((a) => ({ id: a.id, name: a.name, media: !!a.media })),
        language: settings.language,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }
    if (url.pathname === '/dock/action' && req.method === 'POST') {
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 4096) throw new Error('Request too large');
        }
        const { name, id } = JSON.parse(body) as { name?: unknown; id?: unknown };
        if (typeof name !== 'string' || (id !== undefined && typeof id !== 'string')) throw new Error('Invalid action');
        await opts.action(name, id as string | undefined);
        res.writeHead(204);
        res.end();
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String((error as Error).message ?? error));
      }
      return true;
    }
    res.writeHead(404);
    res.end();
    return true;
  };
}
