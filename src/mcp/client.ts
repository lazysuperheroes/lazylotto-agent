import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let mcpClient: McpClient | null = null;

export async function getMcpClient(): Promise<McpClient> {
  if (mcpClient) return mcpClient;

  const url = process.env.LAZYLOTTO_MCP_URL;
  if (!url) throw new Error('Missing LAZYLOTTO_MCP_URL in environment');

  mcpClient = new McpClient({ name: 'lazylotto-agent', version: '0.1.0' });

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

export interface PoolSummary {
  poolId: number;
  name: string;
  winRate: number;
  winRatePercent: number;
  entryFee: number;
  feeTokenSymbol: string;
  prizeCount: number;
  outstandingEntries: number;
  paused: boolean;
  closed: boolean;
}

export interface PoolDetail extends PoolSummary {
  owner: string;
  platformFeePercent: number;
  ticketCID: string;
  winCID: string;
  feeTokenId: string;
}

export interface PrizePackage {
  index: number;
  hbarAmount: string;
  tokens: { tokenId: string; symbol: string; amount: string }[];
  nfts: { tokenId: string; serials: number[] }[];
}

export interface UserState {
  entriesByPool: Record<number, number>;
  pendingPrizesCount: number;
  pendingPrizes: unknown[];
  boost: number;
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
  network: string;
  totalPools: number;
}

export async function listPools(
  type: 'all' | 'global' | 'community' = 'all',
  offset = 0,
  limit = 20
): Promise<PoolSummary[]> {
  return callTool('lazylotto_list_pools', { type, offset, limit });
}

export async function getPool(poolId: number): Promise<PoolDetail> {
  return callTool('lazylotto_get_pool', { poolId });
}

export async function getPrizes(
  poolId: number,
  offset = 0,
  limit = 20
): Promise<PrizePackage[]> {
  return callTool('lazylotto_get_prizes', { poolId, offset, limit });
}

export async function getUserState(address: string): Promise<UserState> {
  return callTool('lazylotto_get_user_state', { address });
}

export async function calculateEv(
  poolId: number,
  address?: string
): Promise<EvCalculation> {
  const args: Record<string, unknown> = { poolId };
  if (address) args.address = address;
  return callTool('lazylotto_calculate_ev', args);
}

export async function getSystemInfo(): Promise<SystemInfo> {
  return callTool('lazylotto_get_system_info');
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

export async function transferPrizes(
  address: string,
  recipientAddress: string,
  index?: number
) {
  const args: Record<string, unknown> = { address, recipientAddress };
  if (index !== undefined) args.index = index;
  return callTool('lazylotto_transfer_prizes', args);
}

export async function closeMcpClient(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close();
    mcpClient = null;
  }
}
