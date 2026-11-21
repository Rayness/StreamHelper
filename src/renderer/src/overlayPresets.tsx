import type { ChatBackgroundStyle, OverlayKind } from '@shared/types';
import { Icon } from './components/icons';
import { useT, type TKey } from './i18n';
import { getData, saveSettings, toast } from './store';

export type OverlayPresetId = 'minimal' | 'glass' | 'neon' | 'cozy' | 'contrast';

export interface OverlayPreset {
  id: OverlayPresetId;
  font: string;
  accent: string;
  text: string;
  bgHex: string;
  bgRgba: string;
  bgOpacity: number;
  radius: number;
  chatStyle: ChatBackgroundStyle;
  shadow: boolean;
}

export const OVERLAY_PRESETS: readonly OverlayPreset[] = [
  {
    id: 'minimal',
    font: 'Inter',
    accent: '#8b5cf6',
    text: '#f4f4f8',
    bgHex: '#13131b',
    bgRgba: 'rgba(19,19,27,0.82)',
    bgOpacity: 82,
    radius: 12,
    chatStyle: 'card',
    shadow: false,
  },
  {
    id: 'glass',
    font: 'Montserrat',
    accent: '#60a5fa',
    text: '#ffffff',
    bgHex: '#141c2b',
    bgRgba: 'rgba(20,28,43,0.58)',
    bgOpacity: 58,
    radius: 16,
    chatStyle: 'glass',
    shadow: true,
  },
  {
    id: 'neon',
    font: 'Montserrat',
    accent: '#d946ef',
    text: '#faf5ff',
    bgHex: '#120a1f',
    bgRgba: 'rgba(18,10,31,0.86)',
    bgOpacity: 86,
    radius: 12,
    chatStyle: 'neon',
    shadow: true,
  },
  {
    id: 'cozy',
    font: 'Inter',
    accent: '#f59e0b',
    text: '#fffbeb',
    bgHex: '#1d1614',
    bgRgba: 'rgba(29,22,20,0.84)',
    bgOpacity: 84,
    radius: 18,
    chatStyle: 'bubble',
    shadow: false,
  },
  {
    id: 'contrast',
    font: 'Montserrat',
    accent: '#22c55e',
    text: '#ffffff',
    bgHex: '#09090d',
    bgRgba: 'rgba(9,9,13,0.92)',
    bgOpacity: 92,
    radius: 8,
    chatStyle: 'stripe',
    shadow: true,
  },
];

function getPreset(id: OverlayPresetId): OverlayPreset {
  return OVERLAY_PRESETS.find((p) => p.id === id) ?? OVERLAY_PRESETS[0];
}

export function applyPresetToOverlay(id: OverlayPresetId, kind: OverlayKind): void {
  const s = getData().settings;
  if (!s) return;
  const p = getPreset(id);
  switch (kind) {
    case 'alerts':
      saveSettings('alerts', {
        ...s.alerts,
        style: {
          ...s.alerts.style,
          fontFamily: p.font,
          textColor: p.text,
          accentColor: p.accent,
          backgroundColor: p.bgHex,
          backgroundOpacity: p.bgOpacity,
          borderRadius: p.radius,
        },
      });
      break;
    case 'chat':
      saveSettings('chatOverlay', {
        ...s.chatOverlay,
        fontFamily: p.font,
        textColor: p.text,
        accentColor: p.accent,
        background: p.bgRgba,
        backgroundStyle: p.chatStyle,
        borderRadius: p.radius,
        shadow: p.shadow,
      });
      break;
    case 'events':
      saveSettings('eventsOverlay', {
        ...s.eventsOverlay,
        fontFamily: p.font,
        textColor: p.text,
        background: p.bgRgba,
      });
      break;
    case 'donations':
      saveSettings('donationsOverlay', {
        ...s.donationsOverlay,
        fontFamily: p.font,
        textColor: p.text,
        accentColor: p.accent,
        background: p.bgRgba,
      });
      break;
    case 'music':
      saveSettings('musicOverlay', {
        ...s.musicOverlay,
        fontFamily: p.font,
        accentColor: p.accent,
        backgroundOpacity: p.bgOpacity,
      });
      break;
    case 'song':
      saveSettings('songRequests', {
        ...s.songRequests,
        fontFamily: p.font,
        accentColor: p.accent,
        backgroundOpacity: p.bgOpacity,
      });
      break;
    case 'goal':
      saveSettings('goals', s.goals.map((g) => ({ ...g, fontFamily: p.font, textColor: p.text, barColor: p.accent })));
      break;
    case 'timer':
      saveSettings('timers', s.timers.map((tm) => ({ ...tm, fontFamily: p.font, textColor: p.text, accentColor: p.accent })));
      break;
    case 'banner':
      saveSettings('banners', s.banners.map((b) => ({ ...b, fontFamily: p.font, textColor: p.text, accentColor: p.accent, background: p.bgRgba })));
      break;
    case 'spotlight':
      saveSettings('spotlightOverlay', { ...s.spotlightOverlay, fontFamily: p.font, textColor: p.text, accentColor: p.accent, background: p.bgHex });
      break;
    case 'live':
      saveSettings('liveOverlay', { ...s.liveOverlay, fontFamily: p.font, accentColor: p.accent });
      break;
    case 'rewards':
      saveSettings('rewardsOverlay', { ...s.rewardsOverlay, fontFamily: p.font, accentColor: p.accent });
      break;
    case 'collab':
      saveSettings('collabOverlay', { ...s.collabOverlay, fontFamily: p.font, accentColor: p.accent });
      break;
    case 'poll':
      saveSettings('poll', { ...s.poll, fontFamily: p.font, textColor: p.text, barColor: p.accent });
      break;
    case 'giveaway':
      saveSettings('giveaway', { ...s.giveaway, fontFamily: p.font, accentColor: p.accent });
      break;
    case 'focus':
      saveSettings('focus', { ...s.focus, fontFamily: p.font, accentColor: p.accent });
      break;
    default:
      break;
  }
}

const ALL_PRESET_TARGETS: readonly OverlayKind[] = [
  'alerts', 'chat', 'events', 'donations', 'music', 'song', 'goal', 'timer', 'banner', 'spotlight', 'live', 'rewards', 'collab', 'poll', 'giveaway', 'focus',
];

export function applyPresetToAllOverlays(id: OverlayPresetId): void {
  for (const kind of ALL_PRESET_TARGETS) applyPresetToOverlay(id, kind);
  toast('success', 'ovStyle.appliedAll');
}

/** 1-click overlay style preset strip (works per overlay or globally across all overlays). */
export function OverlayStylePresets({ kind, compact = false, bare = false }: { kind?: OverlayKind; compact?: boolean; bare?: boolean }) {
  const t = useT();
  const apply = (id: OverlayPresetId) => {
    if (kind) {
      applyPresetToOverlay(id, kind);
      toast('success', 'ovStyle.appliedOne');
    } else {
      applyPresetToAllOverlays(id);
    }
  };
  const chips = (
    <div className="ov-style-grid">
      {OVERLAY_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          data-overlay-preset={p.id}
          className="ov-style-chip"
          onClick={() => apply(p.id)}
        >
          <span className="ov-style-preview" style={{ background: p.bgHex, borderColor: p.accent }}>
            <i style={{ background: p.accent }} />
            <b style={{ background: p.text }} />
          </span>
          <span>{t(`ovStyle.${p.id}` as TKey)}</span>
        </button>
      ))}
    </div>
  );
  if (bare) {
    return (
      <div className="stack">
        <p className="muted small">{t(kind ? 'ovStyle.hintOne' : 'ovStyle.hintAll')}</p>
        {chips}
      </div>
    );
  }
  return (
    <div className={`ov-style-presets ${compact ? 'compact' : ''}`}>
      <div className="ov-style-presets-head">
        <span className="ov-style-presets-label">
          <Icon name="sparkle" size={14} />
          {t(kind ? 'ovStyle.titleOne' : 'ovStyle.titleAll')}
        </span>
        <span className="muted small">{t(kind ? 'ovStyle.hintOne' : 'ovStyle.hintAll')}</span>
      </div>
      {chips}
    </div>
  );
}
