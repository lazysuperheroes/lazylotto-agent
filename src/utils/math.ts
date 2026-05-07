/**
 * Financial math utilities with per-token decimal precision.
 *
 * All rounding uses the token's native decimal places to eliminate
 * floating-point drift. The TOKEN_REGISTRY maps token IDs to their
 * metadata (decimals + display symbol).
 */

import { getTokenInfo } from '../hedera/mirror.js';

// ── Token Registry ────────────────────────────────────────────

export interface TokenMeta {
  decimals: number;
  symbol: string;
}

/** Token metadata keyed by token ID. "hbar" for native HBAR. */
const TOKEN_REGISTRY = new Map<string, TokenMeta>([
  ['hbar', { decimals: 8, symbol: 'HBAR' }],
]);

/** Register a token's metadata. Idempotent. */
export function registerToken(
  tokenId: string,
  decimals: number,
  symbol: string
): void {
  TOKEN_REGISTRY.set(tokenId, { decimals, symbol });
}

/** Get token metadata. Returns cached entry or queries mirror node. */
export async function getTokenMeta(tokenId: string): Promise<TokenMeta> {
  const cached = TOKEN_REGISTRY.get(tokenId);
  if (cached) return cached;

  if (tokenId === 'hbar') {
    return { decimals: 8, symbol: 'HBAR' };
  }

  // R3-FG-20 (round-3 P10-TOK-001): NEVER cache a failed lookup as
  // `{decimals: 0}`. Pre-fix code did exactly that — a single mirror
  // blip on first lookup of a new token cemented 0 decimals
  // permanently in the warm Lambda's process. Every subsequent
  // transfer/withdrawal of that token computed
  // `Math.round(amount * 10^0)` → user got whole-token amounts (or
  // base-unit shifts, depending on direction). Now: rethrow on
  // failure so callers fail loudly and the next call retries the
  // lookup against a recovered mirror. Also R3-FG-67 — validate
  // decimals is a non-negative finite integer before caching.
  const info = await getTokenInfo(tokenId);
  const decimals = Number(info.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(
      `Token ${tokenId} returned malformed decimals=${info.decimals} from mirror node — ` +
      `refusing to cache. Investigate the mirror response.`,
    );
  }
  const meta: TokenMeta = {
    decimals,
    symbol: info.symbol || tokenId,
  };
  TOKEN_REGISTRY.set(tokenId, meta);
  return meta;
}

/** Get cached token metadata (sync). Returns undefined if not registered. */
export function getTokenMetaSync(tokenId: string): TokenMeta | undefined {
  return TOKEN_REGISTRY.get(tokenId);
}

/** Get decimals for a token (sync, cached only). Returns 0 if unknown. */
export function getDecimalsSync(tokenId: string): number {
  return TOKEN_REGISTRY.get(tokenId)?.decimals ?? 0;
}

/** Get display symbol for a token. Returns token ID if unknown. */
export function getSymbol(tokenId: string): string {
  return TOKEN_REGISTRY.get(tokenId)?.symbol ?? tokenId;
}

/** Initialize the registry from environment. Call once at startup. */
export function initTokenRegistry(): void {
  const lazyTokenId = process.env.LAZY_TOKEN_ID;
  if (lazyTokenId) {
    registerToken(lazyTokenId, 1, 'LAZY');
  }
}

// ── Rounding ──────────────────────────────────────────────────

/**
 * Round a number to a token's minimum denomination.
 *
 * @param amount  - The value to round
 * @param decimals - Token decimal places (8 for HBAR, 1 for LAZY, etc.)
 * @returns Rounded value
 *
 * @example roundToDecimals(0.123456789, 8) → 0.12345679  (HBAR precision)
 * @example roundToDecimals(0.15, 1) → 0.2  (LAZY precision)
 */
export function roundToDecimals(amount: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(amount * factor) / factor;
}

/**
 * Round a financial amount using a token's registered decimals.
 * Falls back to raw amount if token not in registry.
 */
export function roundForToken(amount: number, tokenId: string): number {
  const meta = TOKEN_REGISTRY.get(tokenId);
  if (!meta) return amount;
  return roundToDecimals(amount, meta.decimals);
}

/**
 * Round a USD amount to cents (2 decimal places).
 */
export function roundUsd(amount: number): number {
  return roundToDecimals(amount, 2);
}
