import {
  Client,
  TokenAssociateTransaction,
  AccountAllowanceApproveTransaction,
  TokenId,
  AccountId,
  NftId,
} from '@hashgraph/sdk';
import { getOperatorAccountId } from './wallet.js';

export async function associateToken(
  client: Client,
  tokenId: string
): Promise<void> {
  const operatorId = getOperatorAccountId(client);
  const tx = new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(operatorId))
    .setTokenIds([TokenId.fromString(tokenId)]);

  const response = await tx.execute(client);
  await response.getReceipt(client);
}

export async function associateTokens(
  client: Client,
  tokenIds: string[]
): Promise<void> {
  if (tokenIds.length === 0) return;

  const operatorId = getOperatorAccountId(client);
  const tx = new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(operatorId))
    .setTokenIds(tokenIds.map((id) => TokenId.fromString(id)));

  const response = await tx.execute(client);
  await response.getReceipt(client);
}

export async function approveFungibleToken(
  client: Client,
  tokenId: string,
  spender: string,
  amount: number
): Promise<void> {
  const operatorId = getOperatorAccountId(client);
  const tx = new AccountAllowanceApproveTransaction().approveTokenAllowance(
    TokenId.fromString(tokenId),
    AccountId.fromString(operatorId),
    AccountId.fromString(spender),
    amount
  );

  const response = await tx.execute(client);
  await response.getReceipt(client);
}

export async function approveNftCollection(
  client: Client,
  tokenId: string,
  spender: string
): Promise<void> {
  const operatorId = getOperatorAccountId(client);
  const tx =
    new AccountAllowanceApproveTransaction().approveTokenNftAllowanceAllSerials(
      TokenId.fromString(tokenId),
      AccountId.fromString(operatorId),
      AccountId.fromString(spender)
    );

  const response = await tx.execute(client);
  await response.getReceipt(client);
}

/**
 * Set up standard LazyLotto approvals:
 * - LAZY token → GasStation
 * - Other tokens → Storage
 */
export async function setupApprovals(
  client: Client,
  options: {
    lazyTokenId: string;
    gasStationId: string;
    storageId: string;
    lazyAmount?: number;
  }
): Promise<void> {
  const { lazyTokenId, gasStationId, storageId, lazyAmount = 10_000 } = options;

  console.log(`Approving ${lazyAmount} LAZY to GasStation (${gasStationId})...`);
  await approveFungibleToken(client, lazyTokenId, gasStationId, lazyAmount);

  console.log('Approvals complete.');
}
