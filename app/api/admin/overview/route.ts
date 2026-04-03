/**
 * GET /api/admin/overview
 *
 * Returns aggregate platform statistics for admin dashboards.
 * Requires 'admin' tier auth.
 *
 * Response includes:
 *   - Total and active user counts
 *   - Per-token aggregate deposits across all users
 *   - Operator rake balances and gas spent
 *   - Dead letter count
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
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    const allUsers = store.getAllUsers();
    const operator = store.getOperator();
    const deadLetters = store.getDeadLetters();

    // Compute per-token aggregate totals across all users
    const totalDeposited: Record<string, number> = {};
    const totalAvailable: Record<string, number> = {};
    const totalReserved: Record<string, number> = {};
    const totalWithdrawn: Record<string, number> = {};

    for (const user of allUsers) {
      for (const [token, entry] of Object.entries(user.balances.tokens)) {
        totalDeposited[token] = (totalDeposited[token] ?? 0) + entry.totalDeposited;
        totalAvailable[token] = (totalAvailable[token] ?? 0) + entry.available;
        totalReserved[token] = (totalReserved[token] ?? 0) + entry.reserved;
        totalWithdrawn[token] = (totalWithdrawn[token] ?? 0) + entry.totalWithdrawn;
      }
    }

    const activeUsers = allUsers.filter((u) => u.active).length;

    return NextResponse.json(
      {
        users: {
          total: allUsers.length,
          active: activeUsers,
          inactive: allUsers.length - activeUsers,
        },
        balances: {
          totalDeposited,
          totalAvailable,
          totalReserved,
          totalWithdrawn,
        },
        operator: {
          balances: operator.balances,
          totalRakeCollected: operator.totalRakeCollected,
          totalGasSpent: operator.totalGasSpent,
          totalWithdrawnByOperator: operator.totalWithdrawnByOperator,
        },
        deadLetterCount: deadLetters.length,
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
