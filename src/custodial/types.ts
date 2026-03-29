import type { Strategy } from '../config/strategy.js';

// ── User ──────────────────────────────────────────────────────

export interface UserAccount {
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

export interface UserBalances {
  available: number;
  reserved: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalRake: number;
}

export function emptyBalances(): UserBalances {
  return {
    available: 0,
    reserved: 0,
    totalDeposited: 0,
    totalWithdrawn: 0,
    totalRake: 0,
  };
}

// ── Operator ──────────────────────────────────────────────────

export interface OperatorState {
  platformBalance: number;
  totalRakeCollected: number;
  totalGasSpent: number;
  totalWithdrawnByOperator: number;
}

export function emptyOperatorState(): OperatorState {
  return {
    platformBalance: 0,
    totalRakeCollected: 0,
    totalGasSpent: 0,
    totalWithdrawnByOperator: 0,
  };
}

// ── Records ───────────────────────────────────────────────────

export interface DepositRecord {
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
    rolled: boolean;
    wins: number;
  }[];
  totalSpent: number;
  totalWins: number;
  prizesTransferred: boolean;
  gasCostHbar: number;
  amountReserved: number;
  amountSettled: number;
  amountReleased: number;
}

export interface WithdrawalRecord {
  userId: string;
  amount: number;
  tokenId: string | null;
  recipientAccountId: string;
  transactionId: string;
  timestamp: string;
}

export interface GasRecord {
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
    hcs20Tick: process.env.HCS20_TICK ?? 'LLCRED',
    hcs20TopicId: process.env.HCS20_TOPIC_ID || null,
    dataDir: '.custodial-data',
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
