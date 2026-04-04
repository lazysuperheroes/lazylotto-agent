/**
 * Multi-user custodial MCP tools.
 *
 * Registers: multi_user_status, multi_user_register,
 * multi_user_deposit_info, multi_user_play, multi_user_withdraw,
 * multi_user_deregister, multi_user_play_history
 *
 * Per-user auth enforcement:
 *   - user tier: can only operate on their own account (resolved from session accountId)
 *   - admin/operator tier: can operate on any user
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
  const { client, json, errorResult, errorMsg, requireAuth, resolveUserId, checkDeposits,
    acquireUserLock, releaseUserLock } = ctx;

  // ── multi_user_status (admin/operator only) ──────────────────

  server.tool(
    'multi_user_status',
    'List all registered users with balances and last activity.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authResult = await requireAuth(auth_token);
      if ('error' in authResult) return authResult.error;
      const { auth } = authResult;

      // User tier cannot view all users
      if (auth.tier === 'user') {
        return errorResult('Access denied');
      }

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

  // ── multi_user_register ──────────────────────────────────────

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
      const authResult = await requireAuth(auth_token);
      if ('error' in authResult) return authResult.error;
      const { auth } = authResult;

      try {
        // For user tier, auto-fill accountId from their session
        const resolvedAccountId = auth.tier === 'user'
          ? auth.accountId
          : (accountId ?? getOperatorAccountId(client));

        // Check if this account is already registered
        const existing = resolveUserId(resolvedAccountId);
        if (existing) {
          const existingUser = multiUser.getUserStatus(existing);
          const agentWalletChecksummed = withChecksum(getOperatorAccountId(client));
          return json({
            status: 'already_registered',
            userId: existing,
            strategy: existingUser?.strategyName ?? 'unknown',
            rakePercent: existingUser?.rakePercent ?? 0,
            deposit: {
              sendTo: agentWalletChecksummed,
              memo: existingUser?.depositMemo ?? '',
              acceptedTokens: ['HBAR', 'LAZY'],
            },
            message: `This account is already registered as ${existing}. ` +
              `Use your existing deposit memo to fund your account.`,
          });
        }

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

  // ── multi_user_deposit_info ──────────────────────────────────

  server.tool(
    'multi_user_deposit_info',
    'Get deposit memo and funding instructions for an existing user.',
    {
      userId: z.string().optional().describe('User ID (auto-resolved for user tier)'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, auth_token }) => {
      const authResult = await requireAuth(auth_token);
      if ('error' in authResult) return authResult.error;
      const { auth } = authResult;

      // Enforce per-user access
      if (auth.tier === 'user') {
        const myUserId = resolveUserId(auth.accountId);
        if (!myUserId) return errorResult('Not registered. Call multi_user_register first.');
        if (userId && userId !== myUserId) return errorResult('Access denied');
        userId = myUserId;
      }
      if (!userId) return errorResult('userId is required');

      try {
        // Check for new deposits before returning balance
        await checkDeposits();

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

  // ── multi_user_play ──────────────────────────────────────────

  server.tool(
    'multi_user_play',
    'Trigger a play session for a specific user. The user must have sufficient balance.',
    {
      userId: z.string().optional().describe('User ID (auto-resolved for user tier)'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, auth_token }) => {
      const authResult = await requireAuth(auth_token);
      if ('error' in authResult) return authResult.error;
      const { auth } = authResult;

      // Enforce per-user access
      if (auth.tier === 'user') {
        const myUserId = resolveUserId(auth.accountId);
        if (!myUserId) return errorResult('Not registered. Call multi_user_register first.');
        if (userId && userId !== myUserId) return errorResult('Access denied');
        userId = myUserId;
      }
      if (!userId) return errorResult('userId is required');

      try {
        // Check for new deposits before playing
        await checkDeposits();

        // Distributed lock prevents concurrent play for the same user across Lambda instances
        const locked = await acquireUserLock(userId);
        if (!locked) return errorResult('Operation in progress for this user. Try again shortly.');
        try {
          const result = await multiUser.playForUser(userId);
          return json({ sessions: [result] });
        } finally {
          await releaseUserLock(userId);
        }
      } catch (e) {
        return errorResult(`Play failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── multi_user_withdraw ──────────────────────────────────────

  server.tool(
    'multi_user_withdraw',
    'Process a withdrawal for a user. Sends funds to their Hedera account.',
    {
      userId: z.string().optional().describe('User ID (auto-resolved for user tier)'),
      amount: z.number().positive().describe('Amount to withdraw'),
      token: z.string().default('hbar').describe('Token to withdraw: "hbar" or token ID'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, amount, token, auth_token }) => {
      const authResult = await requireAuth(auth_token);
      if ('error' in authResult) return authResult.error;
      const { auth } = authResult;

      // Enforce per-user access
      if (auth.tier === 'user') {
        const myUserId = resolveUserId(auth.accountId);
        if (!myUserId) return errorResult('Not registered. Call multi_user_register first.');
        if (userId && userId !== myUserId) return errorResult('Access denied');
        userId = myUserId;
      }
      if (!userId) return errorResult('userId is required');

      try {
        // Distributed lock prevents concurrent withdrawal for the same user
        const locked = await acquireUserLock(userId);
        if (!locked) return errorResult('Operation in progress for this user. Try again shortly.');
        try {
          const record = await multiUser.processWithdrawal(userId, amount, token);
          return json(record);
        } finally {
          await releaseUserLock(userId);
        }
      } catch (e) {
        return errorResult(`Withdrawal failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── multi_user_deregister ────────────────────────────────────

  server.tool(
    'multi_user_deregister',
    'Deactivate a user account. User can only withdraw remaining balance after this.',
    {
      userId: z.string().optional().describe('User ID (auto-resolved for user tier)'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, auth_token }) => {
      const authResult = await requireAuth(auth_token);
      if ('error' in authResult) return authResult.error;
      const { auth } = authResult;

      // Enforce per-user access
      if (auth.tier === 'user') {
        const myUserId = resolveUserId(auth.accountId);
        if (!myUserId) return errorResult('Not registered. Call multi_user_register first.');
        if (userId && userId !== myUserId) return errorResult('Access denied');
        userId = myUserId;
      }
      if (!userId) return errorResult('userId is required');

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

  // ── multi_user_play_history ──────────────────────────────────

  server.tool(
    'multi_user_play_history',
    'View play session history for a user.',
    {
      userId: z.string().optional().describe('User ID (auto-resolved for user tier)'),
      limit: z.number().int().positive().default(20).describe('Max sessions to return'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ userId, limit, auth_token }) => {
      const authResult = await requireAuth(auth_token);
      if ('error' in authResult) return authResult.error;
      const { auth } = authResult;

      // Enforce per-user access
      if (auth.tier === 'user') {
        const myUserId = resolveUserId(auth.accountId);
        if (!myUserId) return errorResult('Not registered. Call multi_user_register first.');
        if (userId && userId !== myUserId) return errorResult('Access denied');
        userId = myUserId;
      }
      if (!userId) return errorResult('userId is required');

      try {
        // Check for new deposits/activity before returning history
        await checkDeposits();

        const sessions = multiUser.getPlayHistory(userId);
        return json({ userId, sessions: sessions.slice(-limit) });
      } catch (e) {
        return errorResult(`History failed: ${errorMsg(e)}`);
      }
    }
  );
}
