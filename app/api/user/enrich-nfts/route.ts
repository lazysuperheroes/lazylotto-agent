/**
 * POST /api/user/enrich-nfts
 *
 * Lazy enrichment endpoint — takes a list of { hederaId, serial } refs and
 * returns EnrichedPrizeNft[] resolved via Directus + mirror node + verification.
 *
 * Called from the dashboard and audit pages AFTER the initial history / audit
 * response renders. This keeps the critical path fast: raw play data appears
 * immediately, NFT images + verification badges fade in a few hundred ms later.
 *
 * Requires 'user' tier auth. Any authenticated user can resolve any NFT ref
 * (the data is all on-chain/public) — the auth is just to prevent anonymous
 * hammering of Directus.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { enrichPrizes } from '~/enrichment/prizes';
import type { PrizeNft } from '~/agent/ReportGenerator';

const MAX_REFS_PER_REQUEST = 200;

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

    const body = (await request.json()) as { refs?: unknown };
    if (!Array.isArray(body.refs)) {
      return NextResponse.json(
        { error: 'Missing required field: refs (array)' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    if (body.refs.length > MAX_REFS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many refs (max ${MAX_REFS_PER_REQUEST})` },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // Normalize + validate each ref
    const prizeNfts: PrizeNft[] = [];
    for (const raw of body.refs) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const hederaId = typeof r.hederaId === 'string' ? r.hederaId : null;
      const serial = typeof r.serial === 'number' ? r.serial : Number(r.serial);
      if (!hederaId || !Number.isFinite(serial)) continue;
      prizeNfts.push({
        token: typeof r.token === 'string' ? r.token : '',
        hederaId,
        serial,
      });
    }

    if (prizeNfts.length === 0) {
      return NextResponse.json({ enriched: [] }, { headers: CORS_HEADERS });
    }

    const enriched = await enrichPrizes(prizeNfts);
    return NextResponse.json({ enriched }, { headers: CORS_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
