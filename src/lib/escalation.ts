/**
 * Operator-paging helper for the worst-case state during a receipt-uncertain
 * catch: the on-chain action MAY have landed, AND the dead-letter
 * write that's supposed to anchor the recovery just failed.
 *
 * Without an external page (Slack / Discord webhook), the operator
 * has no way to know they need to manually reconstruct the recovery
 * state — the held reserve / claim sits invisibly until the TTL
 * expires and silently double-spends on retry.
 *
 * Reuses the existing `RECONCILE_FAILURE_WEBHOOK_URL` env, so
 * operators only configure one alert path.
 */

import { logger } from './logger.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';

export interface EscalateUncertainDlInput {
  kind:
    | 'refund_uncertain'
    | 'withdrawal_uncertain'
    | 'operator_fee_withdraw_uncertain'
    | 'play_uncertain'
    /** R3-FG-6: creditDeposit's flush failure after recordDeposit landed. */
    | 'deposit_credit_flush_failed'
    /** R3-FG-7: refundedOriginals SADD failed after on-chain refund + claim overwrite. */
    | 'refunded_originals_sadd_failed'
    /** R3-FG-17: in-band audit-write failure — withdrawal, operator-fee, strategy. */
    | 'audit_trail_orphaned';
  /** The submitted on-chain tx whose status is unknown. */
  uncertainTxId: string;
  /** Affected userId (omit for operator-fee). */
  userId?: string;
  /** The original error that prevented dead-letter write. */
  cause: unknown;
}

/** R3-FG-48: skip the page if we've already escalated this txId in the last 6h. */
const ESCALATION_DEDUP_TTL_SEC = 6 * 60 * 60;

export async function escalateUncertainDlFailure(
  input: EscalateUncertainDlInput,
): Promise<void> {
  const url = process.env.RECONCILE_FAILURE_WEBHOOK_URL;
  if (!url) return;

  // R3-FG-48 (round-3 P10-ESC-001): dedup escalations by txId+kind so
  // a stuck dead-letter doesn't re-page every reconcile pass (24+
  // identical pages per day → operator alert fatigue → real pages
  // get ignored). SET-NX-EX with 6h TTL — first caller wins; sibling
  // callers within the window are no-ops.
  try {
    const redis = await getRedis();
    const dedupKey = `${KEY_PREFIX.escalated}${input.kind}:${input.uncertainTxId}`;
    const claimed = await redis.set(dedupKey, '1', {
      nx: true,
      ex: ESCALATION_DEDUP_TTL_SEC,
    });
    if (claimed === null) {
      // Already escalated within the window.
      return;
    }
  } catch (e) {
    // Redis unavailable — fail open and page anyway. Better duplicate
    // pages than silent loss when the alerting backbone is the only
    // way the operator sees the issue.
    logger.warn('escalateUncertainDlFailure: dedup check failed; paging anyway', {
      component: 'Escalation',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const rawCauseMsg =
    input.cause instanceof Error
      ? input.cause.message
      : String(input.cause);

  // F5 (2026-05-06 audit I-13): neutralize Discord-style group
  // mentions in the cause message. Discord webhooks accept
  // `@everyone`/`@here` even in `{ text }` payloads unless
  // `allowed_mentions` is set; an attacker who can influence the
  // cause string (via mirror response, request-body echo, etc.)
  // would otherwise ping the whole alert channel. Insert a
  // zero-width joiner between `@` and `everyone`/`here`/`<role>`
  // so the literal still reads but Discord doesn't expand it.
  const causeMsg = rawCauseMsg.replace(
    /@(everyone|here|[!&]?\d+)/g,
    '@​$1',
  );

  // Slack + Discord both accept `{ text }` shape. Plain text avoids
  // formatting injection. `allowed_mentions: { parse: [] }` is
  // Discord-specific belt-and-braces (Slack ignores it).
  const text =
    `:rotating_light: LazyLotto: ${input.kind} dead-letter write FAILED. ` +
    `On-chain tx ${input.uncertainTxId} status is UNKNOWN and the ` +
    `recovery anchor was lost. ` +
    (input.userId ? `User: ${input.userId}. ` : '') +
    `Cause: ${causeMsg}. ` +
    `Manual triage required — verify the tx on the mirror node and ` +
    `reconstruct the dead-letter row by hand.`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    // Last resort — log it. There is nothing left to escalate to.
    logger.error('escalateUncertainDlFailure: webhook fire failed', {
      component: 'Escalation',
      event: 'uncertain_dl_escalation_webhook_failed',
      kind: input.kind,
      uncertainTxId: input.uncertainTxId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
