/**
 * POST /api/admin/uncertain-tx/[id]/force-release
 *
 * Operator-driven force-release for a `*_uncertain` dead-letter row
 * that the reconcile verifier can't resolve on its own — typically
 * because the on-chain tx never reached the configured mirror node
 * after the 24h max-age threshold has been blown through, or because
 * an operator wants to release a held claim/reserve immediately
 * after manually verifying the mirror state.
 *
 * Requires 'operator' tier (covers admin / operator wallet-bound).
 *
 * Behavior per kind:
 *  - `withdrawal_uncertain`        → release the user reserve.
 *  - `operator_fee_withdraw_uncertain` → no-op state mutation
 *                                    (operator state was never debited);
 *                                    just mark resolved.
 *  - `play_uncertain`              → release every reservation in
 *                                    `details.tokenReservations`.
 *  - `refund_uncertain`            → release the SET-NX-EX claim
 *                                    (`details.claimKey`) so a retry
 *                                    can run.
 *
 * The action is recorded in the dead-letter row's `resolvedBy` field
 * for the audit trail. Caller must include a JSON body with `reason`
 * (free-form string) so the operator's intent is captured.
 *
 * H7 finding: prior to this endpoint there was no admin path to
 * unstick a wedged uncertain row. The reconcile verifier's NOT_FOUND
 * branch returned `still_uncertain` indefinitely.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../../../_lib/auth';
import { getAgentContext } from '../../../../_lib/mcp';
import { withStore } from '../../../../_lib/withStore';
import { checkRateLimit, rateLimitResponse } from '../../../../_lib/rateLimit';
import { logger } from '~/lib/logger';
import { getRedis, KEY_PREFIX } from '~/auth/redis';
import { getMirrorBaseUrl } from '~/hedera/mirror';
import { classifyMirrorResult } from '~/hedera/responseCodes';
import { applyForceRelease } from './handlers';

/**
 * Verifier-lock TTL — must match `VERIFY_LOCK_TTL_SEC` in
 * `src/custodial/uncertainTxVerification.ts` (kept as a literal here
 * to avoid importing test/mocked surface). Both paths must use the
 * same key namespace and TTL so neither can mutate while the other
 * holds the lock.
 */
const VERIFY_LOCK_TTL_SEC = 60;

interface MirrorTxLookup {
  transactions?: Array<{ result: string }>;
}

export type MirrorOutcome = 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'transient';

/**
 * Mirror-node fetch timeout. F5 (2026-05-06 audit I-09): without
 * AbortSignal.timeout, a slow-body mirror response wedges the route
 * indefinitely (the verifier-lock TTL would expire mid-flight while
 * we still hold the connection).
 */
const MIRROR_FETCH_TIMEOUT_MS = 8_000;

/**
 * Look up the on-chain outcome via the mirror node. Returns the
 * classified result, or `transient` for 5xx/network errors (operator
 * should retry).
 */
async function lookupMirrorOutcome(
  txId: string,
): Promise<MirrorOutcome> {
  try {
    const url = `${getMirrorBaseUrl()}/transactions/${txId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(MIRROR_FETCH_TIMEOUT_MS) });
    if (res.status === 404) return 'NOT_FOUND';
    if (!res.ok) return 'transient';
    const body = (await res.json()) as MirrorTxLookup;
    const tx = body.transactions?.[0];
    if (!tx) return 'NOT_FOUND';
    return classifyMirrorResult(tx.result);
  } catch {
    return 'transient';
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * Maximum byte length of the operator-supplied `reason` field. F5
 * (2026-05-06 audit I-01): without a cap, a multi-MB reason inflates
 * the dead-letter row in Redis AND, more importantly, causes
 * `accounting.recordControlEvent` to exceed the 1024-byte HCS-20
 * payload limit — silently downgrading the audit anchor to an
 * `audit_trail_orphaned` row. An operator could deliberately strip
 * the on-chain audit trail of a force-release that way.
 */
const MAX_REASON_LENGTH = 256;

/** Hedera transaction id pattern: `<shard>.<realm>.<num>@<seconds>.<nanos>`. */
const HEDERA_TX_ID_RE = /^\d+\.\d+\.\d+@\d+\.\d+$/;

/**
 * `withStore` only accepts a single-argument handler, so we extract
 * the [id] route segment from the URL pathname rather than from the
 * Next.js `params` context. The shape `/api/admin/uncertain-tx/<id>/force-release`
 * is stable; if the layout ever changes, the regex needs to follow.
 *
 * F5 (2026-05-06 audit I-03): wraps `decodeURIComponent` in a try
 * so malformed UTF-8 (e.g. overlong NUL `%E0%80%80`) returns null
 * instead of throwing `URIError`. Result is shape-validated against
 * the Hedera txId regex so adversarial paths can't masquerade as
 * unrelated dead-letter ids.
 */
function extractId(request: Request): string | null {
  const { pathname } = new URL(request.url);
  const match = pathname.match(/\/api\/admin\/uncertain-tx\/([^/]+)\/force-release\/?$/);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    // URIError on malformed encoding — refuse rather than 500.
    return null;
  }
  if (!HEDERA_TX_ID_RE.test(decoded)) return null;
  return decoded;
}

export const POST = withStore(async (request: Request) => {
  try {
    const auth = await requireTier(request, 'operator');
    if (isErrorResponse(auth)) return auth;

    // F5 (2026-05-06 audit I-11): bind the rate-limit budget to the
    // operator account, not the bearer-token prefix. Otherwise a
    // session-token rotation (legitimate or adversarial) resets the
    // counter and the documented 10/min cap is effectively unbounded.
    if (
      !(await checkRateLimit({
        request,
        action: 'admin-force-release-uncertain',
        limit: 10,
        windowSec: 60,
        identity: auth.accountId,
      }))
    ) {
      return rateLimitResponse(60);
    }

    const id = extractId(request);
    if (!id) {
      return NextResponse.json(
        { error: 'Missing dead-letter id in path.' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const rawBody = (await request.json().catch(() => null)) as unknown;
    const body =
      typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody)
        ? (rawBody as { reason?: unknown })
        : {};
    if (
      typeof body.reason !== 'string' ||
      body.reason.trim() === '' ||
      body.reason.length > MAX_REASON_LENGTH
    ) {
      return NextResponse.json(
        {
          error: `\`reason\` (string, 1–${MAX_REASON_LENGTH} chars) is required in the request body.`,
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    // F5 (2026-05-06 audit I-13 family): strip control characters from
    // reason so it can't break log-line parsers downstream.
    if (/[\x00-\x1f\x7f]/.test(body.reason)) {
      return NextResponse.json(
        { error: '`reason` contains disallowed control characters.' },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    const reason: string = body.reason;

    const { multiUser, store } = await getAgentContext();

    await store.refreshDeadLetters().catch(() => undefined);
    const all = store.getDeadLetters();
    const entry = all.find((e) => e.transactionId === id && !e.resolvedAt);
    if (!entry) {
      return NextResponse.json(
        {
          error: `No unresolved dead-letter found with id ${id}.`,
          hint: 'Either the id is wrong or the entry has already been resolved.',
        },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // F5 (2026-05-06 audit I-14): reject unsupported `entry.kind`
    // BEFORE acquiring the verifier lock. Otherwise an operator
    // probing an `audit_trail_orphaned`/`prize_transfer_failed`
    // entry would hold the 60s lock for nothing, blocking legitimate
    // re-attempts during that window.
    const SUPPORTED_KINDS = new Set([
      'withdrawal_uncertain',
      'operator_fee_withdraw_uncertain',
      'play_uncertain',
      'refund_uncertain',
    ] as const);
    if (!entry.kind || !SUPPORTED_KINDS.has(entry.kind as never)) {
      return NextResponse.json(
        {
          error: `Force-release not supported for dead-letter kind '${entry.kind ?? 'unknown'}'.`,
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // ── R-CRITICAL-1: acquire the same per-txId verifier lock the
    // reconcile pass uses (KEY_PREFIX.verifying:<txId>). Without it,
    // force-release can race a concurrently-running verifier and
    // produce torn state — e.g. verifier's SUCCESS branch settles
    // while force-release's FAILED branch releases, leaving the
    // ledger inconsistent. SET-NX-EX with the same 60s TTL.
    //
    // For refund_uncertain the verifier uses key `verifying:refund:<txId>`
    // (see src/hedera/refund.ts:679-707) so we acquire under that prefix.
    let lockKey: string;
    if (entry.kind === 'refund_uncertain') {
      lockKey = `${KEY_PREFIX.verifying}refund:${id}`;
    } else {
      lockKey = `${KEY_PREFIX.verifying}${id}`;
    }
    let lockAcquired = false;
    try {
      const redis = await getRedis();
      const ok = await redis.set(lockKey, 'force-release', {
        nx: true,
        ex: VERIFY_LOCK_TTL_SEC,
      });
      lockAcquired = ok !== null;
    } catch (e) {
      logger.warn('force-release verifier-lock acquisition failed', {
        component: 'AdminForceRelease',
        uncertainTxId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    if (!lockAcquired) {
      return NextResponse.json(
        {
          error:
            'Concurrent reconcile holds the verifier lock for this entry. ' +
            'Wait a moment (lock TTL is 60s) and retry.',
        },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    // R3-FG-5 (round-3 P9-002): release the verifier-lock on EVERY exit.
    // R2-FG-1 promised "release on ok=false paths" but the route never
    // released the lock at all — every force-release call leaked the
    // 60s TTL, blocking concurrent reconcile + repeat operator clicks.
    // The lock has no fence (literal 'force-release' value), so a plain
    // DEL is safe; we don't risk nuking another acquirer because the
    // SET-NX above guaranteed we own this exact instance.
    const releaseLock = async (): Promise<void> => {
      try {
        const r = await getRedis();
        await r.del(lockKey);
      } catch (e) {
        logger.warn('force-release verifier-lock release failed; relying on TTL', {
          component: 'AdminForceRelease',
          uncertainTxId: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    try {
    // R2-FG-9 (round-2 B-11): re-read the entry AFTER lock acquisition.
    // Between the initial read above and the lock-acquire, a concurrent
    // verifier (whose F26 release just landed under the lowercase
    // RELEASE_SCRIPT R2-FG-6 fix) could have stamped progress markers
    // and resolved the entry. Operating on a stale snapshot would
    // re-apply mutations that already ran — exactly the double-mutate
    // R2-FG-1 closes for the lock layer; this closes the read-snapshot
    // hole on top of it.
    await store.refreshDeadLetters().catch(() => undefined);
    const refreshed = store
      .getDeadLetters()
      .find((e) => e.transactionId === id);
    if (!refreshed) {
      return NextResponse.json(
        {
          error: `Dead-letter ${id} disappeared during force-release (concurrent verifier resolved it).`,
        },
        { status: 409, headers: CORS_HEADERS },
      );
    }
    if (refreshed.resolvedAt) {
      return NextResponse.json(
        {
          error: `Dead-letter ${id} was resolved by a concurrent verifier (${refreshed.resolvedBy ?? 'unknown'}) at ${refreshed.resolvedAt}.`,
          hint: 'No action needed — the verifier already handled it.',
        },
        { status: 409, headers: CORS_HEADERS },
      );
    }
    // Use the fresh snapshot from here on.
    const freshEntry = refreshed;

    // F12: server-side mirror check. After Phase 3, mirror=SUCCESS
    // automatically runs the verifier-equivalent post-conditions
    // for every kind (no override flag — the route does the right
    // thing for every outcome by construction). transient and
    // recent NOT_FOUND refuse with 503/409 because we cannot act
    // safely without a definitive on-chain outcome.
    const mirrorResult = await lookupMirrorOutcome(id);

    const redis = await getRedis();
    const result = await applyForceRelease(freshEntry, mirrorResult, {
      store,
      ledger: multiUser.getLedgerForRecovery(),
      accounting: multiUser.getAccountingForRecovery(),
      agentAccountId: multiUser.getAgentAccountIdForRecovery(),
      // R2-FG-7: route layer threads operator identity into handlers
      // so the F16 triage anchor (and any future control-event
      // emissions from handlers) are attributable.
      by: auth.accountId,
      redis,
      log: logger,
    });

    if (!result.ok) {
      return NextResponse.json(
        result.hint ? { error: result.error, hint: result.hint } : { error: result.error },
        { status: result.status, headers: CORS_HEADERS },
      );
    }
    const action = result.action;

    // Pass-3 fix: HCS-20 audit anchor for the force-release action.
    // Without an immutable on-chain record, the only trail of an
    // operator's override is a mutable Redis row + an internal log
    // line — both wipeable by a compromised operator key. Writing
    // here preserves the action in the topic, where external auditors
    // reconstructing balances from the topic alone (per
    // docs/hcs20-v2-schema.md) can see exactly when + why an override
    // happened. Best-effort: a failed audit write doesn't block the
    // resolution (the local mutation already happened).
    try {
      const accounting = multiUser.getAccountingForRecovery();
      await accounting.recordControlEvent('force_release', {
        by: auth.accountId,
        reason,
        uncertainTxId: id,
        kind: entry.kind,
        mirrorResult,
      });
    } catch (auditErr) {
      logger.warn('force-release HCS-20 audit anchor write failed', {
        component: 'AdminForceRelease',
        uncertainTxId: id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      try {
        await store.upsertDeadLetter({
          transactionId: `audit-orphan:force-release:${id}`,
          timestamp: new Date().toISOString(),
          error: `force-release audit anchor write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'force_release',
            sourceTxId: id,
            originalKind: entry.kind,
            by: auth.accountId,
            reason,
            mirrorResult,
          },
        });
      } catch {
        /* logged above */
      }
    }

    // R3-FG-1 (round-3 P2-002 / P4-001 / P9-003): re-refresh + re-fetch
    // BEFORE the resolve write so we don't spread the pre-lock `entry`
    // snapshot and clobber every progress marker (settledAt,
    // totalWithdrawnAt, historyWrittenAt, auditWrittenAt,
    // operatorDebitedAt, successTriagedAt, ledgerAdjustedAt) that the
    // handler just stamped. Pre-fix the resolve-write at this site
    // spread `...entry` which silently reverted every stamp, allowing
    // a subsequent re-run (operator clears resolvedAt, or the
    // play-uncertain SUCCESS triage path which intentionally retains
    // visible state) to re-execute every step → double-debit.
    let latestEntry = freshEntry;
    try {
      await store.refreshDeadLetters();
      const post = store.getDeadLetters().find((e) => e.transactionId === id);
      if (post) latestEntry = post;
    } catch {
      // Fall through with freshEntry — at least it's post-lock.
    }
    try {
      await store.upsertDeadLetter({
        ...latestEntry,
        resolvedAt: new Date().toISOString(),
        resolvedBy: `operator-force-release:${auth.accountId}:${reason}`,
        resolutionTxId: id,
      });
      await store.flush();
    } catch (e) {
      logger.warn('force-release dead-letter resolve write failed', {
        component: 'AdminForceRelease',
        uncertainTxId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    logger.info('uncertain-tx force-released by operator', {
      component: 'AdminForceRelease',
      event: 'force_release',
      kind: entry.kind,
      uncertainTxId: id,
      operator: auth.accountId,
      reason,
      action,
    });

    return NextResponse.json(
      {
        ok: true,
        kind: entry.kind,
        uncertainTxId: id,
        resolvedBy: auth.accountId,
        reason,
        action,
      },
      { headers: CORS_HEADERS },
    );
    } finally {
      // R3-FG-5: always release the verifier lock — every prior `return`
      // inside the try-block flows through this finally first.
      await releaseLock();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
