/**
 * GET /api/admin/dead-letters
 *
 * Returns all dead-letter entries — deposit transactions that failed
 * processing and could not be credited to any user account.
 * Requires 'admin' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
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

export async function GET(request: Request) {
  try {
    // R5-FG-71 (P7-012): authenticate first, then rate-limit by
    // accountId so token rotation can't bypass the cap. R4-FG-44
    // promised "every admin route" but covered POSTs only; the
    // GETs (this, /users, /overview, /audit, /monitoring) were
    // sibling misses that exposed user PII (eoaAddress, balances,
    // full DL context).
    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    if (
      !(await checkRateLimit({
        request,
        action: 'admin-deadletters',
        limit: 60,
        windowSec: 60,
        identity: auth.accountId,
      }))
    ) {
      return rateLimitResponse(60);
    }

    // R5-FG-81 (P10-OBS-001): support ?kind=&sourceKind=&since=
    // query params with grouping. Pre-fix the route returned a flat
    // {deadLetters, count} with zero filter; with R4 adding ~5 new
    // DL flavors, high-priority deposit_anchor_failed was visually
    // identical to low-priority prize_transfer_failed.
    const url = new URL(request.url);
    const kindFilter = url.searchParams.get('kind');
    const sourceKindFilter = url.searchParams.get('sourceKind');
    const sinceParam = url.searchParams.get('since');
    const sinceMs =
      sinceParam && Number.isFinite(Date.parse(sinceParam))
        ? Date.parse(sinceParam)
        : null;

    const store = await getStore();
    await store.refreshDeadLetters();
    let deadLetters = store.getDeadLetters();
    if (kindFilter) {
      deadLetters = deadLetters.filter((e) => e.kind === kindFilter);
    }
    if (sourceKindFilter) {
      deadLetters = deadLetters.filter(
        (e) =>
          (e.details as { sourceKind?: string } | undefined)?.sourceKind ===
          sourceKindFilter,
      );
    }
    if (sinceMs !== null) {
      deadLetters = deadLetters.filter((e) => {
        const ts = Date.parse(e.timestamp ?? '');
        return Number.isFinite(ts) && ts >= sinceMs;
      });
    }

    // R5-FG-81: grouping by kind for at-a-glance triage. Unresolved
    // DLs grouped by kind with severity rankings so deposit_anchor_failed
    // is visually distinct from prize_transfer_failed.
    const SEVERITY_RANK: Record<string, number> = {
      deposit_anchor_failed: 100,
      rake_anchor_failed: 100,
      refunded_originals_sadd_failed: 95,
      audit_trail_orphaned: 80,
      withdrawal_uncertain: 70,
      operator_fee_withdraw_uncertain: 70,
      play_uncertain: 70,
      refund_uncertain: 70,
      deposit_credit_flush_failed: 60,
      prize_transfer_failed: 50,
    };
    const byKind: Record<string, { count: number; unresolved: number; rank: number }> = {};
    for (const dl of deadLetters) {
      const k = dl.kind ?? 'unknown';
      if (!byKind[k]) {
        byKind[k] = { count: 0, unresolved: 0, rank: SEVERITY_RANK[k] ?? 0 };
      }
      byKind[k].count++;
      if (!dl.resolvedAt) byKind[k].unresolved++;
    }
    const summary = Object.entries(byKind)
      .map(([kind, stats]) => ({ kind, ...stats }))
      .sort((a, b) => b.rank - a.rank || b.unresolved - a.unresolved);

    return NextResponse.json(
      { deadLetters, count: deadLetters.length, summary },
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
