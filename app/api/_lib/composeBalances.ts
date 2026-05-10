/**
 * R10-FG-2 + R11-FG-3 / Phase-9 Cluster C: shared helper for shaping
 * the user-facing balance response.
 *
 * Pre-Phase-8 the /api/user/status route mutated `user.balances`
 * directly on a live store reference (R10-FG-2 — phantom funds in
 * the dashboard for warm Lambdas).
 *
 * Phase-8 Cluster C closed /api/user/status by introducing a local
 * `responseBalances` variable, but R11 found three sibling routes
 * (/api/user/check-deposits, /api/user/play, /api/user/withdraw)
 * still returning raw `user.balances`. The dashboard merges those
 * back into local state and the phantom-funds view returns through
 * a different codepath (R11-FG-3).
 *
 * Phase-9 Cluster C closes the architectural contract:
 *   - `IStore.getUser*` returns `Readonly<UserAccount>` (compile-time
 *     guarantee that route handlers don't mutate the cache).
 *   - All four balance-bearing routes call `composeBalanceResponse`,
 *     which builds the pre-subtracted `responseBalances` and the
 *     `pendingAdjustments` list from the same source of truth.
 *   - The behavioral test for R10-FG-2 (`r10-fg-2-behavioral.test.ts`)
 *     imports this helper directly instead of holding a verbatim
 *     copy — the test/route divergence concern (P1-002, P3-003) is
 *     gone because there is no copy to drift.
 *
 * The helper owns one thing: composing `responseBalances` and
 * `pendingAdjustments` from a `Readonly<UserAccount>`. It does not
 * fetch the user, refresh the cache, or fire any logging — those
 * remain route-level concerns.
 */

import type { UserAccount, UserBalances } from '~/custodial/types';
import { listPendingLedgerAdjustments } from '~/custodial/pendingLedger';

/** Wire shape of a single pending adjustment surfaced to the dashboard. */
export interface PendingAdjustmentView {
  tokenKey: string;
  amount: number;
  reason: string;
  sourceTx: string;
  createdAt: string;
}

/** Aggregate response view for any balance-bearing route. */
export interface BalanceResponseView {
  /**
   * Balances pre-subtracted by any pending refund debits queued for
   * this user. Equal to `user.balances` (by reference) when no
   * pending entries exist — no allocation in the happy path.
   */
  responseBalances: UserBalances;
  /**
   * Per-entry detail for the dashboard badge. Empty array when no
   * pending entries exist.
   */
  pendingAdjustments: PendingAdjustmentView[];
}

/**
 * Compose the balance response view for `user`.
 *
 * On the no-pending happy path, `responseBalances === user.balances`
 * (reference identity, no allocations). When pending entries exist,
 * builds a shallow-cloned `UserBalances` with each token's
 * `available` reduced by the per-token pending sum (`Math.max(0, ...)`-clamped).
 *
 * Failures inside `listPendingLedgerAdjustments` are swallowed —
 * the badge is informational, not load-bearing. A Redis blip leaves
 * the user seeing raw balances rather than 5xx-ing the route.
 */
export async function composeBalanceResponse(
  user: Readonly<UserAccount>,
): Promise<BalanceResponseView> {
  const pendingAdjustments: PendingAdjustmentView[] = [];
  let responseBalances: UserBalances = user.balances;
  try {
    const allPending = await listPendingLedgerAdjustments();
    const userPending = allPending.filter((p) => p.userId === user.userId);
    const pendingByToken: Record<string, number> = {};
    for (const p of userPending) {
      pendingByToken[p.tokenKey] = (pendingByToken[p.tokenKey] ?? 0) + p.amount;
      pendingAdjustments.push({
        tokenKey: p.tokenKey,
        amount: p.amount,
        reason: p.reason,
        sourceTx: p.sourceTx,
        createdAt: p.createdAt,
      });
    }
    if (Object.keys(pendingByToken).length > 0) {
      const adjustedBalances: UserBalances = {
        ...user.balances,
        tokens: { ...user.balances.tokens },
      };
      for (const [tokenKey, pendingSum] of Object.entries(pendingByToken)) {
        const t = adjustedBalances.tokens[tokenKey];
        if (t) {
          adjustedBalances.tokens[tokenKey] = {
            ...t,
            available: Math.max(0, t.available - pendingSum),
          };
        }
      }
      responseBalances = adjustedBalances;
    }
  } catch {
    /* pending-ledger lookup is informational; on failure we return
       the raw store balances and an empty pendingAdjustments array.
       The caller's balance-display path still works. */
  }
  return { responseBalances, pendingAdjustments };
}
