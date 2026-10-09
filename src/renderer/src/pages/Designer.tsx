import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { mediaUrl } from '@shared/alerts';
import { defaultCustomOverlay, uid } from '@shared/defaults';
import { renderTemplate } from '@shared/template';
import { resolveStreamVar } from '@shared/vars';
import type { CustomElement, CustomElementType, CustomOverlay, OverlayKind, OverlayMessage, Settings } from '@shared/types';
import { FontPicker } from '../components/FontPicker';
import { Icon, type IconName } from '../components/icons';
import { MediaPicker } from '../components/MediaPicker';
import { OverlayBar, ScaledFrame } from '../components/overlay';
import { Button, Card, ColorInput, Empty, Field, IconButton, NumberInput, Select, TextArea, TextInput, Toggle } from '../components/ui';
import { useNow } from '../hooks';
import { useT, type TFn, type TKey } from '../i18n';
import { OVERLAYS, overlayDef } from '../overlayCatalog';
import { getData, navigate, saveSettings, useApp } from '../store';

type Rect = { x: number; y: number; w: number; h: number };
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SNAP = 6;
const TYPE_ICON: Record<CustomElementType, IconName> = { text: 'font', image: 'image', shape: 'shapes', widget: 'layers' };
/** Overlays that have several instances: the widget picks which one. */
const INSTANCE_LISTS: Partial<Record<OverlayKind, keyof Settings>> = { goal: 'goals', timer: 'timers', label: 'labels', banner: 'banners', counter: 'counterOverlays', wheel: 'wheels', ad: 'ads' };

const clampNum = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function base(name: string, rect: Rect) {
  return { id: uid('el_'), name, ...rect, rotation: 0, opacity: 100, visible: true, locked: false };
}

export function newElement(type: CustomElementType, o: CustomOverlay, t: TFn, extra: Partial<CustomElement> = {}): CustomElement {
  const cx = (w: number) => Math.round((o.width - w) / 2);
  const cy = (h: number) => Math.round((o.height - h) / 2);
  switch (type) {
    case 'text':
      return { ...base(t('designer.newText'), { x: cx(700), y: cy(120), w: 700, h: 120 }), type, text: t('designer.sampleText'), fontFamily: 'Montserrat', fontSize: 64, fontWeight: 800, italic: false, uppercase: false, color: '#ffffff', align: 'center', valign: 'middle', letterSpacing: 0, lineHeight: 1.15, strokeColor: '#000000', strokeWidth: 0, shadow: true, autoFit: false, ...extra } as CustomElement;
    case 'image':
      return { ...base(t('designer.newImage'), { x: cx(480), y: cy(320), w: 480, h: 320 }), type, media: null, fit: 'contain', radius: 0, ...extra } as CustomElement;
    case 'shape':
      return { ...base(t('designer.newShape'), { x: cx(600), y: cy(200), w: 600, h: 200 }), type, shape: 'rect', fill: 'rgba(20,16,32,0.82)', fill2: '', gradientAngle: 90, borderColor: '#9b6bff', borderWidth: 0, radius: 18, blur: 0, ...extra } as CustomElement;
    case 'widget': {
      const kind = ((extra as { kind?: OverlayKind }).kind ?? 'label') as OverlayKind;
      const [w, h] = overlayDef(kind).size;
      const scale = Math.min(1, (o.width * 0.6) / w, (o.height * 0.6) / h);
      return { ...base(t(`ov.${kind}` as TKey), { x: cx(w * scale), y: cy(h * scale), w: Math.round(w * scale), h: Math.round(h * scale) }), type, kind, itemId: null, ...extra } as CustomElement;
    }
  }
}

/** Ready-made starting points for a new overlay. */
function starter(kind: 'empty' | 'starting' | 'bar' | 'frame', t: TFn): CustomOverlay {
  const o = { ...defaultCustomOverlay(getData().settings!.language), name: t(`designer.starter.${kind}` as TKey) };
  const el = (type: CustomElementType, extra: Partial<CustomElement>) => newElement(type, o, t, extra);
  if (kind === 'starting') {
    o.elements = [
      el('shape', { name: t('designer.background'), x: 0, y: 0, w: 1920, h: 1080, fill: '#120f1c', fill2: '#3a1f6b', gradientAngle: 135, radius: 0 } as Partial<CustomElement>),
      el('text', { name: t('designer.title'), x: 260, y: 360, w: 1400, h: 170, text: t('designer.startingText'), fontSize: 120, fontFamily: 'Unbounded', fontWeight: 800 } as Partial<CustomElement>),
      el('text', { name: t('designer.subtitle'), x: 260, y: 540, w: 1400, h: 80, text: '{title}', fontSize: 44, fontWeight: 600, shadow: false, color: '#d8ccff' } as Partial<CustomElement>),
      el('text', { name: t('designer.newText'), x: 260, y: 900, w: 1400, h: 60, text: `${t('labels.lastFollower')}: {lastfollower}`, fontSize: 34, fontWeight: 700, color: '#ffb547' } as Partial<CustomElement>),
    ];
  } else if (kind === 'bar') {
    o.elements = [
      el('shape', { name: t('designer.background'), x: 0, y: 1000, w: 1920, h: 80, fill: 'rgba(14,12,20,0.86)', radius: 0, borderWidth: 0 } as Partial<CustomElement>),
      el('shape', { name: t('designer.accent'), x: 0, y: 996, w: 1920, h: 4, fill: '#9b6bff', fill2: '#ff5d8f', gradientAngle: 90, radius: 0 } as Partial<CustomElement>),
      el('text', { name: t('labels.lastFollower'), x: 40, y: 1010, w: 560, h: 60, text: '❤ {lastfollower}', fontSize: 30, align: 'left', shadow: false } as Partial<CustomElement>),
      el('text', { name: t('labels.topDonation'), x: 680, y: 1010, w: 560, h: 60, text: '★ {topdonor} — {topdonation}', fontSize: 30, align: 'center', shadow: false } as Partial<CustomElement>),
      el('text', { name: t('designer.clock'), x: 1320, y: 1010, w: 560, h: 60, text: '{time} · {uptime}', fontSize: 30, align: 'right', shadow: false } as Partial<CustomElement>),
    ];
  } else if (kind === 'frame') {
    o.elements = [
      el('shape', { name: t('designer.cameraFrame'), x: 1380, y: 640, w: 500, h: 380, fill: 'transparent', borderColor: '#9b6bff', borderWidth: 6, radius: 24 } as Partial<CustomElement>),
      el('shape', { name: t('designer.nameplate'), x: 1420, y: 990, w: 420, h: 64, fill: '#9b6bff', fill2: '#ff5d8f', gradientAngle: 90, radius: 32 } as Partial<CustomElement>),
      el('text', { name: t('designer.channelName'), x: 1420, y: 990, w: 420, h: 64, text: '{channel}', fontSize: 32, shadow: false } as Partial<CustomElement>),
    ];
  }
  return o;
}

/** What the browser source receives: text with live variables, media as URLs. */
function renderOverlay(o: CustomOverlay, s: Settings, st: ReturnType<typeof getData>['state'], now: number): CustomOverlay {
  return {
    ...o,
    elements: o.elements.filter((e) => e.visible).map((e) => e.type === 'text' ? { ...e, text: st ? renderTemplate(e.text, (n, a) => resolveStreamVar(n, a, s, st, now)) : e.text }
      : e.type === 'image' ? { ...e, media: mediaUrl(e.media) } : e),
  };
}

export function Designer() {
  const t = useT();
  const list = useApp((d) => d.settings!.customOverlays);
  const [selected, setSelected] = useState<string | undefined>(() => { try { return localStorage.getItem('designer.overlay') ?? undefined; } catch { return undefined; } });
  const overlay = list.find((o) => o.id === selected) ?? list[0];
  useEffect(() => { try { if (overlay) localStorage.setItem('designer.overlay', overlay.id); } catch { /* private mode */ } }, [overlay?.id]);
  const create = (kind: 'empty' | 'starting' | 'bar' | 'frame') => {
    const o = starter(kind, t);
    saveSettings('customOverlays', [...getData().settings!.customOverlays, o]);
    setSelected(o.id);
  };
  return (
    <div className="workspace designer-page">
      <header className="workspace-header">
        <div><h1>{t('nav.designer')}</h1><p className="muted small">{t('designer.hint')}</p></div>
        <NewOverlayMenu onCreate={create} />
      </header>
      {list.length > 0 && (
        <div className="chips designer-tabs" role="tablist">
          {list.map((o) => <button key={o.id} type="button" role="tab" aria-selected={o.id === overlay?.id} className={`chip ${o.id === overlay?.id ? 'active' : ''}`} onClick={() => setSelected(o.id)}>{o.name || '—'}</button>)}
        </div>
      )}
      {overlay ? <Editor key={overlay.id} overlay={overlay} onDeleted={() => setSelected(undefined)} /> : (
        <div className="workspace-welcome">
          <span className="workspace-welcome-icon"><Icon name="designer" size={42} /></span>
          <Empty icon="designer" title={t('designer.empty')}>{t('designer.emptyHint')}</Empty>
          <div className="designer-starters">
            {(['empty', 'starting', 'bar', 'frame'] as const).map((k) => <button key={k} type="button" className="designer-starter" onClick={() => create(k)}><Icon name={k === 'empty' ? 'plus' : 'designer'} size={22} /><strong>{t(`designer.starter.${k}`)}</strong><span className="muted small">{t(`designer.starterHint.${k}`)}</span></button>)}
          </div>
        </div>
      )}
    </div>
  );
}

function NewOverlayMenu({ onCreate }: { onCreate: (kind: 'empty' | 'starting' | 'bar' | 'frame') => void }) {
  const t = useT();
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details className="designer-new" ref={ref}>
      <summary className="btn btn-primary btn-md"><Icon name="plus" size={17} /><span>{t('designer.new')}</span></summary>
      <div className="designer-new-menu">
        {(['empty', 'starting', 'bar', 'frame'] as const).map((k) => <button key={k} type="button" onClick={() => { ref.current?.removeAttribute('open'); onCreate(k); }}><strong>{t(`designer.starter.${k}`)}</strong><span className="muted small">{t(`designer.starterHint.${k}`)}</span></button>)}
      </div>
    </details>
  );
}

interface Drag { id: string; handle: Handle; startX: number; startY: number; orig: Rect; scale: number; moved: boolean }

function Editor({ overlay, onDeleted }: { overlay: CustomOverlay; onDeleted: () => void }) {
  const t = useT();
  const settings = useApp((d) => d.settings!);
  const state = useApp((d) => d.state!);
  const now = useNow(2000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ id: string; rect: Rect } | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const drag = useRef<Drag | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const history = useRef<{ undo: CustomOverlay[]; redo: CustomOverlay[] }>({ undo: [], redo: [] });

  const shown = useMemo(() => temp ? { ...overlay, elements: overlay.elements.map((e) => (e.id === temp.id ? { ...e, ...temp.rect } : e)) } : overlay, [overlay, temp]);
  const selected = shown.elements.find((e) => e.id === selectedId) ?? null;
  const message = useMemo<OverlayMessage>(() => ({ type: 'custom', overlay: renderOverlay(shown, settings, state, now) }), [shown, settings, state, now]);

  /** Save a new version of this overlay (with undo). */
  const commit = useCallback((next: CustomOverlay, record = true) => {
    const all = getData().settings!.customOverlays;
    const current = all.find((o) => o.id === next.id);
    if (record && current) { history.current.undo = [...history.current.undo.slice(-49), current]; history.current.redo = []; }
    saveSettings('customOverlays', all.map((o) => (o.id === next.id ? next : o)));
  }, []);
  const latest = () => getData().settings!.customOverlays.find((o) => o.id === overlay.id) ?? overlay;
  const updateEl = (id: string, patch: Partial<CustomElement>) => { const o = latest(); commit({ ...o, elements: o.elements.map((e) => (e.id === id ? { ...e, ...patch } as CustomElement : e)) }); };
  const add = (type: CustomElementType, extra: Partial<CustomElement> = {}) => {
    const el = newElement(type, latest(), t, extra);
    commit({ ...latest(), elements: [...latest().elements, el] });
    setSelectedId(el.id);
  };
  const remove = (id: string) => { commit({ ...latest(), elements: latest().elements.filter((e) => e.id !== id) }); setSelectedId(null); };
  const duplicate = (id: string) => {
    const o = latest();
    const src = o.elements.find((e) => e.id === id);
    if (!src) return;
    const copy = { ...src, id: uid('el_'), name: `${src.name} 2`, x: src.x + 24, y: src.y + 24, locked: false } as CustomElement;
    const i = o.elements.indexOf(src);
    commit({ ...o, elements: [...o.elements.slice(0, i + 1), copy, ...o.elements.slice(i + 1)] });
    setSelectedId(copy.id);
  };
  const reorder = (id: string, dir: 1 | -1 | 'top' | 'bottom') => {
    const o = latest();
    const els = [...o.elements];
    const i = els.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [el] = els.splice(i, 1);
    const to = dir === 'top' ? els.length : dir === 'bottom' ? 0 : clampNum(i + dir, 0, els.length);
    els.splice(to, 0, el);
    commit({ ...o, elements: els });
  };
  const undo = () => {
    const prev = history.current.undo.pop();
    if (!prev) return;
    history.current.redo.push(latest());
    commit(prev, false);
  };
  const redo = () => {
    const next = history.current.redo.pop();
    if (!next) return;
    history.current.undo.push(latest());
    commit(next, false);
  };

  // Keyboard: nudge, delete, duplicate, undo/redo. Never while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
      const el = latest().elements.find((x) => x.id === selectedId);
      if (!el) return;
      if (mod && e.code === 'KeyD') { e.preventDefault(); duplicate(el.id); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(el.id); return; }
      if (e.key === 'Escape') { setSelectedId(null); return; }
      const step = e.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (delta && !el.locked) { e.preventDefault(); updateEl(el.id, { x: el.x + delta[0], y: el.y + delta[1] }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Snap the moving/resizing edges to the canvas and to other elements. */
  const snap = (rect: Rect, id: string, handle: Handle, scale: number): { rect: Rect; gx: number[]; gy: number[] } => {
    const th = SNAP / scale;
    const others = overlay.elements.filter((e) => e.id !== id && e.visible);
    const xs = [0, overlay.width / 2, overlay.width, ...others.flatMap((e) => [e.x, e.x + e.w / 2, e.x + e.w])];
    const ys = [0, overlay.height / 2, overlay.height, ...others.flatMap((e) => [e.y, e.y + e.h / 2, e.y + e.h])];
    const r = { ...rect };
    const gx: number[] = [];
    const gy: number[] = [];
    const best = (values: number[], lines: number[]) => {
      let hit: { line: number; diff: number; index: number } | null = null;
      values.forEach((v, index) => lines.forEach((line) => { const diff = line - v; if (Math.abs(diff) <= th && (!hit || Math.abs(diff) < Math.abs(hit.diff))) hit = { line, diff, index }; }));
      return hit as { line: number; diff: number; index: number } | null;
    };
    if (handle === 'move') {
      const hx = best([r.x, r.x + r.w / 2, r.x + r.w], xs);
      if (hx) { r.x += hx.diff; gx.push(hx.line); }
      const hy = best([r.y, r.y + r.h / 2, r.y + r.h], ys);
      if (hy) { r.y += hy.diff; gy.push(hy.line); }
    } else {
      if (handle.includes('e')) { const h = best([r.x + r.w], xs); if (h) { r.w += h.diff; gx.push(h.line); } }
      if (handle.includes('w')) { const h = best([r.x], xs); if (h) { r.x += h.diff; r.w -= h.diff; gx.push(h.line); } }
      if (handle.includes('s')) { const h = best([r.y + r.h], ys); if (h) { r.h += h.diff; gy.push(h.line); } }
      if (handle.includes('n')) { const h = best([r.y], ys); if (h) { r.y += h.diff; r.h -= h.diff; gy.push(h.line); } }
    }
    return { rect: r, gx, gy };
  };

  const startDrag = (e: ReactPointerEvent, el: CustomElement, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(el.id);
    if (el.locked || e.button !== 0) return;
    const box = layer.current?.getBoundingClientRect();
    const scale = box ? box.width / overlay.width : 1;
    drag.current = { id: el.id, handle, startX: e.clientX, startY: e.clientY, orig: { x: el.x, y: el.y, w: el.w, h: el.h }, scale, moved: false };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.scale;
    const dy = (e.clientY - d.startY) / d.scale;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 2 / d.scale) return;
    d.moved = true;
    const o = d.orig;
    let r: Rect = { ...o };
    if (d.handle === 'move') r = { ...o, x: o.x + dx, y: o.y + dy };
    else {
      if (d.handle.includes('e')) r.w = o.w + dx;
      if (d.handle.includes('s')) r.h = o.h + dy;
      if (d.handle.includes('w')) { r.x = o.x + dx; r.w = o.w - dx; }
      if (d.handle.includes('n')) { r.y = o.y + dy; r.h = o.h - dy; }
      // Shift on a corner keeps the proportions.
      if (e.shiftKey && d.handle.length === 2 && o.h > 0) {
        const ratio = o.w / o.h;
        if (Math.abs(r.w / ratio) > Math.abs(r.h)) { const h = r.w / ratio; if (d.handle.includes('n')) r.y = o.y + o.h - h; r.h = h; }
        else { const w = r.h * ratio; if (d.handle.includes('w')) r.x = o.x + o.w - w; r.w = w; }
      }
    }
    const snapped = e.altKey ? { rect: r, gx: [], gy: [] } : snap(r, d.id, d.handle, d.scale);
    const fin = snapped.rect;
    if (fin.w < 8) { if (d.handle.includes('w')) fin.x -= 8 - fin.w; fin.w = 8; }
    if (fin.h < 8) { if (d.handle.includes('n')) fin.y -= 8 - fin.h; fin.h = 8; }
    setTemp({ id: d.id, rect: { x: Math.round(fin.x), y: Math.round(fin.y), w: Math.round(fin.w), h: Math.round(fin.h) } });
    setGuides({ x: snapped.gx, y: snapped.gy });
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    setGuides({ x: [], y: [] });
    if (d?.moved && temp) updateEl(temp.id, temp.rect);
    setTemp(null);
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const setOverlay = (patch: Partial<CustomOverlay>) => commit({ ...latest(), ...patch });
  return (
    <div className="designer">
      <OverlayBar kind="custom" id={overlay.id} name={overlay.name} size={[overlay.width, overlay.height]} />
      <div className="designer-toolbar">
        <Button size="sm" icon="font" onClick={() => add('text')}>{t('designer.addText')}</Button>
        <Button size="sm" icon="image" onClick={() => add('image')}>{t('designer.addImage')}</Button>
        <Button size="sm" icon="shapes" onClick={() => add('shape')}>{t('designer.addShape')}</Button>
        <WidgetAdder onAdd={(kind) => add('widget', { kind } as Partial<CustomElement>)} />
        <span className="designer-toolbar-gap" />
        <IconButton icon="replay" label={`${t('designer.undo')} (Ctrl+Z)`} onClick={undo} />
        <IconButton icon="refresh" label={`${t('designer.redo')} (Ctrl+Y)`} onClick={redo} />
      </div>
      <div className="designer-body">
        <section className="designer-canvas" onPointerDown={() => setSelectedId(null)}>
          <ScaledFrame src={`${state.overlayUrl}/overlay/custom?id=${encodeURIComponent(overlay.id)}&preview=1`} width={overlay.width} height={overlay.height} maxHeight={620} message={message}>
            <div ref={layer} className="designer-layer" onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
              {shown.elements.map((el) => el.visible && (
                <div key={el.id} className={`designer-box ${el.id === selectedId ? 'selected' : ''} ${el.locked ? 'locked' : ''}`}
                  style={{ left: pct(el.x, overlay.width), top: pct(el.y, overlay.height), width: pct(el.w, overlay.width), height: pct(el.h, overlay.height), transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined }}
                  onPointerDown={(e) => startDrag(e, el, 'move')} title={el.name}>
                  {el.id === selectedId && !el.locked && HANDLES.map((h) => <span key={h} className={`designer-handle h-${h}`} onPointerDown={(e) => startDrag(e, el, h)} />)}
                </div>
              ))}
              {guides.x.map((x, i) => <span key={`x${i}`} className="designer-guide v" style={{ left: pct(x, overlay.width) }} />)}
              {guides.y.map((y, i) => <span key={`y${i}`} className="designer-guide h" style={{ top: pct(y, overlay.height) }} />)}
            </div>
          </ScaledFrame>
          <p className="muted small designer-tips">{t('designer.tips')}</p>
        </section>
        <aside className="designer-side">
          <Layers overlay={overlay} selectedId={selectedId} onSelect={setSelectedId} onUpdate={updateEl} onReorder={reorder} />
          {selected ? <Properties key={selected.id} el={selected} onChange={(patch) => updateEl(selected.id, patch)} onDelete={() => remove(selected.id)} onDuplicate={() => duplicate(selected.id)} onReorder={(dir) => reorder(selected.id, dir)} overlay={overlay} />
            : <OverlayProps overlay={overlay} onChange={setOverlay} onDelete={() => {
              if (!confirm(t('common.confirmDelete'))) return;
              saveSettings('customOverlays', getData().settings!.customOverlays.filter((o) => o.id !== overlay.id));
              onDeleted();
            }} onDuplicate={() => {
              const copy = { ...structuredClone(latest()), id: uid('custom_'), name: `${overlay.name} 2` };
              saveSettings('customOverlays', [...getData().settings!.customOverlays, copy]);
            }} />}
        </aside>
      </div>
    </div>
  );
}

function WidgetAdder({ onAdd }: { onAdd: (kind: OverlayKind) => void }) {
  const t = useT();
  return (
    <select className="input select designer-widget-select" value="" onChange={(e) => { if (e.target.value) onAdd(e.target.value as OverlayKind); }} aria-label={t('designer.addWidget')}>
      <option value="">{t('designer.addWidget')}…</option>
      {OVERLAYS.filter((o) => o.kind !== 'custom').map((o) => <option key={o.kind} value={o.kind}>{t(`ov.${o.kind}` as TKey)}</option>)}
    </select>
  );
}

function Layers({ overlay, selectedId, onSelect, onUpdate, onReorder }: { overlay: CustomOverlay; selectedId: string | null; onSelect: (id: string) => void; onUpdate: (id: string, patch: Partial<CustomElement>) => void; onReorder: (id: string, dir: 1 | -1) => void }) {
  const t = useT();
  return (
    <Card title={t('designer.layers')} icon="layers" className="designer-layers">
      {!overlay.elements.length && <p className="muted small">{t('designer.noLayers')}</p>}
      <ol>
        {[...overlay.elements].reverse().map((el) => (
          <li key={el.id} className={`${el.id === selectedId ? 'active' : ''} ${el.visible ? '' : 'hidden'}`} onClick={() => onSelect(el.id)}>
            <Icon name={TYPE_ICON[el.type]} size={15} />
            <span className="designer-layer-name">{el.name || t(`designer.type.${el.type}` as TKey)}</span>
            <IconButton icon="chevron" className="up" label={t('designer.forward')} onClick={(e) => { e.stopPropagation(); onReorder(el.id, 1); }} />
            <IconButton icon="chevron" className="down" label={t('designer.backward')} onClick={(e) => { e.stopPropagation(); onReorder(el.id, -1); }} />
            <IconButton icon={el.visible ? 'eye' : 'eyeOff'} label={t('designer.visible')} onClick={(e) => { e.stopPropagation(); onUpdate(el.id, { visible: !el.visible }); }} />
            <IconButton icon={el.locked ? 'lock' : 'unlock'} label={t('designer.lock')} onClick={(e) => { e.stopPropagation(); onUpdate(el.id, { locked: !el.locked }); }} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

function OverlayProps({ overlay, onChange, onDelete, onDuplicate }: { overlay: CustomOverlay; onChange: (patch: Partial<CustomOverlay>) => void; onDelete: () => void; onDuplicate: () => void }) {
  const t = useT();
  const presets: [number, number][] = [[1920, 1080], [1280, 720], [2560, 1440], [1080, 1920]];
  return (
    <Card title={t('designer.overlay')} icon="designer">
      <div className="form compact">
        <Field label={t('banners.name')} wide><TextInput value={overlay.name} onChange={(name) => onChange({ name })} /></Field>
        <Field label={t('designer.width')}><NumberInput value={overlay.width} min={50} max={7680} onChange={(width) => onChange({ width })} /></Field>
        <Field label={t('designer.height')}><NumberInput value={overlay.height} min={50} max={7680} onChange={(height) => onChange({ height })} /></Field>
        <Field label={t('designer.presets')} wide><div className="row-gap wrap">{presets.map(([w, h]) => <Button key={`${w}x${h}`} size="sm" onClick={() => onChange({ width: w, height: h })}>{w}×{h}</Button>)}</div></Field>
        <Field label={t('common.background')} hint={t('designer.backgroundHint')} wide><ColorInput value={overlay.background} onChange={(background) => onChange({ background })} /></Field>
      </div>
      <p className="muted small">{t('designer.selectHint')}</p>
      <div className="row-gap wrap">
        <Button size="sm" icon="duplicate" onClick={onDuplicate}>{t('designer.duplicate')}</Button>
        <Button size="sm" variant="danger" icon="trash" onClick={onDelete}>{t('designer.deleteOverlay')}</Button>
      </div>
    </Card>
  );
}

const QUICK_VARS = ['title', 'game', 'viewers', 'uptime', 'time', 'lastfollower', 'lastsub', 'topdonor', 'topdonation', 'lastdonor', 'lastdonation', 'lastdonations:3', 'donations', 'anime'];

function Properties({ el, overlay, onChange, onDelete, onDuplicate, onReorder }: { el: CustomElement; overlay: CustomOverlay; onChange: (patch: Partial<CustomElement>) => void; onDelete: () => void; onDuplicate: () => void; onReorder: (dir: 1 | -1 | 'top' | 'bottom') => void }) {
  const t = useT();
  const variables = useApp((d) => d.settings!.variables);
  const instances = useApp((d) => el.type === 'widget' && INSTANCE_LISTS[el.kind] ? d.settings![INSTANCE_LISTS[el.kind]!] as unknown as { id: string; name?: string; title?: string }[] : null);
  const set = onChange as (patch: Record<string, unknown>) => void;
  return (
    <Card title={el.name || t(`designer.type.${el.type}` as TKey)} icon={TYPE_ICON[el.type]} className="designer-props">
      <div className="form compact">
        <Field label={t('banners.name')} wide><TextInput value={el.name} onChange={(name) => onChange({ name })} /></Field>
        {el.type === 'text' && <>
          <Field label={t('designer.text')} wide><TextArea value={el.text} rows={3} onChange={(text) => set({ text })} /></Field>
          <div className="field field-wide designer-vars">
            <select className="input select" value="" onChange={(e) => { if (e.target.value) set({ text: `${el.text}{${e.target.value}}` }); }} aria-label={t('designer.insertVar')}>
              <option value="">{t('designer.insertVar')}…</option>
              {QUICK_VARS.map((v) => <option key={v} value={v}>{`{${v}}`}</option>)}
              {variables.map((v) => <option key={v.id} value={v.name}>{`{${v.name}}`}</option>)}
            </select>
            <Button size="sm" icon="braces" onClick={() => navigate('variables')}>{t('designer.allVars')}</Button>
          </div>
          <Field label={t('common.font')} wide><FontPicker value={el.fontFamily} onChange={(fontFamily) => set({ fontFamily })} /></Field>
          <Field label={t('common.fontSize')}><NumberInput value={el.fontSize} min={6} max={600} onChange={(fontSize) => set({ fontSize })} /></Field>
          <Field label={t('designer.weight')}><Select value={String(el.fontWeight)} onChange={(w) => set({ fontWeight: Number(w) })} options={['300', '400', '500', '600', '700', '800', '900'].map((w) => ({ value: w, label: w }))} /></Field>
          <Field label={t('common.textColor')}><ColorInput value={el.color} onChange={(color) => set({ color })} /></Field>
          <Field label={t('banners.align')}><Select value={el.align} onChange={(align) => set({ align })} options={(['left', 'center', 'right'] as const).map((a) => ({ value: a, label: t(`align.${a}`) }))} /></Field>
          <Field label={t('designer.valign')}><Select value={el.valign} onChange={(valign) => set({ valign })} options={(['top', 'middle', 'bottom'] as const).map((a) => ({ value: a, label: t(`designer.valign_${a}`) }))} /></Field>
          <Field label={t('designer.letterSpacing')}><NumberInput value={el.letterSpacing} min={-20} max={60} onChange={(letterSpacing) => set({ letterSpacing })} /></Field>
          <Field label={t('designer.lineHeight')}><NumberInput value={el.lineHeight} min={0.6} max={3} step={0.05} onChange={(lineHeight) => set({ lineHeight })} /></Field>
          <Field label={t('designer.stroke')}><NumberInput value={el.strokeWidth} min={0} max={30} onChange={(strokeWidth) => set({ strokeWidth })} /></Field>
          {el.strokeWidth > 0 && <Field label={t('designer.strokeColor')}><ColorInput value={el.strokeColor} onChange={(strokeColor) => set({ strokeColor })} /></Field>}
          <Field label={t('overlays.options')} wide><div className="stack">
            <Toggle checked={el.shadow} onChange={(shadow) => set({ shadow })} label={t('designer.shadow')} />
            <Toggle checked={el.italic} onChange={(italic) => set({ italic })} label={t('designer.italic')} />
            <Toggle checked={el.uppercase} onChange={(uppercase) => set({ uppercase })} label={t('designer.uppercase')} />
            <Toggle checked={el.autoFit} onChange={(autoFit) => set({ autoFit })} label={t('designer.autoFit')} />
          </div></Field>
        </>}
        {el.type === 'image' && <>
          <Field label={t('designer.media')} wide><MediaPicker kind="visual" value={el.media} onChange={(media) => set({ media })} /></Field>
          <Field label={t('designer.fit')}><Select value={el.fit} onChange={(fit) => set({ fit })} options={(['contain', 'cover', 'fill'] as const).map((f) => ({ value: f, label: t(`designer.fit_${f}`) }))} /></Field>
          <Field label={t('chatSettings.radius')}><NumberInput value={el.radius} min={0} max={1000} onChange={(radius) => set({ radius })} /></Field>
        </>}
        {el.type === 'shape' && <>
          <Field label={t('designer.shape')}><Select value={el.shape} onChange={(shape) => set({ shape })} options={(['rect', 'ellipse', 'line'] as const).map((f) => ({ value: f, label: t(`designer.shape_${f}`) }))} /></Field>
          <Field label={t('designer.fill')} hint={t('designer.fillHint')}><ColorInput value={el.fill} onChange={(fill) => set({ fill })} /></Field>
          <Field label={t('designer.gradient')}><Toggle checked={!!el.fill2} onChange={(on) => set({ fill2: on ? '#ff5d8f' : '' })} /></Field>
          {!!el.fill2 && <>
            <Field label={t('designer.fill2')}><ColorInput value={el.fill2} onChange={(fill2) => set({ fill2 })} /></Field>
            <Field label={t('designer.angle')}><NumberInput value={el.gradientAngle} min={0} max={360} onChange={(gradientAngle) => set({ gradientAngle })} /></Field>
          </>}
          {el.shape !== 'line' && <>
            <Field label={t('designer.border')}><NumberInput value={el.borderWidth} min={0} max={100} onChange={(borderWidth) => set({ borderWidth })} /></Field>
            {el.borderWidth > 0 && <Field label={t('designer.borderColor')}><ColorInput value={el.borderColor} onChange={(borderColor) => set({ borderColor })} /></Field>}
          </>}
          {el.shape === 'rect' && <Field label={t('chatSettings.radius')}><NumberInput value={el.radius} min={0} max={1000} onChange={(radius) => set({ radius })} /></Field>}
          <Field label={t('designer.blur')}><NumberInput value={el.blur} min={0} max={100} onChange={(blur) => set({ blur })} /></Field>
        </>}
        {el.type === 'widget' && <>
          <Field label={t('designer.widget')} wide><Select value={el.kind} onChange={(kind) => set({ kind, itemId: null })} options={OVERLAYS.filter((o) => o.kind !== 'custom').map((o) => ({ value: o.kind, label: t(`ov.${o.kind}` as TKey) }))} /></Field>
          {instances && <Field label={t('designer.instance')} wide><Select value={el.itemId ?? ''} onChange={(itemId) => set({ itemId: itemId || null })} options={[{ value: '', label: t('designer.firstInstance') }, ...instances.map((i) => ({ value: i.id, label: i.name ?? i.title ?? i.id }))]} /></Field>}
          <Field label=" " wide><Button size="sm" onClick={() => { const [w, h] = overlayDef(el.kind).size; const k = Math.min(1, overlay.width / w, overlay.height / h); set({ w: Math.round(w * k), h: Math.round(h * k) }); }}>{t('designer.nativeSize')}</Button></Field>
          <p className="muted small field-wide">{t('designer.widgetHint')}</p>
        </>}
        <Field label="X"><NumberInput value={el.x} onChange={(x) => onChange({ x })} /></Field>
        <Field label="Y"><NumberInput value={el.y} onChange={(y) => onChange({ y })} /></Field>
        <Field label={t('designer.width')}><NumberInput value={el.w} min={1} onChange={(w) => onChange({ w })} /></Field>
        <Field label={t('designer.height')}><NumberInput value={el.h} min={1} onChange={(h) => onChange({ h })} /></Field>
        <Field label={t('designer.rotation')}><NumberInput value={el.rotation} min={-360} max={360} onChange={(rotation) => onChange({ rotation })} /></Field>
        <Field label={t('designer.opacity')}><NumberInput value={el.opacity} min={0} max={100} step={5} onChange={(opacity) => onChange({ opacity })} /></Field>
        <Field label={t('designer.position')} wide><div className="row-gap wrap">
          <Button size="sm" onClick={() => onChange({ x: Math.round((overlay.width - el.w) / 2) })}>{t('designer.centerH')}</Button>
          <Button size="sm" onClick={() => onChange({ y: Math.round((overlay.height - el.h) / 2) })}>{t('designer.centerV')}</Button>
          <Button size="sm" onClick={() => onChange({ x: 0, y: 0, w: overlay.width, h: overlay.height })}>{t('designer.fill_canvas')}</Button>
        </div></Field>
      </div>
      <div className="row-gap wrap designer-prop-actions">
        <Button size="sm" onClick={() => onReorder('top')}>{t('designer.toFront')}</Button>
        <Button size="sm" onClick={() => onReorder('bottom')}>{t('designer.toBack')}</Button>
        <Button size="sm" icon="duplicate" onClick={onDuplicate}>{t('designer.duplicate')}</Button>
        <Button size="sm" variant="danger" icon="trash" onClick={onDelete}>{t('common.delete')}</Button>
      </div>
    </Card>
  );
}
