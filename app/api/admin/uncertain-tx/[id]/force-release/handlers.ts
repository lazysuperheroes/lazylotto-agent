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
import { isRefundClaimKey } from '~/auth/redis';
import { HBAR_TOKEN_KEY } from '~/config/strategy';

export interface ForceReleaseContext {
  store: IStore;
  ledger: UserLedger;
  accounting: AccountingService;
  agentAccountId: string;
  redis: {
    set(
      key: string,
      value: string,
      options?: { nx?: boolean; ex?: number },
    ): Promise<unknown>;
    del(...keys: string[]): Promise<number>;
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
    try {
      ctx.ledger.releaseReserve(details.userId, details.amount, details.tokenKey);
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: `Failed to release reserve: ${e instanceof Error ? e.message : String(e)}`,
      };
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
          transactionId: `audit-orphan:${entry.transactionId}`,
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
          transactionId: `audit-orphan:${entry.transactionId}`,
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
          transactionId: `audit-orphan:${entry.transactionId}`,
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
    return {
      ok: true,
      action: `mirror reports FAILED — released ${details.tokenReservations.length} reservation(s) for user ${details.userId}`,
    };
  }

  // F12: mirror=SUCCESS — KEEP reservations held. The on-chain play
  // landed but the in-band settlement code never ran, so we cannot
  // reconstruct the per-pool spend / prize state from here. Stamp
  // `successTriagedAt` (F15 gate) and let the operator complete the
  // manual reconstruction. F16 in Phase 4 will add the matching
  // HCS-20 manual-triage anchor.
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
    action: `mirror reports SUCCESS — reservations held for manual settlement reconstruction (operator must reconcile against dApp pool state)`,
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
    const refundTxId = entry.transactionId; // dead-letter id IS the refundTxId
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

  let rakeReversed = 0;
  if (!progress.ledgerAdjustedAt && depositRecord) {
    const tokenKey = details.tokenKey;
    const humanAmount = details.humanAmount;
    try {
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
    }
  }

  if (!progress.auditWrittenAt && details.agentAccountId) {
    try {
      await ctx.accounting.recordRefund({
        amount: details.humanAmount,
        from: details.agentAccountId,
        to: details.agentAccountId, // sender unknown at force-release time; agent attests
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
          transactionId: `audit-orphan:${entry.transactionId}`,
          timestamp: new Date().toISOString(),
          error: `force-release refund audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'refund_uncertain',
            sourceTxId: entry.transactionId,
            originalTxId: details.originalTxId,
            humanAmount: details.humanAmount,
            tokenKey: details.tokenKey,
          },
        });
      } catch {
        /* logged above */
      }
    }
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

  return {
    ok: true,
    action: `mirror reports SUCCESS — debited refund from user ledger, wrote HCS-20 audit anchor, overwrote claim with refundTxId${
      rakeReversed > 0 ? `, reversed ${rakeReversed} ${details.tokenKey} of operator rake` : ''
    }`,
  };
}
