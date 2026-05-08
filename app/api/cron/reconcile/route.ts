/**
 * GET /api/cron/reconcile
 *
 * Vercel Cron-callable reconcile endpoint. Runs the same reconcile
 * the admin dashboard does, but:
 *   - Authenticated by a shared CRON_SECRET bearer token instead
 *     of a user session token
 *   - Returns 200 only when `solvent: true`; returns 503 with the
 *     same body when insolvent (so a generic uptime monitor can
 *     differentiate "everything is fine" from "the agent is
 *     short of HBAR" without having to parse the JSON)
 *   - Optionally fires a webhook on failure when
 *     RECONCILE_FAILURE_WEBHOOK_URL is set, so insolvency events
 *     get pushed to Slack/Discord without requiring an external
 *     monitor
 *
 * Setup:
 *   1. Set CRON_SECRET to a strong random string in Vercel env vars
 *   2. (Optional) Set RECONCILE_FAILURE_WEBHOOK_URL to a Slack /
 *      Discord incoming webhook URL
 *   3. Add to vercel.json:
 *        {
 *          "crons": [
 *            { "path": "/api/cron/reconcile", "schedule": "0 * * * *" }
 *          ]
 *        }
 *      Vercel Cron supplies the Authorization header automatically
 *      from the CRON_SECRET environment variable when configured
 *      this way.
 *
 * Manual invocation (operator running on demand):
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     https://agent.lazysuperheroes.com/api/cron/reconcile
 */

import { NextResponse } from 'next/server';
import { getStore } from '../../_lib/store';
import { getAgentContext } from '../../_lib/mcp';
import { acquireOperatorLock, releaseOperatorLock, startOperatorLockHeartbeat } from '../../_lib/locks';
import { withStore } from '../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import type { ReconciliationResult } from '~/custodial/Reconciliation';
import { isAuthorizedCron, escapeMrkdwn } from './helpers';

// CORS for the cron endpoint isn't strictly necessary (Vercel Cron
// hits it from the same origin), but include it so an operator can
// curl it manually from their machine for debugging.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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

// Auth check + mrkdwn escape live in ./helpers so vitest can unit-test
// them without booting the agent context.

export const GET = withStore(async (request: Request) => {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json(
      { error: 'Unauthorized: missing or invalid CRON_SECRET' },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  // F5 (2026-05-06 audit I-10): rate limit even with a valid
  // CRON_SECRET. Vercel Cron fires at most a few times per hour
  // legitimately; capping at 10/min makes a leaked secret a much
  // weaker amplification primitive (each call walks every dead
  // letter and fans out mirror-node fetches). Identity is the
  // cron secret prefix so all legitimate cron calls share one
  // bucket.
  // R4-FG-45 (round-4 medium): explicitly compute identity from
  // x-forwarded-for. Pre-fix R3-FG-63 omitted `identity` expecting
  // checkRateLimit's `identityFor(request)` fallback to bucket by
  // source IP — but identityFor checks the Authorization header
  // BEFORE x-forwarded-for, so `Authorization: Bearer
  // $CRON_SECRET` lumped every cron call into one shared
  // bucket-by-bearer-prefix. Compute the IP-bucket directly so the
  // documented "buckets by source IP" actually holds.
  const xff = request.headers.get('x-forwarded-for');
  const clientIp = xff?.split(',')[0]?.trim() ?? 'cron-unknown-ip';
  if (
    !(await checkRateLimit({
      request,
      action: 'cron-reconcile',
      limit: 30,
      windowSec: 60,
      identity: `cron:${clientIp}`,
    }))
  ) {
    return rateLimitResponse(60);
  }

  // Operator lock so cron + manual operator click don't both walk
  // state at once. If we can't acquire (another reconcile in flight),
  // skip this run silently — cron fires every hour, the next run
  // will pick up. NOT 503 because that would page the operator for a
  // benign concurrency event.
  const lockToken = await acquireOperatorLock('reconcile', 900);
  if (!lockToken) {
    return NextResponse.json(
      { skipped: true, reason: 'reconcile already in progress' },
      { headers: CORS_HEADERS },
    );
  }

  // R4-FG-66 (round-4 low): heartbeat the reconcile lock so a slow
  // walk doesn't TTL the lock and let a sibling reconcile mutate
  // overlapping state. R3-FG-29 raised the TTL from 300s → 900s but
  // didn't add a heartbeat — at scale (90+ open DLs × ~10s mirror
  // bias) reconcile can blow 900s; the heartbeat keeps the lock
  // alive for as long as we're actually running. Cleared in finally.
  const heartbeat = startOperatorLockHeartbeat('reconcile', lockToken, 60_000, 900);

  let result: ReconciliationResult;
  try {
    // Process any pending deposits before reconciling so the ledger
    // reflects the latest on-chain state. Same pattern as the admin
    // reconcile route.
    const { multiUser } = await getAgentContext();
    await multiUser.pollDepositsOnce();

    const store = await getStore();
    // Refresh everything reconciliation reads
    await Promise.all([store.refreshUserIndex(), store.refreshOperator()]);

    // Drive reconcile through MultiUserAgent so it picks up both
    // accounting (for refund audit writes) and the UserLedger (for
    // withdrawal_uncertain settle/release).
    result = await multiUser.reconcile();
  } catch (err) {
    heartbeat.cancel();
    await releaseOperatorLock('reconcile', lockToken);
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cron/reconcile] reconcile threw:', err);
    // Reconcile itself failed (mirror node down, Redis unavailable,
    // etc.) — distinct from "reconcile ran and found insolvency".
    // 500 so the monitor distinguishes the two.
    return NextResponse.json(
      { error: message, source: 'reconcile_exception' },
      { status: 500, headers: CORS_HEADERS },
    );
  }
  // Release the lock once reconcile + insolvency check are done.
  // Webhook firing happens after, but doesn't need to hold the lock.
  heartbeat.cancel();
  await releaseOperatorLock('reconcile', lockToken);

  // Webhook on failure (best-effort, never blocks the response).
  // Fire-and-forget so a slow webhook receiver doesn't make the
  // cron run timeout.
  if (!result.solvent && process.env.RECONCILE_FAILURE_WEBHOOK_URL) {
    void fireFailureWebhook(result).catch((webhookErr) => {
      console.error('[cron/reconcile] webhook fire failed:', webhookErr);
    });
  }

  // Return 200 on solvent, 503 on insolvent. The body is the same
  // shape either way so the monitor can parse it for detail.
  return NextResponse.json(result, {
    status: result.solvent ? 200 : 503,
    headers: CORS_HEADERS,
  });
});

/**
 * Post a Slack/Discord-shaped failure message to the webhook URL.
 * Both Slack and Discord webhooks accept `{ text: string }` as the
 * minimum payload, so this works for either.
 *
 * All variable strings (warnings, token names) flow through
 * `escapeMrkdwn` before concatenation. Static format characters
 * (the `*bold*` markers, bullets, the `🚨` emoji) are NOT escaped
 * because they're authored here, not user-supplied.
 */
async function fireFailureWebhook(result: ReconciliationResult): Promise<void> {
  const url = process.env.RECONCILE_FAILURE_WEBHOOK_URL;
  if (!url) return;

  const network = escapeMrkdwn(process.env.HEDERA_NETWORK ?? 'unknown');
  const warningsList = result.warnings.length
    ? result.warnings.map((w) => `• ${escapeMrkdwn(w)}`).join('\n')
    : '(no warnings)';

  const text =
    `🚨 *LazyLotto reconcile FAILED on ${network}*\n` +
    `solvent: ${result.solvent}\n` +
    `\n*Adjusted deltas:*\n` +
    Object.entries(result.adjustedDelta)
      .map(([token, delta]) => `• ${escapeMrkdwn(token)}: ${delta.toFixed(4)}`)
      .join('\n') +
    `\n\n*Warnings:*\n${warningsList}\n` +
    `\n_Run \`/admin\` reconcile or check function logs for details._`;

  // R3-FG-79 (round-3 P10-CRON-002): 5s timeout matches the
  // escalation webhook. Pre-fix could hang the Lambda for the full
  // function ceiling (10s default, 60s for cron) on a bad/slow URL.
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5_000),
  });
}
