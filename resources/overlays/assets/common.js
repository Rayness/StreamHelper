// Shared runtime for StreamHelper overlays (OBS browser sources).
(function () {
  const params = new URLSearchParams(location.search);
  const loadedFonts = new Set();
  const SYSTEM_FONTS = ['system-ui', 'arial', 'segoe ui', 'verdana', 'tahoma', 'times new roman', 'georgia', 'impact', 'consolas'];

  /** Connect to the app, reconnecting forever: the app may start after OBS. */
  function connect(kind, onMessage) {
    const id = params.get('id');
    const url = `ws://${location.host}/ws?kind=${kind}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
    let ws;
    const open = () => {
      ws = new WebSocket(url);
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === 'reload') return location.reload();
        onMessage(msg);
      };
      ws.onclose = () => setTimeout(open, 2000);
      ws.onerror = () => ws.close();
    };
    open();
  }

  /** Load a Google Font by family name (no-op for system fonts). */
  function loadFont(family) {
    if (!family) return;
    const key = family.trim();
    if (!key || loadedFonts.has(key) || SYSTEM_FONTS.includes(key.toLowerCase())) return;
    loadedFonts.add(key);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(key).replace(/%20/g, '+')}:wght@400;600;700;800;900&display=swap`;
    document.head.appendChild(link);
  }

  function fontStack(family) {
    return `"${(family || 'Inter').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  window.SH = { params, connect, loadFont, fontStack, el, formatClock };
})();
