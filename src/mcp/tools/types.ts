/**
 * Shared types and context for MCP tool modules.
 *
 * The ServerContext bundles the helpers, state references, and
 * environment values that every tool registration function needs,
 * so each module can stay decoupled from server.ts internals.
 */

import type { Client } from '@hashgraph/sdk';

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

  /** Check auth for fund-moving operations. Returns error result if auth fails. */
  requireAuth: (providedToken?: string) => ToolResult | null;
}
