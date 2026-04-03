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

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(request: Request) {
  try {
    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    const accountId = auth.accountId;

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

    if (!user) {
      return NextResponse.json(
        { error: 'User not found for this account' },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      {
        userId: user.userId,
        hederaAccountId: user.hederaAccountId,
        eoaAddress: user.eoaAddress,
        depositMemo: user.depositMemo,
        strategyName: user.strategyName,
        strategyVersion: user.strategyVersion,
        rakePercent: user.rakePercent,
        balances: user.balances,
        active: user.active,
        registeredAt: user.registeredAt,
        lastPlayedAt: user.lastPlayedAt,
      },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
