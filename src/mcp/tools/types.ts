/**
 * Shared types and context for MCP tool modules.
 *
 * The ServerContext bundles the helpers, state references, and
 * environment values that every tool registration function needs,
 * so each module can stay decoupled from server.ts internals.
 */

import type { Client } from '@hashgraph/sdk';
import type { AuthContext } from '../../auth/types.js';

// ── MCP tool return shapes ──────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  [x: string]: unknown;
  content: TextContent[];
  isError?: true;
}

// ── Auth result (returned by requireAuth) ───────────────────────

export type AuthResult =
  | { error: ToolResult }
  | { auth: AuthContext };

// ── Session tracking ────────────────────────────────────────────

export interface SessionRecord {
  timestamp: string;
  strategy: string;
  poolsPlayed: number;
  totalEntries: number;
  totalSpent: number;
  totalWins: number;
  currency: string;
}

export interface CumulativeStats {
  sessionsPlayed: number;
  totalEntries: number;
  spentByToken: Record<string, number>;
  winsByToken: Record<string, number>;
}

// ── Context object passed to each register*Tools function ───────

export interface ServerContext {
  client: Client;

  // Pure helpers (stateless)
  json: (data: unknown) => ToolResult;
  errorResult: (message: string) => ToolResult;
  errorMsg: (e: unknown) => string;
  tokenBalance: (tokens: import('../../hedera/mirror.js').TokenBalance[], tokenId: string) => number;
  getOwnerEoa: () => string;
  toEvmAddress: (address: string) => string;

  // Mutable state refs (shared across all modules)
  sessionHistory: SessionRecord[];
  cumulativeStats: CumulativeStats;
  getIsSessionActive: () => boolean;
  setIsSessionActive: (v: boolean) => void;

  /** Auth token for sensitive operations. Null = no auth configured. */
  authToken: string | null;

  /**
   * Check auth for operations. Returns either { auth: AuthContext } on
   * success or { error: ToolResult } on failure.
   */
  requireAuth: (providedToken?: string) => Promise<AuthResult>;

  /**
   * Resolve internal userId from a Hedera account ID.
   * Returns null if the account is not registered.
   */
  resolveUserId: (accountId: string) => string | null;

  /**
   * On-demand deposit detection. Polls the mirror node for new
   * deposits since the last watermark. Returns count processed.
   */
  checkDeposits: () => Promise<number>;

  /**
   * Distributed lock for concurrent play/withdraw prevention.
   * In serverless: Redis SET NX EX with a fence token.
   * In CLI: no-op (returns a dummy token) — in-memory mutex suffices.
   * Returns a fence token string on success, or null if the lock is held.
   * The caller MUST pass the returned token back to releaseUserLock().
   */
  acquireUserLock: (userId: string) => Promise<string | null>;

  /**
   * Release a distributed user lock. Requires the fence token returned
   * by acquireUserLock — releases are no-ops if the token doesn't match.
   */
  releaseUserLock: (userId: string, token: string) => Promise<void>;
}
