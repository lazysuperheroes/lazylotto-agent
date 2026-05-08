/**
 * Per-kind force-release handlers extracted from the route so they
 * can be unit-tested without booting the full Next.js context.
 *
 * F12 (2026-05-06 audit A-08/A-09/A-10/U-01/U-02/U-09/OP-06/SM-07):
 * after the rewrite, mirror=SUCCESS automatically runs the
 * verifier-equivalent post-conditions for every kind (settle +
 * audit anchor for withdrawals, ledger debit + audit anchor +
 * rake reversal for refunds, manual-triage anchor + reservation-hold
 * for plays). The previous `acknowledgeDoubleSpendRisk` flag is
 * dropped — the route now does the right thing on every mirror
 * outcome without operator opt-in.
 *
 * F13 (audit SM-09): handlers read the same idempotency markers
 * the verifier writes (`settledAt`, `auditWrittenAt`, etc.) and
 * skip already-completed steps so a force-release after a partial
 * verifier run doesn't double-mutate.
 *
 * F14 (audit OP-03/SM-10/C-03): operator-fee SUCCESS handler stamps
 * `operatorDebitedAt` BEFORE the local debit; Lambda freeze between
 * stamp and mutate produces a detectable insolvency rather than a
 * silent double-debit on next reconcile.
 *
 * F15 (audit SM-04): play_uncertain handler refuses if the entry
 * already carries `successTriagedAt` — the manual-triage state is
 * intentionally one-way; double-triggering would re-page the
 * operator and could release reservations the operator has not
 * yet reconstructed by hand.
 *
 * F8/F9 (audit U-06/OP-01): refund SUCCESS handler debits the
 * canonical owner from the deposit record (not memo) and reverses
 * the operator rake credit.
 *
 * F10 (audit SM-13): refund FAILED handler overwrites the claim
 * with `failed:<refundTxId>` instead of DEL.
 */

import type { DeadLetterEntry, IStore } from '~/custodial/IStore';
import type { UserLedger } from '~/custodial/UserLedger';
import type { AccountingService } from '~/custodial/AccountingService';
import type { MirrorOutcome } from './route';
import { KEY_PREFIX, isRefundClaimKey } from '~/auth/redis';
import { randomUUID } from 'node:crypto';

/**
 * R3-FG-26 (round-3 P2-005 / P4-009 / P5-AT-001): unique audit-orphan
 * id for force-release. Pre-fix all six sites used the same id
 * `audit-orphan:force-release:${txId}` — repeated audit failures
 * within ONE force-release (or across retries) collided via REPLACE
 * semantics, losing prior failure history. Each call gets a fresh
 * random suffix; the `phase` field in `details` distinguishes phases
 * for replay tooling.
 */
export function uniqueForceReleaseOrphanId(txId: string): string {
  return `audit-orphan:force-release:${txId}:${randomUUID().slice(0, 8)}`;
}
import { HBAR_TOKEN_KEY } from '~/config/strategy';
import { RELEASE_SCRIPT, tryAcquireUserLockWithBackoff, releaseUserLock } from '~/lib/locks';

/**
 * Standard error envelope for the per-user-lock contention path.
 * R2-FG-1 (2026-05-06 round-2 audit X-01/X-02/X-03): every handler
 * that mutates per-user state MUST acquire `lockUser:<userId>` before
 * the mutation. On contention, return 409 so the operator retries —
 * never fall through to mutate without a token.
 */
const USER_LOCK_CONTENTION: HandlerError = {
  ok: false,
  status: 409,
  error:
    'Per-user lock held by a concurrent in-band operation (withdraw / play / refund). ' +
    'Wait a moment and retry — the lock TTL is 60s.',
  hint:
    'This typically clears within seconds. If it persists for minutes, ' +
    'an operator action may be hung; check `/api/admin/dead-letters` for stuck rows.',
};

export interface ForceReleaseContext {
  store: IStore;
  ledger: UserLedger;
  accounting: AccountingService;
  agentAccountId: string;
  /**
   * Operator identity stamped into HCS-20 control events written from
   * force-release handlers (R2-FG-7: play_uncertain SUCCESS triage
   * anchor, mirroring the verifier's `recordControlEvent` call). The
   * route layer already has `auth.accountId` — passing it through
   * keeps the audit trail attributable.
   */
  by: string;
  redis: {
    set(
      key: string,
      value: string,
      options?: { nx?: boolean; ex?: number },
    ): Promise<unknown>;
    /** R2-FG-11: read claim values before overwriting them. */
    get<T = string>(key: string): Promise<T | null>;
    del(...keys: string[]): Promise<number>;
    /** R3-FG-2: fenced compare-and-delete via lowercase RELEASE_SCRIPT. */
    eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>;
    /** R3-FG-23: SADD the original txId to the permanent refunded-originals set. */
    sadd(key: string, member: string): Promise<number>;
  };
  log: {
    warn(msg: string, meta: Record<string, unknown>): void;
    error(msg: string, meta: Record<string, unknown>): void;
  };
}

export interface HandlerResult {
  ok: true;
  action: string;
}

export interface HandlerError {
  ok: false;
  status: number;
  error: string;
  hint?: string;
}

/**
 * Dispatch by kind. Returns either an action description (success)
 * or an error envelope the route maps to an HTTP response. Throws
 * only on unexpected exceptions (the route catches and returns 500).
 */
export async function applyForceRelease(
  entry: DeadLetterEntry,
  mirrorResult: MirrorOutcome,
  ctx: ForceReleaseContext,
): Promise<HandlerResult | HandlerError> {
  // Refuse mirror outcomes that don't give us safe action.
  // F12: with the override flag dropped, mirror=transient and
  // mirror=NOT_FOUND must wait for the verifier (24h max-age policy
  // promotes NOT_FOUND→FAILED automatically).
  if (mirrorResult === 'transient') {
    return {
      ok: false,
      status: 503,
      error:
        'Mirror node lookup failed (5xx / network). Cannot safely confirm ' +
        'on-chain outcome. Retry shortly.',
    };
  }
  if (mirrorResult === 'NOT_FOUND') {
    return {
      ok: false,
      status: 409,
      error:
        'Mirror node has no record of this tx yet. Wait for the next ' +
        'reconcile pass — the verifier will promote NOT_FOUND→FAILED ' +
        'after 24 hours, or you can trigger one manually via ' +
        '/api/admin/reconcile.',
    };
  }

  switch (entry.kind) {
    case 'withdrawal_uncertain':
      return handleWithdrawal(entry, mirrorResult, ctx);
    case 'operator_fee_withdraw_uncertain':
      return handleOperatorFee(entry, mirrorResult, ctx);
    case 'play_uncertain':
      return handlePlay(entry, mirrorResult, ctx);
    case 'refund_uncertain':
      return handleRefund(entry, mirrorResult, ctx);
    default:
      return {
        ok: false,
        status: 400,
        error: `Force-release not supported for dead-letter kind '${entry.kind ?? 'unknown'}'.`,
      };
  }
}

// ── withdrawal_uncertain ──────────────────────────────────────────

interface WithdrawProgress {
  settledAt?: string;
  totalWithdrawnAt?: string;
  historyWrittenAt?: string;
  auditWrittenAt?: string;
}

async function handleWithdrawal(
  entry: DeadLetterEntry,
  mirrorResult: 'SUCCESS' | 'FAILED',
  ctx: ForceReleaseContext,
): Promise<HandlerResult | HandlerError> {
  const details = (entry.details ?? {}) as {
    userId?: string;
    amount?: number;
    tokenKey?: string;
    isHbar?: boolean;
    recipientAccountId?: string;
  } & WithdrawProgress;
  if (
    typeof details.userId !== 'string' ||
    typeof details.amount !== 'number' ||
    !Number.isFinite(details.amount) ||
    details.amount < 0 ||
    typeof details.tokenKey !== 'string'
  ) {
    return {
      ok: false,
      status: 400,
      error:
        'Cannot force-release: dead-letter is malformed (missing or non-finite userId/amount/tokenKey).',
    };
  }

  if (mirrorResult === 'FAILED') {
    // R2-FG-1: serialize the reserve release against active in-band
    // withdraw / play / refund on the same user. The verifier path
    // (uncertainTxVerification.ts F23) does this; F12's force-release
    // sibling mistakenly didn't.
    const userToken = await tryAcquireUserLockWithBackoff(details.userId);
    if (!userToken) return USER_LOCK_CONTENTION;
    try {
      ctx.ledger.releaseReserve(details.userId, details.amount, details.tokenKey);
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: `Failed to release reserve: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      await releaseUserLock(details.userId, userToken);
    }
    return {
      ok: true,
      action: `mirror reports FAILED — released ${details.amount} ${details.tokenKey} reserve for user ${details.userId}`,
    };
  }

  // F12 / F13: mirror=SUCCESS — run verifier-equivalent post-conditions
  // gated by the verifier's idempotency markers. Each step skipped if
  // the verifier already stamped its marker; otherwise mutated AND
  // immediately stamped (F1 accumulator pattern).
  const progress: WithdrawProgress = {
    settledAt: details.settledAt,
    totalWithdrawnAt: details.totalWithdrawnAt,
    historyWrittenAt: details.historyWrittenAt,
    auditWrittenAt: details.auditWrittenAt,
  };

  const stamp = async (): Promise<void> => {
    try {
      await ctx.store.upsertDeadLetter({
        ...entry,
        details: { ...(entry.details ?? {}), ...progress },
      });
    } catch (e) {
      ctx.log.warn('force-release withdrawal stamp failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // R2-FG-1: hold per-user lock around settle/totalWithdrawn/history.
  // Audit anchor (HCS submit) runs OUTSIDE the lock — it doesn't touch
  // per-user store state and HCS submits can hang for seconds.
  const needsLock =
    !progress.settledAt || !progress.totalWithdrawnAt || !progress.historyWrittenAt;
  let userMutateToken: string | null = null;
  if (needsLock) {
    userMutateToken = await tryAcquireUserLockWithBackoff(details.userId);
    if (!userMutateToken) return USER_LOCK_CONTENTION;
  }
  try {
    if (!progress.settledAt) {
      try {
        ctx.ledger.settleSpend(details.userId, details.amount, details.tokenKey);
        progress.settledAt = new Date().toISOString();
        await stamp();
      } catch (e) {
        ctx.log.warn('force-release withdrawal settleSpend failed', {
          component: 'AdminForceRelease',
          uncertainTxId: entry.transactionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!progress.totalWithdrawnAt) {
      try {
        ctx.store.updateBalance(details.userId, (b) => {
          const tokEntry = b.tokens[details.tokenKey!];
          if (tokEntry) tokEntry.totalWithdrawn += details.amount!;
          return b;
        });
        progress.totalWithdrawnAt = new Date().toISOString();
        await stamp();
      } catch (e) {
        ctx.log.warn('force-release withdrawal totalWithdrawn update failed', {
          component: 'AdminForceRelease',
          uncertainTxId: entry.transactionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!progress.historyWrittenAt) {
      try {
        ctx.store.recordWithdrawal({
          userId: details.userId,
          amount: details.amount,
          tokenId: details.isHbar ? null : details.tokenKey,
          recipientAccountId: details.recipientAccountId ?? '',
          transactionId: entry.transactionId,
          timestamp: new Date().toISOString(),
        });
        progress.historyWrittenAt = new Date().toISOString();
        await stamp();
      } catch (e) {
        ctx.log.warn('force-release withdrawal recordWithdrawal failed', {
          component: 'AdminForceRelease',
          uncertainTxId: entry.transactionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    if (userMutateToken) {
      await releaseUserLock(details.userId, userMutateToken);
    }
  }
  if (!progress.auditWrittenAt) {
    try {
      // F18: include withdrawTxId so the reader dedups.
      await ctx.accounting.recordWithdrawal(
        details.recipientAccountId ?? '',
        details.amount,
        details.tokenKey,
        entry.transactionId,
      );
      progress.auditWrittenAt = new Date().toISOString();
      await stamp();
    } catch (auditErr) {
      ctx.log.warn('force-release withdrawal accounting.recordWithdrawal failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      try {
        await ctx.store.upsertDeadLetter({
          // R2-FG-17: salt synthetic id by writer phase so multiple
          // audit-orphan writes for the same source tx don't collide.
          transactionId: uniqueForceReleaseOrphanId(entry.transactionId),
          timestamp: new Date().toISOString(),
          error: `force-release audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'withdrawal_uncertain',
            sourceTxId: entry.transactionId,
            userId: details.userId,
            amount: details.amount,
            tokenKey: details.tokenKey,
            recipientAccountId: details.recipientAccountId ?? '',
            // R2-FG-8: stamp phase for replay tooling.
            phase: 'audit_failed',
          },
        });
      } catch {
        /* logged above */
      }
    }
  }

  return {
    ok: true,
    action: `mirror reports SUCCESS — settled ${details.amount} ${details.tokenKey} for user ${details.userId} and wrote HCS-20 audit anchor`,
  };
}

// ── operator_fee_withdraw_uncertain ───────────────────────────────

interface OperatorProgress {
  operatorDebitedAt?: string;
  auditWrittenAt?: string;
}

async function handleOperatorFee(
  entry: DeadLetterEntry,
  mirrorResult: 'SUCCESS' | 'FAILED',
  ctx: ForceReleaseContext,
): Promise<HandlerResult | HandlerError> {
  const details = (entry.details ?? {}) as {
    amount?: number;
    tokenKey?: string;
  } & OperatorProgress;
  if (
    typeof details.amount !== 'number' ||
    !Number.isFinite(details.amount) ||
    details.amount < 0 ||
    typeof details.tokenKey !== 'string'
  ) {
    return {
      ok: false,
      status: 400,
      error:
        'Cannot force-release: dead-letter is malformed (missing or non-finite amount/tokenKey).',
    };
  }

  if (mirrorResult === 'FAILED') {
    // R2-FG-16 + R3-FG-2: fenced release of F24 per-token pending claim.
    // Read fence from `details.pendingClaimFence` and compare-and-delete.
    // Pre-fix: unfenced DEL nuked fresh acquirers' claims → operator double-pay.
    const failedFence = (details as { pendingClaimFence?: string }).pendingClaimFence;
    if (typeof failedFence === 'string' && failedFence.length > 0) {
      try {
        await ctx.redis.eval(
          RELEASE_SCRIPT,
          [`${KEY_PREFIX.lockOperator}withdraw-pending:${details.tokenKey}`],
          [failedFence],
        );
      } catch (e) {
        ctx.log.warn('force-release operator-fee F24 pending-claim release failed', {
          component: 'AdminForceRelease',
          uncertainTxId: entry.transactionId,
          tokenKey: details.tokenKey,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return {
      ok: true,
      action: `mirror reports FAILED — operator state untouched (was never debited at submit)`,
    };
  }

  // F12 / F13 / F14: mirror=SUCCESS — verifier-equivalent debit + audit
  // gated by progress markers. Stamp BEFORE the mutation (F14): a Lambda
  // freeze between stamp and mutate produces a detectable insolvency
  // (reconcile flags wallet < ledger) rather than a silent double-debit
  // on the next reconcile pass.
  const progress: OperatorProgress = {
    operatorDebitedAt: details.operatorDebitedAt,
    auditWrittenAt: details.auditWrittenAt,
  };

  const stamp = async (): Promise<void> => {
    try {
      await ctx.store.upsertDeadLetter({
        ...entry,
        details: { ...(entry.details ?? {}), ...progress },
      });
    } catch (e) {
      ctx.log.warn('force-release operator-fee stamp failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (!progress.operatorDebitedAt) {
    // F14: stamp first.
    progress.operatorDebitedAt = new Date().toISOString();
    await stamp();
    // R5-FG-10 (round-5 critical): acquire `withdraw-fees`
    // operator-lock around the operator-balance RMW. R3-FG-12 added
    // this lock to the verifier's matching mutation
    // (`uncertainTxVerification.ts:1354`); R4-FG-12 hardened the
    // null-acquire branch. The force-release SIBLING for the SAME
    // mutation acquired NO lock — a concurrent in-band
    // `operatorWithdrawFees` on a DIFFERENT token RMW races the
    // force-release's debit on `op.balances` (last-write-wins on
    // the JS object spread); one debit is silently lost. Mirror the
    // verifier's contract exactly, including the null-acquire orphan.
    const { acquireOperatorLock, releaseOperatorLock } = await import(
      '~/lib/locks'
    );
    const opLockToken = await acquireOperatorLock('withdraw-fees', 60);
    if (!opLockToken) {
      // R4-FG-12: lock contention → write orphan, skip mutation, leave
      // entry unresolved. Surface as ok=false so the route's resolve
      // step doesn't run.
      try {
        await ctx.store.upsertDeadLetter({
          transactionId: uniqueForceReleaseOrphanId(entry.transactionId),
          timestamp: new Date().toISOString(),
          error: 'force-release operator-fee blocked: withdraw-fees lock held by sibling',
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'operator_fee_withdraw_uncertain',
            sourceTxId: entry.transactionId,
            amount: details.amount,
            tokenKey: details.tokenKey,
            phase: 'op_lock_unavailable',
          },
        });
      } catch {
        /* logged below */
      }
      ctx.log.warn('force-release operator-fee withdraw-fees lock contended', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
      });
      return {
        ok: false,
        status: 409,
        error: 'withdraw-fees lock contention — sibling operator-fee operation in flight; retry shortly',
      };
    }
    try {
      const tokenKey = details.tokenKey;
      const amount = details.amount;
      ctx.store.updateOperator((op) => ({
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
      try {
        await ctx.store.flush();
      } catch {
        /* */
      }
    } catch (e) {
      // F14 inverse failure mode: marker stamped but mutation
      // failed — write an audit-orphan so the operator can fix
      // by hand. Do NOT roll back the marker (a re-run would
      // see no marker and retry the mutation, which might
      // succeed — but if the partial mutation already landed
      // through another Lambda's write-through cache, we'd
      // double-debit). Marker + orphan is the safest combo.
      try {
        await ctx.store.upsertDeadLetter({
          // R2-FG-17: salt synthetic id by writer phase.
          transactionId: uniqueForceReleaseOrphanId(entry.transactionId),
          timestamp: new Date().toISOString(),
          error: `force-release operator debit failed after stamp: ${e instanceof Error ? e.message : String(e)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'operator_fee_withdraw_uncertain',
            sourceTxId: entry.transactionId,
            amount: details.amount,
            tokenKey: details.tokenKey,
            phase: 'debit_failed_after_stamp',
          },
        });
      } catch {
        /* logged above by ctx.log */
      }
      ctx.log.warn('force-release operator state update failed (post-stamp)', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // R5-FG-10: always release the withdraw-fees lock.
      try {
        await releaseOperatorLock('withdraw-fees', opLockToken);
      } catch (releaseErr) {
        ctx.log.warn('force-release withdraw-fees lock release failed', {
          component: 'AdminForceRelease',
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
    }
  }

  if (!progress.auditWrittenAt) {
    try {
      // F18: include withdrawTxId so the reader dedups.
      await ctx.accounting.recordOperatorWithdrawal(
        ctx.agentAccountId,
        details.amount,
        details.tokenKey,
        entry.transactionId,
      );
      progress.auditWrittenAt = new Date().toISOString();
      await stamp();
    } catch (auditErr) {
      ctx.log.warn('force-release operator-fee audit write failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      try {
        await ctx.store.upsertDeadLetter({
          // R2-FG-17: salt synthetic id by writer phase.
          transactionId: uniqueForceReleaseOrphanId(entry.transactionId),
          timestamp: new Date().toISOString(),
          error: `force-release operator audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'operator_fee_withdraw_uncertain',
            sourceTxId: entry.transactionId,
            amount: details.amount,
            tokenKey: details.tokenKey,
            phase: 'audit_failed',
          },
        });
      } catch {
        /* logged above */
      }
    }
  }

  // R2-FG-16 + R3-FG-2: fenced release of F24 per-token pending claim.
  const successFence = (details as { pendingClaimFence?: string }).pendingClaimFence;
  if (typeof successFence === 'string' && successFence.length > 0) {
    try {
      await ctx.redis.eval(
        RELEASE_SCRIPT,
        [`${KEY_PREFIX.lockOperator}withdraw-pending:${details.tokenKey}`],
        [successFence],
      );
    } catch (e) {
      ctx.log.warn('force-release operator-fee F24 pending-claim release failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        tokenKey: details.tokenKey,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: true,
    action: `mirror reports SUCCESS — debited ${details.amount} ${details.tokenKey} from operator state and wrote HCS-20 audit anchor`,
  };
}

// ── play_uncertain ────────────────────────────────────────────────

async function handlePlay(
  entry: DeadLetterEntry,
  mirrorResult: 'SUCCESS' | 'FAILED',
  ctx: ForceReleaseContext,
): Promise<HandlerResult | HandlerError> {
  const details = (entry.details ?? {}) as {
    userId?: string;
    tokenReservations?: Array<{ token: string; amount: number }>;
    successTriagedAt?: string;
  };
  if (
    typeof details.userId !== 'string' ||
    !Array.isArray(details.tokenReservations) ||
    !details.tokenReservations.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as { token: unknown }).token === 'string' &&
        typeof (r as { amount: unknown }).amount === 'number' &&
        Number.isFinite((r as { amount: number }).amount) &&
        (r as { amount: number }).amount >= 0,
    )
  ) {
    return {
      ok: false,
      status: 400,
      error:
        'Cannot force-release: dead-letter is malformed (missing or invalid-shape userId/tokenReservations).',
    };
  }

  // F15 (audit SM-04): refuse if the entry has already been
  // SUCCESS-triaged. Reservations are intentionally held until manual
  // settlement reconstruction completes; releasing them via a second
  // force-release would erase the spend evidence.
  if (typeof details.successTriagedAt === 'string') {
    return {
      ok: false,
      status: 409,
      error:
        'play_uncertain entry has already been SUCCESS-triaged; reservations ' +
        'are held pending manual settlement reconstruction. Force-release would ' +
        'erase the spend evidence.',
      hint:
        'If you have completed the manual reconstruction and need to release ' +
        'reservations, clear `details.successTriagedAt` and re-attempt — but ' +
        'this is a destructive operation, document the reason in your runbook.',
    };
  }

  if (mirrorResult === 'FAILED') {
    // R2-FG-1: serialize per-user reservation release against active
    // in-band withdraw / play / refund. The verifier's play_uncertain
    // FAILED branch (uncertainTxVerification.ts:1150) acquires this
    // same lock per F23. Force-release sibling needs to too.
    const userToken = await tryAcquireUserLockWithBackoff(details.userId);
    if (!userToken) return USER_LOCK_CONTENTION;
    try {
      for (const { token, amount } of details.tokenReservations) {
        try {
          ctx.ledger.releaseReserve(details.userId, amount, token);
        } catch (e) {
          ctx.log.warn('force-release play_uncertain releaseReserve failed', {
            component: 'AdminForceRelease',
            uncertainTxId: entry.transactionId,
            token,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      await releaseUserLock(details.userId, userToken);
    }
    return {
      ok: true,
      action: `mirror reports FAILED — released ${details.tokenReservations.length} reservation(s) for user ${details.userId}`,
    };
  }

  // F12 / R2-FG-7: mirror=SUCCESS — KEEP reservations held. The
  // on-chain play landed but the in-band settlement code never ran,
  // so we cannot reconstruct the per-pool spend / prize state from
  // here. Stamp `successTriagedAt` (F15 gate) AND write the matching
  // HCS-20 `play_uncertain_success_pending_triage` anchor that the
  // verifier sibling already writes (F16). Without the anchor, a
  // topic-only auditor sees the user's pre-play balance with the
  // operator wallet short by the spend amount — silent insolvency
  // exactly when force-release is the resolution path.
  try {
    await ctx.accounting.recordControlEvent('play_uncertain_success_pending_triage', {
      by: ctx.by,
      uncertainTxId: entry.transactionId,
      userId: details.userId,
      tokenReservations: details.tokenReservations,
      // R3-FG-22: same deterministic key as the verifier sibling so
      // a retry-after-partial-failure doesn't double-emit the anchor.
      idempotencyKey: `play-triage:${entry.transactionId}`,
    });
  } catch (anchorErr) {
    ctx.log.warn('force-release play_uncertain SUCCESS triage anchor write failed', {
      component: 'AdminForceRelease',
      uncertainTxId: entry.transactionId,
      error: anchorErr instanceof Error ? anchorErr.message : String(anchorErr),
    });
    // R2-FG-8: include `phase` for replay tooling.
    try {
      await ctx.store.upsertDeadLetter({
        transactionId: uniqueForceReleaseOrphanId(entry.transactionId),
        timestamp: new Date().toISOString(),
        error: `force-release play_uncertain SUCCESS triage anchor write failed: ${anchorErr instanceof Error ? anchorErr.message : String(anchorErr)}`,
        kind: 'audit_trail_orphaned',
        details: {
          sourceKind: 'play_uncertain',
          sourceTxId: entry.transactionId,
          userId: details.userId,
          tokenReservations: details.tokenReservations,
          phase: 'success_triage_anchor',
        },
      });
    } catch {
      /* logged above */
    }
  }

  try {
    await ctx.store.upsertDeadLetter({
      ...entry,
      details: {
        ...(entry.details ?? {}),
        successTriagedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    ctx.log.warn('force-release play_uncertain successTriagedAt stamp failed', {
      component: 'AdminForceRelease',
      uncertainTxId: entry.transactionId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    ok: true,
    action: `mirror reports SUCCESS — reservations held for manual settlement reconstruction (operator must reconcile against dApp pool state); HCS-20 triage anchor written`,
  };
}

// ── refund_uncertain ──────────────────────────────────────────────

interface RefundProgress {
  ledgerAdjustedAt?: string;
  auditWrittenAt?: string;
}

async function handleRefund(
  entry: DeadLetterEntry,
  mirrorResult: 'SUCCESS' | 'FAILED',
  ctx: ForceReleaseContext,
): Promise<HandlerResult | HandlerError> {
  const details = (entry.details ?? {}) as {
    claimKey?: string;
    originalTxId?: string;
    refundTxId?: string;
    humanAmount?: number;
    tokenKey?: string;
    agentAccountId?: string;
    reason?: string;
    performedBy?: string;
  } & RefundProgress;

  if (typeof details.claimKey !== 'string') {
    return {
      ok: false,
      status: 400,
      error: 'Cannot force-release: dead-letter missing claimKey.',
    };
  }
  // F2: namespace check.
  if (!isRefundClaimKey(details.claimKey)) {
    ctx.log.error(
      'force-release refund_uncertain claimKey outside KEY_PREFIX.refunded — refusing',
      {
        component: 'AdminForceRelease',
        event: 'malicious_claim_key',
        uncertainTxId: entry.transactionId,
        claimKeyPrefix: details.claimKey.slice(0, 24),
      },
    );
    return {
      ok: false,
      status: 400,
      error:
        'Dead-letter claimKey is not a refund-claim key. Refusing to release — ' +
        'this entry is malformed and requires manual triage.',
    };
  }

  if (mirrorResult === 'FAILED') {
    // F10: overwrite to `failed:<refundTxId>` instead of DEL.
    //
    // R4-FG-36 (round-4 medium): use `details.refundTxId` to match
    // the SUCCESS branch (line ~1059) which writes `details.refundTxId`.
    // Pre-fix this branch used `entry.transactionId` — for legacy
    // entries where `entry.transactionId !== details.refundTxId`,
    // the FAILED and SUCCESS branches disagreed on which tx
    // identifies the refund, breaking diagnostic message symmetry.
    if (typeof details.refundTxId !== 'string' || details.refundTxId.length === 0) {
      return {
        ok: false,
        status: 400,
        error:
          'Dead-letter is missing details.refundTxId. Cannot resolve FAILED branch ' +
          'without an authoritative refund tx id. Manual triage required.',
      };
    }
    const refundTxId = details.refundTxId;
    try {
      await ctx.redis.set(details.claimKey, `failed:${refundTxId}`, {
        ex: 30 * 24 * 60 * 60,
      });
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: `Failed to overwrite claim: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return {
      ok: true,
      action: `mirror reports FAILED — overwrote claim ${details.claimKey} with failed marker`,
    };
  }

  // F12 / F8 / F9: mirror=SUCCESS — run verifier-equivalent
  // ledger debit + audit anchor + claim overwrite to refundTxId
  // + operator rake reversal. Gated by progress markers.
  if (
    typeof details.originalTxId !== 'string' ||
    typeof details.refundTxId !== 'string' ||
    typeof details.humanAmount !== 'number' ||
    !Number.isFinite(details.humanAmount) ||
    details.humanAmount < 0 ||
    typeof details.tokenKey !== 'string'
  ) {
    return {
      ok: false,
      status: 400,
      error:
        'Cannot force-release: refund_uncertain SUCCESS branch needs ' +
        'originalTxId / refundTxId / humanAmount / tokenKey to apply ' +
        'verifier-equivalent post-conditions.',
    };
  }

  // R2-FG-10 (round-2 B-12): require agentAccountId upfront. The
  // pre-fix SUCCESS branch silently skipped audit if `agentAccountId`
  // was missing while still returning 200 with a misleading "audit
  // anchor" action message — the topic was missing the refund anchor
  // and the operator wouldn't notice. Fail loud instead.
  if (typeof details.agentAccountId !== 'string' || details.agentAccountId.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        'Cannot force-release: refund_uncertain dead-letter is missing `agentAccountId` ' +
        'in details. Without it the HCS-20 audit anchor cannot be written; the operator ' +
        'must reconstruct this field before release.',
    };
  }

  const progress: RefundProgress = {
    ledgerAdjustedAt: details.ledgerAdjustedAt,
    auditWrittenAt: details.auditWrittenAt,
  };

  const stamp = async (): Promise<void> => {
    try {
      await ctx.store.upsertDeadLetter({
        ...entry,
        details: { ...(entry.details ?? {}), ...progress },
      });
    } catch (e) {
      ctx.log.warn('force-release refund stamp failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Look up the deposit record (F8/F9 — canonical user + rakeAmount).
  const depositRecord = await ctx.store
    .getDepositByTxId(details.originalTxId)
    .catch(() => undefined);

  // R2-FG-10 (round-2 R-15): without a depositRecord we have no
  // canonical user/from/rake to attribute the refund against, and the
  // pre-fix code wrote an audit anchor with `from === to === agentAccountId`
  // — a meaningless tautology. Refuse SUCCESS so the operator
  // reconstructs the deposit record first (typically by re-running
  // the deposit watcher or hand-seeding from the mirror).
  // Skip this guard if the ledger has already been adjusted on a
  // prior pass — the depositRecord may have since been pruned.
  if (!progress.ledgerAdjustedAt && !depositRecord) {
    return {
      ok: false,
      status: 400,
      error:
        `Cannot force-release: no deposit record found for originalTxId=${details.originalTxId}. ` +
        `Without it the audit anchor would be a meaningless self-loop and the rake-reversal ` +
        `cannot be sized correctly. Reconstruct the deposit record before retrying.`,
    };
  }

  let rakeReversed = 0;
  if (!progress.ledgerAdjustedAt && depositRecord) {
    const tokenKey = details.tokenKey;
    const humanAmount = details.humanAmount;
    // R2-FG-1: serialize the user-balance debit + operator rake
    // reversal against active in-band withdraw / play / refund. The
    // verifier's refund SUCCESS branch (refund.ts:1015 area) acquires
    // this same lock; force-release sibling needs to too.
    const userToken = await tryAcquireUserLockWithBackoff(depositRecord.userId);
    if (!userToken) return USER_LOCK_CONTENTION;
    try {
      // R3-FG-24 (round-3 P3-DS-001): mirror the F7+R2-FG-19 guard
      // that processRefund applies upfront. Pre-fix used the silent
      // `Math.max(0, ...)` clamp below; underflow scenarios (user
      // re-deposited then re-played, available < humanAmount) silently
      // capped to 0 → user kept the refund AND retained available
      // balance from prior deposits. Now: refuse SUCCESS if available
      // is insufficient.
      const userView = ctx.store.getUser?.(depositRecord.userId);
      const tokEntry = userView?.balances?.tokens?.[tokenKey];
      const availableNow = tokEntry?.available ?? 0;
      if (availableNow < humanAmount) {
        // Release the lock before returning.
        await releaseUserLock(depositRecord.userId, userToken);
        return {
          ok: false,
          status: 409,
          error:
            `Cannot force-release: insufficient AVAILABLE balance for ` +
            `${depositRecord.userId} on ${tokenKey} (have ${availableNow}, need ${humanAmount}). ` +
            `Reserved funds are committed against in-flight plays and cannot be refunded.`,
        };
      }
      ctx.store.updateBalance(depositRecord.userId, (b) => {
        const tokEntry = b.tokens[tokenKey];
        if (!tokEntry) return b;
        tokEntry.available = Math.max(0, tokEntry.available - humanAmount);
        return b;
      });
      // F9: rake reversal.
      if (depositRecord.rakeAmount > 0) {
        ctx.store.updateOperator((op) => ({
          ...op,
          balances: {
            ...op.balances,
            [tokenKey]: (op.balances[tokenKey] ?? 0) - depositRecord.rakeAmount,
          },
        }));
        rakeReversed = depositRecord.rakeAmount;
      }
      progress.ledgerAdjustedAt = new Date().toISOString();
      await stamp();
    } catch (e) {
      ctx.log.warn('force-release refund ledger adjustment failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      await releaseUserLock(depositRecord.userId, userToken);
    }
  }

  if (!progress.auditWrittenAt && details.agentAccountId) {
    try {
      // R3-FG-15 (round-3 P4-002): record `to: entry.sender` (the
      // original deposit sender — the canonical recipient) not the
      // agent. Pre-fix self-loop (`from === to === agent`) produced
      // meaningless audit anchors that broke third-party balance
      // reconstruction. Verifier path already does this correctly;
      // force-release sibling now matches.
      //
      // R4-FG-11 (round-4 high): the `depositRecord?.userId` fallback
      // wrote the INTERNAL `usr_*` UUID into the audit anchor's `to`
      // field — meaningless garbage on the topic. The fallback must
      // resolve userId → hederaAccountId via the store, and refuse
      // SUCCESS if neither entry.sender nor the resolved Hedera
      // account is available (mirroring the verifier's contract,
      // which uses entry.sender ONLY).
      let refundTo: string | undefined = entry.sender;
      if (!refundTo && depositRecord?.userId) {
        const user = ctx.store.getUser(depositRecord.userId);
        refundTo = user?.hederaAccountId;
      }
      if (!refundTo) {
        return {
          ok: false,
          status: 400,
          error:
            `Cannot force-release: refund SUCCESS branch needs entry.sender or a resolvable ` +
            `Hedera account for the deposit owner. Both are missing for ${entry.transactionId}.`,
        };
      }
      await ctx.accounting.recordRefund({
        amount: details.humanAmount,
        from: details.agentAccountId,
        to: refundTo,
        originalDepositTxId: details.originalTxId,
        refundTxId: details.refundTxId,
        reason: details.reason ?? 'operator_initiated',
        performedBy: details.performedBy ?? details.agentAccountId,
        ...(rakeReversed > 0
          ? { rakeReversed, rakeReversedToken: details.tokenKey ?? HBAR_TOKEN_KEY }
          : {}),
      });
      progress.auditWrittenAt = new Date().toISOString();
      await stamp();
    } catch (auditErr) {
      ctx.log.warn('force-release refund audit write failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      try {
        await ctx.store.upsertDeadLetter({
          // R2-FG-17: salt synthetic id by writer phase.
          transactionId: uniqueForceReleaseOrphanId(entry.transactionId),
          timestamp: new Date().toISOString(),
          error: `force-release refund audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'refund_uncertain',
            sourceTxId: entry.transactionId,
            originalTxId: details.originalTxId,
            humanAmount: details.humanAmount,
            tokenKey: details.tokenKey,
            // R2-FG-8: stamp phase for replay tooling.
            phase: 'audit_failed',
          },
        });
      } catch {
        /* logged above */
      }
    }
  }

  // R2-FG-11 (round-2 X-12 / B-17): refuse to silently overwrite a
  // verifier-stamped `failed:<refundTxId>` claim. The pre-fix SUCCESS
  // path blindly clobbered any existing value, destroying the
  // on-chain-failed evidence the verifier wrote. Now: GET first; if
  // we see `failed:`, write an audit-orphan anchor + return 409 so
  // the operator must explicitly clear the claim before retrying.
  let existingClaim: string | null = null;
  try {
    existingClaim = await ctx.redis.get<string>(details.claimKey);
  } catch {
    // GET failure is non-fatal; fall through to the overwrite.
  }
  if (typeof existingClaim === 'string' && existingClaim.startsWith('failed:')) {
    ctx.log.error(
      'force-release refund SUCCESS attempted to overwrite failed: claim — refusing',
      {
        component: 'AdminForceRelease',
        event: 'failed_claim_overwrite_blocked',
        uncertainTxId: entry.transactionId,
        existingClaimPrefix: existingClaim.slice(0, 32),
      },
    );
    try {
      await ctx.store.upsertDeadLetter({
        transactionId: uniqueForceReleaseOrphanId(entry.transactionId),
        timestamp: new Date().toISOString(),
        error:
          `force-release refund SUCCESS refused to overwrite an existing failed: claim ` +
          `(${existingClaim.slice(0, 64)}). Operator must clear the claim explicitly.`,
        kind: 'audit_trail_orphaned',
        details: {
          sourceKind: 'refund_uncertain',
          sourceTxId: entry.transactionId,
          phase: 'failed_claim_overwrite_blocked',
          existingClaim,
        },
      });
    } catch {
      /* logged above */
    }
    return {
      ok: false,
      status: 409,
      error:
        `Refund claim ${details.claimKey} is already marked failed by the verifier (${existingClaim}). ` +
        `Force-release SUCCESS would destroy on-chain-failed evidence. Clear the claim explicitly ` +
        `with operator override + reason before retrying.`,
      hint:
        'This usually means the verifier has already classified this refund as on-chain-failed. ' +
        'If you have new mirror evidence that contradicts that, update the claim manually and retry.',
    };
  }

  // Overwrite claim to refundTxId — same semantic as the verifier's
  // SUCCESS path. Replay protection persists for 30d.
  try {
    await ctx.redis.set(details.claimKey, details.refundTxId, {
      ex: 30 * 24 * 60 * 60,
    });
  } catch {
    /* claim overwrite is best-effort */
  }

  // R3-FG-23 (round-3 P3-DR-003): also write to the permanent
  // refunded-originals SADD set so a 30-day claim TTL doesn't open a
  // second-refund window. The processRefund + verifyUncertainRefunds
  // SUCCESS paths both SADD; force-release SUCCESS was the asymmetric
  // sibling that didn't.
  if (details.originalTxId) {
    try {
      await ctx.redis.sadd(KEY_PREFIX.refundedOriginals, details.originalTxId);
    } catch (e) {
      ctx.log.warn('force-release refund SADD permanent-set failed', {
        component: 'AdminForceRelease',
        uncertainTxId: entry.transactionId,
        originalTxId: details.originalTxId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: true,
    action: `mirror reports SUCCESS — debited refund from user ledger, wrote HCS-20 audit anchor, overwrote claim with refundTxId${
      rakeReversed > 0 ? `, reversed ${rakeReversed} ${details.tokenKey} of operator rake` : ''
    }`,
  };
}
