import {
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  TransactionResponse,
  TransactionReceipt,
  Status,
} from '@hashgraph/sdk';
import { GAS_ESTIMATES, HEDERA_DEFAULTS, PRIZE_TRANSFER_RETRY } from '../config/defaults.js';
import { awaitReceipt, CONTRACT_RECEIPT_TIMEOUT_MS } from './transfers.js';

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

/**
 * Domains the dApp MCP server addresses (v3 envelope, Phase 1).
 * See lazy-dapp-v3/src/server/mcp/core/envelope.ts.
 */
export type IntentDomain =
  | 'lotto'
  | 'staking'
  | 'mints'
  | 'swap'
  | 'vote'
  | 'farms'
  | 'allowances'
  | 'delegate'
  | 'wallet';

export type IntentMode = 'human' | 'autonomous';

export interface IntentResponse {
  type: 'transaction_intent';
  // ── v3 envelope additions (Phase 1) — all optional for backwards
  //    compatibility with v2 dApps. We don't act on them; they're here so
  //    consumers that want to inspect them have a typed surface.
  mcpSchemaVersion?: number;
  domain?: IntentDomain;
  /** Free-form sub-kind, e.g. 'lotto.buy_and_roll'. */
  kind?: string;
  intentMode?: IntentMode;
  /** HMAC-SHA256(canonicalJson(intent), dApp's signing key), base64. We do not verify. */
  signature?: string;
  // ── v2 envelope (existing) ────────────────────────────────────
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
  // Bounded receipt wait — on timeout throws ReceiptUncertainError
  // (the canonical "tx submitted, on-chain status unknown" sentinel).
  // Callers wrapped in withIdempotency get claim retention for free
  // because withIdempotency knows about ReceiptUncertainError. M13:
  // contract receipts are slower than HBAR/token transfer receipts
  // (storage writes, gas refunds, gas-laddered retries) so we use
  // CONTRACT_RECEIPT_TIMEOUT_MS (2x the transfer ceiling).
  const receipt = await awaitReceipt(client, txResponse, CONTRACT_RECEIPT_TIMEOUT_MS);

  if (receipt.status !== Status.Success) {
    throw new Error(
      `Transaction ${txResponse.transactionId.toString()} failed: ${receipt.status.toString()}`
    );
  }

  // Estimate gas cost using the published Hedera mainnet gas price
  // (~0.000000082 HBAR/gas). NOTE (R4-FG-63 deferred): this uses
  // intent.gas (the LIMIT) rather than gas actually consumed. The
  // proposed fix to read `receipt.transactionFee` doesn't apply
  // because TransactionReceipt does not expose the fee — that lives
  // on TransactionRecord, which requires a separate paid query.
  // Leaving the over-estimate in place: it's worse for solvency
  // tracking (under-reports operator headroom) but always errs on
  // the safe side (operator looks insolvent earlier rather than
  // later). Proper fix: bolt on a TransactionRecordQuery only when
  // an exact fee is needed, e.g., for fee-withdrawal accounting.
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
  // Bounded receipt wait — on timeout throws ReceiptUncertainError
  // (the canonical "tx submitted, on-chain status unknown" sentinel).
  // Callers wrapped in withIdempotency get claim retention for free
  // because withIdempotency knows about ReceiptUncertainError. M13:
  // contract receipts are slower than HBAR/token transfer receipts
  // (storage writes, gas refunds, gas-laddered retries) so we use
  // CONTRACT_RECEIPT_TIMEOUT_MS (2x the transfer ceiling).
  const receipt = await awaitReceipt(client, txResponse, CONTRACT_RECEIPT_TIMEOUT_MS);

  if (receipt.status !== Status.Success) {
    throw new Error(
      `Transaction ${txResponse.transactionId.toString()} failed: ${receipt.status.toString()}`
    );
  }

  // R4-FG-63 deferred: same estimation caveat as `executeIntent` —
  // intent.gas is the LIMIT, not the actual gas consumed. Real fee
  // lives on TransactionRecord which we don't query for cost.
  const estimatedGasHbar = gas * 0.000000082;

  return {
    transactionId: txResponse.transactionId.toString(),
    receipt,
    status: receipt.status,
    estimatedGasHbar,
  };
}

/**
 * Transfer all pending prizes to an owner's EVM address.
 * Calls transferPendingPrizes(ownerEVM, type(uint256).max) on the LazyLotto contract.
 *
 * Gas is sized from `prizeCount` because each prize triggers a storage
 * rewrite + event emission inside the contract loop. Pass the count
 * from `getUserState(agentAccountId).pendingPrizesCount`.
 *
 * The optional `perPrizeGas` override is used by the retry escalator
 * (see PRIZE_TRANSFER_RETRY in src/config/defaults.ts and the loop in
 * LottoAgent.safeTransferPrizes). Without an override, we use the
 * default first-attempt value from GAS_ESTIMATES.
 */
export async function transferAllPrizes(
  client: Client,
  contractId: string,
  ownerEvmAddress: string,
  options?: {
    /** Number of prizes to transfer (drives gas sizing). Default 1. */
    prizeCount?: number;
    /** Override per-prize gas (for retries). Default uses GAS_ESTIMATES. */
    perPrizeGas?: number;
  },
): Promise<TxResult> {
  // Lazy-import to avoid circular deps at module load time
  const { Interface, MaxUint256 } = await import('ethers');
  const { LazyLottoABI } = await import('../utils/abi.js');

  const iface = new Interface(LazyLottoABI);
  const encoded = iface.encodeFunctionData('transferPendingPrizes', [
    ownerEvmAddress,
    MaxUint256,
  ]);

  const prizeCount = Math.max(1, options?.prizeCount ?? 1);
  const perPrizeGas =
    options?.perPrizeGas ?? GAS_ESTIMATES.transferPendingPrizes.perUnit;
  const base = GAS_ESTIMATES.transferPendingPrizes.base;
  // Cap below the absolute Hedera per-transaction maximum so callers
  // don't get a hard runtime error from the SDK before we even hit the
  // contract. The retry escalator picks the cap from PRIZE_TRANSFER_RETRY
  // (14M) which is slightly under maxGas (14.5M) for safety.
  const gas = Math.min(base + perPrizeGas * prizeCount, GAS_ESTIMATES.maxGas);

  return executeEncodedCall(client, contractId, gas, encoded);
}

/**
 * Retry helper for transferAllPrizes with the escalating gas ladder
 * defined in PRIZE_TRANSFER_RETRY. Each attempt uses a higher per-prize
 * gas budget. INSUFFICIENT_GAS is the only retryable error — anything
 * else (revert, account not found, network) is treated as fatal and
 * thrown immediately so callers can dead-letter it.
 *
 * Used by both LottoAgent.safeTransferPrizes (the in-flight play path)
 * and the operator recovery tool. Returns the successful TxResult plus
 * the attempt number that succeeded.
 */
export interface PrizeTransferRetryResult {
  result: TxResult;
  attempt: number;
  gasUsed: number;
  attemptsLog: { attempt: number; gas: number; error?: string }[];
}

export async function transferAllPrizesWithRetry(
  client: Client,
  contractId: string,
  ownerEvmAddress: string,
  prizeCount: number,
): Promise<PrizeTransferRetryResult> {
  const attemptsLog: { attempt: number; gas: number; error?: string; lastSubmittedTxId?: string }[] = [];

  for (let i = 0; i < PRIZE_TRANSFER_RETRY.attempts.length; i++) {
    const ladder = PRIZE_TRANSFER_RETRY.attempts[i]!;
    // Compute gas for this attempt and clamp to the retry-specific
    // ceiling (14M) which is below the absolute SDK max (14.5M).
    const computed =
      PRIZE_TRANSFER_RETRY.baseGas + ladder.perPrize * prizeCount;
    const gas = Math.min(computed, PRIZE_TRANSFER_RETRY.maxRetryGas);

    try {
      const result = await transferAllPrizes(client, contractId, ownerEvmAddress, {
        prizeCount,
        perPrizeGas: ladder.perPrize,
      });
      attemptsLog.push({ attempt: i + 1, gas, lastSubmittedTxId: result.transactionId });
      return { result, attempt: i + 1, gasUsed: gas, attemptsLog };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // R5-FG-65 (P3-011): extract the transactionId from
      // ReceiptUncertainError / PostSubmitError so the DL records
      // which on-chain tx the recovery script must mirror-check
      // before re-submitting. Pre-fix the message string was the
      // only signal; recovery proceeded blindfold.
      const errTxId =
        err instanceof Error && typeof (err as { transactionId?: string }).transactionId === 'string'
          ? (err as { transactionId: string }).transactionId
          : undefined;
      attemptsLog.push({
        attempt: i + 1,
        gas,
        error: message,
        ...(errTxId ? { lastSubmittedTxId: errTxId } : {}),
      });

      // R4-FG-17 (round-4 high): rethrow ReceiptUncertainError
      // immediately. Pre-fix the retry catch only short-circuited on
      // INSUFFICIENT_GAS; ReceiptUncertainError was wrapped + retried.
      // But the underlying tx may have landed and burned the prize-
      // loop counter. The next attempt submits a new transaction;
      // when the first did succeed, the second reverts and the
      // wrapper logs success — `prizeTransfer.attempts` undercounts.
      // Withdrawals + refunds already follow this rule (no retry on
      // uncertain); contracts.ts must too.
      const isReceiptUncertain =
        err instanceof Error &&
        (err.constructor.name === 'ReceiptUncertainError' ||
          message.includes('ReceiptUncertainError') ||
          message.includes('receipt timeout'));
      if (isReceiptUncertain) {
        const wrapped = new Error(
          `Prize transfer receipt uncertain on attempt ${i + 1}: ${message}`,
        );
        const w = wrapped as Error & {
          attemptsLog: typeof attemptsLog;
          receiptUncertain: true;
          lastSubmittedTxId?: string;
        };
        w.attemptsLog = attemptsLog;
        w.receiptUncertain = true;
        if (errTxId) w.lastSubmittedTxId = errTxId;
        throw wrapped;
      }

      // Only retry on INSUFFICIENT_GAS — everything else is fatal.
      // The Hedera SDK surfaces the receipt status in the error message
      // when getReceipt() throws (see executeEncodedCall above).
      const isGasError = message.includes('INSUFFICIENT_GAS');
      const isLastAttempt = i === PRIZE_TRANSFER_RETRY.attempts.length - 1;

      if (!isGasError || isLastAttempt) {
        // Wrap with the full attempt log so callers can record it for
        // diagnostics / dead-letter context.
        const wrapped = new Error(
          `Prize transfer failed after ${i + 1} attempt(s): ${message}`,
        );
        (wrapped as Error & { attemptsLog: typeof attemptsLog }).attemptsLog =
          attemptsLog;
        throw wrapped;
      }
      // Otherwise: fall through to the next attempt with a higher
      // per-prize budget.
    }
  }

  // Unreachable — the loop either returns or throws.
  throw new Error('Prize transfer retry loop terminated unexpectedly');
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
