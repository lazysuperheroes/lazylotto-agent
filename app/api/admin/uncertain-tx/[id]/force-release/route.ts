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
import { getRedis, KEY_PREFIX, isRefundClaimKey } from '~/auth/redis';
import { getMirrorBaseUrl } from '~/hedera/mirror';
import { classifyMirrorResult } from '~/hedera/responseCodes';

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
 * Decides whether a force-release request must refuse with 409 because
 * the mirror outcome is unsafe to release without an explicit ack.
 *
 * F3 (2026-05-06 audit I-02): the ack must be **strictly** `true`. The
 * old check `!body.acknowledgeDoubleSpendRisk` accepted any truthy
 * value — including the string `"false"` (which is truthy) — which
 * meant a buggy admin UI sending form-text values could accidentally
 * trigger the SUCCESS double-spend override. Reject every non-boolean.
 *
 * F12 (Phase 3) drops the flag entirely; this helper exists so the
 * removal is mechanical (delete every `requiresAckOverride` callsite).
 */
export function requiresAckOverride(mirror: MirrorOutcome, ack: unknown): boolean {
  const acked = ack === true;
  return (mirror === 'SUCCESS' || mirror === 'transient') && !acked;
}

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
        ? (rawBody as { reason?: unknown; acknowledgeDoubleSpendRisk?: unknown })
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

    // ── R-MEDIUM-1: server-side mirror check BEFORE any state
    // mutation. If the on-chain tx actually succeeded, releasing the
    // reserve / claim here lets the user (or operator) re-spend the
    // same balance, then a later reconcile pass would settle the
    // confirmed-success and the operator wallet drains twice. Refuse
    // with 409 unless caller explicitly acknowledges the risk.
    //
    // Pass-3 fix: mirror check runs for EVERY kind unconditionally
    // (no operator-fee exemption). The previous shortcut "operator
    // state was never debited so release is a no-op" was true at
    // submit time but wrong at force-release time — if the on-chain
    // tx actually succeeded, the operator wallet IS drained and we
    // need to debit local state + write the audit anchor (mirror
    // what the verifier would have done).
    const mirrorResult = await lookupMirrorOutcome(id);
    if (mirrorResult === 'SUCCESS' && requiresAckOverride(mirrorResult, body.acknowledgeDoubleSpendRisk)) {
      return NextResponse.json(
        {
          error:
            'Mirror node reports this tx as SUCCESS on chain. Force-releasing ' +
            'would let the user re-spend a balance the operator wallet has ' +
            'already paid out (double-spend). Refusing.',
          hint:
            'Either let the verifier resolve this entry on the next reconcile ' +
            'pass (it will detect SUCCESS and settle correctly), OR pass ' +
            '`acknowledgeDoubleSpendRisk: true` (strict boolean) in the body to override. ' +
            'Override is for cases where the operator has independently ' +
            'manually compensated the resulting drift.',
          mirrorResult,
        },
        { status: 409, headers: CORS_HEADERS },
      );
    }
    if (mirrorResult === 'transient' && requiresAckOverride(mirrorResult, body.acknowledgeDoubleSpendRisk)) {
      return NextResponse.json(
        {
          error:
            'Mirror node lookup failed (5xx / network). Cannot safely confirm ' +
            'on-chain outcome. Retry shortly, or pass ' +
            '`acknowledgeDoubleSpendRisk: true` to override.',
        },
        { status: 503, headers: CORS_HEADERS },
      );
    }

    const ledger = multiUser.getLedgerForRecovery();

    let action: string;
    switch (entry.kind) {
      case 'withdrawal_uncertain': {
        const details = (entry.details ?? {}) as {
          userId?: string;
          amount?: number;
          tokenKey?: string;
        };
        if (
          typeof details.userId !== 'string' ||
          typeof details.amount !== 'number' ||
          typeof details.tokenKey !== 'string'
        ) {
          return NextResponse.json(
            {
              error:
                'Cannot force-release: dead-letter is malformed (missing userId/amount/tokenKey).',
            },
            { status: 400, headers: CORS_HEADERS },
          );
        }
        try {
          ledger.releaseReserve(details.userId, details.amount, details.tokenKey);
          action = `released ${details.amount} ${details.tokenKey} reserve for user ${details.userId}`;
        } catch (e) {
          return NextResponse.json(
            {
              error: `Failed to release reserve: ${e instanceof Error ? e.message : String(e)}`,
            },
            { status: 500, headers: CORS_HEADERS },
          );
        }
        break;
      }
      case 'operator_fee_withdraw_uncertain': {
        const details = (entry.details ?? {}) as {
          amount?: number;
          tokenKey?: string;
        };
        if (
          typeof details.amount !== 'number' ||
          typeof details.tokenKey !== 'string'
        ) {
          return NextResponse.json(
            {
              error:
                'Cannot force-release: dead-letter is malformed (missing amount/tokenKey).',
            },
            { status: 400, headers: CORS_HEADERS },
          );
        }
        // Pass-3 fix: at submit time the operator state was NOT debited
        // (the verifier only debits on confirmed SUCCESS). If the
        // operator is acknowledging an on-chain SUCCESS via override,
        // we MUST run the same debit + audit-anchor that the verifier
        // would have run — otherwise local state diverges from the
        // chain and the operator could "withdraw" the same fees again
        // from local state. For FAILED / NOT_FOUND outcomes the
        // operator state stays at zero (correct).
        if (mirrorResult === 'SUCCESS') {
          // Pass-4 fix: stamp the same `operatorDebitedAt` /
          // `auditWrittenAt` markers the verifier reads so that if
          // the resolve write later fails (Redis blip after we
          // return 200), a subsequent reconcile pass doesn't see
          // `!resolvedAt` and re-debit + re-audit. Skip if already
          // stamped (idempotent).
          const priorMarkers = (entry.details ?? {}) as {
            operatorDebitedAt?: string;
            auditWrittenAt?: string;
          };
          if (!priorMarkers.operatorDebitedAt) {
            try {
              const tokenKey = details.tokenKey;
              const amount = details.amount;
              store.updateOperator((op) => ({
                ...op,
                balances: {
                  ...op.balances,
                  [tokenKey]: (op.balances[tokenKey] ?? 0) - amount,
                },
                totalWithdrawnByOperator: {
                  ...op.totalWithdrawnByOperator,
                  [tokenKey]:
                    (op.totalWithdrawnByOperator[tokenKey] ?? 0) + amount,
                },
              }));
              await store.upsertDeadLetter({
                ...entry,
                details: {
                  ...(entry.details ?? {}),
                  operatorDebitedAt: new Date().toISOString(),
                },
              });
              await store.flush();
            } catch (e) {
              return NextResponse.json(
                {
                  error: `Failed to debit operator state: ${e instanceof Error ? e.message : String(e)}`,
                },
                { status: 500, headers: CORS_HEADERS },
              );
            }
          }
          if (!priorMarkers.auditWrittenAt) {
            try {
              const accounting = multiUser.getAccountingForRecovery();
              await accounting.recordOperatorWithdrawal(
                multiUser.getAgentAccountIdForRecovery(),
                details.amount,
                details.tokenKey,
              );
              await store.upsertDeadLetter({
                ...entry,
                details: {
                  ...(entry.details ?? {}),
                  operatorDebitedAt:
                    priorMarkers.operatorDebitedAt ?? new Date().toISOString(),
                  auditWrittenAt: new Date().toISOString(),
                },
              });
            } catch (auditErr) {
              // Audit failure is best-effort — log + audit_trail_orphaned
              // (mirror the verifier's M16 pattern).
              logger.warn(
                'force-release operator_fee_withdraw_uncertain audit write failed',
                {
                  component: 'AdminForceRelease',
                  uncertainTxId: id,
                  error: auditErr instanceof Error ? auditErr.message : String(auditErr),
                },
              );
              try {
                await store.upsertDeadLetter({
                  transactionId: `audit-orphan:${id}`,
                  timestamp: new Date().toISOString(),
                  error: `force-release audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
                  kind: 'audit_trail_orphaned',
                  details: {
                    sourceKind: 'operator_fee_withdraw_uncertain',
                    sourceTxId: id,
                    amount: details.amount,
                    tokenKey: details.tokenKey,
                  },
                });
              } catch {
                /* logged above */
              }
            }
          }
          action = `mirror reports SUCCESS — debited ${details.amount} ${details.tokenKey} from operator state and wrote HCS-20 audit anchor`;
        } else {
          action = `mirror reports ${mirrorResult} — operator state not debited (was never debited at submit)`;
        }
        break;
      }
      case 'play_uncertain': {
        const details = (entry.details ?? {}) as {
          userId?: string;
          tokenReservations?: Array<{ token: string; amount: number }>;
        };
        if (
          typeof details.userId !== 'string' ||
          !Array.isArray(details.tokenReservations)
        ) {
          return NextResponse.json(
            {
              error:
                'Cannot force-release: dead-letter is malformed (missing userId/tokenReservations).',
            },
            { status: 400, headers: CORS_HEADERS },
          );
        }
        for (const { token, amount } of details.tokenReservations) {
          try {
            ledger.releaseReserve(details.userId, amount, token);
          } catch (e) {
            logger.warn('force-release play_uncertain releaseReserve failed', {
              component: 'AdminForceRelease',
              uncertainTxId: id,
              token,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        action = `released ${details.tokenReservations.length} reservation(s) for user ${details.userId}`;
        break;
      }
      case 'refund_uncertain': {
        const details = (entry.details ?? {}) as { claimKey?: string };
        if (typeof details.claimKey !== 'string') {
          return NextResponse.json(
            {
              error: 'Cannot force-release: dead-letter missing claimKey.',
            },
            { status: 400, headers: CORS_HEADERS },
          );
        }
        // F2 (2026-05-06 audit I-07): refuse to DEL keys outside the
        // refund-claim namespace. A tampered/migrated entry with a
        // claimKey pointing at a session, user lock, killswitch flag,
        // or agentSeq counter would otherwise let an operator-tier
        // request delete arbitrary lla: keys.
        if (!isRefundClaimKey(details.claimKey)) {
          logger.error(
            'force-release refund_uncertain claimKey outside KEY_PREFIX.refunded — refusing',
            {
              component: 'AdminForceRelease',
              event: 'malicious_claim_key',
              uncertainTxId: id,
              operator: auth.accountId,
              claimKeyPrefix: details.claimKey.slice(0, 24),
            },
          );
          return NextResponse.json(
            {
              error:
                'Dead-letter claimKey is not a refund-claim key. ' +
                'Refusing to release — this entry is malformed and requires manual triage.',
            },
            { status: 400, headers: CORS_HEADERS },
          );
        }
        try {
          const redis = await getRedis();
          await redis.del(details.claimKey);
          action = `released SET-NX-EX claim ${details.claimKey}`;
        } catch (e) {
          return NextResponse.json(
            {
              error: `Failed to release claim: ${e instanceof Error ? e.message : String(e)}`,
            },
            { status: 500, headers: CORS_HEADERS },
          );
        }
        break;
      }
      default:
        return NextResponse.json(
          {
            error: `Force-release not supported for dead-letter kind '${entry.kind ?? 'unknown'}'.`,
          },
          { status: 400, headers: CORS_HEADERS },
        );
    }

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
      await accounting.recordControlEvent(
        body.acknowledgeDoubleSpendRisk
          ? 'force_release_override'
          : 'force_release',
        {
          by: auth.accountId,
          reason: body.reason,
          uncertainTxId: id,
          kind: entry.kind,
          mirrorResult,
        },
      );
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
            reason: body.reason,
            mirrorResult,
            acknowledgeDoubleSpendRisk: !!body.acknowledgeDoubleSpendRisk,
          },
        });
      } catch {
        /* logged above */
      }
    }

    try {
      await store.upsertDeadLetter({
        ...entry,
        resolvedAt: new Date().toISOString(),
        resolvedBy: `operator-force-release:${auth.accountId}:${body.reason}`,
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
      reason: body.reason,
      action,
    });

    return NextResponse.json(
      {
        ok: true,
        kind: entry.kind,
        uncertainTxId: id,
        resolvedBy: auth.accountId,
        reason: body.reason,
        action,
      },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
