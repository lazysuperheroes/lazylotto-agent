/**
 * GET /api/user/prize-status
 *
 * Returns the user's prize claim state by querying the LazyLotto dApp
 * for prizes currently sitting in the contract waiting for them to
 * claim, then deriving "claimed" totals by subtracting pending from
 * total-ever-won (sourced from local session history).
 *
 * Why this endpoint exists separately from /api/user/status:
 *   - It makes an MCP roundtrip to the dApp, which is slower than the
 *     local store reads in /status. We don't want to slow down every
 *     dashboard load with a dApp query.
 *   - It's an enrichment, not a load-bearing field. If the dApp is
 *     down, the dashboard should still render — it just shouldn't
 *     show pending claim info.
 *
 * Response shape:
 *   {
 *     available: true,
 *     pending: {
 *       count: number,                       // total pending prize entries
 *       byToken: Record<string, number>,     // { hbar: 5, lazy: 100, ... }
 *       nftCount: number,                    // total NFT serials pending
 *       nfts: PendingNftRef[]                // raw refs for enrichment
 *     },
 *     totalWon: {
 *       byToken: Record<string, number>,     // sum across all sessions
 *       nftCount: number
 *     },
 *     claimed: {
 *       byToken: Record<string, number>,     // totalWon - pending, floored at 0
 *       nftCount: number
 *     }
 *   }
 *
 *   On dApp failure:
 *   {
 *     available: false,
 *     reason: string
 *   }
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { getAgentContext } from '../../_lib/mcp';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export const GET = withStore(async (request: Request) => {
  try {
    // Same read-rate as /status — this is a dashboard enrichment
    // that gets called on mount + after each play, never in a tight
    // loop.
    if (
      !(await checkRateLimit({ request, action: 'user-prize-status', limit: 60, windowSec: 60 }))
    ) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    await store.refreshUserIndex();

    let user = store.getUserByAccountId(auth.accountId);
    if (!user) {
      const allUsers = store.getAllUsers();
      user = allUsers.find(
        (u) => u.eoaAddress.toLowerCase() === auth.accountId.toLowerCase(),
      );
    }
    if (!user) {
      return NextResponse.json(
        { error: 'User not found for this account' },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // Query the dApp for currently-pending prizes via the MCP client.
    // The agent's getPendingPrizesForUser handles failures gracefully
    // and returns null instead of throwing.
    const { multiUser } = await getAgentContext();
    const dappState = await multiUser.getPendingPrizesForUser(user.userId);

    if (!dappState) {
      // Soft failure: return available=false so the dashboard can
      // render the rest of the page without surfacing an error.
      return NextResponse.json(
        {
          available: false,
          reason: 'dApp prize query unavailable',
        },
        { headers: CORS_HEADERS },
      );
    }

    // ── Build pending totals ────────────────────────────────────
    const pendingByToken: Record<string, number> = {};
    let pendingNftCount = 0;

    for (const p of dappState.pendingPrizes) {
      // Fungible side
      if (p.fungiblePrize && p.fungiblePrize.amount > 0) {
        const tokenKey = normalizeTokenKey(p.fungiblePrize.token);
        pendingByToken[tokenKey] = (pendingByToken[tokenKey] ?? 0) + p.fungiblePrize.amount;
      }
      // NFT side — count serials, not entries
      for (const nftRef of p.nfts) {
        pendingNftCount += nftRef.serials.length;
      }
    }

    // ── Build totalWon totals from local session history ────────
    // We pull sessions for THIS user only. The session record's
    // prizesByToken is populated by ReportGenerator from the same
    // pendingPrizes shape we get from getUserState — so the keys
    // line up.
    const sessions = store.getPlaySessionsForUser(user.userId);
    const totalWonByToken: Record<string, number> = {};
    let totalWonNftCount = 0;

    for (const s of sessions) {
      for (const [token, amount] of Object.entries(s.prizesByToken ?? {})) {
        const tokenKey = normalizeTokenKey(token);
        totalWonByToken[tokenKey] = (totalWonByToken[tokenKey] ?? 0) + amount;
      }
      // NFT count — sum nftCount across all pool results
      for (const pr of s.poolResults ?? []) {
        for (const detail of pr.prizeDetails ?? []) {
          totalWonNftCount += detail.nftCount ?? 0;
        }
      }
    }

    // ── Derive claimed = max(0, totalWon - pending) ─────────────
    // Floored at 0 because the user might have prizes pending that
    // we have no local record of (e.g. they played directly on the
    // dApp before connecting the agent). In that case totalWon
    // would be smaller than pending and the subtraction would go
    // negative — which means "the agent has no record of this win
    // but it's there", not "the user owes us prizes."
    const claimedByToken: Record<string, number> = {};
    const allTokens = new Set([
      ...Object.keys(totalWonByToken),
      ...Object.keys(pendingByToken),
    ]);
    for (const token of allTokens) {
      const won = totalWonByToken[token] ?? 0;
      const pending = pendingByToken[token] ?? 0;
      const claimed = Math.max(0, won - pending);
      // Round to 4 decimals to avoid float noise in the UI
      if (claimed > 0) {
        claimedByToken[token] = Math.round(claimed * 10000) / 10000;
      }
    }
    const claimedNftCount = Math.max(0, totalWonNftCount - pendingNftCount);

    return NextResponse.json(
      {
        available: true,
        pending: {
          count: dappState.pendingPrizesCount,
          byToken: pendingByToken,
          nftCount: pendingNftCount,
          // Raw refs so the dashboard can run NFT enrichment on them
          // if it wants per-collection / per-serial detail.
          nfts: dappState.pendingPrizes
            .flatMap((p) => p.nfts)
            .filter((n) => n.serials.length > 0),
        },
        totalWon: {
          byToken: totalWonByToken,
          nftCount: totalWonNftCount,
        },
        claimed: {
          byToken: claimedByToken,
          nftCount: claimedNftCount,
        },
      },
      {
        headers: {
          ...CORS_HEADERS,
          // Cache for 60s + stale-while-revalidate so tab-switching
          // and dashboard re-mounts don't hammer the dApp MCP
          // (which is the slow link in this query — 1-2s round trip).
          //
          // Pending prizes only change when the user plays AND wins,
          // and we refetch explicitly inside handlePlay's success path,
          // so the cache window doesn't hide stale data in practice.
          // The previous max-age=10 was too short to deflect even a
          // back-button bounce.
          //
          // s-maxage matches because Vercel's edge respects it for
          // private responses keyed by Authorization.
          'Cache-Control': 'private, max-age=60, stale-while-revalidate=120',
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
});

/**
 * Normalize a token key from the dApp's various spellings to the
 * lowercase form the agent uses internally.
 *
 * The dApp returns "HBAR" (uppercase) as the native token, while the
 * agent stores it as "hbar" (lowercase). Token IDs (0.0.X) pass through
 * unchanged. Symbolic names like "LAZY" → "lazy" so the totals merge
 * cleanly with the agent's internal naming.
 */
function normalizeTokenKey(token: string): string {
  if (!token) return 'hbar';
  if (token.startsWith('0.0.')) return token;
  return token.toLowerCase();
}
