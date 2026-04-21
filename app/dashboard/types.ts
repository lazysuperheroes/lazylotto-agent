// ---------------------------------------------------------------------------
// Dashboard payload types
// ---------------------------------------------------------------------------
//
// Mapped to the actual API response shapes from /api/user/status, /history,
// /prize-status, and /public/stats. Extracted from the dashboard page during
// the #212 refactor so the same types can be used by future hooks +
// extracted sub-components without circular imports back into the page.

import type { PrizeNftRef } from '../components/PrizeNftCard';

export interface TokenBalanceEntry {
  available: number;
  reserved: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalRake: number;
}

export interface UserBalances {
  tokens: Record<string, TokenBalanceEntry>;
}

export interface VelocityState {
  cap: number | null;
  usedToday: number;
  remaining: number | null;
}

export interface StatusResponse {
  userId: string;
  hederaAccountId: string;
  eoaAddress: string;
  depositMemo: string;
  strategyName: string;
  strategyVersion: string;
  rakePercent: number;
  balances: UserBalances;
  active: boolean;
  registeredAt: string;
  lastPlayedAt: string | null;
  agentWallet?: string;
  /** Per-token 24h withdrawal velocity counters (cap + used + remaining). */
  velocity?: Record<string, VelocityState>;
}

export interface PrizeDetail {
  fungibleAmount?: number;
  fungibleToken?: string;
  nftCount?: number;
  /** Raw NFT refs captured at win time — enriched lazily on the client. */
  nfts?: PrizeNftRef[];
}

export interface PoolResult {
  poolId: number;
  poolName: string;
  entriesBought: number;
  amountSpent: number;
  /**
   * Canonical pool fee token (v2+ sessions). "HBAR" for native, a
   * Hedera token id (e.g. "0.0.8011209") for FTs. Absent on legacy
   * records — callers should treat the missing case as "HBAR" since
   * all pre-v2 spend is HBAR by construction.
   */
  feeTokenId?: string;
  rolled: boolean;
  wins: number;
  prizeDetails: PrizeDetail[];
}

export interface PlaySession {
  sessionId: string;
  userId: string;
  timestamp: string;
  strategyName: string;
  strategyVersion: string;
  boostBps: number;
  poolsEvaluated: number;
  poolsPlayed: number;
  poolResults: PoolResult[];
  totalSpent: number;
  /**
   * Per-token spend (v2+ sessions). Same key space as prizesByToken:
   * "HBAR" for native, Hedera token id for FTs. Absent on legacy
   * records — callers should synthesize `{ HBAR: totalSpent }` when
   * missing since pre-v2 spend is HBAR-only.
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

export interface HistoryResponse {
  userId: string;
  sessions: PlaySession[];
}

// ---------------------------------------------------------------------------
// Prize claim status — pulled from /api/user/prize-status which queries the
// LazyLotto dApp for prizes currently sitting in the contract waiting for the
// user's EOA to claim them. "Claimed" is derived (totalWon - pending). The
// agent's internal HBAR/LAZY balance is a SEPARATE concept — that tracks
// deposits the user made for the agent to spend, and is never incremented
// by prizes.
// ---------------------------------------------------------------------------

export type PrizeStatusResponse =
  | {
      available: true;
      pending: {
        count: number;
        byToken: Record<string, number>;
        nftCount: number;
        nfts: { token: string; hederaId: string; serials: number[] }[];
      };
      totalWon: {
        byToken: Record<string, number>;
        nftCount: number;
      };
      claimed: {
        byToken: Record<string, number>;
        nftCount: number;
      };
    }
  | { available: false; reason: string };

export interface PublicStats {
  agentName: string;
  network: string;
  agentWallet: string | null;
  users: { total: number; active: number };
  rake: { defaultPercent: number };
  tvl: Record<string, number>;
  hcs20TopicId: string | null;
  // Operational status — "open for business" / "temporarily closed"
  acceptingOperations?: boolean;
  statusMessage?: string;
  statusReason?: string | null;
}
