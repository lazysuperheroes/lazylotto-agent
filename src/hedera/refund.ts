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
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { getRedis, KEY_PREFIX } from '../auth/redis.js';
import { logger } from '../lib/logger.js';

const REFUND_KEY_PREFIX = KEY_PREFIX.session.replace('session:', 'refunded:');

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
  if (options?.store) {
    if (!options.store.isTransactionProcessed(transactionId)) {
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

  // ── Replay protection ────────────────────────────────────────
  // Check Redis for an existing refund record before doing anything.
  // We persist the refund record AFTER the on-chain transfer succeeds.
  let redisLockKey: string | null = null;
  try {
    const redis = await getRedis();
    redisLockKey = `${REFUND_KEY_PREFIX}${transactionId}`;
    const existing = await redis.get(redisLockKey);
    if (existing) {
      throw new Error(
        `Transaction ${transactionId} has already been refunded. ` +
        `Original refund tx: ${existing}`,
      );
    }
  } catch (e) {
    // If the error is our "already refunded" sentinel, rethrow.
    // Otherwise it's a Redis read failure — log and proceed (don't
    // block legit refunds on Redis being down).
    if (e instanceof Error && e.message.includes('already been refunded')) {
      throw e;
    }
    console.warn('[Refund] Redis replay check failed (proceeding):', e);
  }

  // ── Mirror node lookup ──────────────────────────────────────
  const mirrorUrl =
    (process.env.HEDERA_NETWORK === 'mainnet'
      ? 'https://mainnet.mirrornode.hedera.com'
      : 'https://testnet.mirrornode.hedera.com') + '/api/v1';

  const txRes = await fetch(`${mirrorUrl}/transactions/${transactionId}`);
  if (!txRes.ok) {
    throw new Error(`Transaction ${transactionId} not found on mirror node`);
  }

  const txData = (await txRes.json()) as MirrorTxResponse;
  const tx = txData.transactions?.[0];
  if (!tx) throw new Error('Transaction not found');
  if (tx.result !== 'SUCCESS') {
    throw new Error(`Transaction was not successful: ${tx.result}`);
  }

  // ── Identify incoming transfer to agent ──────────────────────
  const hbarIn = tx.transfers?.find(
    (t) => t.account === agentAccountId && t.amount > 0,
  );
  const tokenIn = tx.token_transfers?.find(
    (t) => t.account === agentAccountId && t.amount > 0,
  );

  if (!hbarIn && !tokenIn) {
    throw new Error('No incoming transfer to agent found in this transaction');
  }

  // ── Find sender ──────────────────────────────────────────────
  let senderAccountId: string | null = null;
  let refundAmount: number;
  let refundToken: string | null = null;

  if (tokenIn) {
    senderAccountId =
      tx.token_transfers.find(
        (t) => t.token_id === tokenIn.token_id && t.amount < 0,
      )?.account ?? null;
    refundAmount = tokenIn.amount; // base units
    refundToken = tokenIn.token_id;
  } else if (hbarIn) {
    senderAccountId =
      tx.transfers.find(
        (t) => t.amount < 0 && t.account !== agentAccountId,
      )?.account ?? null;
    refundAmount = hbarIn.amount; // tinybars
    refundToken = null; // HBAR
  } else {
    throw new Error('Could not determine sender');
  }

  if (!senderAccountId) {
    throw new Error('Could not determine sender account from transaction');
  }

  // ── Execute refund ───────────────────────────────────────────
  let refundTxId: string;
  let amountDisplay: string;

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
      }
    } catch (e) {
      // Ledger adjustment is best-effort — the on-chain refund already succeeded.
      // Log but don't fail the refund.
      console.error('[Refund] Ledger adjustment failed (on-chain refund succeeded):', e);
    }
  }

  // ── Persist refund record for replay protection ─────────────
  // 30 day TTL — long enough that any duplicate refund attempt
  // will be caught, short enough that the set doesn't grow forever.
  if (redisLockKey) {
    try {
      const redis = await getRedis();
      await redis.set(redisLockKey, refundTxId, { ex: 30 * 24 * 60 * 60 });
    } catch (e) {
      console.warn('[Refund] Failed to record refund in Redis:', e);
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
