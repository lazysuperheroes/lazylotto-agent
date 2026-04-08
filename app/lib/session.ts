'use client';

// ---------------------------------------------------------------------------
// Session helpers — single source of truth for client-side session state.
// ---------------------------------------------------------------------------
//
// All localStorage keys the app stores when a user signs in. Anywhere
// that needs to read or clear session state should import from here so
// adding a new key doesn't require touching five disconnect handlers.
//
// Previously: dashboard, sidebar, account page, and AuthFlow each had
// their own inline 5-line `localStorage.removeItem` block. Adding the
// `lazylotto:lastDepositCheck` key (commit 3) is the kind of thing
// that would silently miss one of those call sites and leave a stale
// throttle gate after sign-out.

export const SESSION_KEYS = [
  'lazylotto:sessionToken',
  'lazylotto:accountId',
  'lazylotto:tier',
  'lazylotto:expiresAt',
  'lazylotto:locked',
  'lazylotto:mcpUrl',
  // Throttle gate for /api/user/check-deposits — clear on sign-out so
  // the next sign-in's first dashboard load actually re-checks.
  'lazylotto:lastDepositCheck',
] as const;

/**
 * Remove every session-related key from localStorage. SSR-safe — does
 * nothing on the server (which has no localStorage) so it's safe to
 * call from any handler that might transitively run during SSR.
 */
export function clearSession(): void {
  if (typeof window === 'undefined') return;
  for (const key of SESSION_KEYS) {
    localStorage.removeItem(key);
  }
}

/**
 * Convenience: clear session + redirect to /auth. Most call sites do
 * exactly this pair, so giving it a single name reduces drift.
 *
 * Pass router.replace (not push) so the previous page isn't in the
 * back history — accidental disconnects shouldn't be backable into
 * stale state.
 */
export function disconnect(redirect: (path: string) => void): void {
  clearSession();
  redirect('/auth');
}

/**
 * Read the current session token from localStorage. SSR-safe (returns
 * null on the server). Convenience wrapper that keeps the localStorage
 * key string out of feature code.
 */
export function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('lazylotto:sessionToken');
}
