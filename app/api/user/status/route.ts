/**
 * GET /api/user/status
 *
 * Returns the authenticated user's account status including balances,
 * registration info, and strategy details. Requires 'user' tier auth.
 *
 * The user is matched by their session's accountId against the store's
 * hederaAccountId or eoaAddress fields.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { withStore } from '../../_lib/withStore';
import { getClient } from '../../_lib/hedera';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { getOperatorAccountId } from '~/hedera/wallet';
import { withChecksum } from '~/utils/checksum';
import { readVelocityStates } from '~/custodial/velocity';
import { listPendingLedgerAdjustments } from '~/custodial/pendingLedger';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

// withStore wrapper: /api/user/status is the dashboard hot path —
// it runs on every mount, every visibility refresh, and after every
// play. Any HTML /500 leak here is the loudest failure mode in the
// app. The wrapper gives us a JSON body with the full stack in
// Vercel logs on any escaped throw.
export const GET = withStore(async (request: Request) => {
  try {
    // Rate limit: 60/min per identity for read endpoints
    if (!(await checkRateLimit({ request, action: 'user-status', limit: 60, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    const accountId = auth.accountId;

    // Refresh the user index so we pick up cross-Lambda writes (registrations
    // from other requests). This is ~1 round trip vs ~8-12 for full load().
    await store.refreshUserIndex();

    // Look up user by Hedera account ID (primary) or EOA address (fallback).
    // PersistentStore has an accountId index, so try that first.
    let user = store.getUserByAccountId(accountId);

    if (!user) {
      // Fallback: iterate all users to match by EOA address
      const allUsers = store.getAllUsers();
      user = allUsers.find(
        (u) =>
          u.eoaAddress.toLowerCase() === accountId.toLowerCase(),
      );
    }

    // If found, refresh just this user to pick up any balance/lastPlayedAt
    // updates from recent MCP play sessions. Another 1 round trip.
    if (user) {
      await store.refreshUser(user.userId);
      user = store.getUser(user.userId) ?? user;
    }

    if (!user) {
      return NextResponse.json(
        { error: 'User not found for this account' },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // Agent wallet address for deposits
    const agentWallet = withChecksum(getOperatorAccountId(getClient()));

    // Withdrawal velocity counters per token. Surfaces "remaining today"
    // in the Withdraw modal so users don't get a raw backend error at
    // submit time when they'd exceed the daily cap.
    //
    // The previous version called getAgentContext() (which spins up the
    // full MultiUserAgent — config load, deposit watcher wiring, ledger
    // setup) just to read counters from Redis, AND it awaited each token
    // sequentially. Now we call readVelocityStates() directly: zero
    // MultiUserAgent dependency, parallel Redis fan-out via Promise.all.
    // Skip on any failure — counters are informational, not load-bearing.
    let velocity: Record<string, { cap: number | null; usedToday: number; remaining: number | null }> = {};
    try {
      // Query the tokens the user actually holds so we don't waste
      // Redis round-trips on empty balances. Always include hbar so the
      // Withdraw modal's default token has a counter even when the user
      // only holds non-HBAR tokens.
      const tokensToQuery = Object.keys(user.balances.tokens);
      if (!tokensToQuery.includes('hbar')) tokensToQuery.push('hbar');
      velocity = await readVelocityStates(user.userId, tokensToQuery);
    } catch {
      /* informational only — leave velocity empty */
    }

    // R9-FG-10 / Phase-7 Cluster E: subtract pending-ledger
    // adjustments from the user's available balances. Pre-fix the
    // route returned `user.balances` verbatim — a refund queued for
    // this user (pending until next drain) showed PHANTOM funds in
    // the dashboard for up to 1 hour. The Withdraw modal would let
    // the user request the refunded amount AGAIN (per-user lock
    // catches it at withdraw time, but the UX was misleading).
    //
    // R10-FG-2 / Phase-8 Cluster C: build a separate response
    // balance object; do NOT reassign `user.balances`. `user` is a
    // live reference to the store-cached UserAccount — reassigning
    // its `.balances` property mutated the cache, so a subsequent
    // /api/user/withdraw call on the same warm Lambda saw balances
    // already net of pending and applied its own pending-debit on
    // top → DOUBLE-DEDUCT. The store cache must be treated as
    // read-only by routes that compose response views.
    const pendingAdjustments: Array<{
      tokenKey: string;
      amount: number;
      reason: string;
      sourceTx: string;
      createdAt: string;
    }> = [];
    let responseBalances = user.balances;
    try {
      const allPending = await listPendingLedgerAdjustments();
      const userPending = allPending.filter((p) => p.userId === user.userId);
      // Build per-token sum to subtract.
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
      // Apply subtraction to a SHALLOW COPY of balances so we don't
      // mutate the store-cached object. `available` reduces by the
      // pending sum; `total` is unchanged (pending is a debit not
      // applied yet).
      if (Object.keys(pendingByToken).length > 0) {
        const adjustedBalances = {
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
        // R10-FG-2: stash on response-only variable; user.balances
        // stays pointing at the store-cached object.
        responseBalances = adjustedBalances;
      }
    } catch {
      /* pending-ledger lookup is informational; if it fails just
         return the raw store balances and skip the badge. */
    }

    return NextResponse.json(
      {
        userId: user.userId,
        hederaAccountId: user.hederaAccountId,
        eoaAddress: user.eoaAddress,
        depositMemo: user.depositMemo,
        agentWallet,
        strategyName: user.strategyName,
        strategyVersion: user.strategyVersion,
        rakePercent: user.rakePercent,
        balances: responseBalances,
        active: user.active,
        registeredAt: user.registeredAt,
        lastPlayedAt: user.lastPlayedAt,
        velocity,
        pendingAdjustments,
      },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    console.error('[user/status] GET failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
