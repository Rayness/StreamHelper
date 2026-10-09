import { useEffect, useState } from 'react';
import { uid } from '@shared/defaults';
import { VARIANT_KEYS } from '@shared/variants';
import type { OverlayKind } from '@shared/types';
import { useT } from '../i18n';
import { getData, saveSettings, setVariantScope, useApp, useVariantScope } from '../store';
import { Icon } from './icons';
import { Button } from './ui';

/**
 * "All scenes / Game / BRB …" above an overlay module: picking a scene makes the whole editor
 * below edit that scene's own copy of the settings (stored as differences from the common ones).
 */
export function SceneVariants({ kind }: { kind: OverlayKind }) {
  const t = useT();
  const key = VARIANT_KEYS[kind];
  const scope = useVariantScope();
  const variants = useApp((d) => d.settings!.overlayVariants).filter((v) => v.kind === kind);
  const obs = useApp((d) => d.state!.obs);
  const [adding, setAdding] = useState(false);
  const [scene, setScene] = useState('');
  // Leaving the module (or switching to another one) always returns to the common settings.
  useEffect(() => () => setVariantScope(null), [kind]);
  if (!key) return null;
  const all = variants;
  const active = scope?.key === key ? all.find((v) => v.id === scope.variantId) : undefined;
  const scenes = obs.scenes.filter((s) => !(obs.containers ?? []).includes(s) && !all.some((v) => v.scene === s));
  const create = (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const existing = all.find((v) => v.scene === clean);
    const id = existing?.id ?? uid('v_');
    if (!existing) saveSettings('overlayVariants', [...(allVariants() ?? []), { id, kind, scene: clean, overrides: {} }]);
    setVariantScope({ key, variantId: id });
    setAdding(false);
    setScene('');
  };
  const changed = active ? Object.keys(active.overrides).length : 0;
  return (
    <div className={`scene-variants ${active ? 'scoped' : ''}`}>
      <div className="scene-variants-row" role="tablist" aria-label={t('variants.title')}>
        <span className="scene-variants-label"><Icon name="video" size={15} />{t('variants.title')}</span>
        <button type="button" role="tab" aria-selected={!active} className={`chip ${!active ? 'active' : ''}`} onClick={() => setVariantScope(null)}>{t('variants.all')}</button>
        {all.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={active?.id === v.id} className={`chip ${active?.id === v.id ? 'active' : ''}`} onClick={() => setVariantScope({ key, variantId: v.id })}>
            {v.scene}{Object.keys(v.overrides).length > 0 && <span className="chip-count">{Object.keys(v.overrides).length}</span>}
          </button>
        ))}
        {adding ? (
          <span className="scene-variants-add">
            {scenes.length > 0 ? (
              <select className="input select" autoFocus value={scene} onChange={(e) => create(e.target.value)}>
                <option value="">{t('variants.pickScene')}</option>
                {scenes.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <input className="input" autoFocus value={scene} placeholder={t('variants.sceneName')} onChange={(e) => setScene(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(scene); if (e.key === 'Escape') setAdding(false); }} />
            )}
            <Button size="sm" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
          </span>
        ) : (
          <button type="button" className="chip chip-add" onClick={() => setAdding(true)}><Icon name="plus" size={14} />{t('variants.add')}</button>
        )}
      </div>
      {active && (
        <div className="scene-variants-note">
          <span>{t('variants.editing', { scene: active.scene })} {changed ? t('variants.changed', { n: changed }) : t('variants.same')}</span>
          {kind === 'alerts' && <span className="muted small">{t('variants.alertsNote')}</span>}
          <span className="scene-variants-actions">
            {changed > 0 && <Button size="sm" icon="replay" onClick={() => saveSettings('overlayVariants', (allVariants() ?? []).map((v) => (v.id === active.id ? { ...v, overrides: {} } : v)))}>{t('variants.reset')}</Button>}
            <Button size="sm" variant="danger" icon="trash" onClick={() => {
              if (!confirm(t('variants.deleteConfirm', { scene: active.scene }))) return;
              setVariantScope(null);
              saveSettings('overlayVariants', (allVariants() ?? []).filter((v) => v.id !== active.id));
            }}>{t('variants.delete')}</Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** Every variant (all kinds), read at click time so concurrent edits of other kinds survive. */
function allVariants() {
  return getData().settings?.overlayVariants;
}
