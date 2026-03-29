import {
  Client,
  AccountId,
  PrivateKey,
  AccountBalanceQuery,
  Hbar,
} from '@hashgraph/sdk';

export interface WalletInfo {
  accountId: AccountId;
  client: Client;
  hbarBalance: Hbar;
  network: string;
}

export function createClient(): Client {
  const network = process.env.HEDERA_NETWORK ?? 'testnet';
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;

  if (!accountId || !privateKey) {
    throw new Error(
      'Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY in environment'
    );
  }

  const client =
    network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();

  client.setOperator(accountId, privateKey);
  return client;
}

export async function getWalletInfo(client: Client): Promise<WalletInfo> {
  const operatorId = client.operatorAccountId;
  if (!operatorId) {
    throw new Error('Client has no operator set');
  }

  const balance = await new AccountBalanceQuery()
    .setAccountId(operatorId)
    .execute(client);

  return {
    accountId: operatorId,
    client,
    hbarBalance: balance.hbars,
    network: process.env.HEDERA_NETWORK ?? 'testnet',
  };
}

export function getOperatorAccountId(client: Client): string {
  const id = client.operatorAccountId;
  if (!id) throw new Error('Client has no operator set');
  return id.toString();
}

export function getPrivateKey(): PrivateKey {
  const key = process.env.HEDERA_PRIVATE_KEY;
  if (!key) throw new Error('Missing HEDERA_PRIVATE_KEY in environment');
  return PrivateKey.fromStringDer(key);
}
