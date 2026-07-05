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
    | 'audit_trail_orphaned'
    /** R4-FG-5: HCS-20 recordDeposit anchor failed after local-store credit landed. */
    | 'deposit_anchor_failed'
    /** R4-FG-5: HCS-20 recordRake anchor failed after operator-rake credit landed. */
    | 'rake_anchor_failed'
    /** R5-FG-48: withIdempotency RELEASE_SCRIPT eval AND plain DEL fallback both failed; claim wedged. */
    | 'idempotency_release_failed'
    /** F1 (2026-07-04): contamination-block dead-letter write failed — recovery anchor lost. */
    | 'prize_transfer_blocked_contamination';
  /** The submitted on-chain tx whose status is unknown. */
  uncertainTxId: string;
  /** Affected userId (omit for operator-fee). */
  userId?: string;
  /** The original error that prevented dead-letter write. */
  cause: unknown;
  /**
   * R5-FG-69 (P6-013): related on-chain tx so the page text can
   * cross-reference. Used by deposit/rake anchor failures — both
   * fire as separate escalations with the same `uncertainTxId`
   * but different kinds; including `relatedTxId` (the deposit txId
   * the anchor is supposed to cover) and the partner kind in the
   * page lets the operator grasp it's one incident, not two.
   */
  relatedTxId?: string;
}

/** R3-FG-48: skip the page if we've already escalated this txId in the last 6h. */
const ESCALATION_DEDUP_TTL_SEC = 6 * 60 * 60;

/**
 * R5-FG-97 (P3-015): per-Lambda local-process suppression for the
 * fail-open path. Pre-fix: when Redis dedup throws, the catch logs
 * "paging anyway" and fires the webhook — but a sustained Redis
 * outage would let the same Lambda warm-handler page repeatedly
 * for the same incident on every retry. Now: keep a Map of
 * `(kind:txId:fingerprint) → expiresAtMs`; suppress within 5 min
 * on the same Lambda even when Redis is down.
 */
const LOCAL_ESCALATION_SUPPRESSION_MS = 5 * 60 * 1000;
const localEscalationLog = new Map<string, number>();

export async function escalateUncertainDlFailure(
  input: EscalateUncertainDlInput,
): Promise<void> {
  const url = process.env.RECONCILE_FAILURE_WEBHOOK_URL;
  if (!url) return;

  const rawCauseMsg =
    input.cause instanceof Error
      ? input.cause.message
      : String(input.cause);

  // R3-FG-48 (round-3 P10-ESC-001): dedup escalations by txId+kind so
  // a stuck dead-letter doesn't re-page every reconcile pass (24+
  // identical pages per day → operator alert fatigue → real pages
  // get ignored). SET-NX-EX with 6h TTL — first caller wins; sibling
  // callers within the window are no-ops.
  //
  // R4-FG-64 (round-4 medium): the dedup key now includes a
  // cause-class fingerprint. Pre-fix the key was just `kind:txId` and
  // a single `uncertainTxId` legitimately hitting MULTIPLE distinct
  // escalation reasons within 6h (malformed-DL → user-lock contention
  // → SADD failure — all collapse into `kind='audit_trail_orphaned'`)
  // would only fire ONCE; the second and third pages were silently
  // suppressed. Including a cause-class hash separates them.
  // Fingerprint is the error class name + first-token of message so a
  // single bug doesn't fan out into N pages but two distinct causes
  // get two pages.
  const causeClass = input.cause instanceof Error
    ? input.cause.name
    : typeof input.cause;
  // R5-FG-67 (P2-009 + P1-012): hash the WHOLE truncated cause
  // message instead of just the first whitespace token. Pre-fix the
  // first-token approach broke for two common SDK shapes:
  //   - "0.0.123@456: receipt timeout" → first token includes the
  //     txId, so EVERY error with txId-at-start got a unique
  //     fingerprint per txId → dedup window collapsed to per-txId
  //     and operator got a page on every bounce.
  //   - "Error: ECONNRESET" / "Error: ETIMEDOUT" → first token
  //     "Error:" identical, so five different network errors
  //     collapsed into one fingerprint (under-dedup hides errors).
  // Hashing the full message (truncated to 256 chars to bound cost)
  // separates distinct error contents while keeping a stable
  // fingerprint across runs.
  const { createHash } = await import('node:crypto');
  const causeFingerprint = `${causeClass}:${createHash('sha256')
    .update(rawCauseMsg.slice(0, 256))
    .digest('hex')
    .slice(0, 16)}`;
  // F17 (2026-07-04 custodial audit): hoist the dedup key + redis handle
  // out of the claim `try` so the webhook-failure catch below can RELEASE
  // the claim. The 6h claim is taken BEFORE the POST; without release, a
  // single transient webhook failure suppresses every retry of this
  // one-shot critical page for 6h — the held reserve/claim then silently
  // double-spends on TTL-expiry. `redisForDedup` is set ONLY after a
  // durable claim lands, so the fail-open (Redis-down) path never attempts
  // a bogus release.
  let dedupKey: string | null = null;
  let redisForDedup: Awaited<ReturnType<typeof getRedis>> | null = null;
  try {
    const redis = await getRedis();
    dedupKey = `${KEY_PREFIX.escalated}${input.kind}:${input.uncertainTxId}:${causeFingerprint}`;
    const claimed = await redis.set(dedupKey, '1', {
      nx: true,
      ex: ESCALATION_DEDUP_TTL_SEC,
    });
    if (claimed === null) {
      // Already escalated within the window for this same cause class.
      return;
    }
    redisForDedup = redis;
  } catch (e) {
    // Redis unavailable — fail open and page anyway. Better duplicate
    // pages than silent loss when the alerting backbone is the only
    // way the operator sees the issue.
    //
    // R5-FG-97 (P3-015): per-Lambda Map suppression for 5min on
    // this same key so a sustained Redis outage doesn't cause the
    // same warm Lambda to fire repeated webhook calls for the same
    // incident.
    const localKey = `${input.kind}:${input.uncertainTxId}:${causeFingerprint}`;
    const nowMs = Date.now();
    const suppressUntil = localEscalationLog.get(localKey);
    if (suppressUntil !== undefined && suppressUntil > nowMs) {
      logger.warn('escalateUncertainDlFailure: dedup down, but local-Lambda suppression still active', {
        component: 'Escalation',
        kind: input.kind,
        suppressedForMs: suppressUntil - nowMs,
      });
      return;
    }
    localEscalationLog.set(localKey, nowMs + LOCAL_ESCALATION_SUPPRESSION_MS);
    // Light GC: drop entries that have already expired so the Map
    // doesn't grow unbounded across a long-lived warm Lambda.
    if (localEscalationLog.size > 1000) {
      for (const [k, v] of localEscalationLog) {
        if (v <= nowMs) localEscalationLog.delete(k);
      }
    }
    logger.warn('escalateUncertainDlFailure: dedup check failed; paging anyway', {
      component: 'Escalation',
      error: e instanceof Error ? e.message : String(e),
    });
  }

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
    // R5-FG-69: reference the related tx so paired-escalation
    // incidents (deposit + rake anchor failures for one deposit)
    // are visibly linked.
    (input.relatedTxId ? `Related tx: ${input.relatedTxId}. ` : '') +
    `Cause: ${causeMsg}. ` +
    `Manual triage required — verify the tx on the mirror node and ` +
    `reconstruct the dead-letter row by hand.`;

  // F17 (2026-07-04 custodial audit): on ANY delivery failure (network
  // throw, 5s timeout, OR a non-2xx response) release the dedup claim so
  // the NEXT escalation pass re-pages instead of being suppressed for 6h.
  // Best-effort — a failed release just falls back to the 6h TTL. Only a
  // durably-claimed key is released (redisForDedup non-null), so the
  // fail-open Redis-down path is untouched. This may re-page if the POST
  // actually landed but its response was lost; a duplicate page is
  // strictly better than a swallowed critical one.
  const releaseDedupClaim = async (): Promise<void> => {
    if (!redisForDedup || !dedupKey) return;
    try {
      await redisForDedup.del(dedupKey);
    } catch {
      /* best-effort — the 6h TTL will eventually clear the claim */
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.error('escalateUncertainDlFailure: webhook returned non-2xx', {
        component: 'Escalation',
        event: 'uncertain_dl_escalation_webhook_failed',
        kind: input.kind,
        uncertainTxId: input.uncertainTxId,
        status: res.status,
      });
      await releaseDedupClaim();
    }
  } catch (err) {
    // Last resort — log it. There is nothing left to escalate to.
    logger.error('escalateUncertainDlFailure: webhook fire failed', {
      component: 'Escalation',
      event: 'uncertain_dl_escalation_webhook_failed',
      kind: input.kind,
      uncertainTxId: input.uncertainTxId,
      error: err instanceof Error ? err.message : String(err),
    });
    await releaseDedupClaim();
  }
}
