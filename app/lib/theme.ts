'use client';

import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Theme preference — 'comic' (default) or 'calm'
// ---------------------------------------------------------------------------
//
// Two variants of the LazyLotto dashboard aesthetic:
//
//   - 'comic' (default): the full LazyVerse night-shift-comic-book
//     treatment — halftone textures, hard neo-brutalist offset shadows,
//     Press Start 2P stickers, bouncy mascot wake, character speech
//     bubbles. The loud, on-brand, first-impression vocabulary.
//
//   - 'calm': a subdued variant for users who want the same product
//     without the intensity. Same colour palette (brand gold + ink +
//     panel), same typography hierarchy, same components — just with
//     halftone stripped to a flat tint, shadows halved, small-caps
//     letter-spacing relaxed, and mascot-wake dialed down. Still
//     recognizably LazyLotto; just quieter in the room.
//
// What calm mode is NOT:
//   - A light theme (the background stays dark)
//   - A utilitarian mode (brand still leads)
//   - A "professional" skin (the mascot still speaks, the character
//     still hangs around, the confetti still fires on wins)
// It's volume, not identity.
//
// Persistence: localStorage under 'lazylotto:theme'. The initial
// render uses the stored value if present; otherwise 'comic'. The
// effect runs on every mount so refreshes pick up the stored value
// without waiting for user interaction.

export type ThemePreference = 'comic' | 'calm';

const THEME_STORAGE_KEY = 'lazylotto:theme';

/**
 * Read the stored theme from localStorage. SSR-safe — returns
 * 'comic' on the server where localStorage is undefined.
 */
export function getStoredTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'comic';
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === 'calm' || raw === 'comic') return raw;
  return 'comic';
}

/**
 * Persist a theme preference and apply it to the document root.
 * Broadcasts a CustomEvent so any live hooks update without a
 * full page reload.
 */
export function setStoredTheme(theme: ThemePreference): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  applyThemeToDocument(theme);
  window.dispatchEvent(
    new CustomEvent<ThemePreference>(THEME_CHANGE_EVENT, { detail: theme }),
  );
}

/**
 * Set the data-theme attribute on <html> so the CSS variant
 * selectors in globals.css (html[data-theme='calm'] ...) take effect.
 * Uses an attribute (not a class) so future theme values don't
 * collide with Tailwind class-based utilities.
 */
export function applyThemeToDocument(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  if (theme === 'comic') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export const THEME_CHANGE_EVENT = 'lazylotto:theme-change';

/**
 * Hook: returns the current theme + a setter. Subscribes to the
 * THEME_CHANGE_EVENT so multiple components in the same tab stay in
 * sync when one of them changes the preference.
 */
export function useTheme(): [ThemePreference, (theme: ThemePreference) => void] {
  const [theme, setTheme] = useState<ThemePreference>('comic');

  useEffect(() => {
    const initial = getStoredTheme();
    setTheme(initial);
    applyThemeToDocument(initial);
    const handler = (e: Event) => {
      const next = (e as CustomEvent<ThemePreference>).detail;
      if (next === 'comic' || next === 'calm') setTheme(next);
    };
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
  }, []);

  return [theme, setStoredTheme];
}
