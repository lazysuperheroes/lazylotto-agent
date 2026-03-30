import {
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  TransactionResponse,
  TransactionReceipt,
  Status,
} from '@hashgraph/sdk';
import { GAS_ESTIMATES, HEDERA_DEFAULTS } from '../config/defaults.js';

export interface TransactionIntent {
  contractId: string;
  functionName: string;
  functionSignature: string;
  params: Record<string, unknown>;
  paramsOrdered: unknown[];
  gas: number;
  gasBreakdown: {
    base: number;
    perUnit: number;
    units: number;
    formula: string;
  };
  payableAmount: string;
  payableToken: string;
  payableUnit: string;
  payableHumanReadable: string;
}

export interface IntentResponse {
  type: 'transaction_intent';
  chain: string;
  intent: TransactionIntent;
  abi: unknown[];
  encoded: string;
  humanReadable: string;
  prerequisites: unknown[];
  warnings: string[];
}

export interface TxResult {
  transactionId: string;
  receipt: TransactionReceipt;
  status: Status;
  /** Estimated gas cost in HBAR (from gas parameter, not actual receipt fee). */
  estimatedGasHbar: number;
}

export async function executeIntent(
  client: Client,
  response: IntentResponse
): Promise<TxResult> {
  const { intent, encoded } = response;

  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(intent.contractId))
    .setGas(intent.gas)
    .setFunctionParameters(Buffer.from(encoded.slice(2), 'hex'));

  if (intent.payableToken === 'HBAR' && BigInt(intent.payableAmount) > 0n) {
    tx.setPayableAmount(Hbar.fromTinybars(intent.payableAmount));
  }

  const txResponse: TransactionResponse = await tx.execute(client);
  const receipt = await txResponse.getReceipt(client);

  // Estimate gas cost (Hedera charges ~0.000000082 HBAR per gas unit)
  const estimatedGasHbar = intent.gas * 0.000000082;

  return {
    transactionId: txResponse.transactionId.toString(),
    receipt,
    status: receipt.status,
    estimatedGasHbar,
  };
}

/**
 * Execute a contract call with pre-encoded calldata (hex string starting with 0x).
 * Used for direct calls where the agent encodes via ethers.Interface rather than
 * going through an MCP transaction intent.
 */
export async function executeEncodedCall(
  client: Client,
  contractId: string,
  gas: number,
  encodedCalldata: string,
): Promise<TxResult> {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(gas)
    .setFunctionParameters(Buffer.from(encodedCalldata.slice(2), 'hex'));

  const txResponse: TransactionResponse = await tx.execute(client);
  const receipt = await txResponse.getReceipt(client);

  const estimatedGasHbar = gas * 0.000000082;

  return {
    transactionId: txResponse.transactionId.toString(),
    receipt,
    status: receipt.status,
    estimatedGasHbar,
  };
}

type GasOperation = Exclude<keyof typeof GAS_ESTIMATES, 'maxGas'>;

export function estimateGas(operation: GasOperation, units: number): number {
  const entry = GAS_ESTIMATES[operation];
  const raw = entry.base + entry.perUnit * units;
  const needsMultiplier =
    operation.startsWith('roll') || operation === 'buyAndRollEntry';
  const estimate = needsMultiplier
    ? Math.ceil(raw * HEDERA_DEFAULTS.gasMultiplier)
    : raw;
  return Math.min(estimate, GAS_ESTIMATES.maxGas);
}
