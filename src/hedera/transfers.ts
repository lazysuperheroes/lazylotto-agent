/**
 * Shared transfer transaction builders.
 * Eliminates duplicate TransferTransaction construction across the codebase.
 */

import {
  Client,
  AccountId,
  Hbar,
  TransferTransaction,
  TokenId,
} from '@hashgraph/sdk';

export interface TransferResult {
  transactionId: string;
}

/** Transfer HBAR between accounts. */
export async function transferHbar(
  client: Client,
  from: string,
  to: string,
  amount: number
): Promise<TransferResult> {
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(from), new Hbar(-amount))
    .addHbarTransfer(AccountId.fromString(to), new Hbar(amount));

  const response = await tx.execute(client);
  await response.getReceipt(client);

  return { transactionId: response.transactionId.toString() };
}

/** Transfer a fungible token between accounts.
 *  Amount is in human-readable units (e.g., 100 LAZY, not 1000 base units). */
export async function transferToken(
  client: Client,
  from: string,
  to: string,
  tokenId: string,
  amount: number,
  decimals?: number
): Promise<TransferResult> {
  // Look up decimals from token registry if not provided
  if (decimals === undefined) {
    const { getTokenMeta } = await import('../utils/math.js');
    const meta = await getTokenMeta(tokenId);
    decimals = meta.decimals;
  }
  const baseUnits = Math.round(amount * Math.pow(10, decimals));
  const tokenIdObj = TokenId.fromString(tokenId);
  const fromId = AccountId.fromString(from);
  const toId = AccountId.fromString(to);

  const tx = new TransferTransaction()
    .addTokenTransfer(tokenIdObj, fromId, -baseUnits)
    .addTokenTransfer(tokenIdObj, toId, baseUnits);

  const response = await tx.execute(client);
  await response.getReceipt(client);

  return { transactionId: response.transactionId.toString() };
}
