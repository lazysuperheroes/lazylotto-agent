/**
 * Shared transfer transaction builders.
 * Eliminates duplicate TransferTransaction construction across the codebase.
 */

import {
  Client,
  AccountId,
  Hbar,
  TransferTransaction,
  TokenId,
  TransactionResponse,
  TransactionReceipt,
} from '@hashgraph/sdk';

export interface TransferResult {
  transactionId: string;
}

/**
 * Resolve the configured receipt-timeout ceiling at module load. The
 * env var `LOTTO_RECEIPT_TIMEOUT_MS` overrides the 8s default for HBAR
 * / token transfers. Below 1s the env value is ignored as nonsense
 * (mirror propagation alone is typically 4-8s).
 */
function envCeilingMs(): number {
  const raw = process.env.LOTTO_RECEIPT_TIMEOUT_MS;
  if (!raw) return 8_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return 8_000;
  return parsed;
}

/**
 * Default ceiling for `awaitReceipt` on simple transfers. Hedera
 * mirror propagation is typically 4-8s; an 8s wall clock is high
 * enough to absorb normal variance while still bounding caller
 * exposure to indeterminate outcomes. Override via
 * `LOTTO_RECEIPT_TIMEOUT_MS` env or per-call.
 */
export const DEFAULT_RECEIPT_TIMEOUT_MS = envCeilingMs();

/**
 * Absolute floor for the contract-call ceiling. Prize transfers
 * gas-laddered up to 14M gas can legitimately take 5-10s to receipt;
 * a misconfigured `LOTTO_RECEIPT_TIMEOUT_MS=1000` (env minimum) would
 * otherwise produce a 2s contract ceiling and dead-letter every
 * prize-transfer attempt. R-LOW-4 fix.
 */
const CONTRACT_RECEIPT_TIMEOUT_FLOOR_MS = 15_000;

/**
 * Ceiling for `awaitReceipt` on contract calls. Contract receipts
 * carry storage writes + gas refunds and can legitimately take
 * longer than transfer receipts — the gas-laddered prize transfer
 * path in particular escalates per-prize gas across retries. 2x the
 * transfer ceiling absorbs the variance without making
 * receipt-uncertain catches fire on every play. Floored at 15s so
 * a too-low env override can't break contract calls.
 */
export const CONTRACT_RECEIPT_TIMEOUT_MS = Math.max(
  envCeilingMs() * 2,
  CONTRACT_RECEIPT_TIMEOUT_FLOOR_MS,
);

/**
 * Marker base class for errors that must NOT release an idempotency
 * claim on throw. `withIdempotency` (src/lib/idempotency.ts) catches
 * any `PreserveClaimError` subclass and skips the DEL — the claim
 * stays at `'pending'` until a reconcile pass or admin tool resolves
 * the on-chain outcome.
 *
 * Subclass this for any future failure mode where the body has
 * already submitted an irreversible on-chain action whose status is
 * unknown to the catch (network blip reading the receipt, OOM after
 * tx.execute returns, etc.). The current concrete subclass is
 * `ReceiptUncertainError`.
 */
export class PreserveClaimError extends Error {
  readonly __preserveIdempotencyClaim = true as const;
}

/**
 * Thrown by `awaitReceipt` when the receipt for a SUBMITTED transaction
 * could not be obtained within the timeout.
 *
 * Critical: this is NOT a confirmed-failure — the transaction MAY have
 * landed on chain. The caller MUST treat the on-chain effect as
 * unknown until verified via the mirror node. In particular:
 *   - Do NOT release any idempotency claim that protects this tx
 *     (releasing would allow a retry, which would double-spend if the
 *     original tx actually landed).
 *   - DO write a dead-letter / pending-verification record so a later
 *     reconcile pass can resolve the outcome on chain.
 *
 * The transaction id is exposed so callers can use it for the
 * mirror-node verification step.
 */
export class ReceiptUncertainError extends PreserveClaimError {
  readonly transactionId: string;
  constructor(transactionId: string) {
    super(
      `Transaction ${transactionId} was submitted but its receipt could not ` +
        `be obtained within the timeout. On-chain status is unknown — verify ` +
        `via the mirror node before retrying.`,
    );
    this.name = 'ReceiptUncertainError';
    this.transactionId = transactionId;
  }
}

/**
 * Transfer HBAR between accounts.
 *
 * Uses a bounded receipt wait (DEFAULT_RECEIPT_TIMEOUT_MS = 8s). On
 * timeout, throws `ReceiptUncertainError` so the caller can keep its
 * idempotency claim / reserve and dead-letter the action for
 * reconcile-time verification. See audit finding C24.
 */
export async function transferHbar(
  client: Client,
  from: string,
  to: string,
  amount: number
): Promise<TransferResult> {
  const response = await submitHbarTransfer(client, from, to, amount);
  await awaitReceipt(client, response);
  return { transactionId: response.transactionId.toString() };
}

/**
 * Transfer a fungible token between accounts. Amount is in
 * human-readable units (e.g., 100 LAZY, not 1000 base units).
 *
 * Uses a bounded receipt wait — see `transferHbar`.
 */
export async function transferToken(
  client: Client,
  from: string,
  to: string,
  tokenId: string,
  amount: number,
  decimals?: number
): Promise<TransferResult> {
  const response = await submitTokenTransfer(
    client,
    from,
    to,
    tokenId,
    amount,
    decimals,
  );
  await awaitReceipt(client, response);
  return { transactionId: response.transactionId.toString() };
}

// ── Phased helpers (submit + bounded awaitReceipt) ─────────────────
// `transferHbar` / `transferToken` above are the simple "do it all"
// path. Callers that need to inspect or persist the response between
// submission and the receipt wait (e.g. refund.ts, which writes the
// refund tx id into a dead-letter row when the receipt times out) use
// the phased helpers below directly.

/**
 * Submit an HBAR transfer to the network and return the response
 * WITHOUT awaiting the receipt. Pair with `awaitReceipt` to get
 * explicit timeout control. Equivalent to the first half of
 * `transferHbar`.
 */
export async function submitHbarTransfer(
  client: Client,
  from: string,
  to: string,
  amount: number,
): Promise<TransactionResponse> {
  return new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(from), new Hbar(-amount))
    .addHbarTransfer(AccountId.fromString(to), new Hbar(amount))
    .execute(client);
}

/**
 * Submit a token transfer to the network and return the response
 * WITHOUT awaiting the receipt. Pair with `awaitReceipt` to get
 * explicit timeout control. Equivalent to the first half of
 * `transferToken`.
 */
export async function submitTokenTransfer(
  client: Client,
  from: string,
  to: string,
  tokenId: string,
  amount: number,
  decimals?: number,
): Promise<TransactionResponse> {
  if (decimals === undefined) {
    const { getTokenMeta } = await import('../utils/math.js');
    const meta = await getTokenMeta(tokenId);
    decimals = meta.decimals;
  }
  const baseUnits = Math.round(amount * Math.pow(10, decimals));
  const tokenIdObj = TokenId.fromString(tokenId);
  return new TransferTransaction()
    .addTokenTransfer(tokenIdObj, AccountId.fromString(from), -baseUnits)
    .addTokenTransfer(tokenIdObj, AccountId.fromString(to), baseUnits)
    .execute(client);
}

/**
 * Await a transaction's receipt with an explicit ceiling. Three
 * distinct outcomes the caller must handle:
 *
 *   1. Resolves: receipt obtained, status SUCCESS. Caller proceeds
 *      with post-conditions (ledger, audit, claim overwrite).
 *   2. Throws `ReceiptStatusError` (from the SDK): tx landed but
 *      reverted on chain (INSUFFICIENT_TX_FEE, CONTRACT_REVERT, etc.).
 *      A confirmed failure — caller may release any idempotency claim
 *      and surface to the user.
 *   3. Throws `ReceiptUncertainError`: ceiling expired without a
 *      receipt. The on-chain outcome is UNKNOWN. Caller MUST NOT
 *      release the idempotency claim and SHOULD persist a record so
 *      a later mirror-node verification pass can resolve.
 *
 * The default ceiling is `DEFAULT_RECEIPT_TIMEOUT_MS` (8000 ms). The
 * underlying `getReceipt` query continues until it resolves on its
 * own; we just stop awaiting it. This is acceptable in serverless
 * because the Lambda freezes the unresolved promise on response.
 */
export async function awaitReceipt(
  client: Client,
  response: TransactionResponse,
  ceilingMs: number = DEFAULT_RECEIPT_TIMEOUT_MS,
): Promise<TransactionReceipt> {
  const transactionId = response.transactionId.toString();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new ReceiptUncertainError(transactionId)),
      ceilingMs,
    );
  });
  try {
    return await Promise.race([response.getReceipt(client), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
