import { HEDERA_DEFAULTS } from '../config/defaults.js';

type Network = 'testnet' | 'mainnet';

function baseUrl(): string {
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as Network;
  return HEDERA_DEFAULTS.mirrorNodeUrl[network] ?? HEDERA_DEFAULTS.mirrorNodeUrl.testnet;
}

async function mirrorGet<T>(path: string): Promise<T> {
  // Handle pagination next links which include /api/v1 prefix
  let url: string;
  if (path.startsWith('/api/v1')) {
    const base = baseUrl();
    // Strip /api/v1 from base to get the origin
    const origin = base.replace(/\/api\/v1$/, '');
    url = `${origin}${path}`;
  } else {
    url = `${baseUrl()}${path}`;
  }
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
  const all: TokenBalance[] = [];
  let next: string | null = `/accounts/${accountId}/tokens?limit=100`;

  while (next) {
    const data: AccountTokensResponse = await mirrorGet<AccountTokensResponse>(next);
    all.push(...(data.tokens ?? []));
    next = data.links?.next ?? null;
  }

  return all;
}

export interface NftInfo {
  token_id: string;
  serial_number: number;
  account_id: string;
  metadata: string;
}

interface NftPageResponse { nfts: NftInfo[]; links?: { next?: string } }

export async function getNfts(accountId: string): Promise<NftInfo[]> {
  const all: NftInfo[] = [];
  let next: string | null = `/accounts/${accountId}/nfts?limit=100`;

  while (next) {
    const data: NftPageResponse = await mirrorGet<NftPageResponse>(next);
    all.push(...(data.nfts ?? []));
    next = data.links?.next ?? null;
  }

  return all;
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

interface AllowancePageResponse { allowances: TokenAllowance[]; links?: { next?: string } }

export async function getTokenAllowances(
  accountId: string
): Promise<TokenAllowance[]> {
  const all: TokenAllowance[] = [];
  let next: string | null = `/accounts/${accountId}/allowances/tokens?limit=100`;

  while (next) {
    const data: AllowancePageResponse = await mirrorGet<AllowancePageResponse>(next);
    all.push(...(data.allowances ?? []));
    next = data.links?.next ?? null;
  }

  return all;
}

export interface MirrorTransaction {
  transaction_id: string;
  consensus_timestamp: string;
  memo_base64: string;
  result: string;
  transfers: { account: string; amount: number }[];
  token_transfers: { token_id: string; account: string; amount: number }[];
}

export async function getTransactionsByAccount(
  accountId: string,
  options?: {
    timestampGt?: string;
    transactionType?: string;
    limit?: number;
    order?: 'asc' | 'desc';
  }
): Promise<MirrorTransaction[]> {
  let path = `/transactions?account.id=${accountId}`;
  if (options?.timestampGt) path += `&timestamp=gt:${options.timestampGt}`;
  if (options?.transactionType)
    path += `&transactiontype=${options.transactionType}`;
  path += `&limit=${options?.limit ?? 25}`;
  path += `&order=${options?.order ?? 'asc'}`;

  const data = await mirrorGet<{ transactions: MirrorTransaction[] }>(path);
  return data.transactions ?? [];
}

/**
 * Sum the charged_tx_fee for all transactions by an account within a time range.
 * Used by reconciliation to account for actual network fees paid.
 */
interface FeeTransaction { charged_tx_fee: number; payer_account_id: string }
interface FeePageResponse { transactions: FeeTransaction[]; links?: { next?: string } }

export async function sumTransactionFees(
  accountId: string,
  fromTimestamp?: string,
): Promise<number> {
  let totalTinybar = 0;
  let next: string | null =
    `/transactions?account.id=${accountId}&limit=100&order=asc` +
    (fromTimestamp ? `&timestamp=gt:${fromTimestamp}` : '');

  while (next) {
    const data: FeePageResponse = await mirrorGet<FeePageResponse>(next);

    for (const tx of data.transactions ?? []) {
      if (tx.payer_account_id === accountId) {
        totalTinybar += tx.charged_tx_fee ?? 0;
      }
    }

    next = data.links?.next ?? null;
  }

  return totalTinybar / 1e8; // Convert tinybars to HBAR
}

export async function waitForMirrorNode(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, HEDERA_DEFAULTS.mirrorNodeDelay)
  );
}
