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
        balances: user.balances,
        active: user.active,
        registeredAt: user.registeredAt,
        lastPlayedAt: user.lastPlayedAt,
        velocity,
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
