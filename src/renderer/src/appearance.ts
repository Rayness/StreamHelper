import { useEffect } from 'react';
import { normalizeAppearance } from '@shared/defaults';
import type { AppearanceSettings, ThemeId } from '@shared/types';
import { saveSettings, useApp } from './store';

export const THEMES: { id: ThemeId; bg: string; side: string; panel: string; line: string }[] = [
  { id: 'midnight', bg: '#0d0d12', side: '#111118', panel: '#1b1b25', line: '#3a3a4c' },
  { id: 'graphite', bg: '#121212', side: '#181818', panel: '#222', line: '#474747' },
  { id: 'ocean', bg: '#0a1018', side: '#0d1520', panel: '#15212f', line: '#31475e' },
  { id: 'oled', bg: '#000', side: '#060606', panel: '#141414', line: '#333' },
  { id: 'light', bg: '#f2f2f7', side: '#e9e9f1', panel: '#fff', line: '#c8c8d4' },
];

export const ACCENTS = ['#9b6bff', '#5b8cff', '#2bb3ff', '#22c7a9', '#4cc764', '#f5b544', '#ff8a4c', '#ff5d8f', '#e05cff'];

export function useAppearance(): AppearanceSettings {
  return normalizeAppearance(useApp((d) => d.settings!.appearance));
}

export function saveAppearance(current: AppearanceSettings, patch: Partial<AppearanceSettings>): void {
  saveSettings('appearance', { ...current, ...patch });
}

/** Mirrors the appearance settings onto <html>; theme.css does the rest. */
export function useApplyAppearance(): void {
  const look = useAppearance();
  const materialSupported = useApp((d) => d.windowMaterial);
  useEffect(() => {
    const root = document.documentElement;
    const set = (name: string, value: string | null) => (value === null ? root.removeAttribute(name) : root.setAttribute(name, value));
    set('data-theme', look.theme);
    set('data-glass', look.glass ? '' : null);
    set('data-material', look.glass && look.windowMaterial !== 'none' && materialSupported ? look.windowMaterial : null);
    set('data-density', look.density);
    set('data-corners', look.corners);
    set('data-motion', look.animations ? null : 'off');
    root.style.setProperty('--accent', look.accent);
    // strength 0 → 92% opaque panels, 100 → 32%.
    root.style.setProperty('--glass-alpha', `${Math.round(92 - look.glassStrength * 0.6)}%`);
    try {
      localStorage.setItem('look', JSON.stringify({ theme: look.theme, accent: look.accent }));
    } catch {
      /* private mode */
    }
  }, [look.theme, look.glass, look.windowMaterial, look.density, look.corners, look.animations, look.accent, look.glassStrength, materialSupported]);
}

/** Before settings arrive: last theme, so a light theme does not flash dark on start. */
export function applyCachedAppearance(): void {
  try {
    const cached = JSON.parse(localStorage.getItem('look') ?? 'null');
    const look = normalizeAppearance(cached);
    document.documentElement.setAttribute('data-theme', look.theme);
    document.documentElement.style.setProperty('--accent', look.accent);
  } catch {
    /* ignore */
  }
}
