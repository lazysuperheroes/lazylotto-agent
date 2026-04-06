/**
 * GET /api/public/stats
 *
 * Public agent statistics — no auth required. Returns aggregate data
 * users can use to assess the agent's trustworthiness:
 *   - Agent wallet address (for HashScan verification)
 *   - Network
 *   - Total registered users
 *   - Rake rate
 *   - Total value locked (per token)
 *   - HCS-20 audit topic ID
 *   - Operator withdrawal recipient (if configured)
 *
 * No PII, no sensitive operator data — anything you'd put on an
 * "about us" page.
 */

import { NextResponse } from 'next/server';
import { getStore } from '../../_lib/store';
import { getClient } from '../../_lib/hedera';
import { getOperatorAccountId } from '~/hedera/wallet';
import { withChecksum } from '~/utils/checksum';
import { loadCustodialConfig } from '~/custodial/types';

// Public endpoint — wide-open CORS so any frontend can read
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET() {
  try {
    const store = await getStore();
    await store.refreshUserIndex();

    const allUsers = store.getAllUsers();
    const activeUsers = allUsers.filter((u) => u.active).length;
    const config = loadCustodialConfig();

    // Aggregate TVL per token (available + reserved)
    const tvl: Record<string, number> = {};
    for (const user of allUsers) {
      for (const [token, entry] of Object.entries(user.balances.tokens)) {
        tvl[token] = (tvl[token] ?? 0) + entry.available + entry.reserved;
      }
    }

    // Round to 4 decimals
    const tvlRounded: Record<string, number> = {};
    for (const [token, value] of Object.entries(tvl)) {
      tvlRounded[token] = Math.round(value * 10000) / 10000;
    }

    const network = (process.env.HEDERA_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

    let agentWallet: string | null = null;
    try {
      agentWallet = withChecksum(getOperatorAccountId(getClient()));
    } catch {
      /* env not configured — null is fine */
    }

    return NextResponse.json(
      {
        agentName: 'LazyLotto Agent',
        network,
        agentWallet,
        users: {
          total: allUsers.length,
          active: activeUsers,
        },
        rake: {
          defaultPercent: config.rake.defaultPercent,
          minPercent: config.rake.minPercent,
          maxPercent: config.rake.maxPercent,
        },
        tvl: tvlRounded,
        hcs20TopicId: config.hcs20TopicId,
        operatorWithdrawAddress: process.env.OPERATOR_WITHDRAW_ADDRESS || null,
      },
      {
        headers: {
          ...CORS_HEADERS,
          // Cache aggressively — this is public data, no per-user variance
          'Cache-Control': 'public, max-age=60, s-maxage=300',
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
