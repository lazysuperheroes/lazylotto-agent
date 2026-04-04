/**
 * Shared refund logic: look up a Hedera transaction on the mirror node,
 * identify the sender and amount, then transfer the funds back.
 *
 * Used by both the `operator_refund` MCP tool and the
 * POST /api/admin/refund API route.
 */

import type { Client } from '@hashgraph/sdk';
import { transferHbar, transferToken } from './transfers.js';
import { getOperatorAccountId } from './wallet.js';
import { withChecksum } from '../utils/checksum.js';
import type { IStore } from '../custodial/IStore.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';

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
        console.log(
          `[Refund] Ledger adjusted: deducted ${humanRefundAmount} ${tokenKey} from user ${user.userId}`,
        );
      }
    } catch (e) {
      // Ledger adjustment is best-effort — the on-chain refund already succeeded.
      // Log but don't fail the refund.
      console.error('[Refund] Ledger adjustment failed (on-chain refund succeeded):', e);
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
