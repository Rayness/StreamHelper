/**
 * Loaded before the app in a moderator's browser: stands in for the Electron preload and carries
 * `window.api` calls and pushes over a websocket to the streamer's StreamHelper.
 */
export const REMOTE_SHIM = String.raw`(() => {
  'use strict';
  const ru = (navigator.language || '').toLowerCase().startsWith('ru');
  const text = {
    lost: ru ? 'Нет связи со StreamHelper стримера. Переподключение…' : 'Lost connection to the streamer\'s StreamHelper. Reconnecting…',
    kicked: ru ? 'Стример отключил этот сеанс.' : 'The streamer closed this session.',
  };
  const listeners = new Map();
  const pending = new Map();
  const outbox = [];
  let seq = 0;
  let ws = null;
  let retry = 0;
  let stopped = false;

  // Overlay previews go through this server, not the streamer's localhost.
  const localize = (state) => state && typeof state === 'object' ? { ...state, overlayUrl: location.origin } : state;

  function banner(message) {
    let el = document.getElementById('remote-banner');
    if (!message) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'remote-banner';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:10px;background:#c4283a;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:calc(100vw - 32px)';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = message;
  }

  function emit(channel, payload) {
    const set = listeners.get(channel);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(channel === 'state' ? localize(payload) : payload); } catch (err) { console.error(err); }
    }
  }

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/remote/ws');
    ws.onopen = () => {
      retry = 0;
      banner(null);
      while (outbox.length) ws.send(outbox.shift());
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'push') emit(msg.channel, msg.payload);
      else if (msg.t === 'reload') location.reload();
      else if (msg.t === 'res') {
        const call = pending.get(msg.id);
        if (!call) return;
        pending.delete(msg.id);
        if (msg.ok) call.resolve(call.channel === 'app:init' && msg.value ? { ...msg.value, state: localize(msg.value.state) } : msg.value);
        else call.reject(new Error(msg.denied ? (ru ? 'Нет прав на это действие' : 'You have no permission for this') : msg.error));
      }
    };
    ws.onclose = (event) => {
      for (const call of pending.values()) call.reject(new Error(text.lost));
      pending.clear();
      if (event.code === 4001) { stopped = true; location.href = '/'; return; }
      if (event.code === 4003) { stopped = true; banner(text.kicked); return; }
      if (stopped) return;
      banner(text.lost);
      setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
  }

  function copy(value) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(value);
    // Plain http on a local network: no Clipboard API.
    const area = document.createElement('textarea');
    area.value = value;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } finally { area.remove(); }
    return Promise.resolve();
  }

  window.api = {
    invoke(channel, ...args) {
      // Things the streamer's computer would do for the window happen in this browser instead.
      if (channel === 'clipboard:write') return copy(String(args[0] ?? '')).then(() => undefined);
      if (channel === 'shell:openExternal') {
        if (/^https?:\/\//.test(String(args[0]))) window.open(String(args[0]), '_blank', 'noopener,noreferrer');
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject, channel });
        const data = JSON.stringify({ t: 'call', id, channel, args });
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
        else outbox.push(data);
      });
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
  };

  connect();
})();
`;
