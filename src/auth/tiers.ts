/**
 * Wallet-bound auth tier resolution + de-escalation.
 *
 * Lives in its OWN module with NO Hedera SDK / proto dependencies so the
 * hot-path auth middleware (`resolveAuth`, run on every request) can
 * re-resolve tiers without dragging the SDK into its import graph.
 * `verify.ts` (which DOES need the SDK for signature checks) imports and
 * re-exports `resolveWalletTier` for back-compat.
 */

import type { AuthTier } from './types.js';

/** Tier hierarchy: operator > admin > user > public. */
export const TIER_LEVEL: Record<AuthTier, number> = {
  public: 0,
  user: 1,
  admin: 2,
  operator: 3,
};

/**
 * Resolve a Hedera account ID to its wallet-bound auth tier from the
 * CURRENT env lists:
 *   - OPERATOR_ACCOUNTS — fees, reconcile, health, kill switch, fee withdrawal
 *   - ADMIN_ACCOUNTS    — refunds, dead-letter queue, all-user views
 * Operator is a strict superset (operator membership short-circuits the
 * admin check). No env-list match → 'user' (the authenticated wallet owner).
 *
 * Pure function of (accountId, env) so the tier invariant is unit-testable
 * without forging mirror-node signatures.
 */
export function resolveWalletTier(accountId: string): AuthTier {
  const parseList = (raw: string | undefined): string[] =>
    (raw ?? '').split(',').map((a) => a.trim()).filter(Boolean);

  const operatorAccounts = parseList(process.env.OPERATOR_ACCOUNTS);
  const adminAccounts    = parseList(process.env.ADMIN_ACCOUNTS);

  if (operatorAccounts.includes(accountId)) return 'operator';
  if (adminAccounts.includes(accountId))    return 'admin';
  return 'user';
}

/**
 * F7 (2026-07-05 custodial audit): de-escalate a session's baked tier to
 * the CURRENT env membership, taking the LOWER of the two.
 *
 * An account removed from OPERATOR_ACCOUNTS / ADMIN_ACCOUNTS is
 * de-escalated on its very next request — even for a locked (no-TTL)
 * session — without waiting for the 7-day TTL or a re-auth. Tier can only
 * ever DROP here: we NEVER auto-escalate above the tier baked at auth time
 * (raising tier still requires a fresh signed challenge, so a compromised
 * env list can't silently promote an existing session).
 *
 * Synthetic non-wallet accounts (CLI fail-open `local` / MCP_AUTH_TOKEN
 * `local-owner`) are not env-listed and keep their tier as-is.
 */
export function deEscalateTier(storedTier: AuthTier, accountId: string): AuthTier {
  if (accountId === 'local' || accountId === 'local-owner') return storedTier;
  const current = resolveWalletTier(accountId);
  return TIER_LEVEL[current] < TIER_LEVEL[storedTier] ? current : storedTier;
}
