/**
 * Types used across the audit page + its testable helpers.
 *
 * Kept in their own file so helpers.ts and extracted components can
 * import without pulling in the client-component surface of page.tsx
 * (which would force the helpers file to be 'use client' and fail
 * in Node test context).
 *
 * These shapes mirror src/custodial/hcs20-v2.ts NormalizedSession but
 * are inlined here so the client doesn't need a server-only import.
 * The reader's state machine produces these alongside the legacy
 * entries[].
 */

export type V2SessionStatus =
  | 'closed_success'
  | 'closed_aborted'
  | 'in_flight'
  | 'orphaned'
  | 'corrupt';

export interface V2PrizeFt { t: 'ft'; tk: string; amt: number }
export interface V2PrizeNft { t: 'nft'; tk: string; sym: string; ser: number[] }
export type V2Prize = V2PrizeFt | V2PrizeNft;

export interface V2NormalizedPool {
  poolId: number;
  seq: number;
  entries: number;
  spent: number;
  spentToken: string;
  wins: number;
  prizes: V2Prize[];
  ts: string;
}

export interface V2NormalizedSession {
  sessionId: string;
  user: string;
  agent?: string;
  status: V2SessionStatus;
  strategy?: string;
  boostBps?: number;
  openedAt?: string;
  closedAt?: string;
  pools: V2NormalizedPool[];
  totalSpent: number;
  totalSpentByToken: Record<string, number>;
  totalWins: number;
  totalPrizeValue: number;
  totalPrizeValueByToken: Record<string, number>;
  totalNftCount: number;
  prizeTransfer?: {
    status: 'succeeded' | 'skipped' | 'failed' | 'recovered';
    txId?: string;
    attempts?: number;
    gasUsed?: number;
    lastError?: string;
  };
  warnings: string[];
  firstSeq: number;
  lastSeq: number;
}
