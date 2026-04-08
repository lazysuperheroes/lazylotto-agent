'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CharacterMascot } from './auth/CharacterMascot';
import {
  LSH_CHARACTERS,
  loadOrPickCharacterIdx,
  pickLine,
} from './lib/characters';
import { getVisitCount } from './lib/mascotRarity';

// ---------------------------------------------------------------------------
// Root redirect — "checking for session" interstitial
// ---------------------------------------------------------------------------
//
// The previous incarnation was a generic `animate-spin rounded-full border-2`
// ring — the universal AI app loading pattern. Users hit this for ~200ms
// during the auth check and it was the FIRST thing they saw. That's the
// single most important impression moment in the product; a generic
// spinner wastes it.
//
// Replaced with the persistent LazyLotto mascot + a one-line quip. The
// mascot is loaded from localStorage (same character the user sees on
// every other page) so returning users see a familiar face, and
// first-time users see a random character that persists into /auth.
// CharacterMascot handles image loading + error fallback internally so
// the 200ms interstitial doesn't flash or reflow.
//
// The quip is picked deterministically per character so a single page
// refresh doesn't cycle text mid-redirect.

const INTERSTITIAL_LINES = [
  'Looking for your session…',
  'Checking the vault…',
  'One moment — finding your key.',
];

export default function Home() {
  const router = useRouter();
  const [characterIdx, setCharacterIdx] = useState(0);

  useEffect(() => {
    // Rehydrate the mascot BEFORE kicking the redirect so the user sees
    // a character for at least a frame instead of a bare wrapper.
    setCharacterIdx(loadOrPickCharacterIdx());

    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
      return;
    }

    const tier = localStorage.getItem('lazylotto:tier') ?? '';
    if (tier === 'admin' || tier === 'operator') {
      router.replace('/admin');
      return;
    }

    // Smart home redirect for returning user-tier accounts. The product
    // vision is "the agent plays autonomously, the user watches" — so
    // after a user has visited the dashboard enough times to have
    // internalized the loop, the most relevant surface shifts from
    // /dashboard (where they see the balance and can manually nudge a
    // play) to /account (where they manage preferences, check stuck
    // deposits, and view the on-chain trust links).
    //
    // Threshold: >20 dashboard visits. Users can still navigate to
    // /dashboard via the sidebar any time — this only changes the
    // root-URL default landing page. Enabled only for calm-mode users
    // by default would be MORE subtle but also opaque; the explicit
    // dashboard-visit threshold is easier to reason about.
    const visits = getVisitCount();
    if (visits > 20) {
      router.replace('/account');
      return;
    }

    router.replace('/dashboard');
  }, [router]);

  const character = LSH_CHARACTERS[characterIdx] ?? LSH_CHARACTERS[0]!;
  // Seed by character name so the same character always shows the same
  // interstitial line — stable across the 200ms redirect, no jitter.
  const line = pickLine(INTERSTITIAL_LINES, character.name);

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <CharacterMascot key={character.name} character={character} size="sm" line={line} />
    </div>
  );
}
