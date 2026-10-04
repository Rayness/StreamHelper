// Shared runtime for StreamHelper overlays (OBS browser sources).
(function () {
  const params = new URLSearchParams(location.search);
  const loadedFonts = new Set();
  /** Rendered inside StreamHelper's own preview: show sample content instead of an empty screen. */
  const preview = params.has('preview');
  const SYSTEM_FONTS = ['system-ui', 'arial', 'segoe ui', 'verdana', 'tahoma', 'times new roman', 'georgia', 'impact', 'consolas'];

  /** Connect to the app, reconnecting forever: the app may start after OBS. */
  function connect(kind, onMessage) {
    const id = params.get('id');
    const url = `ws://${location.host}/ws?kind=${kind}${id ? `&id=${encodeURIComponent(id)}` : ''}${preview ? '&preview=1' : ''}`;
    let ws;
    let retry;
    let stopped = false;
    let attempts = 0;
    let profileVisible = true;
    const open = () => {
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onopen = () => { attempts = 0; };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === 'reload') return location.reload();
        if (msg.type === 'profileVisibility') {
          const wasVisible = profileVisible;
          profileVisible = preview || !!msg.visible;
          document.documentElement.style.visibility = profileVisible ? '' : 'hidden';
          if (!profileVisible) {
            onMessage(msg);
            if (kind === 'alerts') onMessage({ type: 'alertSkip' });
            if (kind === 'spotlight') onMessage({ type: 'spotlight', message: null });
            document.querySelectorAll('audio,video').forEach((media) => media.pause());
            if ('speechSynthesis' in window) speechSynthesis.cancel();
          } else if (!wasVisible) return location.reload();
          return;
        }
        if (!profileVisible) return;
        onMessage(msg);
      };
      ws.onclose = () => { if (!stopped) retry = setTimeout(open, Math.min(10000, 1000 * 2 ** Math.min(attempts++, 4))); };
      ws.onerror = () => ws.close();
    };
    open();
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(retry); ws?.close(); }, { once: true });
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

  /** Load a font and apply it to an element. */
  function useFont(node, family) {
    loadFont(family);
    node.style.fontFamily = fontStack(family);
  }

  /** Imported media are referenced by file name; the overlay server serves them under /media/. */
  function mediaUrl(name) {
    if (!name) return null;
    return name.startsWith('/') || /^https?:/.test(name) ? name : `/media/${encodeURIComponent(name)}`;
  }

  function tr(lang, ru, en) {
    return lang === 'en' ? en : ru;
  }

  /** Russian plural: plural(5, 'голос', 'голоса', 'голосов'). */
  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  const reducedMotion = params.has('reducedMotion');

  /** Fit the entire alert, including media and long text, into the browser-source viewport. */
  function alertBounds(viewWidth, viewHeight, width, height, style) {
    const number = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
    const margin = Math.max(0, Math.min(number(style.safeMargin, 24), viewWidth / 4, viewHeight / 4));
    const scale = Math.min(1, (viewWidth - margin * 2) / Math.max(1, width), (viewHeight - margin * 2) / Math.max(1, height));
    const w = width * scale, h = height * scale;
    const anchor = style.anchor || 'center';
    const ax = anchor.endsWith('Left') ? 0 : anchor.endsWith('Right') ? 1 : .5;
    const ay = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : .5;
    const x = Math.max(0, Math.min(100, number(style.x, 50))) / 100 * viewWidth - w * ax;
    const y = Math.max(0, Math.min(100, number(style.y, 50))) / 100 * viewHeight - h * ay;
    return { left: Math.max(margin, Math.min(viewWidth - margin - w, x)), top: Math.max(margin, Math.min(viewHeight - margin - h, y)), scale };
  }

  window.SH = { params, connect, loadFont, fontStack, el, formatClock, useFont, mediaUrl, tr, plural, reducedMotion, preview, alertBounds };
})();
