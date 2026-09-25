import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * DonationAlerts implicit-grant redirect lands here. The token is in the URL fragment,
 * which the server never sees, so a tiny page reads it and posts it back.
 */
const CALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>StreamHelper</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f14;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#1a1a22;padding:32px 40px;border-radius:16px;text-align:center;max-width:420px}
h1{font-size:20px;margin:0 0 8px}p{color:#aaa;margin:0}</style></head>
<body><div class="card"><h1 id="t">…</h1><p id="d"></p></div>
<script>
const ru = (navigator.language || '').startsWith('ru');
const T = ru
  ? { ok: 'DonationAlerts подключён', okd: 'Можно закрыть вкладку и вернуться в StreamHelper.', fail: 'Не удалось подключить', faild: 'Попробуйте ещё раз из приложения.' }
  : { ok: 'DonationAlerts connected', okd: 'You can close this tab and return to StreamHelper.', fail: 'Connection failed', faild: 'Please try again from the app.' };
const show = (ok) => { document.getElementById('t').textContent = ok ? T.ok : T.fail; document.getElementById('d').textContent = ok ? T.okd : T.faild; };
const p = new URLSearchParams(location.hash.slice(1));
const token = p.get('access_token');
if (!token) show(false);
else fetch('/auth/donationalerts/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ access_token: token, expires_in: Number(p.get('expires_in')) || undefined }) })
  .then((r) => show(r.ok)).catch(() => show(false));
history.replaceState(null, '', location.pathname);
</script></body></html>`;

function readBody(req: IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createAuthRoutes(onDaToken: (token: string, expiresIn?: number) => Promise<boolean>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname === '/auth/donationalerts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(CALLBACK_PAGE);
      return true;
    }
    if (url.pathname === '/auth/donationalerts/token' && req.method === 'POST') {
      // Only our own callback page (same origin) may hand us a token.
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        res.writeHead(403).end();
        return true;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const ok = typeof body.access_token === 'string' && (await onDaToken(body.access_token, body.expires_in));
        res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(400).end();
      }
      return true;
    }
    return false;
  };
}
