/**
 * Operator (platform admin) MCP tools.
 *
 * Registers: operator_balance, operator_withdraw_fees, operator_reconcile,
 * operator_health, operator_dead_letters, operator_refund
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { MultiUserAgent } from '../../custodial/MultiUserAgent.js';
import { withChecksum } from '../../utils/checksum.js';
import type { ServerContext } from './types.js';

// ── Registration ────────────────────────────────────────────────

export function registerOperatorTools(
  server: McpServer,
  multiUser: MultiUserAgent,
  ctx: ServerContext
): void {
  const { json, errorResult, errorMsg, requireAuth } = ctx;

  server.tool(
    'operator_balance',
    'View operator platform balance: rake collected, gas spent, net profit.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const op = multiUser.getOperatorBalance();
        const netProfit: Record<string, number> = {};
        for (const [t, raked] of Object.entries(op.totalRakeCollected)) {
          const withdrawn = op.totalWithdrawnByOperator[t] ?? 0;
          netProfit[t] = raked - withdrawn;
        }
        // Subtract gas from HBAR net
        netProfit['hbar'] = (netProfit['hbar'] ?? 0) - op.totalGasSpent;
        return json({ ...op, netProfit });
      } catch (e) {
        return errorResult(`Failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'operator_withdraw_fees',
    'Withdraw accumulated rake fees from the operator platform balance.',
    {
      amount: z.number().positive().describe('Amount to withdraw'),
      to: z.string().describe('Recipient Hedera account ID'),
      token: z.enum(['HBAR', 'LAZY']).default('HBAR').describe('Token to withdraw'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ amount, to, token, auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const txId = await multiUser.operatorWithdrawFees(amount, to, token);
        const op = multiUser.getOperatorBalance();
        return json({
          withdrawn: amount,
          to,
          transactionId: txId,
          remainingBalances: op.balances,
        });
      } catch (e) {
        return errorResult(`Withdrawal failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'operator_reconcile',
    'Compare on-chain wallet balances against internal ledger. Reports per-token deltas and solvency status.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const result = await multiUser.reconcile();
        return json(result);
      } catch (e) {
        return errorResult(`Reconciliation failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── Admin tools (dead letters, refunds) ─────────────────────

  server.tool(
    'operator_dead_letters',
    'View the dead-letter queue: deposits that could not be processed (unknown token, unknown memo, inactive user). ' +
      'Each entry includes the transaction ID, timestamp, and error reason.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const deadLetters = multiUser.getHealth(); // health includes error count
        // Access store directly for dead letters
        const store = (multiUser as unknown as { store: { getDeadLetters(): unknown[] } }).store;
        const entries = store?.getDeadLetters?.() ?? [];
        return json({
          count: (entries as unknown[]).length,
          entries: (entries as { transactionId: string; timestamp: string; error: string }[]).map(e => ({
            transactionId: e.transactionId,
            timestamp: e.timestamp,
            error: e.error,
          })),
        });
      } catch (e) {
        return errorResult(`Failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'operator_refund',
    'Refund a specific transaction back to the sender. Looks up the transaction on the mirror node ' +
      'to find the sender account, then transfers the amount back.',
    {
      transactionId: z.string().describe('The Hedera transaction ID to refund (e.g., 0.0.1234-1234567890-123456789)'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ transactionId, auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        // Look up the transaction on mirror node
        const { getTransactionsByAccount } = await import('../../hedera/mirror.js');
        const { transferHbar, transferToken } = await import('../../hedera/transfers.js');
        const { getOperatorAccountId } = await import('../../hedera/wallet.js');

        const agentAccountId = getOperatorAccountId(ctx.client);

        // Fetch the specific transaction from mirror node
        const mirrorUrl = (process.env.HEDERA_NETWORK === 'mainnet'
          ? 'https://mainnet.mirrornode.hedera.com'
          : 'https://testnet.mirrornode.hedera.com') + '/api/v1';

        const txRes = await fetch(`${mirrorUrl}/transactions/${transactionId}`);
        if (!txRes.ok) {
          return errorResult(`Transaction ${transactionId} not found on mirror node`);
        }
        const txData = (await txRes.json()) as { transactions: Array<{
          transfers: Array<{ account: string; amount: number }>;
          token_transfers: Array<{ token_id: string; account: string; amount: number }>;
          result: string;
        }> };

        const tx = txData.transactions?.[0];
        if (!tx) return errorResult('Transaction not found');
        if (tx.result !== 'SUCCESS') return errorResult(`Transaction was not successful: ${tx.result}`);

        // Find the sender (who sent TO the agent)
        const hbarIn = tx.transfers?.find(t => t.account === agentAccountId && t.amount > 0);
        const tokenIn = tx.token_transfers?.find(t => t.account === agentAccountId && t.amount > 0);

        if (!hbarIn && !tokenIn) {
          return errorResult('No incoming transfer to agent found in this transaction');
        }

        // Find who sent it (the account with the negative amount)
        let senderAccountId: string | null = null;
        let refundAmount: number;
        let refundToken: string | null = null;

        if (tokenIn) {
          senderAccountId = tx.token_transfers.find(t => t.token_id === tokenIn.token_id && t.amount < 0)?.account ?? null;
          refundAmount = tokenIn.amount; // base units
          refundToken = tokenIn.token_id;
        } else if (hbarIn) {
          senderAccountId = tx.transfers.find(t => t.amount < 0 && t.account !== agentAccountId)?.account ?? null;
          refundAmount = hbarIn.amount; // tinybars
          refundToken = null; // HBAR
        } else {
          return errorResult('Could not determine sender');
        }

        if (!senderAccountId) {
          return errorResult('Could not determine sender account from transaction');
        }

        // Execute the refund
        let refundTxId: string;
        if (refundToken) {
          // Token refund (amount is in base units, transferToken expects human-readable)
          const { getTokenMeta } = await import('../../utils/math.js');
          const meta = await getTokenMeta(refundToken);
          const humanAmount = refundAmount / Math.pow(10, meta.decimals);
          const result = await transferToken(ctx.client, agentAccountId, senderAccountId, refundToken, humanAmount);
          refundTxId = result.transactionId;
        } else {
          // HBAR refund (amount is in tinybars, transferHbar expects HBAR)
          const hbarAmount = refundAmount / 1e8;
          const result = await transferHbar(ctx.client, agentAccountId, senderAccountId, hbarAmount);
          refundTxId = result.transactionId;
        }

        return json({
          refunded: true,
          originalTx: transactionId,
          sender: withChecksum(senderAccountId),
          amount: refundToken
            ? `${refundAmount} base units of ${refundToken}`
            : `${refundAmount / 1e8} HBAR`,
          refundTxId,
        });
      } catch (e) {
        return errorResult(`Refund failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── Infrastructure tools ───────────────────────────────────

  server.tool(
    'operator_health',
    'Health check: uptime, deposit watcher status, error count, active users, pending reserves.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        return json(multiUser.getHealth());
      } catch (e) {
        return errorResult(`Health check failed: ${errorMsg(e)}`);
      }
    }
  );
}
