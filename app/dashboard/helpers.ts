// ---------------------------------------------------------------------------
// Dashboard helpers — pure formatters and the character-line state machine
// ---------------------------------------------------------------------------
//
// Extracted from the dashboard page during the #212 refactor. None of these
// touch React state — they're pure functions consumed by both the page and
// the future hook splits. Keeping them in one place lets us unit-test them
// without mounting the full dashboard.

import { LSH_CHARACTERS, pickLine } from '../lib/characters';
import type { StatusResponse } from './types';

/**
 * Public dApp URL for the user's claim flow. Mainnet vs testnet is
 * decided at build time from NEXT_PUBLIC_HEDERA_NETWORK (set in
 * next.config.mjs from the same env var the agent uses).
 */
export const DAPP_URL =
  process.env.NEXT_PUBLIC_HEDERA_NETWORK === 'mainnet'
    ? 'https://dapp.lazysuperheroes.com'
    : 'https://testnet-dapp.lazysuperheroes.com';

/**
 * Direct deep-link to the user's pending prize list on the dApp.
 * Used by the "Claim on dApp →" CTA on the dashboard Pending Claim
 * panel. The `/lotto/prizes` path lands on the claim UI directly
 * instead of the generic profile page.
 */
export const DAPP_CLAIM_URL = `${DAPP_URL}/lotto/prizes`;

export function tokenSymbol(tokenKey: string): string {
  if (tokenKey.toLowerCase() === 'hbar') return 'HBAR';
  return tokenKey;
}

export function formatAmount(amount: number): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Character line selection — pick the right quip pool based on agent state
// ---------------------------------------------------------------------------
//
// Replaces a 6-level nested ternary that was correct but unreadable. The
// state machine here is:
//
//   no status         → empty (nothing to render)
//   play in flight    → playingLines (keeps the mascot "talking" during wait)
//   agent closed      → nappingLines (kill switch engaged)
//   first run         → introLines (just registered, no balance, no plays)
//   funded, no plays  → readyLines (teach the user to hit Play)
//   funded, has plays → lazyLines (reward loop quips)
//   no balance        → taglines (generic encouragement to fund)
//
// The line is picked deterministically per user via pickLine() so the
// same page refresh shows the same quip — only the state transition
// rotates them. Play state appends '-play' to the seed so a play in
// flight gets a different selection from the post-play idle state.

export interface CharacterLineState {
  status: StatusResponse | null;
  playLoading: boolean;
  agentClosed: boolean;
  isFirstRun: boolean;
  hasPlayableBalance: boolean;
  sessionsLength: number;
  /**
   * True when the user has wins sitting in the LazyLotto contract that
   * weren't earned through this agent (typically direct dApp plays
   * before the user registered with the agent). When this is true we
   * suppress the first-run teaching bubble — the narrative headline
   * up top already carries the claim-pending call to action, and a
   * "welcome, new player" intro line would contradict it.
   */
  hasPendingClaim?: boolean;
}

export function pickCharacterLine(
  character: (typeof LSH_CHARACTERS)[number],
  state: CharacterLineState,
): string {
  const {
    status,
    playLoading,
    agentClosed,
    isFirstRun,
    hasPlayableBalance,
    sessionsLength,
    hasPendingClaim,
  } = state;
  if (!status) return '';
  if (playLoading) return pickLine(character.playingLines, status.userId + '-play');
  if (agentClosed) return pickLine(character.nappingLines, status.userId);
  // Claim-pending edge case: suppress the bubble so the narrative
  // headline ("Crawford spotted your dApp wins — go grab it…") stands
  // alone without a contradicting first-run teaching line underneath.
  if (isFirstRun && hasPendingClaim) return '';
  if (isFirstRun) return pickLine(character.introLines, status.userId);
  if (hasPlayableBalance && sessionsLength === 0) {
    return pickLine(character.readyLines, status.userId);
  }
  if (hasPlayableBalance) return pickLine(character.lazyLines, status.userId);
  return pickLine(character.taglines, status.userId);
}
