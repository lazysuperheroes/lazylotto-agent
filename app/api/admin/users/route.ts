/**
 * GET /api/admin/users
 *
 * Returns all registered users with checksummed Hedera addresses.
 * Requires 'admin' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { withChecksum } from '~/utils/checksum';

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
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();

    // Refresh the user index + records from Redis
    await store.refreshUserIndex();

    const allUsers = store.getAllUsers();

    const users = allUsers.map((user) => ({
      userId: user.userId,
      hederaAccountId: withChecksum(user.hederaAccountId),
      eoaAddress: user.eoaAddress,
      depositMemo: user.depositMemo,
      strategyName: user.strategyName,
      strategyVersion: user.strategyVersion,
      rakePercent: user.rakePercent,
      balances: user.balances,
      active: user.active,
      registeredAt: user.registeredAt,
      lastPlayedAt: user.lastPlayedAt,
    }));

    return NextResponse.json({ users }, { headers: CORS_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
