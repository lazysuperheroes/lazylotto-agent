/**
 * Single-user (agent-owned wallet) MCP tools.
 *
 * Registers: agent_play, agent_status, agent_transfer_prizes,
 * agent_set_strategy, agent_wallet_info, agent_withdraw,
 * agent_stop, agent_audit, agent_onboard
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { LottoAgent } from '../../agent/LottoAgent.js';
import { StrategySchema, type Strategy } from '../../config/strategy.js';
import { loadStrategy as loadStrategyFromFile } from '../../config/loader.js';
import { getWalletInfo, getOperatorAccountId } from '../../hedera/wallet.js';
import { transferAllPrizes } from '../../hedera/contracts.js';
import { getTokenBalances, getNfts } from '../../hedera/mirror.js';
import { getUserState } from '../client.js';
import type { ServerContext, SessionRecord } from './types.js';
import { hbarToNumber } from '../../utils/format.js';
import { transferHbar, transferToken } from '../../hedera/transfers.js';

// ── Registration ────────────────────────────────────────────────

export function registerSingleUserTools(
  server: McpServer,
  agent: LottoAgent,
  ctx: ServerContext
): void {
  const {
    client,
    json,
    errorResult,
    errorMsg,
    tokenBalance,
    getOwnerEoa,
    toEvmAddress,
    sessionHistory,
    cumulativeStats,
    getIsSessionActive,
    setIsSessionActive,
    requireAuth,
  } = ctx;

  // ── 1. agent_play ───────────────────────────────────────────

  server.tool(
    'agent_play',
    'Run a lottery play session. Returns pools played, results, and net P&L.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      if (getIsSessionActive()) {
        return errorResult('A session is already running. Wait for it to complete.');
      }

      try {
        setIsSessionActive(true);

        const report = await agent.play();

        // Record session
        const record: SessionRecord = {
          timestamp: report.startedAt,
          strategy: report.strategy,
          poolsPlayed: report.poolsPlayed,
          totalEntries: report.totalEntries,
          totalSpent: report.totalSpent,
          totalWins: report.totalWins,
          currency: report.currency,
        };
        sessionHistory.push(record);
        cumulativeStats.sessionsPlayed++;
        cumulativeStats.totalEntries += report.totalEntries;
        // report.totalSpent is a single number (sum across tokens) —
        // Track under 'mixed' key since we don't have per-token from SessionReport yet
        cumulativeStats.spentByToken['mixed'] = (cumulativeStats.spentByToken['mixed'] ?? 0) + report.totalSpent;
        cumulativeStats.winsByToken['mixed'] = (cumulativeStats.winsByToken['mixed'] ?? 0) + report.totalWins;

        // Persist session history to disk (best-effort)
        try {
          const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
          const { join, dirname } = await import('node:path');
          const { fileURLToPath } = await import('node:url');
          const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
          const dir = join(projectRoot, '.session-history');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(
            `${dir}/sessions.json`,
            JSON.stringify({ sessions: sessionHistory, cumulative: cumulativeStats }, null, 2),
            'utf-8',
          );
        } catch { /* persistence not critical */ }

        return json({
          status: 'completed',
          poolsPlayed: report.poolsPlayed,
          poolsEvaluated: report.poolsEvaluated,
          totalEntries: report.totalEntries,
          totalSpent: report.totalSpent,
          spentByToken: report.spentByToken,
          totalWins: report.totalWins,
          totalPrizeValue: report.totalPrizeValue,
          prizesByToken: report.prizesByToken,
          poolResults: report.poolResults,
        });
      } catch (e) {
        return errorResult(`Play session failed: ${errorMsg(e)}`);
      } finally {
        setIsSessionActive(false);
      }
    }
  );

  // ── 2. agent_status ─────────────────────────────────────────

  server.tool(
    'agent_status',
    'Get agent status: wallet balances, pending prizes, session history, current strategy, cumulative stats.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const info = await getWalletInfo(client);
        const accountId = info.accountId.toString();
        const hbar = hbarToNumber(info.hbarBalance);
        const tokens = await getTokenBalances(accountId);

        const lazyTokenId = process.env.LAZY_TOKEN_ID;
        const lazyBalance = lazyTokenId
          ? tokenBalance(tokens, lazyTokenId)
          : null;

        let pendingPrizes = 0;
        try {
          const state = await getUserState(accountId);
          pendingPrizes = state.pendingPrizesCount;
        } catch {
          /* MCP client may not be connected */
        }

        const strategy = agent.getStrategy();

        return json({
          wallet: {
            accountId,
            network: process.env.HEDERA_NETWORK ?? 'testnet',
            hbar,
            lazy: lazyBalance,
          },
          pendingPrizes,
          strategy: {
            name: strategy.name,
            budget: strategy.budget,
            playStyle: {
              action: strategy.playStyle.action,
              entriesPerBatch: strategy.playStyle.entriesPerBatch,
              transferToOwner: strategy.playStyle.transferToOwner,
            },
          },
          sessionHistory: sessionHistory.slice(-10),
          cumulative: cumulativeStats,
          isPlaying: getIsSessionActive(),
        });
      } catch (e) {
        return errorResult(`Status check failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 3. agent_transfer_prizes ────────────────────────────────

  server.tool(
    'agent_transfer_prizes',
    'Transfer all pending prizes to the configured OWNER_EOA. ' +
      'Uses transferPendingPrizes(ownerEOA, type(uint256).max) — in-memory reassignment, no token transfers needed.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const ownerEoa = getOwnerEoa();
        const accountId = getOperatorAccountId(client);

        // Check pending prizes
        const state = await getUserState(accountId);
        if (state.pendingPrizesCount === 0) {
          return json({
            transferred: 0,
            message: 'No pending prizes to transfer.',
          });
        }

        const ownerEvmAddress = toEvmAddress(ownerEoa);
        const contractId = process.env.LAZYLOTTO_CONTRACT_ID;
        if (!contractId) return errorResult('LAZYLOTTO_CONTRACT_ID not set in environment');
        const txResult = await transferAllPrizes(client, contractId, ownerEvmAddress);

        return json({
          transferred: state.pendingPrizesCount,
          recipient: ownerEoa,
          transactionId: txResult.transactionId,
          status: txResult.status.toString(),
          prizes: state.pendingPrizes,
        });
      } catch (e) {
        return errorResult(`Prize transfer failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 4. agent_set_strategy ───────────────────────────────────

  server.tool(
    'agent_set_strategy',
    'Update the agent strategy. Pass a built-in name (conservative, balanced, aggressive) or a full strategy JSON object.',
    {
      strategy: z
        .union([
          z.enum(['conservative', 'balanced', 'aggressive']),
          z.string().describe('JSON string of a full strategy object'),
        ])
        .describe('Strategy name or JSON object'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ strategy: input, auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        let parsed: Strategy;

        if (['conservative', 'balanced', 'aggressive'].includes(input)) {
          parsed = loadStrategyFromFile(input);
        } else {
          // Parse as JSON strategy object
          const raw = JSON.parse(input);
          parsed = StrategySchema.parse(raw);
        }

        agent.setStrategy(parsed);

        return json({
          updated: true,
          strategy: {
            name: parsed.name,
            description: parsed.description,
            budget: parsed.budget,
            poolFilter: parsed.poolFilter,
            playStyle: {
              action: parsed.playStyle.action,
              entriesPerBatch: parsed.playStyle.entriesPerBatch,
              minExpectedValue: parsed.playStyle.minExpectedValue,
            },
          },
        });
      } catch (e) {
        return errorResult(`Invalid strategy: ${errorMsg(e)}`);
      }
    }
  );

  // ── 5. agent_wallet_info ────────────────────────────────────

  server.tool(
    'agent_wallet_info',
    'Detailed wallet info: account ID, HBAR balance, LAZY balance, token associations, active approvals, owner EOA, held NFTs.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const info = await getWalletInfo(client);
        const accountId = info.accountId.toString();
        const hbar = hbarToNumber(info.hbarBalance);
        const tokens = await getTokenBalances(accountId);
        const nfts = await getNfts(accountId);

        const lazyTokenId = process.env.LAZY_TOKEN_ID;
        const lazyBalance = lazyTokenId
          ? tokenBalance(tokens, lazyTokenId)
          : null;

        let ownerEoa: string | null = null;
        try {
          ownerEoa = getOwnerEoa();
        } catch {
          /* not configured */
        }

        return json({
          accountId,
          network: process.env.HEDERA_NETWORK ?? 'testnet',
          hbar,
          lazy: lazyBalance,
          lazyTokenId: lazyTokenId ?? null,
          ownerEoa,
          tokenAssociations: tokens.map((t) => ({
            tokenId: t.token_id,
            balance: t.balance / Math.pow(10, t.decimals),
            decimals: t.decimals,
          })),
          nfts: nfts.map((n) => ({
            tokenId: n.token_id,
            serial: n.serial_number,
          })),
          contracts: {
            lazyLotto: process.env.LAZYLOTTO_CONTRACT_ID ?? null,
            storage: process.env.LAZYLOTTO_STORAGE_ID ?? null,
            gasStation: process.env.LAZY_GAS_STATION_ID ?? null,
          },
        });
      } catch (e) {
        return errorResult(`Wallet info failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 6. agent_withdraw ───────────────────────────────────────

  server.tool(
    'agent_withdraw',
    'Withdraw HBAR or LAZY from the agent wallet to a specified address (defaults to OWNER_EOA). Use to recover funds.',
    {
      amount: z.number().positive().describe('Amount to withdraw'),
      token: z
        .enum(['HBAR', 'LAZY'])
        .describe('Token to withdraw: HBAR or LAZY'),
      to: z
        .string()
        .optional()
        .describe('Recipient Hedera account ID (defaults to OWNER_EOA)'),
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ amount, token, to, auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const recipient = to ?? getOwnerEoa();
        // Restrict to OWNER_EOA if no explicit 'to' and auth is required
        const ownerEoa = process.env.OWNER_EOA;
        if (ownerEoa && to && to !== ownerEoa) {
          return errorResult(
            `Withdrawal restricted to OWNER_EOA (${ownerEoa}). ` +
              `Requested: ${to}. Remove OWNER_EOA restriction or use the correct address.`
          );
        }
        const operatorId = getOperatorAccountId(client);

        let transactionId: string;

        if (token === 'HBAR') {
          const result = await transferHbar(client, operatorId, recipient, amount);
          transactionId = result.transactionId;
        } else {
          const lazyTokenId = process.env.LAZY_TOKEN_ID;
          if (!lazyTokenId) {
            return errorResult('LAZY_TOKEN_ID not set in environment');
          }
          const result = await transferToken(client, operatorId, recipient, lazyTokenId, amount);
          transactionId = result.transactionId;
        }

        // Fetch remaining balance
        const info = await getWalletInfo(client);
        const hbar = hbarToNumber(info.hbarBalance);
        const tokens = await getTokenBalances(operatorId);
        const lazyTokenId = process.env.LAZY_TOKEN_ID;
        const lazyRemaining = lazyTokenId
          ? tokenBalance(tokens, lazyTokenId)
          : null;

        return json({
          withdrawn: { amount, token, to: recipient },
          transactionId,
          remainingBalance: { hbar, lazy: lazyRemaining },
        });
      } catch (e) {
        return errorResult(`Withdrawal failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 7. agent_stop ───────────────────────────────────────────

  server.tool(
    'agent_stop',
    'Signals stop, transfers pending prizes to owner, returns summary. Current session runs to completion.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        // Signal active session to stop
        const wasPlaying = getIsSessionActive();
        // Note: cannot interrupt an active play session mid-flight.
        // This tool transfers prizes and prevents new sessions from starting.

        // Transfer any pending prizes
        const accountId = getOperatorAccountId(client);
        let transferred = 0;
        let transferTxId: string | null = null;

        try {
          const ownerEoa = getOwnerEoa();
          const state = await getUserState(accountId);

          if (state.pendingPrizesCount > 0) {
            const ownerEvmAddress = toEvmAddress(ownerEoa);
            const contractId = process.env.LAZYLOTTO_CONTRACT_ID;
            if (!contractId) return errorResult('LAZYLOTTO_CONTRACT_ID not set in environment');
            const txResult = await transferAllPrizes(client, contractId, ownerEvmAddress);
            transferred = state.pendingPrizesCount;
            transferTxId = txResult.transactionId;
          }
        } catch (e) {
          // Best-effort transfer — report what happened
          return json({
            stopped: true,
            wasPlaying,
            prizesTransferred: 0,
            transferError: errorMsg(e),
            cumulative: cumulativeStats,
          });
        }

        return json({
          stopped: true,
          wasPlaying,
          prizesTransferred: transferred,
          transferTransactionId: transferTxId,
          cumulative: cumulativeStats,
        });
      } catch (e) {
        return errorResult(`Stop failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 8. agent_audit ──────────────────────────────────────────

  server.tool(
    'agent_audit',
    'Comprehensive audit of agent configuration: wallet balances, win rate boost, NFT delegation status, ' +
      'token approvals, strategy summary, prize destination, pending prizes, contract addresses. ' +
      'Returns warnings and actionable recommendations.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const { AuditReport } = await import('../../agent/AuditReport.js');
        const audit = new AuditReport(client, agent.getStrategy());
        const result = await audit.generate();
        return json(result);
      } catch (e) {
        return errorResult(`Audit failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 9. agent_onboard ────────────────────────────────────────

  server.tool(
    'agent_onboard',
    'Check onboarding status and return a step-by-step checklist. ' +
      'Each step has a status (done/missing/warning) and instructions. ' +
      'Use this to guide users through first-time setup conversationally.',
    {
      auth_token: z.string().optional().describe('Auth token (required when MCP_AUTH_TOKEN is set)'),
    },
    async ({ auth_token }) => {
      const authErr = await requireAuth(auth_token);
      if (authErr) return authErr;
      try {
        const steps: {
          step: number;
          name: string;
          status: 'done' | 'missing' | 'warning';
          detail: string;
          action?: string;
        }[] = [];

        let stepNum = 1;

        // Step 1: Hedera credentials
        const hasAccountId = !!process.env.HEDERA_ACCOUNT_ID;
        const hasPrivateKey = !!process.env.HEDERA_PRIVATE_KEY;
        steps.push({
          step: stepNum++,
          name: 'Hedera credentials',
          status: hasAccountId && hasPrivateKey ? 'done' : 'missing',
          detail: hasAccountId && hasPrivateKey
            ? `Account ${process.env.HEDERA_ACCOUNT_ID} configured`
            : 'HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set in .env',
          action: hasAccountId && hasPrivateKey
            ? undefined
            : 'Run "lazylotto-agent --wizard" or manually create a .env file from .env.example',
        });

        // Step 2: Owner wallet
        const hasOwner = !!process.env.OWNER_EOA;
        steps.push({
          step: stepNum++,
          name: 'Owner wallet (prize destination)',
          status: hasOwner ? 'done' : 'missing',
          detail: hasOwner
            ? `Prizes will transfer to ${process.env.OWNER_EOA}`
            : 'OWNER_EOA not set. Prizes cannot be forwarded to you.',
          action: hasOwner
            ? undefined
            : 'Set OWNER_EOA=0.0.XXXXX in .env (your main Hedera wallet)',
        });

        // Step 3: MCP endpoint
        const hasMcp = !!process.env.LAZYLOTTO_MCP_URL;
        steps.push({
          step: stepNum++,
          name: 'LazyLotto MCP endpoint',
          status: hasMcp ? 'done' : 'missing',
          detail: hasMcp
            ? `MCP: ${process.env.LAZYLOTTO_MCP_URL}`
            : 'LAZYLOTTO_MCP_URL not set.',
          action: hasMcp
            ? undefined
            : 'Set LAZYLOTTO_MCP_URL in .env (testnet: https://testnet-dapp.lazysuperheroes.com/api/mcp)',
        });

        // Step 4: Wallet funding
        let hbar = 0;
        let lazyBalance: number | null = null;
        if (hasAccountId && hasPrivateKey) {
          try {
            const info = await getWalletInfo(client);
            hbar = hbarToNumber(info.hbarBalance);
            const acctId = info.accountId.toString();
            const tokens = await getTokenBalances(acctId);
            const lazyTokenId = process.env.LAZY_TOKEN_ID;
            if (lazyTokenId) {
              lazyBalance = tokenBalance(tokens, lazyTokenId);
            }
          } catch {
            /* wallet query failed */
          }
        }

        const funded = hbar >= 1;
        steps.push({
          step: stepNum++,
          name: 'Wallet funding',
          status: funded ? (hbar < 5 ? 'warning' : 'done') : 'missing',
          detail: hasAccountId
            ? `HBAR: ${hbar.toFixed(2)}${lazyBalance !== null ? `, LAZY: ${lazyBalance}` : ''}`
            : 'Cannot check — credentials not configured',
          action: funded
            ? undefined
            : 'Send HBAR and LAZY tokens to the agent wallet',
        });

        // Step 5: Token associations & approvals (--setup)
        let hasAssociations = false;
        if (hasAccountId && hasPrivateKey) {
          try {
            const acctId = process.env.HEDERA_ACCOUNT_ID!;
            const tokens = await getTokenBalances(acctId);
            const lazyTokenId = process.env.LAZY_TOKEN_ID;
            hasAssociations = !!lazyTokenId && tokens.some((t) => t.token_id === lazyTokenId);
          } catch {
            /* mirror node query failed */
          }
        }

        steps.push({
          step: stepNum++,
          name: 'Token setup (associations & approvals)',
          status: hasAssociations ? 'done' : 'missing',
          detail: hasAssociations
            ? 'LAZY token associated'
            : 'Token associations and approvals not detected',
          action: hasAssociations
            ? undefined
            : 'Run "lazylotto-agent --setup" to associate tokens and set allowances',
        });

        // Step 6: Strategy
        const strategyName = agent.getStrategy().name;
        steps.push({
          step: stepNum++,
          name: 'Strategy',
          status: 'done',
          detail: `Active strategy: ${strategyName}`,
          action: undefined,
        });

        // Step 7: Delegation (optional)
        const hasDelegate = !!process.env.DELEGATE_REGISTRY_ID;
        steps.push({
          step: stepNum++,
          name: 'NFT delegation (optional, for win rate boost)',
          status: hasDelegate ? 'done' : 'warning',
          detail: hasDelegate
            ? `Delegate registry: ${process.env.DELEGATE_REGISTRY_ID}`
            : 'No delegation configured. Agent plays without win rate boost.',
          action: hasDelegate
            ? 'Run "lazylotto-agent --audit" to verify delegated NFTs'
            : 'From your owner wallet, delegate LSH NFTs to the agent address. Then set DELEGATE_REGISTRY_ID and LSH_TOKEN_ID in .env.',
        });

        // Summary
        const done = steps.filter((s) => s.status === 'done').length;
        const missing = steps.filter((s) => s.status === 'missing').length;
        const warnings = steps.filter((s) => s.status === 'warning').length;
        const ready = missing === 0;

        return json({
          ready,
          summary: ready
            ? `All ${done} required steps complete. ${warnings} optional warning(s). Agent is ready to play!`
            : `${missing} step(s) need attention before the agent can play.`,
          steps,
          nextAction: missing > 0
            ? steps.find((s) => s.status === 'missing')?.action ?? null
            : 'Run agent_play to start a lottery session!',
        });
      } catch (e) {
        return errorResult(`Onboard check failed: ${errorMsg(e)}`);
      }
    }
  );
}
