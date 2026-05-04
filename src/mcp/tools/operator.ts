/**
 * Operator (platform admin) MCP tools.
 *
 * Registers: operator_balance, operator_withdraw_fees, operator_reconcile,
 * operator_health, operator_dead_letters, operator_refund,
 * operator_recover_stuck_prizes
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { MultiUserAgent } from '../../custodial/MultiUserAgent.js';
import { withChecksum } from '../../utils/checksum.js';
import {
  acquireUserLock,
  releaseUserLock,
  acquireOperatorLock,
  releaseOperatorLock,
} from '../../lib/locks.js';
import type { ServerContext, AuthResult } from './types.js';

// ── Registration ────────────────────────────────────────────────

export function registerOperatorTools(
  server: McpServer,
  multiUser: MultiUserAgent,
  ctx: ServerContext
): void {
  const { json, errorResult, errorMsg, requireAuth } = ctx;

  /** Require admin or operator tier. Returns error ToolResult if denied, null if allowed. */
  function requireOperator(authResult: AuthResult) {
    if ('error' in authResult) return authResult.error;
    if (authResult.auth.tier === 'user') return errorResult('Access denied');
    return null;
  }

  server.tool(
    'operator_balance',
    'View operator platform balance: rake collected, gas spent, net profit.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authResult = await requireAuth(auth_token);
      const denied = requireOperator(authResult);
      if (denied) return denied;
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
      const authResult = await requireAuth(auth_token);
      const denied = requireOperator(authResult);
      if (denied) return denied;
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
      const authResult = await requireAuth(auth_token);
      const denied = requireOperator(authResult);
      if (denied) return denied;

      // Operator-level lock: reconcile walks the entire user list and
      // can take >60s on a populated store. Two concurrent reconciles
      // (cron + admin click, or two admin clicks) walking the same
      // state could write conflicting outputs. 5 min TTL is enough
      // for the walk + mirror-node calls; lock auto-releases if the
      // Lambda dies mid-flight.
      const lockToken = await acquireOperatorLock('reconcile', 300);
      if (!lockToken) {
        return errorResult(
          'Reconcile already in progress. Try again in a few minutes.',
        );
      }
      try {
        const result = await multiUser.reconcile();
        return json(result);
      } catch (e) {
        return errorResult(`Reconciliation failed: ${errorMsg(e)}`);
      } finally {
        await releaseOperatorLock('reconcile', lockToken);
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
      const authResult = await requireAuth(auth_token);
      const denied = requireOperator(authResult);
      if (denied) return denied;
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
      const authResult = await requireAuth(auth_token);
      const denied = requireOperator(authResult);
      if (denied) return denied;
      const performedBy =
        'auth' in authResult ? authResult.auth.accountId : 'unknown';
      try {
        const { processRefund } = await import('../../hedera/refund.js');
        // Pass store for ledger adjustment + accounting for HCS-20
        // v2 audit entry. Without accounting, refunds happen on
        // chain but never appear in the audit trail, leaving
        // deposits as unpaired credits.
        const store = multiUser.getStoreInstance();
        const accounting = multiUser.getAccountingService();
        const result = await processRefund(ctx.client, transactionId, {
          store,
          ...(accounting ? { accounting } : {}),
          reason: 'operator_initiated',
          performedBy,
        });
        return json(result);
      } catch (e) {
        return errorResult(`Refund failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'operator_recover_stuck_prizes',
    'Recover prizes that got stranded in the agent wallet because the in-flight ' +
      'transferPendingPrizes call failed (typically INSUFFICIENT_GAS). Calls the ' +
      'contract with the same retry-with-escalating-gas ladder used by the play path, ' +
      'records the recovery on the HCS-20 audit topic, and marks any matching ' +
      'prize_transfer_failed dead-letter entries as resolved. Default mode is dry-run; ' +
      'pass execute=true to perform the transfer.',
    {
      userId: z.string().describe('Internal user ID whose stuck prizes should be recovered'),
      execute: z.boolean().default(false).describe('Set true to actually perform the transfer (default false = dry-run)'),
      reason: z.string().default('manual recovery via operator_recover_stuck_prizes').describe('Free-text reason recorded in the HCS-20 audit entry'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, execute, reason, auth_token }) => {
      const authResult = await requireAuth(auth_token);
      const denied = requireOperator(authResult);
      if (denied) return denied;
      // Identify the operator for the audit log entry. After requireOperator
      // passes, authResult is guaranteed to have an `auth` field.
      const performedBy =
        'auth' in authResult ? authResult.auth.accountId : 'unknown';

      // Acquire the per-user distributed lock for the duration of the
      // recovery so two operators (or the same operator from two tabs)
      // hitting different Lambdas can't both attempt recovery and both
      // write resolved-dead-letter rows. Same lock primitive that
      // serialises play and withdraw — recovery is now consistent with
      // every other write path that mutates a single user's ledger.
      // 5 min TTL: the contract call + retry ladder + audit write fits
      // comfortably; lock auto-releases if the Lambda dies mid-flight.
      const lockToken = execute ? await acquireUserLock(userId, 300) : null;
      if (execute && !lockToken) {
        return errorResult(
          'Operation in progress for this user. Try again shortly.',
        );
      }

      try {
        const result = await multiUser.recoverStuckPrizesForUser(userId, {
          dryRun: !execute,
          reason,
          performedBy,
        });
        return json(result);
      } catch (e) {
        return errorResult(`Recovery failed: ${errorMsg(e)}`);
      } finally {
        if (lockToken) await releaseUserLock(userId, lockToken);
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
      const authResult = await requireAuth(auth_token);
      const denied = requireOperator(authResult);
      if (denied) return denied;
      try {
        return json(multiUser.getHealth());
      } catch (e) {
        return errorResult(`Health check failed: ${errorMsg(e)}`);
      }
    }
  );
}
