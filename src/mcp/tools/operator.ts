/**
 * Operator (platform admin) MCP tools.
 *
 * Registers: operator_balance, operator_withdraw_fees, operator_health
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { MultiUserAgent } from '../../custodial/MultiUserAgent.js';
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
    {},
    async () => {
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
      const authErr = requireAuth(auth_token);
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
    'operator_health',
    'Health check: uptime, deposit watcher status, error count, active users, pending reserves.',
    {},
    async () => {
      try {
        return json(multiUser.getHealth());
      } catch (e) {
        return errorResult(`Health check failed: ${errorMsg(e)}`);
      }
    }
  );
}
