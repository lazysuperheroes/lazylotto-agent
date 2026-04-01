import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let mcpClient: McpClient | null = null;

export async function getMcpClient(): Promise<McpClient> {
  if (mcpClient) return mcpClient;

  const url = process.env.LAZYLOTTO_MCP_URL;
  if (!url) throw new Error('Missing LAZYLOTTO_MCP_URL in environment');

  const { createRequire } = await import('node:module');
  const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
  mcpClient = new McpClient({ name: 'lazylotto-agent', version: pkg.version });

  const headers: Record<string, string> = {};
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
  args: Record<string, unknown> = {}
): Promise<T> {
  const client = await getMcpClient();
  const result = await client.callTool({ name: toolName, arguments: args });

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

export interface UserState {
  entriesByPool: Record<number, number>;
  pendingPrizesCount: number;
  pendingPrizes: unknown[];
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

  return {
    entriesByPool,
    pendingPrizesCount: raw.pendingPrizesCount ?? 0,
    pendingPrizes: raw.pendingPrizes ?? [],
    boost: raw.boost ?? 0,
  };
}

export async function listPools(
  type: 'all' | 'global' | 'community' = 'all',
  offset = 0,
  limit = 20
): Promise<PoolSummary[]> {
  const raw = await callTool<any[]>('lazylotto_list_pools', { type, offset, limit });
  const arr = Array.isArray(raw) ? raw : (raw as any)?.pools ?? [];
  return arr.map(mapPoolSummary);
}

export async function getPool(poolId: number): Promise<PoolDetail> {
  const raw = await callTool<any>('lazylotto_get_pool', { poolId });
  return mapPoolDetail(raw);
}

export async function getUserState(address: string): Promise<UserState> {
  const raw = await callTool<any>('lazylotto_get_user_state', { address });
  return mapUserState(raw);
}

export async function calculateEv(
  poolId: number,
  address?: string
): Promise<EvCalculation> {
  const args: Record<string, unknown> = { poolId };
  if (address) args.address = address;
  const raw = await callTool<any>('lazylotto_calculate_ev', args);
  return mapEvCalculation(raw);
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const raw = await callTool<any>('lazylotto_get_system_info');
  return mapSystemInfo(raw);
}

export async function checkPrerequisites(
  address: string,
  poolId: number,
  action: string,
  count = 1
): Promise<unknown[]> {
  return callTool('lazylotto_check_prerequisites', {
    address,
    poolId,
    action,
    count,
  });
}

export async function buyEntries(
  poolId: number,
  count: number,
  action: string,
  address: string
) {
  return callTool('lazylotto_buy_entries', { poolId, count, action, address });
}

export async function roll(poolId: number, address: string, count?: number) {
  const args: Record<string, unknown> = { poolId, address };
  if (count !== undefined) args.count = count;
  return callTool('lazylotto_roll', args);
}

export async function closeMcpClient(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close();
    mcpClient = null;
  }
}
