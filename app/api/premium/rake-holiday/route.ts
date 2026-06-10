/**
 * POST /api/premium/rake-holiday — the x402-gated "rake holiday" capability.
 *
 * Pay a USD-denominated price (in USDC or the live HBAR equivalent) via x402;
 * on settlement the signed-in user gets 0% rake for the configured window.
 *
 * x402 is an ALTERNATIVE payment channel and is OFF by default: when the gate
 * isn't active (`isX402Active` false), this purchase is simply unavailable
 * (503) — we never grant a free holiday. The rake itself is untouched; the
 * grant flips the user's effective rake to 0 via src/custodial/rakeHoliday.ts.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { loadFeatureConfig, isX402Active } from '~/config/features';
import { grantRakeHoliday } from '~/custodial/rakeHoliday';

export const maxDuration = 60;
export const runtime = 'nodejs';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

export const POST = withStore(async (request: Request) => {
  const cfg = loadFeatureConfig();

  // x402 OFF / half-configured → the purchase is unavailable (never free).
  if (!isX402Active(cfg)) {
    return NextResponse.json(
      { error: 'Rake-holiday purchase is not available (x402 payment gate disabled).' },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  if (
    !(await checkRateLimit({ request, action: 'rake-holiday', limit: 10, windowSec: 60 }))
  ) {
    return rateLimitResponse(60);
  }

  const auth = await requireTier(request, 'user');
  if (isErrorResponse(auth)) return auth;

  const store = await getStore();
  await store.refreshUserIndex();
  const user = store.getUserByAccountId(auth.accountId);
  if (!user) {
    return NextResponse.json(
      { error: 'User not found for this account. Register first.' },
      { status: 404, headers: CORS_HEADERS },
    );
  }

  // Dynamic import keeps the @x402 SDK out of the cold path; only reached on
  // the active gate.
  const { buildRakeHolidayRequirements } = await import('~/x402/scheme');
  const { settleOrChallenge } = await import('../../_lib/x402Gate');

  const origin = new URL(request.url).origin;
  const days = cfg.x402.rakeHoliday.durationDays;

  try {
    const accepts = await buildRakeHolidayRequirements(cfg.x402);
    const gate = await settleOrChallenge({
      request,
      cfg: cfg.x402,
      accepts,
      resourceUrl: `${origin}/api/premium/rake-holiday`,
      resourceDescription: `LazyLotto rake holiday — 0% rake for ${days} days · $${(
        cfg.x402.rakeHoliday.priceUsdCents / 100
      ).toFixed(2)}`,
    });

    if (gate.kind === 'challenge') return gate.response;

    // Payment settled — grant the holiday (idempotent per settlement tx).
    const { settlement, paidRequirements } = gate;
    const { grant, alreadyProcessed } = await grantRakeHoliday({
      userId: user.userId,
      durationDays: days,
      settlementTxId: settlement.transaction,
      priceUsdCents: cfg.x402.rakeHoliday.priceUsdCents,
      asset: paidRequirements.asset,
      amount: paidRequirements.amount,
      nowMs: Date.now(),
    });

    const until = new Date(grant.untilMs).toISOString();

    // x402 commerce: optional on-chain audit anchor (flag-gated via
    // X402_RECORD_TO_HCS20). Best-effort — the grant in Redis is the source of
    // truth, so a topic-write failure (or accounting not configured) must NEVER
    // fail the user's paid purchase. Only emitted on a fresh grant, not a
    // replay; the reader also de-dups on the settlement tx, but skipping the
    // re-emit keeps the topic clean.
    if (cfg.x402.recordToHcs20 && !alreadyProcessed) {
      try {
        const { getAgentContext } = await import('../../_lib/mcp');
        const { multiUser } = await getAgentContext();
        await multiUser.getAccountingForRecovery().recordX402RakeHoliday({
          userAccountId: auth.accountId,
          recordedBy: multiUser.getAgentAccountIdForRecovery(),
          settlementTxId: settlement.transaction,
          asset: paidRequirements.asset,
          amount: paidRequirements.amount,
          priceUsdCents: cfg.x402.rakeHoliday.priceUsdCents,
          durationDays: days,
          untilIso: until,
        });
      } catch (recErr) {
        console.error(
          '[rake-holiday] HCS-20 receipt anchor failed (non-fatal):',
          recErr,
        );
      }
    }

    // Humanized amount for the user-facing message (e.g. "63.15 HBAR") — the
    // settlement itself recorded the atomic amount. Falls back to atomic if the
    // chosen requirement somehow lacks the display enrichment.
    const paid =
      (paidRequirements.extra as { display?: string } | undefined)?.display ??
      paidRequirements.amount;
    return NextResponse.json(
      {
        ok: true,
        alreadyProcessed,
        rakeHoliday: {
          until,
          durationDays: days,
          paid,
          settlementTx: settlement.transaction,
          payer: settlement.payer ?? null,
          asset: paidRequirements.asset,
        },
        message: alreadyProcessed
          ? `This payment (${paid}) was already applied; your rake holiday is active.`
          : `Rake holiday active — 0% rake until ${until}. You paid ${paid}.`,
      },
      {
        headers: {
          ...CORS_HEADERS,
          'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settlement)).toString('base64'),
        },
      },
    );
  } catch (err) {
    console.error('[rake-holiday] x402 flow failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Payment processing failed: ${message}` },
      { status: 502, headers: CORS_HEADERS },
    );
  }
});
