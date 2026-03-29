import {
  Client,
  ContractCallQuery,
  ContractId,
  AccountId,
} from '@hashgraph/sdk';
import { Interface } from 'ethers';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);
const { LazyDelegateRegistryABI } = esmRequire('@lazysuperheroes/lazy-lotto');

const iface = new Interface(LazyDelegateRegistryABI as readonly string[]);

function toEvmAddress(hederaId: string): string {
  if (hederaId.startsWith('0x')) return hederaId;
  return '0x' + AccountId.fromString(hederaId).toSolidityAddress();
}

async function contractCall(
  client: Client,
  contractId: string,
  functionName: string,
  args: unknown[],
  gas = 100_000
): Promise<Uint8Array> {
  const encoded = iface.encodeFunctionData(functionName, args);

  const result = await new ContractCallQuery()
    .setContractId(ContractId.fromString(contractId))
    .setGas(gas)
    .setFunctionParameters(Buffer.from(encoded.slice(2), 'hex'))
    .execute(client);

  return result.bytes;
}

// ── Delegation queries ────────────────────────────────────────

export interface DelegatedNfts {
  tokens: string[];
  serials: bigint[][];
}

/**
 * Get all NFTs delegated TO a delegate address.
 * Calls getNFTsDelegatedTo(address) → (address[], uint256[][])
 */
export async function getDelegatedNfts(
  client: Client,
  registryContractId: string,
  delegateAddress: string
): Promise<DelegatedNfts> {
  const delegateEvm = toEvmAddress(delegateAddress);

  const bytes = await contractCall(
    client,
    registryContractId,
    'getNFTsDelegatedTo',
    [delegateEvm],
    500_000
  );

  const [tokens, serials] = iface.decodeFunctionResult(
    'getNFTsDelegatedTo',
    bytes
  );

  return {
    tokens: (tokens as string[]).map((t: string) => t),
    serials: (serials as bigint[][]).map((s: bigint[]) => [...s]),
  };
}

/**
 * Get specific NFT serials of a token delegated TO a delegate.
 * Calls getSerialsDelegatedTo(address, address) → uint256[]
 */
export async function getSerialsDelegatedTo(
  client: Client,
  registryContractId: string,
  delegateAddress: string,
  tokenAddress: string
): Promise<bigint[]> {
  const delegateEvm = toEvmAddress(delegateAddress);
  const tokenEvm = toEvmAddress(tokenAddress);

  const bytes = await contractCall(
    client,
    registryContractId,
    'getSerialsDelegatedTo',
    [delegateEvm, tokenEvm]
  );

  const [serials] = iface.decodeFunctionResult(
    'getSerialsDelegatedTo',
    bytes
  );

  return [...(serials as bigint[])];
}

/**
 * Check if a specific NFT serial is delegated to a delegate.
 * Calls checkDelegateToken(address, address, uint256) → bool
 */
export async function checkDelegateToken(
  client: Client,
  registryContractId: string,
  delegateAddress: string,
  tokenAddress: string,
  serial: number | bigint
): Promise<boolean> {
  const delegateEvm = toEvmAddress(delegateAddress);
  const tokenEvm = toEvmAddress(tokenAddress);

  const bytes = await contractCall(
    client,
    registryContractId,
    'checkDelegateToken',
    [delegateEvm, tokenEvm, serial]
  );

  const [result] = iface.decodeFunctionResult('checkDelegateToken', bytes);
  return result as boolean;
}

/**
 * Check if a wallet is delegated to a delegate.
 * Calls checkDelegateWallet(address, address) → bool
 */
export async function checkDelegateWallet(
  client: Client,
  registryContractId: string,
  ownerAddress: string,
  delegateAddress: string
): Promise<boolean> {
  const ownerEvm = toEvmAddress(ownerAddress);
  const delegateEvm = toEvmAddress(delegateAddress);

  const bytes = await contractCall(
    client,
    registryContractId,
    'checkDelegateWallet',
    [ownerEvm, delegateEvm]
  );

  const [result] = iface.decodeFunctionResult('checkDelegateWallet', bytes);
  return result as boolean;
}
