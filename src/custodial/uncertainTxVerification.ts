/**
 * Reconcile-time verification of `*_uncertain` dead-letter entries.
 *
 * When an on-chain submission's receipt times out (after `tx.execute`
 * returns successfully), the calling code persists a dead-letter row
 * with kind `withdrawal_uncertain`, `operator_fee_withdraw_uncertain`,
 * or `play_uncertain` and KEEPS its idempotency / reserve claim. The
 * on-chain outcome is unknown.
 *
 * This module walks those rows, queries the mirror node for each tx,
 * and resolves:
 *
 *   - Confirmed SUCCESS: complete the post-conditions (ledger
 *     adjustment, audit write, store flush) and mark the entry
 *     resolved. Leave any SET-NX-EX claim in place.
 *   - Confirmed FAILED: release the held claim / reserve so the
 *     operator (or user) can retry, and mark the entry resolved.
 *   - Still NOT_FOUND or transient mirror error: leave the entry
 *     untouched; next reconcile pass will retry. After 24h of
 *     persistent NOT_FOUND, the entry is promoted to FAILED — Hedera
 *     consensus is sub-second, so anything not on mirror after a day
 *     never landed.
 *
 * The refund verification path is in `src/hedera/refund.ts`
 * (`verifyUncertainRefunds`) — kept there because it's tightly
 * coupled to refund's claim-key semantics and audit-write helper.
 *
 * ── Concurrency safety ────────────────────────────────────────────
 *
 * Each verifier acquires a per-txId Redis SET-NX-EX lock
 * (`KEY_PREFIX.verifying:<txId>`, 60s TTL) BEFORE any state mutation.
 * Two reconcile passes overlapping (admin-click + cron) will see the
 * same open entry, but only one will hold the verifying lock and
 * mutate state. The other gets `still_uncertain` and bows out. Lock
 * naturally expires; explicit release would be racy, so we don't.
 */

import type { IStore, DeadLetterEntry } from './IStore.js';
import type { UserLedger } from './UserLedger.js';
import type { AccountingService } from './AccountingService.js';
import { getMirrorBaseUrl } from '../hedera/mirror.js';
import { classifyMirrorResult, type MirrorResult } from '../hedera/responseCodes.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { logger } from '../lib/logger.js';
import { escalateUncertainDlFailure } from '../lib/escalation.js';

// ── Constants ─────────────────────────────────────────────────────

/**
 * After this many hours of persistent NOT_FOUND, an uncertain entry
 * is promoted to FAILED. Hedera consensus is sub-second; anything
 * still invisible to the mirror node after 24h has functionally
 * never landed, so it's safe to release the held claim/reserve.
 */
const NOT_FOUND_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Per-txId verifier lock TTL. Long enough to absorb a slow mirror
 * fetch + audit write, short enough that a crashed verifier's lock
 * doesn't wedge the entry beyond the next reconcile cadence.
 */
const VERIFY_LOCK_TTL_SEC = 60;

/**
 * Number of times a malformed entry can be skipped before the
 * operator is paged. The entry sits in the dead-letter list until
 * resolved by hand; we want a signal so it doesn't quietly rot.
 */
const MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE = 5;

// Mirror node tx response shape (partial — only what we need).
interface MirrorTxLookup {
  transactions?: Array<{ result: string }>;
}

// ── Outcome shapes ────────────────────────────────────────────────

export interface WithdrawalVerificationOutcome {
  withdrawTxId: string;
  userId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  /** Human-readable note suitable for an admin UI. */
  note: string;
}

export interface OperatorFeeWithdrawVerificationOutcome {
  withdrawTxId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  note: string;
}

export interface PlayVerificationOutcome {
  uncertainTxId: string;
  userId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  note: string;
}

// ── Shared helpers ────────────────────────────────────────────────

/**
 * Acquire the per-txId verifier lock. Returns true on success, false
 * if another reconcile pass already holds it.
 */
async function acquireVerifyLock(txId: string): Promise<boolean> {
  try {
    const redis = await getRedis();
    const key = `${KEY_PREFIX.verifying}${txId}`;
    const result = await redis.set(key, '1', { nx: true, ex: VERIFY_LOCK_TTL_SEC });
    return result !== null;
  } catch (e) {
    // Redis blip — fail closed. Better to skip this pass than to risk
    // double-mutation if the next pass sees the entry resolved.
    logger.warn('verifier lock acquisition failed; skipping entry this pass', {
      component: 'UncertainTx',
      event: 'verify_lock_redis_error',
      txId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Look up a tx on the mirror node and classify the result. Returns
 * `null` for a transient/network error (caller should treat as
 * still-uncertain and retry next pass).
 */
async function lookupMirrorResult(
  txId: string,
): Promise<{ result: MirrorResult } | { transientError: string }> {
  try {
    const url = `${getMirrorBaseUrl()}/transactions/${txId}`;
    const res = await fetch(url);
    if (res.status === 404) return { result: 'NOT_FOUND' };
    if (!res.ok) {
      return { transientError: `Mirror returned ${res.status}; will retry next reconcile.` };
    }
    const body = (await res.json()) as MirrorTxLookup;
    const tx = body.transactions?.[0];
    if (!tx) return { result: 'NOT_FOUND' };
    return { result: classifyMirrorResult(tx.result) };
  } catch (e) {
    return {
      transientError: `Mirror lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Apply the NOT_FOUND max-age policy. Entries older than 24h are
 * promoted to FAILED — Hedera consensus is sub-second, so anything
 * not on the mirror after a day never landed.
 */
function applyNotFoundMaxAge(entry: DeadLetterEntry): MirrorResult {
  const ageMs = Date.now() - new Date(entry.timestamp).getTime();
  return ageMs > NOT_FOUND_MAX_AGE_MS ? 'FAILED' : 'NOT_FOUND';
}

/**
 * Increment `verificationAttempts` on a malformed entry and page if
 * the threshold is hit. Persists the increment via upsertDeadLetter.
 */
async function bumpVerificationAttempts(
  store: IStore,
  entry: DeadLetterEntry,
): Promise<void> {
  const prior = (entry.details?.verificationAttempts as number | undefined) ?? 0;
  const next = prior + 1;
  try {
    await store.upsertDeadLetter({
      ...entry,
      details: { ...(entry.details ?? {}), verificationAttempts: next },
    });
  } catch {
    // Already in a degraded state; logging would be noise.
  }
  if (next === MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE) {
    logger.error(
      `dead-letter entry malformed for ${MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE} ` +
        `consecutive reconcile passes — manual triage required`,
      {
        component: 'UncertainTx',
        event: 'malformed_dl_threshold_reached',
        kind: entry.kind,
        txId: entry.transactionId,
      },
    );
    await escalateUncertainDlFailure({
      kind: (entry.kind ?? 'withdrawal_uncertain') as
        | 'withdrawal_uncertain'
        | 'operator_fee_withdraw_uncertain'
        | 'play_uncertain'
        | 'refund_uncertain',
      uncertainTxId: entry.transactionId,
      userId: entry.details?.userId as string | undefined,
      cause: new Error(
        `Malformed dead-letter persisted across ${MAX_VERIFICATION_ATTEMPTS_BEFORE_PAGE} reconcile passes`,
      ),
    });
  }
}

/**
 * Write an `audit_trail_orphaned` dead-letter when a verifier's
 * audit-write fails. Mirrors the in-band path's failure handling —
 * audit asymmetry was finding M16.
 */
async function recordAuditOrphan(
  store: IStore,
  sourceKind: NonNullable<DeadLetterEntry['kind']>,
  sourceTxId: string,
  details: Record<string, unknown>,
  cause: unknown,
): Promise<void> {
  try {
    // Synthetic id so this row coexists with the original (which the
    // verifier resolves at the same `transactionId`). Without the
    // suffix, upsertDeadLetter dedups them and the orphan vanishes
    // when the verifier writes the resolve marker.
    await store.upsertDeadLetter({
      transactionId: `audit-orphan:${sourceTxId}`,
      timestamp: new Date().toISOString(),
      error: `verifier audit write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      kind: 'audit_trail_orphaned',
      details: { sourceKind, sourceTxId, ...details },
    });
  } catch {
    // Already escalated by the calling verifier; nothing more to do.
  }
}

/**
 * Mark an entry resolved (idempotent — safe to call twice). When
 * `progress` is supplied, the per-post-condition idempotency
 * markers are merged into `entry.details` so a re-run after a crash
 * can read which steps already happened and skip them. R-HIGH-1 fix.
 */
async function markResolved(
  store: IStore,
  entry: DeadLetterEntry,
  resolutionTxId: string,
  progress?: Record<string, unknown>,
): Promise<void> {
  try {
    await store.upsertDeadLetter({
      ...entry,
      details: { ...(entry.details ?? {}), ...(progress ?? {}) },
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'reconcile',
      resolutionTxId,
    });
  } catch (e) {
    logger.warn('uncertain dead-letter resolve write failed', {
      component: 'UncertainTx',
      event: 'dl_resolve_write_failed',
      kind: entry.kind,
      txId: entry.transactionId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Persist a progress marker mid-flight (between post-condition
 * steps) so a Lambda crash before `markResolved` is still recoverable
 * by the next reconcile pass without duplicating the completed steps.
 * Failures are logged but not surfaced — the worst case is a duplicate
 * post-condition on re-run, which is the very thing this guards
 * against, so we don't want a stamp failure to block subsequent steps.
 */
async function stampProgress(
  store: IStore,
  entry: DeadLetterEntry,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    await store.upsertDeadLetter({
      ...entry,
      details: { ...(entry.details ?? {}), ...patch },
    });
  } catch (e) {
    logger.warn('uncertain dead-letter progress stamp failed', {
      component: 'UncertainTx',
      event: 'dl_progress_stamp_failed',
      kind: entry.kind,
      txId: entry.transactionId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── verifyUncertainWithdrawals ────────────────────────────────────

export async function verifyUncertainWithdrawals(
  store: IStore,
  ledger: UserLedger,
  accounting?: AccountingService,
): Promise<WithdrawalVerificationOutcome[]> {
  const outcomes: WithdrawalVerificationOutcome[] = [];

  await store.refreshDeadLetters().catch(() => undefined);
  const open = store
    .getDeadLetters()
    .filter((e) => e.kind === 'withdrawal_uncertain' && !e.resolvedAt);
  if (open.length === 0) return outcomes;

  for (const entry of open) {
    const withdrawTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      userId?: string;
      withdrawTxId?: string;
      amount?: number;
      tokenKey?: string;
      isHbar?: boolean;
      recipientAccountId?: string;
    };
    const userId = details.userId ?? '(unknown)';

    if (
      typeof details.userId !== 'string' ||
      typeof details.amount !== 'number' ||
      typeof details.tokenKey !== 'string'
    ) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: 'Dead-letter entry malformed (missing userId / amount / tokenKey). Manual triage required.',
      });
      continue;
    }

    // C4: per-txId lock. Skip if another reconcile is processing.
    if (!(await acquireVerifyLock(withdrawTxId))) {
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
      });
      continue;
    }

    // ── Mirror lookup ──────────────────────────────────────────
    const lookup = await lookupMirrorResult(withdrawTxId);
    if ('transientError' in lookup) {
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: lookup.transientError,
      });
      continue;
    }
    let { result } = lookup;
    if (result === 'NOT_FOUND') {
      result = applyNotFoundMaxAge(entry);
    }

    if (result === 'NOT_FOUND') {
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    if (result === 'FAILED') {
      try {
        ledger.releaseReserve(details.userId, details.amount, details.tokenKey);
      } catch (e) {
        logger.warn('withdrawal_uncertain releaseReserve failed', {
          component: 'UncertainTx',
          withdrawTxId,
          userId: details.userId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      // H10: flush before marking resolved, so the release survives
      // a Lambda freeze between mutation and resolve.
      try {
        await store.flush();
      } catch {
        /* flush failure is logged inside the store */
      }
      await markResolved(store, entry, withdrawTxId);
      outcomes.push({
        withdrawTxId,
        userId,
        status: 'failed',
        note: 'On-chain withdrawal failed (or not on mirror after 24h); reserve released, user can retry.',
      });
      continue;
    }

    // ── Confirmed SUCCESS: settle + audit + flush + resolve ────
    //
    // R-HIGH-1: each post-condition is idempotency-marked so a
    // Lambda crash mid-mutation (or `accounting.recordWithdrawal`
    // exceeding the 60s lock TTL — HCS submits can hang on Hedera
    // congestion) doesn't cause a re-run to duplicate the completed
    // steps. Markers are stamped immediately after each step
    // succeeds; the next reconcile pass reads them and skips.
    type WithdrawProgress = {
      settledAt?: string;
      totalWithdrawnAt?: string;
      historyWrittenAt?: string;
      auditWrittenAt?: string;
    };
    const priorProgress = (entry.details ?? {}) as WithdrawProgress;
    const progress: WithdrawProgress = {
      settledAt: priorProgress.settledAt,
      totalWithdrawnAt: priorProgress.totalWithdrawnAt,
      historyWrittenAt: priorProgress.historyWrittenAt,
      auditWrittenAt: priorProgress.auditWrittenAt,
    };

    if (!progress.settledAt) {
      try {
        ledger.settleSpend(details.userId, details.amount, details.tokenKey);
        progress.settledAt = new Date().toISOString();
        await stampProgress(store, entry, { settledAt: progress.settledAt });
      } catch (e) {
        logger.warn('withdrawal_uncertain settleSpend failed', {
          component: 'UncertainTx',
          withdrawTxId,
          userId: details.userId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (!progress.totalWithdrawnAt) {
      try {
        store.updateBalance(details.userId, (b) => {
          const tokEntry = b.tokens[details.tokenKey!];
          if (tokEntry) tokEntry.totalWithdrawn += details.amount!;
          return b;
        });
        progress.totalWithdrawnAt = new Date().toISOString();
        await stampProgress(store, entry, {
          totalWithdrawnAt: progress.totalWithdrawnAt,
        });
      } catch (e) {
        logger.warn('withdrawal_uncertain totalWithdrawn update failed', {
          component: 'UncertainTx',
          withdrawTxId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (!progress.historyWrittenAt) {
      try {
        store.recordWithdrawal({
          userId: details.userId,
          amount: details.amount,
          tokenId: details.isHbar ? null : details.tokenKey,
          recipientAccountId: details.recipientAccountId ?? '',
          transactionId: withdrawTxId,
          timestamp: new Date().toISOString(),
        });
        progress.historyWrittenAt = new Date().toISOString();
        await stampProgress(store, entry, {
          historyWrittenAt: progress.historyWrittenAt,
        });
      } catch (e) {
        logger.warn('withdrawal_uncertain recordWithdrawal failed', {
          component: 'UncertainTx',
          withdrawTxId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // C3: HCS-20 audit anchor — was missing entirely. Without this,
    // confirmed-via-reconcile withdrawals are invisible to external
    // auditors reconstructing from the topic. R-HIGH-1: also gated
    // by auditWrittenAt — `accounting.recordWithdrawal` writes a
    // burn op with no idempotency on the message body, so a re-run
    // would emit a SECOND burn for the same withdrawal.
    if (accounting && !progress.auditWrittenAt) {
      try {
        await accounting.recordWithdrawal(
          details.recipientAccountId ?? '',
          details.amount,
          details.tokenKey,
        );
        progress.auditWrittenAt = new Date().toISOString();
        await stampProgress(store, entry, {
          auditWrittenAt: progress.auditWrittenAt,
        });
      } catch (auditErr) {
        // M16: audit failure → audit_trail_orphaned dead-letter so
        // the operator surfaces it the same way as in-band failures.
        logger.warn('withdrawal_uncertain accounting.recordWithdrawal failed', {
          component: 'UncertainTx',
          withdrawTxId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
        await recordAuditOrphan(
          store,
          'withdrawal_uncertain',
          withdrawTxId,
          { userId: details.userId, amount: details.amount, tokenKey: details.tokenKey },
          auditErr,
        );
      }
    }

    // H10: flush BEFORE marking resolved.
    try {
      await store.flush();
    } catch {
      /* flush failure is logged inside the store */
    }
    await markResolved(store, entry, withdrawTxId, progress);

    outcomes.push({
      withdrawTxId,
      userId,
      status: 'confirmed',
      note: 'On-chain withdrawal confirmed; ledger settled and HCS-20 audit anchor written.',
    });
  }

  return outcomes;
}

// ── verifyUncertainOperatorFeeWithdrawals ─────────────────────────

export async function verifyUncertainOperatorFeeWithdrawals(
  store: IStore,
  agentAccountId: string,
  accounting?: AccountingService,
): Promise<OperatorFeeWithdrawVerificationOutcome[]> {
  const outcomes: OperatorFeeWithdrawVerificationOutcome[] = [];

  await store.refreshDeadLetters().catch(() => undefined);
  const open = store
    .getDeadLetters()
    .filter((e) => e.kind === 'operator_fee_withdraw_uncertain' && !e.resolvedAt);
  if (open.length === 0) return outcomes;

  for (const entry of open) {
    const withdrawTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      withdrawTxId?: string;
      amount?: number;
      tokenKey?: string;
      token?: string;
      recipientAccountId?: string;
    };

    if (
      typeof details.amount !== 'number' ||
      typeof details.tokenKey !== 'string'
    ) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: 'Dead-letter entry malformed (missing amount / tokenKey). Manual triage required.',
      });
      continue;
    }

    if (!(await acquireVerifyLock(withdrawTxId))) {
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
      });
      continue;
    }

    const lookup = await lookupMirrorResult(withdrawTxId);
    if ('transientError' in lookup) {
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: lookup.transientError,
      });
      continue;
    }
    let { result } = lookup;
    if (result === 'NOT_FOUND') {
      result = applyNotFoundMaxAge(entry);
    }

    if (result === 'NOT_FOUND') {
      outcomes.push({
        withdrawTxId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    if (result === 'FAILED') {
      try {
        await store.flush();
      } catch {
        /* */
      }
      await markResolved(store, entry, withdrawTxId);
      outcomes.push({
        withdrawTxId,
        status: 'failed',
        note: 'On-chain operator fee withdrawal failed (or not on mirror after 24h); nothing to roll back.',
      });
      continue;
    }

    // SUCCESS: debit operator balance + write HCS-20 audit anchor.
    // R-HIGH-1: idempotency markers gate each step so a Lambda crash
    // doesn't double-debit on the next reconcile pass.
    type OperatorProgress = {
      operatorDebitedAt?: string;
      auditWrittenAt?: string;
    };
    const priorOperatorProgress = (entry.details ?? {}) as OperatorProgress;
    const operatorProgress: OperatorProgress = {
      operatorDebitedAt: priorOperatorProgress.operatorDebitedAt,
      auditWrittenAt: priorOperatorProgress.auditWrittenAt,
    };

    if (!operatorProgress.operatorDebitedAt) {
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
            [tokenKey]: (op.totalWithdrawnByOperator[tokenKey] ?? 0) + amount,
          },
        }));
        operatorProgress.operatorDebitedAt = new Date().toISOString();
        await stampProgress(store, entry, {
          operatorDebitedAt: operatorProgress.operatorDebitedAt,
        });
      } catch (e) {
        logger.warn('operator_fee_withdraw_uncertain operator state update failed', {
          component: 'UncertainTx',
          withdrawTxId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (accounting && !operatorProgress.auditWrittenAt) {
      try {
        await accounting.recordOperatorWithdrawal(
          agentAccountId,
          details.amount,
          details.tokenKey,
        );
        operatorProgress.auditWrittenAt = new Date().toISOString();
        await stampProgress(store, entry, {
          auditWrittenAt: operatorProgress.auditWrittenAt,
        });
      } catch (auditErr) {
        logger.warn(
          'operator_fee_withdraw_uncertain accounting.recordOperatorWithdrawal failed',
          {
            component: 'UncertainTx',
            withdrawTxId,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          },
        );
        await recordAuditOrphan(
          store,
          'operator_fee_withdraw_uncertain',
          withdrawTxId,
          { amount: details.amount, tokenKey: details.tokenKey },
          auditErr,
        );
      }
    }

    try {
      await store.flush();
    } catch {
      /* */
    }
    await markResolved(store, entry, withdrawTxId, operatorProgress);

    outcomes.push({
      withdrawTxId,
      status: 'confirmed',
      note: 'On-chain operator fee withdrawal confirmed; operator state debited and HCS-20 audit anchor written.',
    });
  }

  return outcomes;
}

// ── verifyUncertainPlays ──────────────────────────────────────────
//
// C1: when a play session's contract submission times out, we keep
// per-token reservations and dead-letter. Reconcile resolves:
//   - FAILED (or 24h NOT_FOUND): release every reservation in the
//     stored tokenReservations list.
//   - SUCCESS: the on-chain action landed but in-band settlement
//     code never ran. We CANNOT reconstruct settlement here (the
//     play session has no PlaySessionResult). Mark the entry
//     resolved with a flag for manual triage — the operator must
//     reconcile entries against dApp pool state by hand.
//   - NOT_FOUND (recent): leave for next reconcile pass.

export async function verifyUncertainPlays(
  store: IStore,
  ledger: UserLedger,
): Promise<PlayVerificationOutcome[]> {
  const outcomes: PlayVerificationOutcome[] = [];

  await store.refreshDeadLetters().catch(() => undefined);
  const open = store
    .getDeadLetters()
    .filter((e) => e.kind === 'play_uncertain' && !e.resolvedAt);
  if (open.length === 0) return outcomes;

  for (const entry of open) {
    const uncertainTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      userId?: string;
      tokenReservations?: Array<{ token: string; amount: number }>;
    };
    const userId = details.userId ?? '(unknown)';

    if (
      typeof details.userId !== 'string' ||
      !Array.isArray(details.tokenReservations)
    ) {
      await bumpVerificationAttempts(store, entry);
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: 'Dead-letter entry malformed (missing userId / tokenReservations). Manual triage required.',
      });
      continue;
    }

    if (!(await acquireVerifyLock(uncertainTxId))) {
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
      });
      continue;
    }

    const lookup = await lookupMirrorResult(uncertainTxId);
    if ('transientError' in lookup) {
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: lookup.transientError,
      });
      continue;
    }
    let { result } = lookup;
    if (result === 'NOT_FOUND') {
      result = applyNotFoundMaxAge(entry);
    }

    if (result === 'NOT_FOUND') {
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    if (result === 'FAILED') {
      // Confirmed not-on-chain: release every reserved token amount.
      for (const { token, amount } of details.tokenReservations) {
        try {
          ledger.releaseReserve(details.userId, amount, token);
        } catch (e) {
          logger.warn('play_uncertain releaseReserve failed', {
            component: 'UncertainTx',
            uncertainTxId,
            userId: details.userId,
            token,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      try {
        await store.flush();
      } catch {
        /* */
      }
      await markResolved(store, entry, uncertainTxId);
      outcomes.push({
        uncertainTxId,
        userId,
        status: 'failed',
        note: 'Play submission failed (or not on mirror after 24h); reservations released.',
      });
      continue;
    }

    // SUCCESS: on-chain play landed but in-band settlement code did
    // NOT run. We cannot reconstruct PlaySessionResult here (no
    // pool-result data, no prizes record). Mark resolved with a
    // manual-triage flag and page the operator. The reservations
    // remain held until manual unlock — releasing them blindly would
    // erase the spend evidence for the operator's reconstruction.
    logger.error(
      'play_uncertain confirmed SUCCESS — manual triage required to reconstruct settlement',
      {
        component: 'UncertainTx',
        event: 'play_uncertain_success_manual_triage',
        uncertainTxId,
        userId: details.userId,
        tokenReservations: details.tokenReservations,
      },
    );
    await escalateUncertainDlFailure({
      kind: 'play_uncertain',
      uncertainTxId,
      userId: details.userId,
      cause: new Error(
        'play_uncertain confirmed SUCCESS — settlement state must be reconstructed manually from dApp pool state',
      ),
    });
    try {
      await store.upsertDeadLetter({
        ...entry,
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'reconcile-success-needs-manual-triage',
        resolutionTxId: uncertainTxId,
      });
    } catch {
      /* logged via escalation */
    }
    outcomes.push({
      uncertainTxId,
      userId,
      status: 'confirmed',
      note: 'On-chain play confirmed; reservations held pending manual settlement reconstruction (operator paged).',
    });
  }

  return outcomes;
}
