import {
  Client,
  AccountId,
  TransferTransaction,
  TokenId,
  Hbar,
} from '@hashgraph/sdk';
import { Interface, MaxUint256 } from 'ethers';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { LottoAgent } from '../agent/LottoAgent.js';
import { StrategySchema, type Strategy } from '../config/strategy.js';
import { GAS_ESTIMATES, HEDERA_DEFAULTS } from '../config/defaults.js';
import {
  createClient,
  getWalletInfo,
  getOperatorAccountId,
} from '../hedera/wallet.js';
import { executeEncodedCall } from '../hedera/contracts.js';
import {
  getTokenBalances,
  getNfts,
  type TokenBalance,
} from '../hedera/mirror.js';
import { getUserState, type UserState } from '../mcp/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const esmRequire = createRequire(import.meta.url);
const { LazyLottoABI } = esmRequire('@lazysuperheroes/lazy-lotto');

// ── Helpers ───────────────────────────────────────────────────

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tokenBalance(tokens: TokenBalance[], tokenId: string): number {
  const t = tokens.find((tok) => tok.token_id === tokenId);
  if (!t) return 0;
  return t.balance / Math.pow(10, t.decimals);
}

function getOwnerEoa(): string {
  const owner = process.env.OWNER_EOA;
  if (!owner) throw new Error('OWNER_EOA not set in environment');
  return owner;
}

function toEvmAddress(address: string): string {
  return address.startsWith('0x')
    ? address
    : '0x' + AccountId.fromString(address).toSolidityAddress();
}

// ── Session history (in-memory, resets on restart) ────────────

interface SessionRecord {
  timestamp: string;
  strategy: string;
  poolsPlayed: number;
  totalEntries: number;
  totalSpent: number;
  totalWins: number;
  currency: string;
}

const sessionHistory: SessionRecord[] = [];
let cumulativeStats = {
  sessionsPlayed: 0,
  totalEntries: 0,
  totalSpent: 0,
  totalWins: 0,
};

// ── Active session guard ──────────────────────────────────────

let activeSession: AbortController | null = null;

// ══════════════════════════════════════════════════════════════
//  MCP Server
// ══════════════════════════════════════════════════════════════

export async function startMcpServer(
  agent: LottoAgent,
  multiUser?: import('../custodial/MultiUserAgent.js').MultiUserAgent
): Promise<void> {
  const client = createClient();

  const server = new McpServer({
    name: 'lazylotto-agent',
    version: '0.1.0',
  });

  // ── 1. agent_play ─────────────────────────────────────────

  server.tool(
    'agent_play',
    'Run a lottery play session. Returns pools played, results, and net P&L.',
    {},
    async () => {
      if (activeSession) {
        return errorResult('A session is already running. Use agent_stop to cancel it.');
      }

      try {
        activeSession = new AbortController();

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
        cumulativeStats.totalSpent += report.totalSpent;
        cumulativeStats.totalWins += report.totalWins;

        return json({
          status: 'completed',
          poolsPlayed: report.poolsPlayed,
          poolsEvaluated: report.poolsEvaluated,
          totalEntries: report.totalEntries,
          totalSpent: report.totalSpent,
          totalWins: report.totalWins,
          currency: report.currency,
          net: report.totalWins - report.totalSpent,
          poolResults: report.poolResults,
        });
      } catch (e) {
        return errorResult(`Play session failed: ${errorMsg(e)}`);
      } finally {
        activeSession = null;
      }
    }
  );

  // ── 2. agent_status ───────────────────────────────────────

  server.tool(
    'agent_status',
    'Get agent status: wallet balances, pending prizes, session history, current strategy, cumulative stats.',
    {},
    async () => {
      try {
        const info = await getWalletInfo(client);
        const accountId = info.accountId.toString();
        const hbar = Number(info.hbarBalance.toTinybars().toString()) / 1e8;
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
          isPlaying: activeSession !== null,
        });
      } catch (e) {
        return errorResult(`Status check failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 3. agent_transfer_prizes ──────────────────────────────

  server.tool(
    'agent_transfer_prizes',
    'Transfer all pending prizes to the configured OWNER_EOA. ' +
      'Uses transferPendingPrizes(ownerEOA, type(uint256).max) — in-memory reassignment, no token transfers needed.',
    {},
    async () => {
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

        // Encode transferPendingPrizes(address, uint256)
        const ownerEvmAddress = toEvmAddress(ownerEoa);
        const iface = new Interface(LazyLottoABI as readonly string[]);
        const encoded = iface.encodeFunctionData('transferPendingPrizes', [
          ownerEvmAddress,
          MaxUint256,
        ]);

        const contractId = process.env.LAZYLOTTO_CONTRACT_ID;
        if (!contractId) return errorResult('LAZYLOTTO_CONTRACT_ID not set in environment');
        const txResult = await executeEncodedCall(
          client,
          contractId,
          GAS_ESTIMATES.transferPendingPrizes.base,
          encoded
        );

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

  // ── 4. agent_set_strategy ─────────────────────────────────

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
    },
    async ({ strategy: input }) => {
      try {
        let parsed: Strategy;

        if (['conservative', 'balanced', 'aggressive'].includes(input)) {
          // Load built-in strategy from package directory
          const stratPath = resolve(__dirname, '..', '..', 'strategies', `${input}.json`);
          const raw = JSON.parse(readFileSync(stratPath, 'utf-8'));
          parsed = StrategySchema.parse(raw);
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

  // ── 5. agent_wallet_info ──────────────────────────────────

  server.tool(
    'agent_wallet_info',
    'Detailed wallet info: account ID, HBAR balance, LAZY balance, token associations, active approvals, owner EOA, held NFTs.',
    {},
    async () => {
      try {
        const info = await getWalletInfo(client);
        const accountId = info.accountId.toString();
        const hbar = Number(info.hbarBalance.toTinybars().toString()) / 1e8;
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

  // ── 6. agent_withdraw ─────────────────────────────────────

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
    },
    async ({ amount, token, to }) => {
      try {
        const recipient = to ?? getOwnerEoa();
        const operatorId = getOperatorAccountId(client);

        const recipientAccountId = AccountId.fromString(recipient);
        const senderAccountId = AccountId.fromString(operatorId);

        let transactionId: string;

        if (token === 'HBAR') {
          const tx = new TransferTransaction()
            .addHbarTransfer(senderAccountId, new Hbar(-amount))
            .addHbarTransfer(recipientAccountId, new Hbar(amount));

          const response = await tx.execute(client);
          await response.getReceipt(client);
          transactionId = response.transactionId.toString();
        } else {
          // LAZY transfer
          const lazyTokenId = process.env.LAZY_TOKEN_ID;
          if (!lazyTokenId) {
            return errorResult('LAZY_TOKEN_ID not set in environment');
          }

          // LAZY has 1 decimal — convert human amount to base units
          const baseUnits = Math.round(amount * Math.pow(10, HEDERA_DEFAULTS.lazyDecimals));
          const tokenIdObj = TokenId.fromString(lazyTokenId);

          const tx = new TransferTransaction()
            .addTokenTransfer(tokenIdObj, senderAccountId, -baseUnits)
            .addTokenTransfer(tokenIdObj, recipientAccountId, baseUnits);

          const response = await tx.execute(client);
          await response.getReceipt(client);
          transactionId = response.transactionId.toString();
        }

        // Fetch remaining balance
        const info = await getWalletInfo(client);
        const hbar = Number(info.hbarBalance.toTinybars().toString()) / 1e8;
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

  // ── 7. agent_stop ─────────────────────────────────────────

  server.tool(
    'agent_stop',
    'Stop the current play session (if running), transfer any pending prizes to the owner, and return a partial summary.',
    {},
    async () => {
      try {
        // Signal active session to stop
        const wasPlaying = activeSession !== null;
        if (activeSession) {
          activeSession.abort();
          activeSession = null;
        }

        // Transfer any pending prizes
        const accountId = getOperatorAccountId(client);
        let transferred = 0;
        let transferTxId: string | null = null;

        try {
          const ownerEoa = getOwnerEoa();
          const state = await getUserState(accountId);

          if (state.pendingPrizesCount > 0) {
            const ownerEvmAddress = toEvmAddress(ownerEoa);
            const iface = new Interface(LazyLottoABI as readonly string[]);
            const encoded = iface.encodeFunctionData(
              'transferPendingPrizes',
              [ownerEvmAddress, MaxUint256]
            );

            const contractId = process.env.LAZYLOTTO_CONTRACT_ID;
            if (!contractId) return errorResult('LAZYLOTTO_CONTRACT_ID not set in environment');
            const txResult = await executeEncodedCall(
              client,
              contractId,
              GAS_ESTIMATES.transferPendingPrizes.base,
              encoded
            );

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

  // ── 8. agent_audit ─────────────────────────────────────────

  server.tool(
    'agent_audit',
    'Comprehensive audit of agent configuration: wallet balances, win rate boost, NFT delegation status, ' +
      'token approvals, strategy summary, prize destination, pending prizes, contract addresses. ' +
      'Returns warnings and actionable recommendations.',
    {},
    async () => {
      try {
        const { AuditReport } = await import('../agent/AuditReport.js');
        const audit = new AuditReport(client, agent.getStrategy());
        const result = await audit.generate();
        return json(result);
      } catch (e) {
        return errorResult(`Audit failed: ${errorMsg(e)}`);
      }
    }
  );

  // ── 9. agent_onboard ───────────────────────────────────────

  server.tool(
    'agent_onboard',
    'Check onboarding status and return a step-by-step checklist. ' +
      'Each step has a status (done/missing/warning) and instructions. ' +
      'Use this to guide users through first-time setup conversationally.',
    {},
    async () => {
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
            : 'Set LAZYLOTTO_MCP_URL=https://lazylotto.app/api/mcp in .env',
        });

        // Step 4: Wallet funding
        let hbar = 0;
        let lazyBalance: number | null = null;
        if (hasAccountId && hasPrivateKey) {
          try {
            const info = await getWalletInfo(client);
            hbar = Number(info.hbarBalance.toTinybars().toString()) / 1e8;
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

  // ══════════════════════════════════════════════════════════
  //  Multi-User Tools (only registered when multiUser agent provided)
  // ══════════════════════════════════════════════════════════

  if (multiUser) {
    server.tool(
      'multi_user_status',
      'List all registered users with balances and last activity.',
      {},
      async () => {
        try {
          const users = multiUser.getAllUsersStatus();
          return json({
            totalUsers: users.length,
            activeUsers: users.filter((u) => u.active).length,
            users: users.map((u) => ({
              userId: u.userId,
              hederaAccountId: u.hederaAccountId,
              eoaAddress: u.eoaAddress,
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
      'Register a new user. Returns their unique deposit memo for funding.',
      {
        accountId: z.string().describe('User Hedera account ID (0.0.XXXXX)'),
        eoaAddress: z.string().describe('User EOA for prize delivery (0.0.XXXXX or 0x...)'),
        strategy: z.enum(['conservative', 'balanced', 'aggressive']).default('balanced')
          .describe('Strategy name'),
        rakePercent: z.number().optional()
          .describe('Optional negotiated rake (must be within configured band)'),
      },
      async ({ accountId, eoaAddress, strategy: strat, rakePercent }) => {
        try {
          const user = await multiUser.registerUser(accountId, eoaAddress, strat, rakePercent);
          return json({
            userId: user.userId,
            depositMemo: user.depositMemo,
            agentWallet: getOperatorAccountId(client),
            rakePercent: user.rakePercent,
            strategy: user.strategyName,
            instructions:
              `Send HBAR or LAZY to ${getOperatorAccountId(client)} ` +
              `with memo "${user.depositMemo}" to fund your account.`,
          });
        } catch (e) {
          return errorResult(`Registration failed: ${errorMsg(e)}`);
        }
      }
    );

    server.tool(
      'multi_user_deposit_info',
      'Get deposit memo and funding instructions for an existing user.',
      { userId: z.string().describe('User ID') },
      async ({ userId }) => {
        try {
          const user = multiUser.getUserStatus(userId);
          if (!user) return errorResult('User not found');
          return json({
            depositMemo: user.depositMemo,
            agentWallet: getOperatorAccountId(client),
            balances: user.balances,
            instructions:
              `Send HBAR or LAZY to ${getOperatorAccountId(client)} ` +
              `with memo "${user.depositMemo}"`,
          });
        } catch (e) {
          return errorResult(`Failed: ${errorMsg(e)}`);
        }
      }
    );

    server.tool(
      'multi_user_play',
      'Trigger a play session for a specific user or all eligible users.',
      { userId: z.string().optional().describe('Specific user ID, or omit for all eligible') },
      async ({ userId }) => {
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
      },
      async ({ userId, amount }) => {
        try {
          const record = await multiUser.processWithdrawal(userId, amount);
          return json(record);
        } catch (e) {
          return errorResult(`Withdrawal failed: ${errorMsg(e)}`);
        }
      }
    );

    server.tool(
      'multi_user_deregister',
      'Deactivate a user account. User can only withdraw remaining balance after this.',
      { userId: z.string().describe('User ID') },
      async ({ userId }) => {
        try {
          multiUser.deregisterUser(userId);
          const user = multiUser.getUserStatus(userId);
          return json({
            deregistered: true,
            userId,
            remainingBalance: user?.balances.available ?? 0,
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
      },
      async ({ userId, limit }) => {
        try {
          const sessions = multiUser.getPlayHistory(userId);
          return json({ userId, sessions: sessions.slice(-limit) });
        } catch (e) {
          return errorResult(`History failed: ${errorMsg(e)}`);
        }
      }
    );

    server.tool(
      'operator_balance',
      'View operator platform balance: rake collected, gas spent, net profit.',
      {},
      async () => {
        try {
          const op = multiUser.getOperatorBalance();
          return json({
            ...op,
            netProfit: op.totalRakeCollected - op.totalGasSpent - op.totalWithdrawnByOperator,
          });
        } catch (e) {
          return errorResult(`Failed: ${errorMsg(e)}`);
        }
      }
    );

    server.tool(
      'operator_withdraw_fees',
      'Withdraw accumulated rake fees from the operator platform balance.',
      {
        amount: z.number().positive().describe('Amount in HBAR to withdraw'),
        to: z.string().describe('Recipient Hedera account ID'),
      },
      async ({ amount, to }) => {
        try {
          const txId = await multiUser.operatorWithdrawFees(amount, to);
          const op = multiUser.getOperatorBalance();
          return json({
            withdrawn: amount,
            to,
            transactionId: txId,
            remainingPlatformBalance: op.platformBalance,
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

  // ── Start server ──────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
