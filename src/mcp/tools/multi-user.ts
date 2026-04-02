/**
 * Multi-user custodial MCP tools.
 *
 * Registers: multi_user_status, multi_user_register,
 * multi_user_deposit_info, multi_user_play, multi_user_withdraw,
 * multi_user_deregister, multi_user_play_history
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { MultiUserAgent } from '../../custodial/MultiUserAgent.js';
import { getOperatorAccountId } from '../../hedera/wallet.js';
import { withChecksum } from '../../utils/checksum.js';
import type { ServerContext } from './types.js';

// ── Registration ────────────────────────────────────────────────

export function registerMultiUserTools(
  server: McpServer,
  multiUser: MultiUserAgent,
  ctx: ServerContext
): void {
  const { client, json, errorResult, errorMsg, requireAuth } = ctx;

  server.tool(
    'multi_user_status',
    'List all registered users with balances and last activity.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const users = multiUser.getAllUsersStatus();
        return json({
          totalUsers: users.length,
          activeUsers: users.filter((u) => u.active).length,
          users: users.map((u) => ({
            userId: u.userId,
            hederaAccountId: withChecksum(u.hederaAccountId),
            eoaAddress: u.eoaAddress.startsWith('0x') ? u.eoaAddress : withChecksum(u.eoaAddress),
            strategy: u.strategyName,
            rakePercent: u.rakePercent,
            balances: u.balances,
            active: u.active,
            lastPlayedAt: u.lastPlayedAt,
          })),
        });
      } catch (e) {
        return errorResult(`Status failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'multi_user_register',
    'Register a new user. Returns their unique deposit memo for funding. ' +
      'Only eoaAddress is required (for prize delivery). accountId defaults to the agent wallet ' +
      'for deposit/withdrawal routing.',
    {
      eoaAddress: z.string().describe('User EOA for prize delivery (0.0.XXXXX or 0x...)'),
      accountId: z.string().optional()
        .describe('User Hedera account ID for deposits/withdrawals (defaults to agent wallet)'),
      strategy: z.enum(['conservative', 'balanced', 'aggressive']).default('balanced')
        .describe('Strategy name'),
      rakePercent: z.number().optional()
        .describe('Optional negotiated rake (must be within configured band)'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ eoaAddress, accountId, strategy: strat, rakePercent, auth_token }) => {
      const authErr = requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const resolvedAccountId = accountId ?? getOperatorAccountId(client);
        const user = await multiUser.registerUser(resolvedAccountId, eoaAddress, strat, rakePercent);
        const agentWallet = getOperatorAccountId(client);
        const agentWalletChecksummed = withChecksum(agentWallet);
        return json({
          status: 'registered',
          userId: user.userId,
          strategy: user.strategyName,
          rakePercent: user.rakePercent,
          deposit: {
            sendTo: agentWalletChecksummed,
            memo: user.depositMemo,
            acceptedTokens: ['HBAR', 'LAZY'],
          },
          instructions: [
            `User registered successfully with ${user.rakePercent}% rake fee.`,
            `To fund the account, send HBAR or LAZY to ${agentWalletChecksummed} with memo: ${user.depositMemo}`,
            'The deposit watcher will detect the transfer within ~15 seconds.',
            'Once funded, use multi_user_play to start a lottery session.',
          ],
        });
      } catch (e) {
        return errorResult(`Registration failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'multi_user_deposit_info',
    'Get deposit memo and funding instructions for an existing user.',
    {
      userId: z.string().describe('User ID'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, auth_token }) => {
      const authErr = requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const user = multiUser.getUserStatus(userId);
        if (!user) return errorResult('User not found');
        const agentWalletChecksummed = withChecksum(getOperatorAccountId(client));
        return json({
          deposit: {
            sendTo: agentWalletChecksummed,
            memo: user.depositMemo,
          },
          balances: user.balances,
          instructions:
            `Send HBAR or LAZY to ${agentWalletChecksummed} ` +
            `with memo: ${user.depositMemo}`,
        });
      } catch (e) {
        return errorResult(`Failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'multi_user_play',
    'Trigger a play session for a specific user or all eligible users.',
    {
      userId: z.string().optional().describe('Specific user ID, or omit for all eligible'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, auth_token }) => {
      const authErr = requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        if (userId) {
          const result = await multiUser.playForUser(userId);
          return json({ sessions: [result] });
        } else {
          const results = await multiUser.playForAllEligible();
          return json({ sessions: results });
        }
      } catch (e) {
        return errorResult(`Play failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'multi_user_withdraw',
    'Process a withdrawal for a user. Sends funds to their Hedera account.',
    {
      userId: z.string().describe('User ID'),
      amount: z.number().positive().describe('Amount to withdraw'),
      token: z.string().default('hbar').describe('Token to withdraw: "hbar" or token ID'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, amount, token, auth_token }) => {
      const authErr = requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const record = await multiUser.processWithdrawal(userId, amount, token);
        return json(record);
      } catch (e) {
        return errorResult(`Withdrawal failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'multi_user_deregister',
    'Deactivate a user account. User can only withdraw remaining balance after this.',
    {
      userId: z.string().describe('User ID'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, auth_token }) => {
      const authErr = requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        multiUser.deregisterUser(userId);
        const user = multiUser.getUserStatus(userId);
        return json({
          deregistered: true,
          userId,
          remainingBalance: user?.balances.tokens ?? {},
          message: 'User deactivated. They can still withdraw remaining funds.',
        });
      } catch (e) {
        return errorResult(`Deregistration failed: ${errorMsg(e)}`);
      }
    }
  );

  server.tool(
    'multi_user_play_history',
    'View play session history for a user.',
    {
      userId: z.string().describe('User ID'),
      limit: z.number().int().positive().default(20).describe('Max sessions to return'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, limit, auth_token }) => {
      const authErr = requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const sessions = multiUser.getPlayHistory(userId);
        return json({ userId, sessions: sessions.slice(-limit) });
      } catch (e) {
        return errorResult(`History failed: ${errorMsg(e)}`);
      }
    }
  );
}
