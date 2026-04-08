'use client';

import { useEffect } from 'react';
import { applyThemeToDocument, getStoredTheme } from '../lib/theme';

// ---------------------------------------------------------------------------
// ThemeBoot
// ---------------------------------------------------------------------------
//
// Mount-time client component that reads the stored theme preference
// and applies `data-theme="calm"` (or removes it) on the <html> root.
// Lives in the root layout so every page picks up the user's preference
// on first render.
//
// Why not inline this in app/layout.tsx directly? The layout is a
// server component, so it can't read localStorage. A tiny mount-only
// client component is the cleanest way to bridge the SSR/client gap
// without turning the whole layout into a client component.
//
// Flash-of-wrong-theme window: There's a brief moment (< 50ms) where
// the user sees the default comic theme before the effect runs and
// applies calm. Acceptable — calm mode is an opt-in preference, not
// an accessibility-critical setting, and the SSR-rendered markup is
// still fully usable during that window. If a future pass wants to
// eliminate the flash entirely, the fix is an inline <script> in
// layout.tsx that sets the attribute synchronously before the first
// paint — but that adds a render-blocking script for a cosmetic win.

export function ThemeBoot() {
  useEffect(() => {
    applyThemeToDocument(getStoredTheme());
  }, []);
  return null;
}
