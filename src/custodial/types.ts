import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Strategy } from '../config/strategy.js';
import type { PrizeDetail } from '../agent/ReportGenerator.js';

// ── Schema version ────────────────────────────────────────────
// Bump when the shape of any persisted record changes in an
// incompatible way. Writes always stamp records with this value;
// reads tolerate missing/older versions (legacy data without a
// version is treated as v0 and passed through unchanged).
//
// Version history:
//   0 — pre-versioning (no schemaVersion field)
//   1 — initial versioned schema (2026-04-06)
//   2 — PlaySessionResult gains spentByToken + poolResults[].feeTokenId
//       (2026-04-21). Legacy v0/v1 records synthesize
//       spentByToken = { HBAR: totalSpent } on read — all pre-v2 spend
//       is HBAR by construction. See MultiUserAgent.playForUser and
//       app/api/user/history/route.ts for the read-time fallback.

export const CURRENT_SCHEMA_VERSION = 2;

// ── User ──────────────────────────────────────────────────────

export interface UserAccount {
  /** Schema version stamped at write time. Missing = legacy (v0). */
  schemaVersion?: number;
  userId: string;
  depositMemo: string;
  hederaAccountId: string;
  eoaAddress: string;
  strategyName: string;
  strategyVersion: string;
  strategySnapshot: Strategy;
  rakePercent: number;
  balances: UserBalances;
  connectionTopicId: string | null;
  registeredAt: string;
  lastPlayedAt: string | null;
  active: boolean;
}

/** Per-token balance entry. Each token the user has deposited gets its own entry. */
export interface TokenBalanceEntry {
  available: number;
  reserved: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalRake: number;
}

/** User balances keyed by token ("hbar" for native, token ID for FTs). */
export interface UserBalances {
  tokens: Record<string, TokenBalanceEntry>;
}

export function emptyBalances(): UserBalances {
  return { tokens: {} };
}

export function emptyTokenEntry(): TokenBalanceEntry {
  return {
    available: 0,
    reserved: 0,
    totalDeposited: 0,
    totalWithdrawn: 0,
    totalRake: 0,
  };
}

/** Get or create a token balance entry for a user. */
export function getTokenEntry(
  balances: UserBalances,
  token: string
): TokenBalanceEntry {
  if (!balances.tokens[token]) {
    balances.tokens[token] = emptyTokenEntry();
  }
  return balances.tokens[token];
}

/** Check if a user has any token with available balance >= threshold. */
export function hasAvailableToken(
  balances: UserBalances,
  minAmount: number
): boolean {
  return Object.values(balances.tokens).some(
    (e) => e.available >= minAmount
  );
}

/** Get per-token reserve summary (for display — never sum across currencies). */
export function reserveSummary(
  balances: UserBalances
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [token, entry] of Object.entries(balances.tokens)) {
    if (entry.reserved > 0) result[token] = entry.reserved;
  }
  return result;
}

// ── Operator ──────────────────────────────────────────────────

export interface OperatorState {
  /** Schema version stamped at write time. Missing = legacy (v0). */
  schemaVersion?: number;
  /** Per-token platform balance (rake collected minus gas minus withdrawn). */
  balances: Record<string, number>;
  /** Per-token cumulative rake collected. */
  totalRakeCollected: Record<string, number>;
  /** Gas is always HBAR on Hedera — single number. */
  totalGasSpent: number;
  /** Per-token operator withdrawals. */
  totalWithdrawnByOperator: Record<string, number>;
}

export function emptyOperatorState(): OperatorState {
  return {
    balances: {},
    totalRakeCollected: {},
    totalGasSpent: 0,
    totalWithdrawnByOperator: {},
  };
}

// ── Records ───────────────────────────────────────────────────

export interface DepositRecord {
  /** Schema version stamped at write time. Missing = legacy (v0). */
  schemaVersion?: number;
  transactionId: string;
  userId: string;
  grossAmount: number;
  rakeAmount: number;
  netAmount: number;
  tokenId: string | null;
  memo: string;
  timestamp: string;
}

export interface PlaySessionResult {
  /** Schema version stamped at write time. Missing = legacy (v0). */
  schemaVersion?: number;
  sessionId: string;
  userId: string;
  timestamp: string;
  strategyName: string;
  strategyVersion: string;
  boostBps: number;
  poolsEvaluated: number;
  poolsPlayed: number;
  poolResults: {
    poolId: number;
    poolName: string;
    entriesBought: number;
    amountSpent: number;
    /**
     * Canonical pool fee token (v2+). "HBAR" for native, a Hedera
     * token id (e.g. "0.0.8011209") for FTs. Sourced from
     * PoolResult.feeTokenId at write time. Legacy v0/v1 records
     * lack this field; readers should assume "HBAR" when absent
     * since all pre-v2 spend is HBAR by construction.
     */
    feeTokenId?: string;
    rolled: boolean;
    wins: number;
    prizeDetails: PrizeDetail[];
  }[];
  totalSpent: number;
  /**
   * Per-token spend breakdown (v2+). Same key space as prizesByToken:
   * "HBAR" for native, Hedera token id for FTs. Legacy v0/v1 records
   * lack this field — dashboard/history readers should synthesize
   * { HBAR: totalSpent } on the fly since pre-v2 spend is HBAR-only.
   */
  spentByToken?: Record<string, number>;
  totalWins: number;
  totalPrizeValue: number;
  prizesByToken: Record<string, number>;
  prizesTransferred: boolean;
  gasCostHbar: number;
  amountReserved: number;
  amountSettled: number;
  amountReleased: number;
}

export interface WithdrawalRecord {
  /** Schema version stamped at write time. Missing = legacy (v0). */
  schemaVersion?: number;
  userId: string;
  amount: number;
  tokenId: string | null;
  recipientAccountId: string;
  transactionId: string;
  timestamp: string;
}

export interface GasRecord {
  /** Schema version stamped at write time. Missing = legacy (v0). */
  schemaVersion?: number;
  transactionId: string;
  userId: string | 'system';
  operation: string;
  gasCostHbar: number;
  timestamp: string;
}

// ── Config ────────────────────────────────────────────────────

export interface RakeConfig {
  defaultPercent: number;
  minPercent: number;
  maxPercent: number;
  /** Volume-based tiers: deposit above threshold gets the lower rate */
  volumeTiers: VolumeTier[];
}

export interface VolumeTier {
  minDeposit: number;   // Deposit amount threshold (in budget currency)
  rakePercent: number;  // Rate offered at this tier
}

export interface CustodialConfig {
  rake: RakeConfig;
  depositPollIntervalMs: number;
  hcs10PollIntervalMs: number;
  minDepositAmount: number;
  maxUserBalance: number;
  maxUsersPerPlayCycle: number;
  /** Minimum HBAR to reserve per active user with balance > 0, to cover gas costs. */
  gasReservePerUser: number;
  hcs20Tick: string;
  hcs20TopicId: string | null;
  dataDir: string;
}

export function loadCustodialConfig(): CustodialConfig {
  return {
    rake: {
      defaultPercent: Number(process.env.RAKE_DEFAULT_PERCENT ?? 5.0),
      minPercent: Number(process.env.RAKE_MIN_PERCENT ?? 2.0),
      maxPercent: Number(process.env.RAKE_MAX_PERCENT ?? 5.0),
      volumeTiers: [
        { minDeposit: 1000, rakePercent: 3.0 },
        { minDeposit: 500, rakePercent: 3.5 },
        { minDeposit: 200, rakePercent: 4.0 },
        { minDeposit: 50, rakePercent: 5.0 },
      ],
    },
    depositPollIntervalMs: Number(process.env.DEPOSIT_POLL_INTERVAL_MS ?? 10_000),
    hcs10PollIntervalMs: 15_000,
    minDepositAmount: 1,
    maxUserBalance: Number(process.env.MAX_USER_BALANCE ?? 10_000),
    maxUsersPerPlayCycle: 10,
    gasReservePerUser: Number(process.env.GAS_RESERVE_PER_USER ?? 5),
    hcs20Tick: process.env.HCS20_TICK ?? 'LLCRED',
    hcs20TopicId: process.env.HCS20_TOPIC_ID || null,
    dataDir: process.env.CUSTODIAL_DATA_DIR
      ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.custodial-data'),
  };
}

// ── HCS-10 Negotiation Messages ───────────────────────────────

export type NegotiationMessage =
  | {
      type: 'welcome';
      strategies: string[];
      rakePercent: number;
      rakeRange: { min: number; max: number };
      boostBps: number;
      minDeposit: number;
      maxBalance: number;
      agentWallet: string;
    }
  | {
      type: 'configure';
      strategy: string;
      eoaAddress: string;
      rakePercent?: number;
    }
  | {
      type: 'deposit_memo';
      memo: string;
      agentWallet: string;
      instructions: string;
    }
  | {
      type: 'deposit_confirmed';
      grossAmount: number;
      rakeAmount: number;
      netCredited: number;
      newBalance: UserBalances;
    }
  | {
      type: 'play_result';
      session: PlaySessionResult;
      newBalance: UserBalances;
    }
  | {
      type: 'balance_update';
      balances: UserBalances;
    }
  | {
      type: 'withdrawal_confirmed';
      amount: number;
      transactionId: string;
      newBalance: UserBalances;
    }
  | {
      type: 'error';
      message: string;
    };

// ── Errors ────────────────────────────────────────────────────

export class InsufficientBalanceError extends Error {
  constructor(
    public userId: string,
    public requested: number,
    public available: number
  ) {
    super(
      `Insufficient balance for user ${userId}: requested ${requested}, available ${available}`
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class UserNotFoundError extends Error {
  constructor(public userId: string) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
  }
}

export class UserInactiveError extends Error {
  constructor(public userId: string) {
    super(`User ${userId} is inactive (deregistered). Withdrawals only.`);
    this.name = 'UserInactiveError';
  }
}
