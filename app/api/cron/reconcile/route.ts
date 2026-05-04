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
import { getClient } from '../../_lib/hedera';
import { getStore } from '../../_lib/store';
import { getAgentContext } from '../../_lib/mcp';
import { acquireOperatorLock, releaseOperatorLock } from '../../_lib/locks';
import { withStore } from '../../_lib/withStore';
import { reconcile, type ReconciliationResult } from '~/custodial/Reconciliation';
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

  // Operator lock so cron + manual operator click don't both walk
  // state at once. If we can't acquire (another reconcile in flight),
  // skip this run silently — cron fires every hour, the next run
  // will pick up. NOT 503 because that would page the operator for a
  // benign concurrency event.
  const lockToken = await acquireOperatorLock('reconcile', 300);
  if (!lockToken) {
    return NextResponse.json(
      { skipped: true, reason: 'reconcile already in progress' },
      { headers: CORS_HEADERS },
    );
  }

  let result: ReconciliationResult;
  try {
    // Process any pending deposits before reconciling so the ledger
    // reflects the latest on-chain state. Same pattern as the admin
    // reconcile route.
    const { multiUser } = await getAgentContext();
    await multiUser.pollDepositsOnce();

    const client = getClient();
    const store = await getStore();

    // Refresh everything reconciliation reads
    await Promise.all([store.refreshUserIndex(), store.refreshOperator()]);

    result = await reconcile(client, store);
  } catch (err) {
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

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}
