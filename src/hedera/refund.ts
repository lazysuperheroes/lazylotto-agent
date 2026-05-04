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
import { transferHbar, transferToken } from './transfers.js';
import { getOperatorAccountId } from './wallet.js';
import { withChecksum } from '../utils/checksum.js';
import type { IStore } from '../custodial/IStore.js';
import type { AccountingService } from '../custodial/AccountingService.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { logger } from '../lib/logger.js';
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

  // ── Mirror lookup + on-chain transfer (rollback claim on failure) ──
  //
  // Anything that throws between here and the success of the
  // on-chain transfer leaves the 'pending' marker in place. Without
  // explicit rollback, the marker would TTL-expire after 30 days,
  // permanently blocking retries for that txId. We DEL the marker on
  // throw so a retry can claim again immediately. Once the transfer
  // succeeds (refundTxId is set), we're committed and no rollback
  // happens — any subsequent failure (audit write, ledger adjustment,
  // marker overwrite) is a recoverable post-condition handled by the
  // ledger / audit / overwrite blocks' own try/catch.
  let refundTxId: string;
  let amountDisplay: string;
  let senderAccountId: string;
  let refundToken: string | null;
  let refundAmount: number;
  let tx: MirrorTxResponse['transactions'][number];
  try {
    const mirrorUrl =
      (process.env.HEDERA_NETWORK === 'mainnet'
        ? 'https://mainnet.mirrornode.hedera.com'
        : 'https://testnet.mirrornode.hedera.com') + '/api/v1';

    const txRes = await fetch(`${mirrorUrl}/transactions/${transactionId}`);
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

    // Execute refund (the irreversible step)
    if (refundToken) {
      // Token refund (amount is in base units, transferToken expects human-readable)
      const { getTokenMeta } = await import('../utils/math.js');
      const meta = await getTokenMeta(refundToken);
      const humanAmount = refundAmount / Math.pow(10, meta.decimals);
      const result = await transferToken(
        client,
        agentAccountId,
        senderAccountId,
        refundToken,
        humanAmount,
      );
      refundTxId = result.transactionId;
      amountDisplay = `${humanAmount} ${meta.symbol} (${refundToken})`;
    } else {
      // HBAR refund (amount is in tinybars, transferHbar expects HBAR)
      const hbarAmount = refundAmount / 1e8;
      const result = await transferHbar(
        client,
        agentAccountId,
        senderAccountId,
        hbarAmount,
      );
      refundTxId = result.transactionId;
      amountDisplay = `${hbarAmount} HBAR`;
    }
  } catch (err) {
    // Pre-transfer failure (mirror lookup, sender resolution, chain
    // rejection). Release the claim so the operator can retry once
    // the underlying issue is resolved.
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
        // Convert base units to human-readable for the deduction
        let humanRefundAmount: number;
        if (refundToken) {
          const { getTokenMeta } = await import('../utils/math.js');
          const meta = await getTokenMeta(refundToken);
          humanRefundAmount = refundAmount / Math.pow(10, meta.decimals);
        } else {
          humanRefundAmount = refundAmount / 1e8;
        }

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
      // Compute the human-readable amount that matches what the
      // user actually saw. Token decimals already applied above
      // for the refund tx itself, so re-derive here.
      let humanAmount: number;
      if (refundToken) {
        const { getTokenMeta } = await import('../utils/math.js');
        const meta = await getTokenMeta(refundToken);
        humanAmount = refundAmount / Math.pow(10, meta.decimals);
      } else {
        humanAmount = refundAmount / 1e8;
      }
      await options.accounting.recordRefund({
        amount: humanAmount,
        from: agentAccountId,
        to: senderAccountId,
        originalDepositTxId: transactionId,
        refundTxId,
        reason: options.reason ?? 'operator_initiated',
        performedBy: options.performedBy ?? agentAccountId,
      });
    } catch (auditErr) {
      logger.warn('refund HCS-20 audit entry failed', {
        component: 'Refund',
        event: 'refund_audit_failed',
        originalTx: transactionId,
        refundTxId,
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
      await redis.set(redisLockKey, refundTxId, { ex: 30 * 24 * 60 * 60 });
    } catch (e) {
      console.warn('[Refund] Failed to overwrite refund marker with refundTxId:', e);
    }
  }

  return {
    refunded: true,
    originalTx: transactionId,
    sender: withChecksum(senderAccountId),
    amount: amountDisplay,
    refundTxId,
    ledgerAdjusted,
  };
}
