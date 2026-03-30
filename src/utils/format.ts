/**
 * Shared formatting and conversion utilities.
 * Eliminates duplicate helpers across the codebase.
 */

import { AccountId } from '@hashgraph/sdk';
import type { TokenBalance } from '../hedera/mirror.js';
import { roundToDecimals } from './math.js';

/** Extract human-readable balance for a token from mirror node data (rounded to token decimals). */
export function tokenBalanceToNumber(
  tokens: TokenBalance[],
  tokenId: string
): number {
  const t = tokens.find((tok) => tok.token_id === tokenId);
  if (!t) return 0;
  return roundToDecimals(t.balance / Math.pow(10, t.decimals), t.decimals);
}

/** Convert a single token balance entry to human-readable number. */
export function tokenEntryToHuman(t: { balance: number; decimals: number }): number {
  return roundToDecimals(t.balance / Math.pow(10, t.decimals), t.decimals);
}

/** Convert Hbar object to number (in HBAR, not tinybars). */
export function hbarToNumber(hbar: { toTinybars(): { toString(): string } }): number {
  return Number(hbar.toTinybars().toString()) / 1e8;
}

/** Format unknown error to string. */
export function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert Hedera account ID to EVM address (0x-prefixed). */
export function toEvmAddress(hederaId: string): string {
  if (hederaId.startsWith('0x')) return hederaId;
  return '0x' + AccountId.fromString(hederaId).toSolidityAddress();
}
