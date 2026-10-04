import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { OverlayKind, OverlayMessage } from '@shared/types';
import { renderAlert, sampleEvent } from '@shared/alerts';
import { useT } from '../i18n';
import { overlayDef, overlayPath } from '../overlayCatalog';
import { call, callOk, useApp } from '../store';
import { Icon } from './icons';
import { Button, IconButton } from './ui';

/**
 * Live preview of an overlay: the real overlay page at its native size, scaled down to fit.
 * Tall overlays (chat, wheel) are capped by `maxHeight` and centred.
 */
export function ScaledFrame({ src, width, height, maxHeight = 460, message }: { src: string; width: number; height: number; maxHeight?: number; message?: OverlayMessage }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const sendPreview = () => { if (message) frame.current?.contentWindow?.postMessage(message, new URL(src).origin); };
  useEffect(sendPreview, [message, src]);
  const [box, setBox] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el);
    setBox(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const scale = box ? Math.min(box / width, maxHeight / height) : 0;
  return (
    <div ref={ref} className="scaled-frame checker" style={{ height: scale ? height * scale : Math.min(maxHeight, 200) }}>
      {scale > 0 && (
        <iframe
          ref={frame}
          src={src}
          onLoad={sendPreview}
          title="preview"
          style={{ width, height, transform: `scale(${scale})`, left: Math.max(0, (box - width * scale) / 2) }}
          tabIndex={-1}
        />
      )}
    </div>
  );
}

const previewUrl = (url: string) => url + (url.includes('?') ? '&' : '?') + 'preview=1';

/** Preview of an overlay kind (optionally one instance) at its recommended size. */
export function OverlayPreview({ kind, id, maxHeight, children }: { kind: OverlayKind; id?: string; maxHeight?: number; children?: ReactNode }) {
  const t = useT();
  const base = useApp((d) => d.state!.overlayUrl);
  const alerts = useApp((d) => d.settings!.alerts);
  const lang = useApp((d) => d.settings!.language);
  const currency = useApp((d) => d.settings!.currency);
  const def = overlayDef(kind);
  const message: OverlayMessage | undefined = kind === 'alerts' ? { type: 'alert', alert: renderAlert(sampleEvent('follow', lang, currency), {
    ...alerts, types: { ...alerts.types, follow: { ...alerts.types.follow, enabled: true, minAmount: 0 } },
  }, currency)! } : undefined;
  if (!base) return <p className="muted small">{t('overlays.serverDown')}</p>;
  return (
    <div className="ov-preview">
      <ScaledFrame key={`${kind}:${id ?? ''}`} src={previewUrl(base + overlayPath(kind, id))} width={def.size[0]} height={def.size[1]} maxHeight={maxHeight} message={message} />
      {children && <div className="ov-preview-actions">{children}</div>}
    </div>
  );
}

/** URL of an overlay + one-click "Add to OBS", copy and open. */
export function OverlayBar({ kind, id, name }: { kind: OverlayKind; id?: string; name: string }) {
  const t = useT();
  const base = useApp((d) => d.state!.overlayUrl);
  const obsReady = useApp((d) => d.state!.obs.status === 'connected');
  const inObs = useApp((d) => d.state!.overlayKinds[kind] ?? 0);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  const def = overlayDef(kind);
  if (!base) return null;
  const url = base + overlayPath(kind, id);
  return (
    <div className="ov-bar">
      <span className={`ov-state ${inObs ? 'on' : ''}`} title={t('overlays.inObsHint')}>
        <span className="ov-state-dot" />
        {inObs ? t('overlays.inObs', { n: inObs }) : t('overlays.notInObs')}
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
        {def.size[0]}×{def.size[1]}
      </span>
      <IconButton icon="external" label={t('overlays.open')} onClick={() => void call('shell:openExternal', url)} />
      <Button
        variant="primary"
        size="sm"
        icon="plus"
        disabled={!obsReady || adding}
        title={obsReady ? t('overlays.addToObsHint') : t('overlays.addToObsOff')}
        onClick={async () => {
          setAdding(true);
          await callOk('obs:addBrowserSource', `StreamHelper · ${name}`, url, def.size[0], def.size[1]);
          setAdding(false);
        }}
      >
        {t('overlays.addToObs')}
      </Button>
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
