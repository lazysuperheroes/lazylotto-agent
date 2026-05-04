import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let mcpClient: McpClient | null = null;

export async function getMcpClient(): Promise<McpClient> {
  if (mcpClient) return mcpClient;

  const url = process.env.LAZYLOTTO_MCP_URL;
  if (!url) throw new Error('Missing LAZYLOTTO_MCP_URL in environment');

  let version = '0.1.1';
  try {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
    version = pkg.version;
  } catch {
    // Serverless: package.json may not be on the filesystem
  }
  mcpClient = new McpClient({ name: 'lazylotto-agent', version });

  // Opt into the dApp's autonomous intent mode (Phase 1 of the v3 envelope):
  // dApp skips the Redis intent-record write and omits executeUrl. We sign and
  // submit locally via Hedera SDK, so the executeUrl was never used anyway.
  const headers: Record<string, string> = {
    'X-MCP-Intent-Mode': 'autonomous',
  };
  const apiKey = process.env.LAZYLOTTO_MCP_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });

  await mcpClient.connect(transport);
  return mcpClient;
}

export async function callTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown> = {},
  _retry = false,
): Promise<T> {
  let client: McpClient;
  try {
    client = await getMcpClient();
  } catch (e) {
    if (!_retry) {
      // Connection may be stale — reset and retry once
      mcpClient = null;
      return callTool(toolName, args, true);
    }
    throw e;
  }

  let result;
  try {
    result = await client.callTool({ name: toolName, arguments: args });
  } catch (e) {
    if (!_retry) {
      // Transport error — reset client and retry once
      mcpClient = null;
      return callTool(toolName, args, true);
    }
    throw e;
  }

  const content = result.content as { type: string; text?: string }[] | undefined;

  if (result.isError) {
    const text =
      content
        ?.map((c) => (c.type === 'text' ? c.text : ''))
        .join('') ?? 'Unknown MCP error';
    throw new Error(`MCP tool ${toolName} failed: ${text}`);
  }

  const textContent = content?.find((c) => c.type === 'text');

  if (!textContent?.text) {
    throw new Error(`MCP tool ${toolName} returned no text content`);
  }

  return JSON.parse(textContent.text) as T;
}

// ── Typed MCP tool wrappers ───────────────────────────────────

// ── Internal interfaces (agent's canonical types) ────────────

export interface PoolSummary {
  poolId: number;
  name: string;
  winRatePercent: number;
  entryFee: number;
  feeTokenSymbol: string;
  prizeCount: number;
  outstandingEntries: number;
  paused: boolean;
  closed: boolean;
  /** Trust level from displayInfo — used for pool recommendations. */
  trustLevel: string | null;
}

export interface PoolDetail extends PoolSummary {
  owner: string;
  platformFeePercent: number;
  ticketCID: string;
  winCID: string;
  /** Token ID for the fee token. null/empty = HBAR (native). */
  feeTokenId: string;
}

/**
 * A specific NFT (or batch of serials from the same collection) won in a pool.
 * Shape matches lotto_get_user_state.pendingPrizes[].nfts as documented in
 * lazy-dapp-v3/docs/features/MCP_NFT_PRIZE_ENRICHMENT.md
 */
export interface NftPrizeRef {
  /** On-chain symbol from mirror node (e.g. "HSuite", "LSH Comic #1"). */
  token: string;
  /** Hedera token ID ("0.0.X") — the canonical lookup key. */
  hederaId: string;
  /** Serial numbers the user has won for this token. */
  serials: number[];
}

export interface PendingPrize {
  poolId: number;
  asNFT: boolean;
  fungiblePrize: { token: string; amount: number };
  /** NFTs awarded in this prize. Empty array if pure fungible. */
  nfts: NftPrizeRef[];
}

export interface UserState {
  entriesByPool: Record<number, number>;
  pendingPrizesCount: number;
  pendingPrizes: PendingPrize[];
  boost: number | { rawBps: number; percent: number };
}

export interface EvCalculation {
  poolId: number;
  entryCost: number;
  effectiveWinRate: number;
  avgPrizeValue: number;
  expectedValue: number;
  recommendation: string;
}

export interface SystemInfo {
  contractAddresses: {
    lazyLotto: string;
    storage: string;
    poolManager: string;
    gasStation: string;
  };
  lazyToken: string;
  lazyDecimals: number;
  network: string;
  totalPools: number;
}

// ── MCP response mapping layer ───────────────────────────────
// Translates MCP wire format to agent internal types.
// Handles both v1 (current) and v2 (post-delta) field names.

function mapPoolSummary(raw: any): PoolSummary {
  const poolId = raw.poolId ?? raw.id ?? 0;
  return {
    poolId,
    name: raw.displayInfo?.name ?? raw.name ?? `Pool #${poolId}`,
    winRatePercent: raw.winRatePercent ?? 0,
    entryFee: raw.entryFee ?? 0,
    feeTokenSymbol: raw.feeTokenSymbol ?? 'HBAR',
    prizeCount: raw.prizeCount ?? 0,
    outstandingEntries: raw.outstandingEntries ?? 0,
    paused: raw.paused ?? false,
    closed: raw.closed ?? false,
    trustLevel: raw.displayInfo?.trustLevel ?? null,
  };
}

function mapPoolDetail(raw: any): PoolDetail {
  // feeTokenId: MCP returns "HBAR" for native token. Map to empty string
  // (agent uses empty/null for HBAR, token ID string for FTs).
  const rawFeeToken = raw.feeTokenId ?? raw.feeTokenHederaId ?? 'HBAR';
  const feeTokenId = rawFeeToken === 'HBAR' ? '' : rawFeeToken;

  return {
    ...mapPoolSummary(raw),
    owner: raw.owner ?? '',
    platformFeePercent: raw.platformFeePercent ?? 0,
    ticketCID: raw.ticketCID ?? '',
    winCID: raw.winCID ?? '',
    feeTokenId,
  };
}

function mapEvCalculation(raw: any): EvCalculation {
  return {
    poolId: raw.poolId ?? 0,
    entryCost: raw.entryCost ?? 0,
    // Agent uses decimal; MCP returns percent
    effectiveWinRate: raw.effectiveWinRate ?? (raw.effectiveWinRatePercent ?? 0) / 100,
    avgPrizeValue: raw.avgPrizeValue ?? raw.prizeBreakdown?.avgFungiblePrizeValue ?? 0,
    expectedValue: raw.expectedValue ?? raw.fungibleEvPerEntry ?? 0,
    recommendation: raw.recommendation ?? '',
  };
}

function mapSystemInfo(raw: any): SystemInfo {
  // Handle both v1 (contracts/tokens) and v2 (contractAddresses/lazyToken) shapes
  const contracts = raw.contractAddresses ?? raw.contracts ?? {};
  const lazyTokenObj = raw.lazyToken;
  const lazyTokenId = typeof lazyTokenObj === 'string'
    ? lazyTokenObj
    : lazyTokenObj?.id ?? raw.tokens?.lazy ?? '';
  const lazyDecimals = typeof lazyTokenObj === 'object'
    ? lazyTokenObj?.decimals ?? 1
    : raw.tokens?.lazyDecimals ?? 1;

  return {
    contractAddresses: {
      lazyLotto: contracts.lazyLotto ?? '',
      storage: contracts.storage ?? '',
      poolManager: contracts.poolManager ?? '',
      gasStation: contracts.gasStation ?? '',
    },
    lazyToken: lazyTokenId,
    lazyDecimals,
    network: raw.network ?? '',
    totalPools: raw.totalPools ?? 0,
  };
}

function mapUserState(raw: any): UserState {
  // entriesByPool: MCP returns array [{poolId, entries}], agent wants Record<number, number>
  let entriesByPool: Record<number, number> = {};
  if (Array.isArray(raw.entriesByPool)) {
    entriesByPool = Object.fromEntries(
      raw.entriesByPool.map((e: any) => [e.poolId, e.entries ?? e.count ?? 0])
    );
  } else if (raw.entriesByPool && typeof raw.entriesByPool === 'object') {
    entriesByPool = raw.entriesByPool;
  }

  // Map pendingPrizes with the new NFT enrichment shape.
  // Backward compat: older dApp builds returned nftPrizes as a count;
  // new builds return nfts: NftPrizeRef[]. We prefer nfts when present.
  const pendingPrizes: PendingPrize[] = (raw.pendingPrizes ?? []).map((p: any) => ({
    poolId: p.poolId ?? 0,
    asNFT: p.asNFT ?? false,
    fungiblePrize: {
      token: p.fungiblePrize?.token ?? 'HBAR',
      amount: Number(p.fungiblePrize?.amount ?? 0),
    },
    nfts: Array.isArray(p.nfts)
      ? p.nfts.map((n: any) => ({
          token: String(n.token ?? ''),
          hederaId: String(n.hederaId ?? ''),
          serials: Array.isArray(n.serials) ? n.serials.map((s: unknown) => Number(s)) : [],
        }))
      : [],
  }));

  return {
    entriesByPool,
    pendingPrizesCount: raw.pendingPrizesCount ?? 0,
    pendingPrizes,
    boost: raw.boost ?? 0,
  };
}

export async function listPools(
  type: 'all' | 'global' | 'community' = 'all',
  offset = 0,
  limit = 20
): Promise<PoolSummary[]> {
  const raw = await callTool<any[]>('lotto_list_pools', { type, offset, limit });
  const arr = Array.isArray(raw) ? raw : (raw as any)?.pools ?? [];
  return arr.map(mapPoolSummary);
}

export async function getPool(poolId: number): Promise<PoolDetail> {
  const raw = await callTool<any>('lotto_get_pool', { poolId });
  return mapPoolDetail(raw);
}

export async function getUserState(address: string): Promise<UserState> {
  const raw = await callTool<any>('lotto_get_user_state', { address });
  return mapUserState(raw);
}

export async function calculateEv(
  poolId: number,
  address?: string
): Promise<EvCalculation> {
  const args: Record<string, unknown> = { poolId };
  if (address) args.address = address;
  const raw = await callTool<any>('lotto_calculate_ev', args);
  return mapEvCalculation(raw);
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const raw = await callTool<any>('lotto_get_system_info');
  return mapSystemInfo(raw);
}

export async function checkPrerequisites(
  address: string,
  poolId: number,
  action: string,
  count = 1
): Promise<unknown[]> {
  return callTool('lotto_check_prerequisites', {
    address,
    poolId,
    action,
    count,
  });
}

// Phase 1.12 split: dApp replaced lazylotto_buy_entries(action) with three
// dedicated tools (lotto_buy_entries, lotto_buy_and_roll, lotto_buy_and_redeem)
// that take {poolId, count, address} — no action param. We keep this wrapper's
// signature so callers (LottoAgent) don't need to change, and route by action.
// Exported for the dispatch test in client.test.ts.
export const BUY_TOOL_BY_ACTION: Record<string, string> = {
  buy: 'lotto_buy_entries',
  buy_and_roll: 'lotto_buy_and_roll',
  buy_and_redeem: 'lotto_buy_and_redeem',
};

export async function buyEntries(
  poolId: number,
  count: number,
  action: string,
  address: string
) {
  const toolName = BUY_TOOL_BY_ACTION[action];
  if (!toolName) {
    throw new Error(`buyEntries: unknown action '${action}'`);
  }
  return callTool(toolName, { poolId, count, address });
}

export async function roll(poolId: number, address: string, count?: number) {
  const args: Record<string, unknown> = { poolId, address };
  if (count !== undefined) args.count = count;
  return callTool('lotto_roll', args);
}

export async function closeMcpClient(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close();
    mcpClient = null;
  }
}

// Exported for testing
export { mapPoolSummary, mapPoolDetail, mapEvCalculation, mapUserState, mapSystemInfo };
