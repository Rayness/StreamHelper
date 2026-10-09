import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { OverlayKind, OverlayMessage, OverlayVariant } from '@shared/types';
import { renderAlert, sampleEvent } from '@shared/alerts';
import { VARIANT_KEYS } from '@shared/variants';
import { useT } from '../i18n';
import { overlayDef, overlayPath } from '../overlayCatalog';
import { call, callOk, useApp, useVariantScope } from '../store';
import { Icon } from './icons';
import { Button, IconButton } from './ui';

/**
 * Live preview of an overlay: the real overlay page at its native size, scaled down to fit.
 * Tall overlays (chat, wheel) are capped by `maxHeight` and centred.
 */
export function ScaledFrame({ src, width, height, maxHeight = 460, message, zoomToAlert = false, frameRef, children }: { src: string; width: number; height: number; maxHeight?: number; message?: OverlayMessage; zoomToAlert?: boolean; frameRef?: (frame: HTMLIFrameElement | null, scale: number) => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const sendPreview = () => { if (message) frame.current?.contentWindow?.postMessage(message, new URL(src).origin); };
  // Callers rebuild `message` on every render; resend only when its content changes,
  // otherwise each state push restarted the preview animation.
  const messageKey = message ? JSON.stringify(message) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(sendPreview, [messageKey, src]);
  const [box, setBox] = useState(0);
  const [bounds, setBounds] = useState<{x:number;y:number;width:number;height:number}>();
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const b = event.data?.bounds;
      if (event.source !== frame.current?.contentWindow || event.origin !== new URL(src).origin || event.data?.type !== 'alertPreviewBounds') return;
      if (!b || ![b.x,b.y,b.width,b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return;
      setBounds((old) => old && Object.keys(b).every((key) => old[key as keyof typeof old] === b[key]) ? old : b);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [src]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el);
    setBox(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const detailHeight = Math.min(maxHeight, Math.max(220, box * .65));
  const detail = zoomToAlert && bounds;
  const scale = box ? detail ? Math.min(box * .9 / bounds.width, detailHeight * .85 / bounds.height, 1) : Math.min(box / width, maxHeight / height) : 0;
  useEffect(() => { frameRef?.(frame.current, scale); });
  return (
    <div ref={ref} className="scaled-frame checker" style={{ height: detail ? detailHeight : scale ? height * scale : Math.min(maxHeight, 200) }}>
      {scale > 0 && (
        <iframe
          ref={frame}
          src={src}
          onLoad={sendPreview}
          title="preview"
          style={{ width, height, transform: `scale(${scale})`, left: detail ? box/2 - (bounds.x + bounds.width/2)*scale : Math.max(0, (box - width * scale) / 2), top: detail ? detailHeight/2 - (bounds.y + bounds.height/2)*scale : 0 }}
          tabIndex={-1}
        />
      )}
      {scale > 0 && children && <div className="scaled-frame-layer" style={{ width: width * scale, height: height * scale, left: Math.max(0, (box - width * scale) / 2) }}>{children}</div>}
    </div>
  );
}

/** The per-scene variant the open editor is working on, when it belongs to this overlay kind. */
export function useActiveVariant(kind: OverlayKind): OverlayVariant | undefined {
  const scope = useVariantScope();
  const variants = useApp((d) => d.settings!.overlayVariants);
  if (!scope || VARIANT_KEYS[kind] !== scope.key) return undefined;
  return variants.find((v) => v.id === scope.variantId && v.kind === kind);
}

const previewUrl = (url: string) => url + (url.includes('?') ? '&' : '?') + 'preview=1';

/** Preview of an overlay kind (optionally one instance) at its recommended size. */
export function OverlayPreview({ kind, id, maxHeight, children, size }: { kind: OverlayKind; id?: string; maxHeight?: number; children?: ReactNode; size?: [number, number] }) {
  const t = useT();
  const base = useApp((d) => d.state!.overlayUrl);
  const alerts = useApp((d) => d.settings!.alerts);
  const lang = useApp((d) => d.settings!.language);
  const currency = useApp((d) => d.settings!.currency);
  const variant = useActiveVariant(kind);
  const def = overlayDef(kind);
  const [w, h] = size ?? def.size;
  const style = variant?.overrides.style && typeof variant.overrides.style === 'object' ? variant.overrides.style as object : {};
  const message: OverlayMessage | undefined = kind === 'alerts' ? { type: 'alert', alert: renderAlert(sampleEvent('follow', lang, currency), {
    ...alerts, style: { ...alerts.style, ...style }, types: { ...alerts.types, follow: { ...alerts.types.follow, enabled: true, minAmount: 0 } },
  }, currency)! } : undefined;
  if (!base) return <p className="muted small">{t('overlays.serverDown')}</p>;
  return (
    <div className="ov-preview">
      <ScaledFrame key={`${kind}:${id ?? ''}:${variant?.id ?? ''}`} src={previewUrl(base + overlayPath(kind, id, variant?.id))} width={w} height={h} maxHeight={maxHeight} message={message} />
      {children && <div className="ov-preview-actions">{children}</div>}
    </div>
  );
}

/**
 * URL of an overlay + one-click "Add to OBS" (into the chosen scene's StreamHelper group), copy and
 * open. While the editor works on one scene's settings, the URL and the target follow that scene.
 */
export function OverlayBar({ kind, id, name, size }: { kind: OverlayKind; id?: string; name: string; size?: [number, number] }) {
  const t = useT();
  const base = useApp((d) => d.state!.overlayUrl);
  const obs = useApp((d) => d.state!.obs);
  const obsReady = obs.status === 'connected';
  const connected = useApp((d) => d.state!.overlayKinds[kind] ?? 0);
  const variant = useActiveVariant(kind);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  const scenes = obs.scenes.filter((s) => !(obs.containers ?? []).includes(s));
  const [picked, setPicked] = useState('');
  const def = overlayDef(kind);
  if (!base) return null;
  const [w, h] = size ?? def.size;
  const url = base + overlayPath(kind, id, variant?.id);
  const target = variant?.scene ?? (scenes.includes(picked) ? picked : obs.currentScene);
  // Sources of exactly this overlay (same instance and scene variant), per scene.
  const placed = (obs.appSources ?? []).filter((a) => a.kind === kind && (a.id ?? undefined) === (id ?? undefined) && (a.variant ?? undefined) === variant?.id);
  const placedScenes = [...new Set(placed.map((a) => a.scene))];
  const inObs = obsReady && obs.appSources ? placedScenes.length : connected;
  return (
    <div className="ov-bar">
      <span className={`ov-state ${inObs ? 'on' : ''}`} title={placedScenes.length ? placedScenes.join(', ') : t('overlays.inObsHint')}>
        <span className="ov-state-dot" />
        {placedScenes.length ? t('overlays.inScenes', { scenes: placedScenes.slice(0, 3).join(', ') + (placedScenes.length > 3 ? ` +${placedScenes.length - 3}` : '') }) : inObs ? t('overlays.inObs', { n: inObs }) : t('overlays.notInObs')}
      </span>
      <button
        type="button"
        className="ov-url mono"
        title={t('common.copy')}
        onClick={() => {
          void call('clipboard:write', url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        <Icon name={copied ? 'check' : 'link'} size={14} />
        <span>{copied ? t('common.copied') : url.replace(/^https?:\/\//, '')}</span>
      </button>
      <span className="pill" title={t('overlays.sizeHint')}>
        {w}×{h}
      </span>
      <IconButton icon="external" label={t('overlays.open')} onClick={() => void call('shell:openExternal', url)} />
      <span className="ov-add">
        {obsReady && !variant && scenes.length > 1 && (
          <select className="input select ov-scene" value={target} title={t('overlays.targetScene')} aria-label={t('overlays.targetScene')} onChange={(e) => setPicked(e.target.value)}>
            {scenes.map((s) => <option key={s} value={s}>{s === obs.currentScene ? `${s} ●` : s}</option>)}
          </select>
        )}
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          disabled={!obsReady || adding || (!!variant && !obs.scenes.includes(variant.scene))}
          title={obsReady ? t('overlays.addToObsHint') : t('overlays.addToObsOff')}
          onClick={async () => {
            setAdding(true);
            await callOk('obs:addBrowserSource', `StreamHelper · ${name}${variant ? ` · ${variant.scene}` : ''}`, url, w, h, target);
            setAdding(false);
          }}
        >
          {variant ? t('overlays.addToScene', { scene: variant.scene }) : t('overlays.addToObs')}
        </Button>
      </span>
    </div>
  );
}

/** Chips to pick one of several instances (goals, timers, banners...) plus "add". */
export function InstancePicker<T extends { id: string }>({
  items,
  value,
  onChange,
  label,
  onAdd,
  addLabel,
}: {
  items: T[];
  value: string | undefined;
  onChange: (id: string) => void;
  label: (item: T) => string;
  onAdd: () => void;
  addLabel: string;
}) {
  return (
    <div className="chips" role="tablist">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={it.id === value} className={`chip ${it.id === value ? 'active' : ''}`} onClick={() => onChange(it.id)}>
          {label(it) || '—'}
        </button>
      ))}
      <button type="button" className="chip chip-add" onClick={onAdd}>
        <Icon name="plus" size={14} />
        {addLabel}
      </button>
    </div>
  );
}

/** The selected instance, falling back to the first one when the stored id is gone. */
export function pickInstance<T extends { id: string }>(items: T[], id: string | undefined): T | undefined {
  return items.find((i) => i.id === id) ?? items[0];
}
