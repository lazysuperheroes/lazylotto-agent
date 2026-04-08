'use client';

import { useEffect, useState } from 'react';
import { CharacterMascot } from '../auth/CharacterMascot';
import {
  LSH_CHARACTERS,
  loadOrPickCharacterIdx,
  pickLine,
} from '../lib/characters';

// ---------------------------------------------------------------------------
// LoadingMascot
// ---------------------------------------------------------------------------
//
// A page-level loading treatment that puts the LazyLotto mascot at the
// centre of the moment instead of a generic animate-spin ring. Used for
// any loading state big enough to occupy real estate (AuthFlow initial
// session check, wallet-connect phases, audit trail hydration, etc.).
//
// Why this exists: the pre-delight app shipped three copies of
//
//     <div className="h-8 w-8 animate-spin rounded-full border-2
//                     border-muted border-t-brand" />
//
// which is the universal AI-generated loading ring. Every one of those
// appeared at a first-impression moment (AuthFlow loading branch, wallet
// connecting, audit page fetch) — exactly the moments where the product
// needs to feel distinctive. The audit flagged these as Pattern 1
// (rounded-corner AI-slop tells) and this component is the central fix.
//
// What it does:
//   - Loads the user's persistent character from localStorage via
//     loadOrPickCharacterIdx (same source as every other mascot site)
//   - Picks a loading line deterministically per character name so the
//     same character always shows the same quip — no jitter during the
//     brief ~200ms-1s window the loading state is visible
//   - Renders a small CharacterMascot with the line under it as a speech
//     caption. The mascot's idle-float animation provides the "working"
//     motion cue that the spinning ring used to provide, via a
//     composited transform (no layout thrash).
//
// Accessibility:
//   - role="status" + aria-live="polite" so screen readers announce the
//     line when the loading state mounts. Not aria-atomic: the line is
//     static per mount, so re-announcing isn't a concern.
//   - The mascot frame is aria-hidden because the line text is the
//     announced content; the character image is decorative.
//
// Reduced motion:
//   - Handled by CharacterMascot's mascot-idle class, which already
//     wraps its animation in a prefers-reduced-motion guard.

export interface LoadingMascotProps {
  /**
   * Pool of loading messages. One is picked deterministically per
   * character so the same character shows the same line on repeat
   * mounts. Write product-specific copy — "Checking your session…"
   * beats "Loading…" every time.
   */
  lines: string[];
  /** Mascot frame size. Default 'sm' (80px). */
  size?: 'sm' | 'lg';
}

export function LoadingMascot({ lines, size = 'sm' }: LoadingMascotProps) {
  const [characterIdx, setCharacterIdx] = useState(0);

  useEffect(() => {
    setCharacterIdx(loadOrPickCharacterIdx());
  }, []);

  const character = LSH_CHARACTERS[characterIdx] ?? LSH_CHARACTERS[0]!;
  // Seed by character name so the line is stable across re-renders
  // during the loading window.
  const line = pickLine(lines, character.name);

  return (
    <div
      className="flex flex-col items-center gap-3 py-6 text-center"
      role="status"
      aria-live="polite"
    >
      <CharacterMascot
        key={character.name}
        character={character}
        size={size}
        line={line}
      />
    </div>
  );
}
