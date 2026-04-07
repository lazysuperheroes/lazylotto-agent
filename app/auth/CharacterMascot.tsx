'use client';

import { useState } from 'react';
import Image from 'next/image';
import type { LshCharacter } from '../lib/characters';

// ---------------------------------------------------------------------------
// CharacterMascot
// ---------------------------------------------------------------------------
//
// The mascot block used in multiple AuthFlow states (landing, connecting,
// already-auth, success). Renders the bordered comic-panel frame plus the
// reroll die corner button plus an optional speech line below.
//
// State management (vs. the previous useCallback factory inside AuthFlow):
//   - useState `imageLoaded`: drives the loading shimmer. The animate-pulse
//     class lives on the wrapper conditional on this flag instead of being
//     imperatively removed via parentElement DOM walk. Future-proof against
//     next/image internal changes — no DOM-traversal contracts.
//   - useState `imageError`: when the Filebase CDN fails (or the image URL
//     404s on a new character not yet propagated), we fall back to a `?`
//     placeholder inside the same bordered frame. The previous behavior
//     was `style.display = 'none'` which left an empty box — users saw
//     the bordered frame with nothing in it and the character name
//     underneath. Now they see a placeholder so the frame still reads
//     as "the mascot is here, just temporarily unavailable".
//
// Extracted from AuthFlow to:
//   1. Make the loading + error states stateful (the parent useCallback
//      factory had no place to hold state without forcing AuthFlow to
//      track per-mascot state itself).
//   2. Make the component testable in isolation.
//   3. Reset state automatically when the character changes — React
//      remounts the component because we key it on character.name.

export interface CharacterMascotProps {
  character: LshCharacter;
  size?: 'sm' | 'lg';
  line?: string;
  onReroll?: () => void;
}

export function CharacterMascot({
  character,
  size = 'lg',
  line,
  onReroll,
}: CharacterMascotProps) {
  const dim = size === 'lg' ? 'h-32 w-32' : 'h-20 w-20';
  const dimPx = size === 'lg' ? 128 : 80;

  // Reset on character change so the loading shimmer re-fires when
  // the user rerolls. Keying the parent on character.name handles this
  // automatically by remounting, but the explicit state init makes the
  // intent clear and lets us guard against React strict mode quirks.
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  return (
    <div className="animate-fade-scale-in flex flex-col items-center gap-2">
      <div className="relative">
        <div
          className={`relative ${dim} overflow-hidden border-2 border-brand bg-[var(--color-panel)] panel-shadow-sm ${
            imageLoaded || imageError ? '' : 'animate-pulse'
          }`}
        >
          {imageError ? (
            // Fallback when the CDN fails — keep the frame intact so the
            // surface still reads as "mascot present", just placeholder.
            <div
              className="flex h-full w-full items-center justify-center text-2xl text-muted"
              aria-label={`${character.name} image unavailable`}
            >
              ?
            </div>
          ) : (
            <Image
              src={character.img}
              alt={character.name}
              width={dimPx}
              height={dimPx}
              className="h-full w-full object-contain"
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageError(true)}
            />
          )}
        </div>
        {onReroll && (
          <button
            type="button"
            onClick={onReroll}
            aria-label="Change mascot"
            className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center border-2 border-brand bg-[var(--color-panel)] text-xs transition-colors hover:bg-brand/20"
          >
            <span aria-hidden="true">🎲</span>
          </button>
        )}
      </div>
      {line && (
        <p className="text-sm font-medium text-brand">{line}</p>
      )}
    </div>
  );
}
