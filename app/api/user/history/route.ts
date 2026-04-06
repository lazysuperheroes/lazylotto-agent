/**
 * GET /api/user/history
 *
 * Returns the authenticated user's play session history (most recent 20).
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { checkDeposits } from '../../_lib/deposits';
import { enrichPrizes, type EnrichedPrizeNft } from '~/enrichment/prizes';
import type { PlaySessionResult } from '~/custodial/types';
import type { PrizeNft } from '~/agent/ReportGenerator';

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

    // Process any pending deposits before returning history
    await checkDeposits();

    const store = await getStore();
    const accountId = auth.accountId;

    // Resolve userId from accountId
    let user = store.getUserByAccountId(accountId);

    if (!user) {
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

    // Get play sessions for this user, return the most recent 20
    const sessions = store.getPlaySessionsForUser(user.userId);
    const recent = sessions.slice(-20).reverse();

    // Enrich NFT prizes across all sessions in a single batch pass
    const allNftRefs: PrizeNft[] = [];
    for (const session of recent) {
      for (const pr of session.poolResults) {
        for (const pd of pr.prizeDetails) {
          if (pd.nfts) allNftRefs.push(...pd.nfts);
        }
      }
    }

    // Deduplicate by hederaId!serial — enrichPrizes does this internally too
    // but we want to index the results for re-attachment
    const enrichedByKey = new Map<string, EnrichedPrizeNft>();
    if (allNftRefs.length > 0) {
      try {
        const enriched = await enrichPrizes(allNftRefs);
        for (const e of enriched) {
          enrichedByKey.set(`${e.hederaId}!${e.serial}`, e);
        }
      } catch (err) {
        // Enrichment failure should not break history — degrade to raw capture
        console.warn('[history] prize enrichment failed:', err);
      }
    }

    // Re-attach enriched data to each session's prizeDetails
    const enrichedSessions = recent.map((session: PlaySessionResult) => ({
      ...session,
      poolResults: session.poolResults.map((pr) => ({
        ...pr,
        prizeDetails: pr.prizeDetails.map((pd) => ({
          ...pd,
          enrichedNfts: pd.nfts
            ?.map((n) => enrichedByKey.get(`${n.hederaId}!${n.serial}`))
            .filter((e): e is EnrichedPrizeNft => Boolean(e)),
        })),
      })),
    }));

    return NextResponse.json(
      { userId: user.userId, sessions: enrichedSessions },
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
