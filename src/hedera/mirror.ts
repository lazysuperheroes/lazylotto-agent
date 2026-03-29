import { HEDERA_DEFAULTS } from '../config/defaults.js';

type Network = 'testnet' | 'mainnet';

function baseUrl(): string {
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as Network;
  return HEDERA_DEFAULTS.mirrorNodeUrl[network] ?? HEDERA_DEFAULTS.mirrorNodeUrl.testnet;
}

async function mirrorGet<T>(path: string): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Mirror node ${res.status}: ${url}`);
  }
  return res.json() as Promise<T>;
}

export interface TokenBalance {
  token_id: string;
  balance: number;
  decimals: number;
}

export interface AccountTokensResponse {
  tokens: TokenBalance[];
  links?: { next?: string };
}

export async function getTokenBalances(
  accountId: string
): Promise<TokenBalance[]> {
  const data = await mirrorGet<AccountTokensResponse>(
    `/accounts/${accountId}/tokens`
  );
  return data.tokens;
}

export async function getHbarBalance(accountId: string): Promise<number> {
  const data = await mirrorGet<{ balance: { balance: number } }>(
    `/balances?account.id=${accountId}`
  );
  return data.balance.balance;
}

export interface NftInfo {
  token_id: string;
  serial_number: number;
  account_id: string;
  metadata: string;
}

export async function getNfts(accountId: string): Promise<NftInfo[]> {
  const data = await mirrorGet<{ nfts: NftInfo[] }>(
    `/accounts/${accountId}/nfts`
  );
  return data.nfts;
}

export async function getTokenInfo(
  tokenId: string
): Promise<{ symbol: string; decimals: string; name: string }> {
  return mirrorGet(`/tokens/${tokenId}`);
}

export interface TokenAllowance {
  owner: string;
  spender: string;
  token_id: string;
  amount: number;
  amount_granted: number;
}

export async function getTokenAllowances(
  accountId: string
): Promise<TokenAllowance[]> {
  const data = await mirrorGet<{ allowances: TokenAllowance[] }>(
    `/accounts/${accountId}/allowances/tokens`
  );
  return data.allowances ?? [];
}

export async function waitForMirrorNode(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, HEDERA_DEFAULTS.mirrorNodeDelay)
  );
}
