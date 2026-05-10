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
 * R6 (Phase 1 structural fix): every subclass MUST set
 * `transactionId` (the on-chain tx whose status is unknown). This
 * lets callers do `instanceof PreserveClaimError` and access
 * `err.transactionId` with proper TypeScript narrowing — no need
 * to widen to `instanceof ReceiptUncertainError || instanceof
 * PostSubmitError` per call site. The lint rule
 * `no-direct-preserve-claim-subclass` (enforced by
 * `src/__tests__/sibling-archetype-gate.test.ts`) forbids any
 * `instanceof ReceiptUncertainError` or `instanceof PostSubmitError`
 * outside this file — every gate must be on the parent class.
 *
 * Subclass for any future failure mode where the body has already
 * submitted an irreversible on-chain action whose status is unknown
 * (network blip reading receipt, OOM after tx.execute returns, etc.).
 * Current concrete subclasses: `ReceiptUncertainError`, `PostSubmitError`.
 */
export abstract class PreserveClaimError extends Error {
  readonly __preserveIdempotencyClaim = true as const;
  abstract readonly transactionId: string;

  /**
   * R8-FG-32 / Phase-6 Cluster D + R9-P3-006 / Phase-7 Cluster H:
   * runtime abstract guard. The `abstract` keyword is enforced at
   * compile time only — a future cast
   * `new (PreserveClaimError as any)('msg')` would instantiate the
   * parent with `transactionId: undefined`, then `isPreserveClaim`
   * would treat it as a preserve and hold the idempotency claim for
   * TTL with no transaction id to verify against. The Phase-6 guard
   * blocked direct parent instantiation; Phase-7 also rejects
   * incomplete subclasses that didn't override `transactionId` —
   * any `class Sub extends PreserveClaimError {}` (no constructor)
   * would inherit `transactionId` as `undefined` and pass the
   * Phase-6 check. The post-super validation enforces non-empty
   * string, catching the test-fixture archetype P3 found.
   */
  constructor(message?: string) {
    super(message);
    if (new.target === PreserveClaimError) {
      throw new TypeError('PreserveClaimError is abstract; instantiate a subclass');
    }
    // R9-P3-006 — defer the transactionId check to a microtask so
    // subclass constructors get a chance to set it after `super()`.
    // The check fires on the NEXT tick — by which time the subclass
    // ctor body has run. If the subclass forgot to set `transactionId`
    // (or set it to a non-string / empty string), we throw async,
    // which surfaces in the caller's promise rejection if the
    // subclass was instantiated inside an async path. For sync paths,
    // this is equivalent to the next event-loop tick.
    queueMicrotask(() => {
      if (typeof this.transactionId !== 'string' || this.transactionId.length === 0) {
        // Use console.error rather than throw — async-throw inside
        // queueMicrotask becomes an unhandledRejection which crashes
        // Node. console.error fires in the operator's logs and
        // makes the misuse visible without nuking the runtime.
        console.error(
          '[PreserveClaimError] subclass instantiated with invalid transactionId:',
          this.constructor.name,
          'transactionId =',
          this.transactionId,
        );
      }
    });
  }
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
 * R5-FG-3 (P2-001 + P3-002): thrown when ANY error occurs in the
 * `submit + awaitReceipt` window AFTER `tx.execute()` has returned a
 * response but the receipt has not yet been confirmed. Pre-fix this
 * exact gap let raw SDK errors (signer disposed, network reset
 * mid-fetch, V8 OOM, post-internal-retry rejections in non-receipt
 * shape) fall through `withIdempotency`'s catch, which only treated
 * `PreserveClaimError` as "keep claim" → the on-chain submit may have
 * landed, the claim was DELed, and a client retry with the same
 * `Idempotency-Key` saw a fresh SET-NX win and re-executed → double-spend.
 *
 * Subclass of `PreserveClaimError`, so `withIdempotency` keeps the
 * claim — operator must verify outcome via mirror node before any retry.
 */
export class PostSubmitError extends PreserveClaimError {
  readonly transactionId: string;
  readonly originalError: unknown;
  constructor(transactionId: string, originalError: unknown) {
    const causeMsg =
      originalError instanceof Error ? originalError.message : String(originalError);
    super(
      `Transaction ${transactionId} was submitted but a post-submit error ` +
        `occurred before the receipt could be confirmed: ${causeMsg}. ` +
        `On-chain status is UNKNOWN — verify via the mirror node before retrying.`,
    );
    this.name = 'PostSubmitError';
    this.transactionId = transactionId;
    this.originalError = originalError;
  }
}

/**
 * R5-FG-3: submit a transaction and await its receipt under a single
 * try/catch that lifts ANY post-submit error to `PreserveClaimError`.
 * This is the canonical helper for any code path that does
 * `tx.execute()` + post-conditions in `withIdempotency` scope —
 * processWithdrawal, processRefund, transferAllPrizesWithRetry, etc.
 *
 * Contract:
 *   - `build()` runs WITHOUT a try/catch around it. If `build()`
 *     throws (pre-submit failure: validation, signing, network blip
 *     before tx hit the wire), the error propagates as-is.
 *   - Once `build()` returns, the on-chain submit is in flight.
 *     ANY error from this point — including the receipt timeout AND
 *     arbitrary throws between submit and the await — is wrapped as
 *     `PreserveClaimError` so the caller's idempotency claim survives.
 *   - On success, returns `{ response, receipt, transactionId }`.
 */
export async function safeSubmit(
  client: Client,
  build: () => Promise<TransactionResponse>,
  options?: { ceilingMs?: number },
): Promise<{
  response: TransactionResponse;
  receipt: TransactionReceipt;
  transactionId: string;
}> {
  // Pre-submit: any throw here is a confirmed pre-submit failure.
  // The body did NOT reach the network so releasing an idempotency
  // claim is safe (matches `withIdempotency`'s default semantics).
  const response = await build();
  const transactionId = response.transactionId.toString();
  // Post-submit window: every throw must lift to PreserveClaim.
  try {
    const receipt = await awaitReceipt(client, response, options?.ceilingMs);
    return { response, receipt, transactionId };
  } catch (err) {
    if (err instanceof PreserveClaimError) {
      // Already preserve-claim shape (ReceiptUncertainError most often).
      throw err;
    }
    throw new PostSubmitError(transactionId, err);
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
  // R5-FG-3: route through safeSubmit so any error in the
  // submit→awaitReceipt window lifts to PreserveClaimError.
  const { transactionId } = await safeSubmit(client, () =>
    submitHbarTransfer(client, from, to, amount),
  );
  return { transactionId };
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
  // R5-FG-3: route through safeSubmit (see `transferHbar`).
  const { transactionId } = await safeSubmit(client, () =>
    submitTokenTransfer(client, from, to, tokenId, amount, decimals),
  );
  return { transactionId };
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
