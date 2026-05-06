/**
 * Shared refund logic: look up a Hedera transaction on the mirror node,
 * identify the sender and amount, then transfer the funds back.
 *
 * Used by both the `operator_refund` MCP tool and the
 * POST /api/admin/refund API route.
 *
 * Safety guarantees:
 *   1. Replay protection — every refunded txId is recorded in Redis,
 *      duplicate refund attempts are rejected.
 *   2. Deposit validation — only refunds transactions that were
 *      credited as deposits via the deposit watcher. Random inbound
 *      transfers (operator gas top-ups, prize transfers, bounty
 *      payouts) cannot be refunded.
 *   3. Ledger adjustment — when refund completes, the user's internal
 *      balance is decremented to prevent phantom funds.
 */

import type { Client } from '@hashgraph/sdk';
import {
  submitHbarTransfer,
  submitTokenTransfer,
  awaitReceipt,
  ReceiptUncertainError,
} from './transfers.js';
import { getMirrorBaseUrl } from './mirror.js';
import { getOperatorAccountId } from './wallet.js';
import { withChecksum } from '../utils/checksum.js';
import type { IStore, DeadLetterEntry } from '../custodial/IStore.js';
import type { AccountingService } from '../custodial/AccountingService.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { logger } from '../lib/logger.js';
import { escalateUncertainDlFailure } from '../lib/escalation.js';
import { classifyMirrorResult } from './responseCodes.js';
import { acquireUserLock, releaseUserLock } from '../lib/locks.js';

const REFUND_KEY_PREFIX = KEY_PREFIX.refunded;

// ── Types ────────────────────────────────────────────────────────

export interface RefundResult {
  refunded: boolean;
  originalTx: string;
  sender: string;
  amount: string;
  refundTxId: string;
  /** If the refund matched a user deposit, the userId whose balance was adjusted. */
  ledgerAdjusted?: string;
}

/** Optional store for ledger adjustment on refund. */
export interface RefundLedgerOptions {
  store: IStore;
  /**
   * Optional AccountingService for HCS-20 v2 audit trail. When
   * provided, processRefund writes a `refund` op to the topic
   * after the on-chain transfer succeeds. Without it, refunds
   * happen on chain but never appear in the audit trail —
   * leaving deposits as un-paired credits and breaking
   * reconciliation math for external auditors.
   */
  accounting?: AccountingService;
  /**
   * Operator account ID recorded as `performedBy` in the audit
   * entry. Defaults to the agent operator account.
   */
  performedBy?: string;
  /**
   * Free-text reason for the refund (stuck_deposit,
   * operator_initiated, etc.). Recorded in the audit entry.
   */
  reason?: string;
}

// ── Mirror node transaction shape (partial) ─────────────────────

interface MirrorTxResponse {
  transactions: Array<{
    transfers: Array<{ account: string; amount: number }>;
    token_transfers: Array<{ token_id: string; account: string; amount: number }>;
    result: string;
    memo_base64: string;
  }>;
}

// ── Core ─────────────────────────────────────────────────────────

/**
 * Process a refund for a specific Hedera transaction.
 *
 * 1. Fetches the transaction from the mirror node
 * 2. Identifies the sender (the account with the negative transfer to the agent)
 * 3. Transfers the same amount back to the sender
 */
export async function processRefund(
  client: Client,
  transactionId: string,
  options?: RefundLedgerOptions,
): Promise<RefundResult> {
  const agentAccountId = getOperatorAccountId(client);

  // ── Validation: only credited deposits can be refunded ───────
  // Reject any txId that wasn't processed by the deposit watcher.
  // Without this, an admin could refund operator gas top-ups, prize
  // transfers, bounty payouts, or any other inbound transfer.
  //
  // Uses `isDepositCredited` (cross-Lambda Redis check) rather than
  // the local-cache `isTransactionProcessed`. The latter would return
  // a false negative on a Lambda whose local cache hadn't yet seen the
  // recent deposit, refusing a legitimate refund.
  if (options?.store) {
    if (!(await options.store.isDepositCredited(transactionId))) {
      throw new Error(
        `Transaction ${transactionId} was not credited as a user deposit. ` +
        `Only deposits processed by the deposit watcher can be refunded.`,
      );
    }
  } else {
    console.warn(
      '[Refund] processRefund called without a store — deposit validation skipped. ' +
      'This is unsafe in production.',
    );
  }

  // ── Replay protection: atomic SET-NX-EX claim ────────────────
  // Atomic claim — `SET NX EX` returns 'OK' iff this is the first
  // caller to claim across all Lambdas, null if another Lambda already
  // claimed. The pre-fix pattern (GET then later SET after the on-chain
  // transfer) had a multi-second TOCTOU window covering the mirror-node
  // lookup + the on-chain refund tx; two admin clicks landing on
  // different Lambdas could both pass the GET and both execute the
  // refund. Same bug class as the duplicate-deposit incident.
  //
  // Marker progression:
  //   1. SET-NX-EX 'pending' — first claim wins
  //   2. On success: overwrite with the actual refundTxId
  //   3. On failure: DEL so a retry can claim again
  //
  // FAIL CLOSED: if Redis is unreachable we cannot claim — refuse
  // the refund. Refunds are irreversible on-chain.
  let redisLockKey: string | null = null;
  try {
    const redis = await getRedis();
    redisLockKey = `${REFUND_KEY_PREFIX}${transactionId}`;
    const claimResult = await redis.set(
      redisLockKey,
      'pending',
      { nx: true, ex: 30 * 24 * 60 * 60 },
    );
    if (claimResult === null) {
      // Another caller has already claimed. Read the stored value so
      // we can include the actual refundTxId in the error if the prior
      // refund completed; if it's still 'pending', surface that
      // explicitly so the operator knows to wait.
      const existing = await redis.get<string>(redisLockKey);
      throw new Error(
        existing && existing !== 'pending'
          ? `Transaction ${transactionId} has already been refunded. ` +
            `Original refund tx: ${existing}`
          : `Refund for ${transactionId} is already in progress on another ` +
            `Lambda. Try again in a minute.`,
      );
    }
  } catch (e) {
    // Rethrow our own sentinels unchanged
    if (
      e instanceof Error &&
      (e.message.includes('already been refunded') ||
        e.message.includes('already in progress'))
    ) {
      throw e;
    }
    // Any other error means we couldn't claim — refuse the refund.
    throw new Error(
      'Refund replay protection unavailable: the Redis backend is not ' +
      'reachable right now. Refusing to refund without an atomic claim. ' +
      'Retry once the backend recovers.',
    );
  }

  // ── Mirror lookup + on-chain transfer (claim release semantics differ) ──
  //
  // Three failure regimes, each with different claim-handling rules:
  //
  //   A. PRE-SUBMISSION (mirror lookup, sender resolution, tx.execute
  //      throws): the on-chain transfer never happened. DEL the claim
  //      so the operator can retry once the underlying issue clears.
  //
  //   B. CONFIRMED FAILURE (awaitReceipt throws ReceiptStatusError):
  //      the tx landed on chain but reverted (INSUFFICIENT_TX_FEE,
  //      etc.). Same as A — DEL claim, allow retry.
  //
  //   C. RECEIPT UNCERTAIN (awaitReceipt throws ReceiptUncertainError):
  //      the tx was submitted but the receipt timed out. The on-chain
  //      outcome is UNKNOWN — the tx may have landed. We MUST NOT
  //      release the claim (releasing would let a retry double-refund
  //      if the original tx actually settled). Instead we write a
  //      `refund_uncertain` dead-letter and rethrow. The reconcile-
  //      time verification pass (verifyUncertainRefunds, below) walks
  //      these and either completes the bookkeeping or releases the
  //      claim once the mirror node knows the answer.
  //
  // Once we successfully complete awaitReceipt, we're committed — any
  // subsequent failure (audit write, ledger adjustment, marker
  // overwrite) is a recoverable post-condition handled by those
  // blocks' own try/catch.
  let refundTxId: string | undefined;
  let amountDisplay: string;
  let senderAccountId: string;
  // Initialized to null so TS sees a definite assignment for the
  // catch-block destructuring even when the throw happens before the
  // mirror lookup writes the real value (it's then either still null
  // for HBAR or the token id for FTs).
  let refundToken: string | null = null;
  let refundAmount: number;
  let humanRefundAmount: number;
  let tx: MirrorTxResponse['transactions'][number];
  try {
    const mirrorUrl = `${getMirrorBaseUrl()}/transactions/${transactionId}`;

    const txRes = await fetch(mirrorUrl);
    if (!txRes.ok) {
      throw new Error(`Transaction ${transactionId} not found on mirror node`);
    }

    const txData = (await txRes.json()) as MirrorTxResponse;
    const fetched = txData.transactions?.[0];
    if (!fetched) throw new Error('Transaction not found');
    if (fetched.result !== 'SUCCESS') {
      throw new Error(`Transaction was not successful: ${fetched.result}`);
    }
    tx = fetched;

    // Identify incoming transfer to agent
    const hbarIn = tx.transfers?.find(
      (t) => t.account === agentAccountId && t.amount > 0,
    );
    const tokenIn = tx.token_transfers?.find(
      (t) => t.account === agentAccountId && t.amount > 0,
    );

    if (!hbarIn && !tokenIn) {
      throw new Error('No incoming transfer to agent found in this transaction');
    }

    // Find sender
    let resolvedSender: string | null = null;
    if (tokenIn) {
      resolvedSender =
        tx.token_transfers.find(
          (t) => t.token_id === tokenIn.token_id && t.amount < 0,
        )?.account ?? null;
      refundAmount = tokenIn.amount; // base units
      refundToken = tokenIn.token_id;
    } else if (hbarIn) {
      resolvedSender =
        tx.transfers.find(
          (t) => t.amount < 0 && t.account !== agentAccountId,
        )?.account ?? null;
      refundAmount = hbarIn.amount; // tinybars
      refundToken = null; // HBAR
    } else {
      throw new Error('Could not determine sender');
    }

    if (!resolvedSender) {
      throw new Error('Could not determine sender account from transaction');
    }
    senderAccountId = resolvedSender;

    // Compute the human-readable amount once — used for the on-chain
    // submission, the audit entry, the ledger adjustment, and
    // (potentially) the dead-letter row. Keeping it in one place
    // ensures all four agree.
    let symbolForDisplay: string;
    if (refundToken) {
      const { getTokenMeta } = await import('../utils/math.js');
      const meta = await getTokenMeta(refundToken);
      humanRefundAmount = refundAmount / Math.pow(10, meta.decimals);
      symbolForDisplay = `${meta.symbol} (${refundToken})`;
    } else {
      humanRefundAmount = refundAmount / 1e8;
      symbolForDisplay = 'HBAR';
    }
    amountDisplay = `${humanRefundAmount} ${symbolForDisplay}`;

    // Submit the refund tx, then await the receipt with an explicit
    // 8s ceiling. Splitting submit from awaitReceipt is what makes
    // the receipt-uncertain regime distinguishable from
    // pre-submission failure.
    const response = refundToken
      ? await submitTokenTransfer(
          client,
          agentAccountId,
          senderAccountId,
          refundToken,
          humanRefundAmount,
        )
      : await submitHbarTransfer(
          client,
          agentAccountId,
          senderAccountId,
          humanRefundAmount,
        );
    refundTxId = response.transactionId.toString();
    await awaitReceipt(client, response);
  } catch (err) {
    if (err instanceof ReceiptUncertainError) {
      // Regime C: tx submitted, outcome unknown. KEEP claim. Persist a
      // refund_uncertain dead-letter so reconcile (or an admin tool)
      // can resolve via the mirror node without double-refunding.
      if (options?.store) {
        const memo = tx!.memo_base64
          ? Buffer.from(tx!.memo_base64, 'base64').toString('utf-8')
          : undefined;
        const entry: DeadLetterEntry = {
          // Keyed by the refund tx (the unique uncertain action). The
          // original deposit tx is preserved in `details.originalTxId`.
          transactionId: err.transactionId,
          timestamp: new Date().toISOString(),
          error: err.message,
          sender: senderAccountId!,
          ...(memo ? { memo } : {}),
          kind: 'refund_uncertain',
          details: {
            originalTxId: transactionId,
            refundTxId: err.transactionId,
            humanAmount: humanRefundAmount!,
            // L18: when refundToken is null (HBAR refund) we want
            // tokenKey to be HBAR_TOKEN_KEY and token to be omitted
            // from the row entirely. Previously the `!` assertion
            // wrote `token: null` and tokenKey worked only by
            // coincidence (the verifier didn't read `token`).
            tokenKey: refundToken ?? HBAR_TOKEN_KEY,
            ...(refundToken ? { token: refundToken } : {}),
            agentAccountId,
            performedBy: options.performedBy ?? agentAccountId,
            reason: options.reason ?? 'operator_initiated',
            // Reconcile uses claimKey to release the SET-NX-EX marker
            // when (and only when) the mirror confirms the tx FAILED.
            claimKey: redisLockKey,
          },
        };
        try {
          await options.store.upsertDeadLetter(entry);
        } catch (dlErr) {
          logger.error(
            'CRITICAL: refund_uncertain dead-letter write failed — manual reconcile required',
            {
              component: 'Refund',
              event: 'refund_uncertain_dl_write_failed',
              originalTx: transactionId,
              refundTxId: err.transactionId,
              error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            },
          );
          // H11: page the operator. The claim is retained on rethrow
          // below, the on-chain status is unknown, AND the recovery
          // anchor is missing. Without a webhook signal the held
          // claim sits invisibly until TTL expiry.
          await escalateUncertainDlFailure({
            kind: 'refund_uncertain',
            uncertainTxId: err.transactionId,
            cause: dlErr,
          });
        }
      }
      logger.error('refund receipt timed out — dead-lettered as refund_uncertain', {
        component: 'Refund',
        event: 'refund_receipt_uncertain',
        originalTx: transactionId,
        refundTxId: err.transactionId,
      });
      // Claim deliberately retained. Note: refunds are NOT wrapped in
      // `withIdempotency` (call sites in app/api/admin/refund/route.ts
      // and src/mcp/tools/operator.ts call processRefund directly), so
      // the `PreserveClaimError` mechanism in idempotency.ts does NOT
      // apply here. Retention is enforced by the in-function
      // SET-NX-EX claim on `redisLockKey` (see Regime A/B branch
      // below — that branch DELs; this branch does not). The reconcile
      // verifier (`verifyUncertainRefunds`) is solely responsible for
      // resolving the claim once the mirror confirms the on-chain
      // outcome. Rethrow so the caller surfaces the uncertainty.
      throw err;
    }
    // Regimes A + B: pre-submission OR confirmed on-chain failure.
    // Release the claim so the operator can retry once the underlying
    // issue is resolved.
    if (redisLockKey) {
      try {
        const redis = await getRedis();
        await redis.del(redisLockKey);
      } catch (delErr) {
        // The 30-day TTL is the worst-case fallback; the marker
        // expires on its own. Surface so an operator can manually
        // DEL if they need a faster retry window.
        logger.error('refund claim release failed after pre-transfer error', {
          component: 'Refund',
          event: 'refund_claim_release_failed',
          originalTx: transactionId,
          claimError: err instanceof Error ? err.message : String(err),
          releaseError: delErr instanceof Error ? delErr.message : String(delErr),
        });
      }
    }
    throw err;
  }
  // After the try block, refundTxId is guaranteed set — awaitReceipt
  // either returned cleanly (success) or threw (caught above with
  // throw). Type assertion just narrows for the rest of the function.
  const confirmedRefundTxId: string = refundTxId!;

  // ── Ledger adjustment ─────────────────────────────────────────
  // If this refund matches a user deposit, deduct from their balance
  // to prevent phantom funds (user keeps balance AND gets refund).
  let ledgerAdjusted: string | undefined;

  if (options?.store) {
    try {
      const memo = tx.memo_base64
        ? Buffer.from(tx.memo_base64, 'base64').toString('utf-8')
        : '';
      const user = memo ? options.store.getUserByMemo(memo) : undefined;

      if (user) {
        const tokenKey = refundToken ?? HBAR_TOKEN_KEY;
        // humanRefundAmount was computed in the on-chain submit block
        // above — reuse it here so the audit, ledger, and on-chain
        // amount all agree.

        // Per-user distributed lock around the ledger adjustment —
        // prevents two concurrent refunds for the same user (different
        // txIds, both legitimate) from racing on entry.available and
        // losing one of the deductions.
        //
        // If the user is mid-play/mid-withdraw and holds the lock, we
        // retry with backoff for up to ~10 seconds. If we still can't
        // acquire, the on-chain refund has already settled so we CANNOT
        // silently drop the ledger debit (that creates phantom funds —
        // the user would spend the refunded amount twice). Instead we
        // persist a pending ledger adjustment that a drain sweep
        // (called at the top of each reconcile, and on-demand by admin)
        // will apply once the user lock is free.
        let lockToken: string | null = null;
        const backoffMs = [50, 100, 200, 500, 1000, 2000, 3000];
        for (const delay of backoffMs) {
          lockToken = await acquireUserLock(user.userId, 30);
          if (lockToken) break;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        if (lockToken) {
          try {
            options.store.updateBalance(user.userId, (b) => {
              const entry = b.tokens[tokenKey];
              if (!entry) return b;
              // Deduct from available (clamp to 0)
              entry.available = Math.max(0, entry.available - humanRefundAmount);
              return b;
            });

            ledgerAdjusted = user.userId;
            logger.info('refund ledger adjusted', {
              component: 'Refund',
              event: 'refund_ledger_adjusted',
              userId: user.userId,
              amount: humanRefundAmount,
              token: tokenKey,
              originalTx: transactionId,
            });
          } finally {
            await releaseUserLock(user.userId, lockToken);
          }
        } else {
          // Lock contention never cleared — queue a pending adjustment
          // so a later drain sweep applies it. This closes the phantom
          // funds gap: refund amount cannot be silently dropped.
          try {
            const { queuePendingLedgerAdjustment } = await import(
              '../custodial/pendingLedger.js'
            );
            await queuePendingLedgerAdjustment({
              userId: user.userId,
              tokenKey,
              amount: humanRefundAmount,
              reason: 'refund',
              sourceTx: transactionId,
              createdAt: new Date().toISOString(),
            });
            logger.warn(
              'refund ledger adjustment queued — user lock contention did not clear, will apply on next drain',
              {
                component: 'Refund',
                userId: user.userId,
                originalTx: transactionId,
                amount: humanRefundAmount,
                token: tokenKey,
              },
            );
            ledgerAdjusted = user.userId; // recorded in the pending queue
          } catch (queueErr) {
            // If even the pending queue is unreachable we're in real
            // trouble — surface loudly so the operator can manually fix.
            logger.error(
              'CRITICAL: refund ledger adjustment could not be queued — PHANTOM FUNDS POSSIBLE',
              {
                component: 'Refund',
                userId: user.userId,
                originalTx: transactionId,
                amount: humanRefundAmount,
                token: tokenKey,
                error: queueErr,
              },
            );
          }
        }
      }
    } catch (e) {
      // Ledger adjustment is best-effort — the on-chain refund already succeeded.
      // Log but don't fail the refund.
      console.error('[Refund] Ledger adjustment failed (on-chain refund succeeded):', e);
    }
  }

  // ── HCS-20 v2 audit entry ────────────────────────────────────
  // Write the refund to the on-chain audit topic so external
  // auditors can pair every deposit with its inverse. Without this,
  // a refund leaves a phantom credit on the audit trail (the
  // original mint with no offsetting burn/refund), breaking
  // reconciliation math for any third party reading the topic.
  //
  // Best-effort: the on-chain refund tx already succeeded, so we
  // log on failure but don't throw — the operator can recover the
  // missing audit entry manually if needed.
  if (options?.accounting) {
    try {
      await options.accounting.recordRefund({
        amount: humanRefundAmount,
        from: agentAccountId,
        to: senderAccountId,
        originalDepositTxId: transactionId,
        refundTxId: confirmedRefundTxId,
        reason: options.reason ?? 'operator_initiated',
        performedBy: options.performedBy ?? agentAccountId,
      });
    } catch (auditErr) {
      logger.warn('refund HCS-20 audit entry failed', {
        component: 'Refund',
        event: 'refund_audit_failed',
        originalTx: transactionId,
        refundTxId: confirmedRefundTxId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  }

  // ── Overwrite the 'pending' claim with the actual refundTxId ────
  // The atomic SET-NX-EX claim earlier wrote 'pending' to the marker.
  // Now that the on-chain refund has completed and we know the
  // refundTxId, overwrite with the real value (resetting the 30-day
  // TTL) so future duplicate attempts get a useful error message.
  // Best-effort: if this overwrite fails, the 'pending' marker still
  // gives 30 days of replay protection — operationally equivalent
  // for safety, just less informative on a duplicate-attempt error.
  if (redisLockKey) {
    try {
      const redis = await getRedis();
      await redis.set(redisLockKey, confirmedRefundTxId, { ex: 30 * 24 * 60 * 60 });
    } catch (e) {
      console.warn('[Refund] Failed to overwrite refund marker with refundTxId:', e);
    }
  }

  return {
    refunded: true,
    originalTx: transactionId,
    sender: withChecksum(senderAccountId),
    amount: amountDisplay,
    refundTxId: confirmedRefundTxId,
    ledgerAdjusted,
  };
}

// ── Reconcile-time verification of refund_uncertain dead-letters ──
//
// Walks the dead-letter queue for entries with kind ===
// 'refund_uncertain' (written when awaitReceipt timed out during a
// refund). For each, queries the mirror node:
//
//   - If the mirror returns SUCCESS: the refund landed. Complete the
//     post-conditions (HCS-20 audit, ledger adjustment) and resolve
//     the dead-letter. Leave the SET-NX-EX claim in place (it now
//     correctly records the actual refundTxId) so any retry is
//     rejected as a duplicate.
//
//   - If the mirror returns a non-SUCCESS result: the refund failed
//     on chain. Release the claim so the operator can retry, and
//     resolve the dead-letter with a failure note.
//
//   - If the mirror returns 404 (not yet propagated): leave the
//     entry as-is. The next reconcile pass will re-check.
//
// Returns a per-entry summary so callers (reconcile, admin tool) can
// surface the resolution in their output.

export interface RefundVerificationOutcome {
  refundTxId: string;
  originalTxId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  /** Human-readable note suitable for an admin UI. */
  note: string;
}

/** 24h after entry.timestamp, NOT_FOUND is treated as FAILED (H7). */
const NOT_FOUND_MAX_AGE_MS_REFUND = 24 * 60 * 60 * 1000;
const VERIFY_LOCK_TTL_SEC_REFUND = 60;

export async function verifyUncertainRefunds(
  _client: Client,
  store: IStore,
  accounting?: AccountingService,
): Promise<RefundVerificationOutcome[]> {
  void _client; // reserved; mirror suffices today
  const outcomes: RefundVerificationOutcome[] = [];

  // Reload the dead-letter list so we don't act on a stale snapshot.
  await store.refreshDeadLetters().catch(() => undefined);
  const all = store.getDeadLetters();
  const open = all.filter(
    (e) => e.kind === 'refund_uncertain' && !e.resolvedAt,
  );
  if (open.length === 0) return outcomes;

  for (const entry of open) {
    const refundTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      originalTxId?: string;
      refundTxId?: string;
      humanAmount?: number;
      tokenKey?: string;
      token?: string | null;
      agentAccountId?: string;
      performedBy?: string;
      reason?: string;
      claimKey?: string | null;
      ledgerAdjustedAt?: string;
    };
    const originalTxId = details.originalTxId ?? '(unknown)';

    // C4: per-txId verifier lock to prevent two reconcile passes
    // double-mutating the same entry.
    try {
      const redis = await getRedis();
      const lockKey = `${KEY_PREFIX.verifying}refund:${refundTxId}`;
      const lockResult = await redis.set(lockKey, '1', {
        nx: true,
        ex: VERIFY_LOCK_TTL_SEC_REFUND,
      });
      if (lockResult === null) {
        outcomes.push({
          refundTxId,
          originalTxId,
          status: 'still_uncertain',
          note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
        });
        continue;
      }
    } catch (e) {
      logger.warn('refund verifier lock acquisition failed; skipping pass', {
        component: 'Refund',
        event: 'verify_lock_redis_error',
        refundTxId,
        error: e instanceof Error ? e.message : String(e),
      });
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: 'Could not acquire verifier lock; will retry next pass.',
      });
      continue;
    }

    // ── Mirror node lookup (H8: use classifier) ──────────────
    let result: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
    try {
      const url = `${getMirrorBaseUrl()}/transactions/${refundTxId}`;
      const res = await fetch(url);
      if (res.status === 404) {
        result = 'NOT_FOUND';
      } else if (!res.ok) {
        // Other errors (5xx, timeouts) — leave for next pass.
        outcomes.push({
          refundTxId,
          originalTxId,
          status: 'still_uncertain',
          note: `Mirror node returned ${res.status}; will retry next reconcile.`,
        });
        continue;
      } else {
        const body = (await res.json()) as MirrorTxResponse;
        const tx = body.transactions?.[0];
        if (!tx) {
          result = 'NOT_FOUND';
        } else {
          result = classifyMirrorResult(tx.result);
        }
      }
    } catch (e) {
      // Network error → still uncertain, retry later.
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: `Mirror lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // H7: NOT_FOUND for >24h → FAILED.
    if (result === 'NOT_FOUND') {
      const ageMs = Date.now() - new Date(entry.timestamp).getTime();
      if (ageMs > NOT_FOUND_MAX_AGE_MS_REFUND) {
        result = 'FAILED';
      }
    }

    if (result === 'NOT_FOUND') {
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    // ── Confirmed FAILED: release claim, mark resolved ───────
    if (result === 'FAILED') {
      if (details.claimKey) {
        try {
          const redis = await getRedis();
          await redis.del(details.claimKey);
        } catch (e) {
          logger.warn(
            'refund_uncertain claim release failed during verification',
            {
              component: 'Refund',
              refundTxId,
              originalTxId,
              error: e instanceof Error ? e.message : String(e),
            },
          );
        }
      }
      try {
        await store.flush();
      } catch {
        /* */
      }
      try {
        await store.upsertDeadLetter({
          ...entry,
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'reconcile',
          // No resolutionTxId — there isn't one; the refund failed.
        });
      } catch (e) {
        logger.warn('refund_uncertain dead-letter resolve write failed', {
          component: 'Refund',
          refundTxId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'failed',
        note: 'On-chain refund failed (or not on mirror after 24h); claim released, retry permitted.',
      });
      continue;
    }

    // ── Confirmed SUCCESS: complete bookkeeping + mark resolved ──
    // Best-effort: each post-condition is wrapped so a partial
    // failure (audit, ledger) doesn't block resolution. The claim
    // marker is already in place (kept by the original refund call)
    // so re-attempts are still rejected as duplicates.

    // M15: skip ledger adjustment if a previous verification pass
    // already applied it. Re-running verifiers (idempotency-by-id)
    // must NOT re-debit the user's `available`.
    const ledgerAdjusted = typeof details.ledgerAdjustedAt === 'string';
    let didAdjustLedger = false;

    // Ledger adjustment (if user matches a memo and not already adjusted)
    if (entry.memo && !ledgerAdjusted) {
      try {
        const user = store.getUserByMemo(entry.memo);
        if (user && details.tokenKey && typeof details.humanAmount === 'number') {
          const tokenKey = details.tokenKey;
          const humanAmount = details.humanAmount;
          let lockToken: string | null = null;
          const backoffMs = [50, 100, 200, 500, 1000];
          for (const delay of backoffMs) {
            lockToken = await acquireUserLock(user.userId, 30);
            if (lockToken) break;
            await new Promise((r) => setTimeout(r, delay));
          }
          if (lockToken) {
            try {
              store.updateBalance(user.userId, (b) => {
                const tokEntry = b.tokens[tokenKey];
                if (!tokEntry) return b;
                tokEntry.available = Math.max(
                  0,
                  tokEntry.available - humanAmount,
                );
                return b;
              });
              didAdjustLedger = true;
            } finally {
              await releaseUserLock(user.userId, lockToken);
            }
          } else {
            // Queue a pending adjustment if locked — same fallback
            // as the in-flight refund path.
            const { queuePendingLedgerAdjustment } = await import(
              '../custodial/pendingLedger.js'
            );
            await queuePendingLedgerAdjustment({
              userId: user.userId,
              tokenKey,
              amount: humanAmount,
              reason: 'refund',
              sourceTx: originalTxId,
              createdAt: new Date().toISOString(),
            });
            didAdjustLedger = true;
          }
        }
      } catch (e) {
        logger.warn(
          'refund_uncertain verification: ledger adjustment failed',
          {
            component: 'Refund',
            refundTxId,
            error: e instanceof Error ? e.message : String(e),
          },
        );
      }
    }

    // HCS-20 audit entry (if accounting available and details intact).
    // R-HIGH-1: idempotency-marked via `auditWrittenAt`. A Lambda
    // crash AFTER recordRefund returns but BEFORE the resolve write
    // would otherwise let the next pass emit a SECOND HCS-20 burn op
    // for the same refund (`recordRefund` has no body-level
    // idempotency).
    const auditAlreadyWritten =
      typeof (details as { auditWrittenAt?: string }).auditWrittenAt === 'string';
    let didWriteAudit = false;
    if (
      accounting &&
      details.agentAccountId &&
      entry.sender &&
      typeof details.humanAmount === 'number' &&
      details.originalTxId &&
      !auditAlreadyWritten
    ) {
      try {
        await accounting.recordRefund({
          amount: details.humanAmount,
          from: details.agentAccountId,
          to: entry.sender,
          originalDepositTxId: details.originalTxId,
          refundTxId,
          reason: details.reason ?? 'operator_initiated',
          performedBy: details.performedBy ?? details.agentAccountId,
        });
        didWriteAudit = true;
      } catch (e) {
        logger.warn('refund_uncertain verification: audit write failed', {
          component: 'Refund',
          refundTxId,
          error: e instanceof Error ? e.message : String(e),
        });
        // M16: audit failure → audit_trail_orphaned dead-letter so
        // the operator surfaces the missing on-chain anchor. Synthetic
        // id so the orphan coexists with the resolved refund_uncertain
        // entry (which has the same refundTxId as transactionId).
        try {
          await store.upsertDeadLetter({
            transactionId: `audit-orphan:${refundTxId}`,
            timestamp: new Date().toISOString(),
            error: `refund verifier audit write failed: ${e instanceof Error ? e.message : String(e)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'refund_uncertain',
              sourceTxId: refundTxId,
              originalTxId: details.originalTxId,
              humanAmount: details.humanAmount,
            },
          });
        } catch {
          /* logged above */
        }
      }
    }

    // Overwrite the 'pending' claim marker with the real refundTxId
    // for nicer error messages on duplicate-attempt rejection.
    if (details.claimKey) {
      try {
        const redis = await getRedis();
        await redis.set(details.claimKey, refundTxId, {
          ex: 30 * 24 * 60 * 60,
        });
      } catch {
        // The 'pending' marker still gives 30-day replay protection;
        // a less-informative duplicate error is acceptable.
      }
    }

    // H10: flush before resolve so verifier mutations survive a
    // Lambda freeze between settlement and the resolve marker.
    try {
      await store.flush();
    } catch {
      /* */
    }

    try {
      await store.upsertDeadLetter({
        ...entry,
        // M15: stamp ledgerAdjustedAt so a re-run won't double-debit.
        // R-HIGH-1: same treatment for auditWrittenAt — guards
        // duplicate HCS-20 burn op on Lambda-crash + retry.
        details: {
          ...(entry.details ?? {}),
          ...(didAdjustLedger || ledgerAdjusted
            ? {
                ledgerAdjustedAt:
                  details.ledgerAdjustedAt ?? new Date().toISOString(),
              }
            : {}),
          ...(didWriteAudit || auditAlreadyWritten
            ? {
                auditWrittenAt:
                  (details as { auditWrittenAt?: string }).auditWrittenAt ??
                  new Date().toISOString(),
              }
            : {}),
        },
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'reconcile',
        resolutionTxId: refundTxId,
      });
    } catch (e) {
      logger.warn('refund_uncertain dead-letter resolve write failed', {
        component: 'Refund',
        refundTxId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    outcomes.push({
      refundTxId,
      originalTxId,
      status: 'confirmed',
      note: 'On-chain refund confirmed; bookkeeping completed.',
    });
  }

  return outcomes;
}
