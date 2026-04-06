/**
 * POST /api/user/check-deposits
 *
 * Fires a mirror-node deposit poll for new incoming transactions to the
 * agent wallet. Returns how many deposits were processed and (if the
 * caller resolves to a registered user) the user's refreshed balance.
 *
 * This is called as a background fire-and-forget from the dashboard
 * client AFTER the initial status + history responses render. It takes
 * ~500-1000ms on a cold lambda (mirror node query) so we keep it off
 * the critical path.
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { checkDeposits } from '../../_lib/deposits';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function POST(request: Request) {
  try {
    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const processed = await checkDeposits();

    // If the caller is a registered user, return their refreshed balance
    // so the dashboard can update in place without a full reload.
    const store = await getStore();
    await store.refreshUserIndex();

    let user = store.getUserByAccountId(auth.accountId);
    if (!user) {
      const allUsers = store.getAllUsers();
      user = allUsers.find(
        (u) => u.eoaAddress.toLowerCase() === auth.accountId.toLowerCase(),
      );
    }

    if (user) {
      await store.refreshUser(user.userId);
      user = store.getUser(user.userId) ?? user;
    }

    return NextResponse.json(
      {
        processed,
        balances: user?.balances ?? null,
        lastPlayedAt: user?.lastPlayedAt ?? null,
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
