/**
 * Shared refund logic: look up a Hedera transaction on the mirror node,
 * identify the sender and amount, then transfer the funds back.
 *
 * Used by both the `operator_refund` MCP tool and the
 * POST /api/admin/refund API route.
 *
 * Safety guarantees:
 *   1. Replay protection — every refunded txId is recorded in Redis,
 *      duplicate refund attempts are rejected.
 *   2. Deposit validation — only refunds transactions that were
 *      credited as deposits via the deposit watcher. Random inbound
 *      transfers (operator gas top-ups, prize transfers, bounty
 *      payouts) cannot be refunded.
 *   3. Ledger adjustment — when refund completes, the user's internal
 *      balance is decremented to prevent phantom funds.
 */

import type { Client } from '@hashgraph/sdk';
import {
  submitHbarTransfer,
  submitTokenTransfer,
  safeSubmit,
  PreserveClaimError,
} from './transfers.js';
import { getMirrorBaseUrl } from './mirror.js';
import { getOperatorAccountId } from './wallet.js';
import { withChecksum } from '../utils/checksum.js';
import type { IStore, DeadLetterEntry } from '../custodial/IStore.js';
import type { DepositRecord } from '../custodial/types.js';
import type { AccountingService } from '../custodial/AccountingService.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { getRedis, KEY_PREFIX, isRefundClaimKey } from '../auth/redis.js';
import { logger } from '../lib/logger.js';
import { escalateUncertainDlFailure } from '../lib/escalation.js';
import { classifyMirrorResult } from './responseCodes.js';
import { RELEASE_SCRIPT, acquireUserLock, releaseUserLock, tryAcquireUserLockWithBackoff } from '../lib/locks.js';
import { parseTxIdTimestamp } from '../custodial/uncertainTxVerification.js';
import { mintAuditOrphanId } from '../lib/orphanIds.js';
import { randomUUID } from 'node:crypto';

const REFUND_KEY_PREFIX = KEY_PREFIX.refunded;

// ── Types ────────────────────────────────────────────────────────

export interface RefundResult {
  refunded: boolean;
  originalTx: string;
  sender: string;
  amount: string;
  refundTxId: string;
  /** If the refund matched a user deposit, the userId whose balance was adjusted. */
  ledgerAdjusted?: string;
}

/** Optional store for ledger adjustment on refund. */
export interface RefundLedgerOptions {
  store: IStore;
  /**
   * Optional AccountingService for HCS-20 v2 audit trail. When
   * provided, processRefund writes a `refund` op to the topic
   * after the on-chain transfer succeeds. Without it, refunds
   * happen on chain but never appear in the audit trail —
   * leaving deposits as un-paired credits and breaking
   * reconciliation math for external auditors.
   */
  accounting?: AccountingService;
  /**
   * Operator account ID recorded as `performedBy` in the audit
   * entry. Defaults to the agent operator account.
   */
  performedBy?: string;
  /**
   * Free-text reason for the refund (stuck_deposit,
   * operator_initiated, etc.). Recorded in the audit entry.
   */
  reason?: string;
  /**
   * R2-FG-24: skip the on-chain cross-check that validates the
   * `DepositRecord` against the mirror node. Default `false` —
   * production runs MUST cross-check. Tests / offline scenarios can
   * set this `true` to bypass the network call.
   */
  skipMirrorCrossCheck?: boolean;
}

// ── Mirror node transaction shape (partial) ─────────────────────

interface MirrorTxResponse {
  transactions: Array<{
    transfers: Array<{ account: string; amount: number }>;
    token_transfers: Array<{ token_id: string; account: string; amount: number }>;
    result: string;
    memo_base64: string;
  }>;
}

// ── Core ─────────────────────────────────────────────────────────

/**
 * Process a refund for a specific Hedera transaction.
 *
 * 1. Fetches the transaction from the mirror node
 * 2. Identifies the sender (the account with the negative transfer to the agent)
 * 3. Transfers the same amount back to the sender
 */
export async function processRefund(
  client: Client,
  transactionId: string,
  options?: RefundLedgerOptions,
): Promise<RefundResult> {
  const agentAccountId = getOperatorAccountId(client);

  // ── Validation: only RECORDED deposits can be refunded ───────
  // Reject any txId that wasn't processed by the deposit watcher.
  // Without this, an admin could refund operator gas top-ups, prize
  // transfers, bounty payouts, or any other inbound transfer.
  //
  // F11 (2026-05-06 audit OP-07): the gate uses `getDepositByTxId`,
  // not `isDepositCredited`. The latter returns true the moment
  // `tryClaimTransaction` SADDs the txId into `processed-tx`, which
  // happens BEFORE `recordDeposit` actually persists the
  // `DepositRecord`. On lock contention or partial-failure paths the
  // claim can persist without a record — so a parallel refund call
  // would pass `isDepositCredited === true` and fire an on-chain
  // refund against a never-credited deposit. Requiring the actual
  // `DepositRecord` closes that gap AND gives us the canonical
  // userId / netAmount / rakeAmount we need below.
  //
  // F8 (2026-05-06 audit U-06): the deposit record is also the
  // canonical owner — we debit from depositRecord.userId rather
  // than re-resolving via memo at refund time. Memo lookup is
  // correct at deposit-watcher time; at refund time, a memo
  // collision would otherwise debit the wrong user.
  let depositRecord: DepositRecord | undefined;
  // R3-FG-4 (round-3 P1-001): the user lock must be acquired EARLY —
  // BEFORE the F7 guard, mirror cross-check, on-chain submit, and
  // ledger debit. R2-FG-19's commit message claimed this was the
  // case ("guard runs UNDER the user lock acquired upstream") but the
  // actual production code only acquired the lock around the ledger
  // debit AFTER the on-chain refund had already settled. A concurrent
  // in-band play that reserved+settled between the guard at line 164
  // and the submit at line 526 silently drained `available` while
  // the refund was still in flight → operator double-pay (the play
  // settles + the refund returns gross). Now we hold the lock from
  // depositRecord lookup through awaitReceipt + ledger debit + audit
  // anchor + SADD permanent set + claim overwrite. The inner
  // acquireUserLock at line ~682 is now redundant (we own the lock
  // the whole time) so its mutation block runs directly without the
  // queue fallback (queue path was R3-FG-25 — drops rake reversal).
  let outerUserLockToken: string | null = null;
  let outerUserLockUserId: string | null = null;
  if (options?.store) {
    depositRecord = await options.store.getDepositByTxId(transactionId);
    if (!depositRecord) {
      throw new Error(
        `Transaction ${transactionId} was not credited as a user deposit ` +
          `(no DepositRecord found). Only deposits processed by the ` +
          `deposit watcher can be refunded.`,
      );
    }
    // R3-FG-4: acquire the outer user lock with backoff. Refuse the
    // refund entirely if the lock can't be acquired — better to
    // surface the contention than to fire the on-chain refund and
    // race a concurrent in-band op.
    //
    // R4-FG-9 (round-4 high): TTL bumped from 60s → 180s. The lock is
    // held across mirror cross-check (8s timeout) + refundedOriginals
    // SADD + submit + awaitReceipt (8s ceiling) + ledger debit + rake
    // reversal + recordRefund HCS submit + claim overwrite + second
    // SADD. Conservatively 18-25s on happy path; 60s+ on HCS / mirror
    // congestion. A 60s TTL guaranteed mid-flight expiry on a slow
    // mainnet day, after which a parallel in-band withdraw/play could
    // acquire the same lock and race the still-running refund's
    // mutations. 180s gives the worst-case work window enough headroom
    // and is still short enough that genuine wedges are visible.
    outerUserLockUserId = depositRecord.userId;
    outerUserLockToken = await tryAcquireUserLockWithBackoff(outerUserLockUserId, 180);
    if (!outerUserLockToken) {
      throw new Error(
        `Refund blocked: per-user lock contention for ${outerUserLockUserId} did not ` +
          `clear after retries. The user is mid-play / mid-withdraw / mid-refund. ` +
          `Wait for the in-flight op to complete and retry.`,
      );
    }
  }

  // R3-FG-4: outer try/finally so the user lock releases on every exit.
  try {
  if (options?.store && depositRecord) {

    // F7 + R2-FG-19 (round-2 G-01 / F7 caveat): consumed-balance
    // guard. Pre-fix used `available + reserved >= netAmount` — a
    // deposit fully reserved by an active play passed the guard, the
    // play settled, and the refund went out anyway: operator paid
    // twice. Now: `available >= netAmount` only (reserved excluded).
    // Reserved funds are committed against an in-flight play; once
    // the play settles they're gone, and refunding them would drain
    // the operator the second time.
    //
    // The guard now runs UNDER the user lock acquired upstream so
    // `available` can't drift between the check and the on-chain
    // submit (e.g. another in-band play reserving against the same
    // deposit). The lock key is `lockUser:<userId>` shared with the
    // verifier (R2-FG-15 decision).
    const user = options.store.getUser(depositRecord.userId);
    if (user) {
      const tokenKey = depositRecord.tokenId ?? HBAR_TOKEN_KEY;
      const tokEntry = user.balances?.tokens?.[tokenKey];
      const available = tokEntry?.available ?? 0;
      const reserved = tokEntry?.reserved ?? 0;
      if (available < depositRecord.netAmount) {
        throw new Error(
          `Cannot refund deposit ${transactionId}: insufficient AVAILABLE balance ` +
            `(available: ${available} ${tokenKey}, reserved: ${reserved}, ` +
            `deposit netAmount: ${depositRecord.netAmount}). Reserved funds are ` +
            `committed against an in-flight play and cannot be refunded — ` +
            `wait for the play to settle, or release the reservation first.`,
        );
      }
    }

    // R2-FG-24 (round-2 B-15): cross-check the DepositRecord against
    // the on-chain deposit tx. Pre-fix code trusted the
    // DepositRecord blindly — anyone with Redis write access could
    // plant a fake record (`{ userId, netAmount, ... }`) for a
    // transactionId and `processRefund` would honour it. Fetch the
    // deposit tx from the mirror node and assert SUCCESS + a positive
    // transfer to the agent matching `netAmount + rakeAmount`.
    //
    // Skipped under `--skip-mirror-check` (test/CI scenarios where the
    // mirror node isn't reachable). FAIL CLOSED in production: a
    // mirror lookup failure rejects the refund — refunds are
    // irreversible on-chain.
    if (!options.skipMirrorCrossCheck) {
      try {
        const mirrorBase = getMirrorBaseUrl();
        const url = `${mirrorBase}/transactions/${encodeURIComponent(transactionId)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.status === 404) {
          throw new Error(
            `Cannot refund deposit ${transactionId}: mirror node has NO record of it (404). ` +
              `Either the DepositRecord was planted via Redis write or the deposit tx never landed.`,
          );
        }
        if (!res.ok) {
          throw new Error(
            `Cannot refund deposit ${transactionId}: mirror node returned ${res.status}. ` +
              `Refusing to refund without on-chain confirmation.`,
          );
        }
        const body = (await res.json()) as {
          transactions?: Array<{
            result?: string;
            transfers?: Array<{ account: string; amount: number }>;
            token_transfers?: Array<{ token_id: string; account: string; amount: number }>;
          }>;
        };
        const tx = body.transactions?.[0];
        if (!tx || tx.result !== 'SUCCESS') {
          throw new Error(
            `Cannot refund deposit ${transactionId}: mirror result is ` +
              `'${tx?.result ?? 'missing'}', not SUCCESS — the credit has no on-chain backing.`,
          );
        }
        // Validate transfer to agent matching gross amount.
        const agentId = client.operatorAccountId?.toString();
        const grossAmount = depositRecord.netAmount + depositRecord.rakeAmount;
        if (!agentId) {
          // Defensive — if we don't know the agent we can't cross-check
          // the recipient. Skip the recipient match but warn.
          console.warn(
            '[Refund] R2-FG-24: client has no operatorAccountId; ' +
              'mirror cross-check limited to SUCCESS only.',
          );
        } else if (depositRecord.tokenId === null) {
          // HBAR. Expected tinybars = grossAmount * 1e8.
          const expected = Math.round(grossAmount * 1e8);
          const incoming = (tx.transfers ?? []).filter(
            (t) => t.account === agentId && t.amount > 0,
          );
          const matched = incoming.find((t) => Math.abs(t.amount - expected) <= 1);
          if (!matched) {
            throw new Error(
              `Cannot refund deposit ${transactionId}: on-chain HBAR transfers to agent ${agentId} ` +
                `do not include a positive entry of ${expected} tinybars (gross=${grossAmount} HBAR). ` +
                `DepositRecord may have been planted.`,
            );
          }
        } else {
          // HTS. Decimals lookup left to caller's mirror; here we
          // enforce direction + matching token_id only. The reader
          // does the precise decimals comparison via verify-audit.
          const tokenId = depositRecord.tokenId;
          const incoming = (tx.token_transfers ?? []).filter(
            (t) =>
              t.token_id === tokenId &&
              t.account === agentId &&
              t.amount > 0,
          );
          if (incoming.length === 0) {
            throw new Error(
              `Cannot refund deposit ${transactionId}: on-chain has no positive token_transfer ` +
                `for token ${tokenId} to agent ${agentId}. ` +
                `DepositRecord may have been planted.`,
            );
          }
        }
      } catch (e) {
        // Re-throw our own errors (we want the refund refused).
        if (e instanceof Error && e.message.startsWith('Cannot refund deposit')) {
          throw e;
        }
        // Network / parse errors: fail-closed.
        throw new Error(
          `Cannot refund deposit ${transactionId}: on-chain cross-check failed ` +
            `(${e instanceof Error ? e.message : String(e)}). Refusing to refund — ` +
            `refunds are irreversible.`,
        );
      }
    }
  } else {
    console.warn(
      '[Refund] processRefund called without a store — deposit validation skipped. ' +
      'This is unsafe in production.',
    );
  }

  // ── Replay protection: atomic SET-NX-EX claim ────────────────
  // Atomic claim — `SET NX EX` returns 'OK' iff this is the first
  // caller to claim across all Lambdas, null if another Lambda already
  // claimed. The pre-fix pattern (GET then later SET after the on-chain
  // transfer) had a multi-second TOCTOU window covering the mirror-node
  // lookup + the on-chain refund tx; two admin clicks landing on
  // different Lambdas could both pass the GET and both execute the
  // refund. Same bug class as the duplicate-deposit incident.
  //
  // Marker progression:
  //   1. SET-NX-EX 'pending' — first claim wins
  //   2. On success: overwrite with the actual refundTxId
  //   3. On failure: DEL so a retry can claim again
  //
  // FAIL CLOSED: if Redis is unreachable we cannot claim — refuse
  // the refund. Refunds are irreversible on-chain.
  //
  // R2-FG-2 (2026-05-06 round-2 audit S-04): in addition to the
  // SET-NX-EX claim with 30-day TTL, this path also checks a
  // permanent (no-TTL) SADD set `KEY_PREFIX.refundedOriginals` —
  // and, on confirmed success, ADDs to that set. After the claim
  // TTLs out, a new processRefund call would otherwise pass SET-NX
  // and fire a SECOND on-chain transfer. The permanent set blocks
  // that path: any tx in `refundedOriginals` is permanently
  // refused (operator must explicitly remove it via runbook to
  // genuinely retry).
  let redisLockKey: string | null = null;
  try {
    const redis = await getRedis();

    // R2-FG-2: permanent set check first — bypass the TTL window.
    const alreadyRefunded = await redis.sismember(
      KEY_PREFIX.refundedOriginals,
      transactionId,
    );
    if (alreadyRefunded === 1) {
      throw new Error(
        `Transaction ${transactionId} is in the permanent refunded-originals ` +
          `set — it has been refunded before. To retry, an operator must ` +
          `explicitly SREM the txId from \`${KEY_PREFIX.refundedOriginals}\` ` +
          `(documented runbook step).`,
      );
    }

    redisLockKey = `${REFUND_KEY_PREFIX}${transactionId}`;
    // R5-FG-68 (P6-010): store a fenced value `pending:<uuid>` so
    // the Regime A/B failure DEL at line ~791 can compare-and-delete
    // via RELEASE_SCRIPT instead of unfenced DEL. Pre-fix the
    // unfenced DEL would nuke a SIBLING acquirer's claim if the
    // current Lambda's TTL elapsed and a sibling had acquired with
    // their own value. Same archetype as R4-FG-65 fenced for
    // withIdempotency; refund.ts was the sibling miss.
    const claimFence = `pending:${randomUUID()}`;
    const claimResult = await redis.set(
      redisLockKey,
      claimFence,
      { nx: true, ex: 30 * 24 * 60 * 60 },
    );
    if (claimResult === null) {
      // Another caller has already claimed. Read the stored value so
      // we can include the actual refundTxId in the error if the prior
      // refund completed; if it's still 'pending', surface that
      // explicitly so the operator knows to wait.
      //
      // F10 (2026-05-06 audit SM-13): a `failed:<refundTxId>` value
      // means the verifier confirmed FAILED on chain. Surface that
      // distinctly so the operator knows a previous attempt failed
      // and that an explicit retry requires clearing the claim
      // (e.g. via force-release).
      //
      // R2-FG-2 (S-03): an unrecognized claim value (legacy / hand-
      // edited / partial overwrite) is reported as "unexpected state"
      // rather than asserting "already been refunded" — the value is
      // not a refundTxId and the message would mislead the operator.
      const existing = await redis.get<string>(redisLockKey);
      let message: string;
      // R5-FG-68: legacy literal 'pending' OR new fenced 'pending:<uuid>'
      // both indicate an in-progress refund claim.
      if (
        existing === 'pending' ||
        (typeof existing === 'string' && existing.startsWith('pending:'))
      ) {
        message =
          `Refund for ${transactionId} is already in progress on another ` +
          `Lambda. Try again in a minute.`;
      } else if (typeof existing === 'string' && existing.startsWith('failed:')) {
        message =
          `Refund for ${transactionId} previously FAILED on chain ` +
          `(prior refund tx: ${existing.slice('failed:'.length)}). ` +
          `Clear the claim via force-release to retry.`;
      } else if (
        typeof existing === 'string' &&
        /^\d+\.\d+\.\d+@\d+\.\d+$/.test(existing)
      ) {
        // Recognized: a real Hedera refund tx id.
        message =
          `Transaction ${transactionId} has already been refunded. ` +
          `Original refund tx: ${existing}`;
      } else if (typeof existing === 'string' && existing) {
        // R2-FG-2 (S-03): claim has an unrecognized value. Don't lie
        // about "already refunded"; surface as unexpected state.
        message =
          `Refund claim for ${transactionId} is in an unexpected state ` +
          `(value not a Hedera txId, not 'pending', not 'failed:*'). ` +
          `Investigate the Redis claim manually before retrying.`;
      } else {
        message =
          `Refund for ${transactionId} is already in progress on another ` +
          `Lambda. Try again in a minute.`;
      }
      throw new Error(message);
    }
  } catch (e) {
    // Rethrow our own sentinels unchanged
    if (
      e instanceof Error &&
      (e.message.includes('already been refunded') ||
        e.message.includes('already in progress') ||
        e.message.includes('previously FAILED on chain') ||
        e.message.includes('permanent refunded-originals') ||
        e.message.includes('unexpected state'))
    ) {
      throw e;
    }
    // Any other error means we couldn't claim — refuse the refund.
    throw new Error(
      'Refund replay protection unavailable: the Redis backend is not ' +
      'reachable right now. Refusing to refund without an atomic claim. ' +
      'Retry once the backend recovers.',
    );
  }

  // ── Mirror lookup + on-chain transfer (claim release semantics differ) ──
  //
  // Three failure regimes, each with different claim-handling rules:
  //
  //   A. PRE-SUBMISSION (mirror lookup, sender resolution, tx.execute
  //      throws): the on-chain transfer never happened. DEL the claim
  //      so the operator can retry once the underlying issue clears.
  //
  //   B. CONFIRMED FAILURE (awaitReceipt throws ReceiptStatusError):
  //      the tx landed on chain but reverted (INSUFFICIENT_TX_FEE,
  //      etc.). Same as A — DEL claim, allow retry.
  //
  //   C. RECEIPT UNCERTAIN (awaitReceipt throws ReceiptUncertainError):
  //      the tx was submitted but the receipt timed out. The on-chain
  //      outcome is UNKNOWN — the tx may have landed. We MUST NOT
  //      release the claim (releasing would let a retry double-refund
  //      if the original tx actually settled). Instead we write a
  //      `refund_uncertain` dead-letter and rethrow. The reconcile-
  //      time verification pass (verifyUncertainRefunds, below) walks
  //      these and either completes the bookkeeping or releases the
  //      claim once the mirror node knows the answer.
  //
  // Once we successfully complete awaitReceipt, we're committed — any
  // subsequent failure (audit write, ledger adjustment, marker
  // overwrite) is a recoverable post-condition handled by those
  // blocks' own try/catch.
  let refundTxId: string | undefined;
  let amountDisplay: string;
  let senderAccountId: string;
  // Initialized to null so TS sees a definite assignment for the
  // catch-block destructuring even when the throw happens before the
  // mirror lookup writes the real value (it's then either still null
  // for HBAR or the token id for FTs).
  let refundToken: string | null = null;
  let refundAmount: number;
  let humanRefundAmount: number;
  let tx: MirrorTxResponse['transactions'][number];
  try {
    const mirrorUrl = `${getMirrorBaseUrl()}/transactions/${transactionId}`;

    // F5 (2026-05-06 audit I-09): 8s timeout on mirror lookup.
    const txRes = await fetch(mirrorUrl, { signal: AbortSignal.timeout(8_000) });
    if (!txRes.ok) {
      throw new Error(`Transaction ${transactionId} not found on mirror node`);
    }

    const txData = (await txRes.json()) as MirrorTxResponse;
    const fetched = txData.transactions?.[0];
    if (!fetched) throw new Error('Transaction not found');
    if (fetched.result !== 'SUCCESS') {
      throw new Error(`Transaction was not successful: ${fetched.result}`);
    }
    tx = fetched;

    // Identify incoming transfer to agent
    const hbarIn = tx.transfers?.find(
      (t) => t.account === agentAccountId && t.amount > 0,
    );
    const tokenIn = tx.token_transfers?.find(
      (t) => t.account === agentAccountId && t.amount > 0,
    );

    if (!hbarIn && !tokenIn) {
      throw new Error('No incoming transfer to agent found in this transaction');
    }

    // Find sender
    let resolvedSender: string | null = null;
    if (tokenIn) {
      resolvedSender =
        tx.token_transfers.find(
          (t) => t.token_id === tokenIn.token_id && t.amount < 0,
        )?.account ?? null;
      refundAmount = tokenIn.amount; // base units
      refundToken = tokenIn.token_id;
    } else if (hbarIn) {
      resolvedSender =
        tx.transfers.find(
          (t) => t.amount < 0 && t.account !== agentAccountId,
        )?.account ?? null;
      refundAmount = hbarIn.amount; // tinybars
      refundToken = null; // HBAR
    } else {
      throw new Error('Could not determine sender');
    }

    if (!resolvedSender) {
      throw new Error('Could not determine sender account from transaction');
    }
    senderAccountId = resolvedSender;

    // Compute the human-readable amount once — used for the on-chain
    // submission, the audit entry, the ledger adjustment, and
    // (potentially) the dead-letter row. Keeping it in one place
    // ensures all four agree.
    let symbolForDisplay: string;
    if (refundToken) {
      const { getTokenMeta } = await import('../utils/math.js');
      const meta = await getTokenMeta(refundToken);
      humanRefundAmount = refundAmount / Math.pow(10, meta.decimals);
      symbolForDisplay = `${meta.symbol} (${refundToken})`;
    } else {
      humanRefundAmount = refundAmount / 1e8;
      symbolForDisplay = 'HBAR';
    }
    amountDisplay = `${humanRefundAmount} ${symbolForDisplay}`;

    // R3-FG-11 (round-3 P3-DR-001): SADD `refundedOriginals` BEFORE
    // the on-chain submit so a Lambda freeze post-HCS-pre-SADD cannot
    // open a 30-day double-refund window. Pre-fix order: submit →
    // ledger debit → HCS audit → SADD. Lambda freeze between HCS and
    // SADD left the per-tx claim 'pending' for 30 days, after which
    // sismember=0 → SET-NX succeeds → second on-chain refund. Now
    // SADD lands FIRST; if SADD fails before submit, refuse the
    // refund entirely (no on-chain action). The post-success SADD
    // call below becomes idempotent (set already contains the txId).
    try {
      const redis = await getRedis();
      await redis.sadd(KEY_PREFIX.refundedOriginals, transactionId);
    } catch (e) {
      // R5-FG-21 / R5-FG-93 (P3-007): pre-submit SADD-refused had no
      // orphan trail. Pre-fix this throw flowed to the route as 5xx
      // with no DL, no page — operator retried, SADD failed again,
      // threw again. Once Redis recovered and operator retried, SADD
      // succeeded and refund fired with no record of prior attempts.
      // Mirror R4-FG-4: write `audit_trail_orphaned` + escalate
      // BEFORE throwing so the operator has a paged trail.
      try {
        if (options?.store) {
          await options.store.upsertDeadLetter({
            transactionId: mintAuditOrphanId(
              'audit-orphan:refund-sadd-pre-submit',
              transactionId,
            ),
            timestamp: new Date().toISOString(),
            error: `pre-submit refundedOriginals SADD failed: ${e instanceof Error ? e.message : String(e)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'refund_pre_submit_sadd',
              sourceTxId: transactionId,
              phase: 'refunded_originals_sadd_pre_submit_failed',
            },
          });
        }
      } catch {
        /* throw below is the operator-visible signal */
      }
      try {
        await escalateUncertainDlFailure({
          kind: 'refunded_originals_sadd_failed',
          uncertainTxId: transactionId,
          cause: e,
        });
      } catch {
        /* throw below is the operator-visible signal */
      }
      throw new Error(
        `Refund blocked: pre-submit refundedOriginals SADD failed (${e instanceof Error ? e.message : String(e)}). ` +
          `Cannot proceed without the permanent duplicate-prevention gate landed. ` +
          `Audit-trail orphan row written + operator paged.`,
      );
    }

    // R5-FG-3 (P2-001 + P3-002): route through safeSubmit so any
    // post-submit error — receipt timeout OR raw SDK throws between
    // execute() and the receipt resolve — lifts to PreserveClaimError.
    // Pre-fix only ReceiptUncertainError survived to Regime C; non-
    // receipt-shape post-submit errors (signer disposed, V8 OOM,
    // network reset) fell through to Regime A/B and DELed the claim
    // while the on-chain submit may have landed → double-spend window.
    const submitResult = await safeSubmit(client, () =>
      refundToken
        ? submitTokenTransfer(
            client,
            agentAccountId,
            senderAccountId,
            refundToken,
            humanRefundAmount,
          )
        : submitHbarTransfer(
            client,
            agentAccountId,
            senderAccountId,
            humanRefundAmount,
          ),
    );
    refundTxId = submitResult.transactionId;
  } catch (err) {
    // R5-FG-3 + R6 Phase 1: gate on parent PreserveClaimError so
    // any subclass (ReceiptUncertainError, PostSubmitError, future)
    // takes the uncertain regime uniformly — keep claim, dead-letter,
    // escalate.
    if (err instanceof PreserveClaimError) {
      // Regime C: tx submitted, outcome unknown. KEEP claim. Persist a
      // refund_uncertain dead-letter so reconcile (or an admin tool)
      // can resolve via the mirror node without double-refunding.
      if (options?.store) {
        const memo = tx!.memo_base64
          ? Buffer.from(tx!.memo_base64, 'base64').toString('utf-8')
          : undefined;
        const entry: DeadLetterEntry = {
          // Keyed by the refund tx (the unique uncertain action). The
          // original deposit tx is preserved in `details.originalTxId`.
          transactionId: err.transactionId,
          timestamp: new Date().toISOString(),
          error: err.message,
          sender: senderAccountId!,
          ...(memo ? { memo } : {}),
          kind: 'refund_uncertain',
          details: {
            originalTxId: transactionId,
            refundTxId: err.transactionId,
            humanAmount: humanRefundAmount!,
            // L18: when refundToken is null (HBAR refund) we want
            // tokenKey to be HBAR_TOKEN_KEY and token to be omitted
            // from the row entirely. Previously the `!` assertion
            // wrote `token: null` and tokenKey worked only by
            // coincidence (the verifier didn't read `token`).
            tokenKey: refundToken ?? HBAR_TOKEN_KEY,
            ...(refundToken ? { token: refundToken } : {}),
            agentAccountId,
            performedBy: options.performedBy ?? agentAccountId,
            reason: options.reason ?? 'operator_initiated',
            // Reconcile uses claimKey to release the SET-NX-EX marker
            // when (and only when) the mirror confirms the tx FAILED.
            claimKey: redisLockKey,
          },
        };
        try {
          await options.store.upsertDeadLetter(entry);
        } catch (dlErr) {
          logger.error(
            'CRITICAL: refund_uncertain dead-letter write failed — manual reconcile required',
            {
              component: 'Refund',
              event: 'refund_uncertain_dl_write_failed',
              originalTx: transactionId,
              refundTxId: err.transactionId,
              error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            },
          );
          // H11: page the operator. The claim is retained on rethrow
          // below, the on-chain status is unknown, AND the recovery
          // anchor is missing. Without a webhook signal the held
          // claim sits invisibly until TTL expiry.
          await escalateUncertainDlFailure({
            kind: 'refund_uncertain',
            uncertainTxId: err.transactionId,
            cause: dlErr,
          });
        }
      }
      logger.error('refund receipt timed out — dead-lettered as refund_uncertain', {
        component: 'Refund',
        event: 'refund_receipt_uncertain',
        originalTx: transactionId,
        refundTxId: err.transactionId,
      });
      // Claim deliberately retained. Note: refunds are NOT wrapped in
      // `withIdempotency` (call sites in app/api/admin/refund/route.ts
      // and src/mcp/tools/operator.ts call processRefund directly), so
      // the `PreserveClaimError` mechanism in idempotency.ts does NOT
      // apply here. Retention is enforced by the in-function
      // SET-NX-EX claim on `redisLockKey` (see Regime A/B branch
      // below — that branch DELs; this branch does not). The reconcile
      // verifier (`verifyUncertainRefunds`) is solely responsible for
      // resolving the claim once the mirror confirms the on-chain
      // outcome. Rethrow so the caller surfaces the uncertainty.
      throw err;
    }
    // Regimes A + B: pre-submission OR confirmed on-chain failure.
    // Release the claim so the operator can retry once the underlying
    // issue is resolved.
    //
    // R4-FG-3 (round-4 critical): SREM the originalTxId from the
    // permanent `refundedOriginals` ban set. The pre-submit SADD at
    // line ~553 is correct insurance against the regime-C window;
    // however, when the submit later fails pre-consensus (Regime A:
    // InsufficientPayerBalance, signature, etc.) or the consensus
    // receipt is non-uncertain FAILURE (Regime B: e.g.
    // InvalidSignature, TokenNotAssociated), no tokens moved — the
    // permanent ban must be lifted so the legitimate refund can be
    // retried after the operator addresses the underlying issue.
    // Pre-fix: any Regime-A failure permanently locked the deposit
    // out of any future refund (operator burnt out a permanent slot
    // by trying to fund a refund before the agent had balance).
    try {
      const redis = await getRedis();
      await redis.srem(KEY_PREFIX.refundedOriginals, transactionId);
    } catch (sremErr) {
      logger.error('CRITICAL: refundedOriginals SREM failed after pre-transfer error', {
        component: 'Refund',
        event: 'refunded_originals_srem_failed',
        originalTx: transactionId,
        claimError: err instanceof Error ? err.message : String(err),
        sremError: sremErr instanceof Error ? sremErr.message : String(sremErr),
      });
      // R5-FG-12 (round-5 critical): write `audit_trail_orphaned` +
      // escalate so the operator gets a runbook for clearing the
      // stuck `refundedOriginals` membership. Pre-fix R4-FG-3's
      // SREM-failure path was pure logging — the user could never
      // be refunded again because subsequent refund attempts hit
      // `sismember=1` from the unreverted SADD. Reconcile cron's
      // `verifyUncertainRefunds` does NOT walk this orphan kind, so
      // the operator must replay manually; the runbook entry is a
      // dead-letter row + a webhook page documenting the txId to
      // SREM by hand.
      try {
        const { mintAuditOrphanId } = await import('../lib/orphanIds.js');
        await store.upsertDeadLetter({
          transactionId: mintAuditOrphanId(
            'audit-orphan:refund-srem',
            transactionId,
          ),
          timestamp: new Date().toISOString(),
          error: `refundedOriginals SREM failed after Regime-A submit error: ${sremErr instanceof Error ? sremErr.message : String(sremErr)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'refunded_originals_srem_failed',
            sourceTxId: transactionId,
            phase: 'srem_failed',
            claimError: err instanceof Error ? err.message : String(err),
          },
        });
      } catch {
        /* logged above */
      }
      try {
        const { escalateUncertainDlFailure } = await import('../lib/escalation.js');
        await escalateUncertainDlFailure({
          kind: 'refunded_originals_sadd_failed',
          uncertainTxId: transactionId,
          cause: sremErr,
        });
      } catch (escErr) {
        logger.error('refundedOriginals SREM escalation also failed', {
          component: 'Refund',
          error: escErr instanceof Error ? escErr.message : String(escErr),
        });
      }
    }
    if (redisLockKey) {
      try {
        const redis = await getRedis();
        // R5-FG-68: fenced compare-and-DEL via RELEASE_SCRIPT.
        // Pre-fix unfenced DEL nuked sibling acquirers' fresh
        // claims after our 30-day TTL elapsed.
        await redis.eval(RELEASE_SCRIPT, [redisLockKey], [claimFence]);
      } catch (delErr) {
        // The 30-day TTL is the worst-case fallback; the marker
        // expires on its own. Surface so an operator can manually
        // DEL if they need a faster retry window.
        logger.error('refund claim release failed after pre-transfer error', {
          component: 'Refund',
          event: 'refund_claim_release_failed',
          originalTx: transactionId,
          claimError: err instanceof Error ? err.message : String(err),
          releaseError: delErr instanceof Error ? delErr.message : String(delErr),
        });
      }
    }
    throw err;
  }
  // After the try block, refundTxId is guaranteed set — awaitReceipt
  // either returned cleanly (success) or threw (caught above with
  // throw). Type assertion just narrows for the rest of the function.
  const confirmedRefundTxId: string = refundTxId!;

  // ── Ledger adjustment ─────────────────────────────────────────
  // If this refund matches a user deposit, deduct from their balance
  // to prevent phantom funds (user keeps balance AND gets refund).
  //
  // F8 (2026-05-06 audit U-06): debit the user identified on the
  // recorded `DepositRecord`. The previous `getUserByMemo(memo)`
  // lookup was vulnerable to memo-collision attacks where an attacker
  // sends a deposit with a victim's depositMemo — the deposit
  // watcher routes the credit to the victim, but a refund would
  // pay back the on-chain sender (attacker) while debiting the
  // victim. Looking up by the recorded txId binds the debit to the
  // canonical owner.
  //
  // F9 (2026-05-06 audit OP-01): reverse the operator's rake credit
  // when refunding a previously-raked deposit. Without this, the
  // operator's `balances[token]` retains `rakeAmount` for every
  // refunded deposit, driving a persistent insolvency signal in
  // reconcile.
  let ledgerAdjusted: string | undefined;
  let rakeReversed = 0;

  if (options?.store) {
    try {
      const user = depositRecord
        ? options.store.getUser(depositRecord.userId)
        : undefined;

      if (user && depositRecord) {
        const tokenKey = refundToken ?? HBAR_TOKEN_KEY;
        // humanRefundAmount was computed in the on-chain submit block
        // above — reuse it here so the audit, ledger, and on-chain
        // amount all agree.

        // Per-user distributed lock around the ledger adjustment —
        // prevents two concurrent refunds for the same user (different
        // txIds, both legitimate) from racing on entry.available and
        // losing one of the deductions.
        //
        // If the user is mid-play/mid-withdraw and holds the lock, we
        // retry with backoff for up to ~10 seconds. If we still can't
        // acquire, the on-chain refund has already settled so we CANNOT
        // silently drop the ledger debit (that creates phantom funds —
        // the user would spend the refunded amount twice). Instead we
        // persist a pending ledger adjustment that a drain sweep
        // (called at the top of each reconcile, and on-demand by admin)
        // will apply once the user lock is free.
        // R3-FG-4: we already hold the outer user lock acquired at the
        // top of processRefund, so we mutate directly. The pre-fix
        // inner acquireUserLock + queue fallback (R3-FG-25 — drops
        // rake reversal) is unreachable now that the refund refuses
        // upfront on outer-lock contention.
        options.store.updateBalance(user.userId, (b) => {
          const entry = b.tokens[tokenKey];
          if (!entry) return b;
          entry.available = Math.max(0, entry.available - humanRefundAmount);
          return b;
        });
        ledgerAdjusted = user.userId;

        // F9 (2026-05-06 audit OP-01): reverse the operator's
        // rake credit. The deposit credited `op.balances[token]
        // += rakeAmount`. The refund returns gross to the user;
        // without this reversal the operator retains the rake
        // with no on-chain backing — every refunded deposit
        // drives a persistent insolvency signal.
        if (depositRecord.rakeAmount > 0) {
          options.store.updateOperator((op) => ({
            ...op,
            balances: {
              ...op.balances,
              [tokenKey]: (op.balances[tokenKey] ?? 0) - depositRecord!.rakeAmount,
            },
          }));
          rakeReversed = depositRecord.rakeAmount;
        }

        logger.info('refund ledger adjusted', {
          component: 'Refund',
          event: 'refund_ledger_adjusted',
          userId: user.userId,
          amount: humanRefundAmount,
          token: tokenKey,
          originalTx: transactionId,
          rakeReversed,
        });
      }
    } catch (e) {
      // R3-FG-9 (round-3 P5-RU-001): the five post-conditions
      // (ledger debit / audit anchor / claim overwrite / rake reversal /
      // SADD) were not atomic — failure of (d) silently dropped the
      // operator-balance reversal AND blocked future retry via the
      // SADD permanent set. Now: write audit_trail_orphaned + page
      // operator. The on-chain refund already succeeded; we cannot
      // rollback. Operator MUST manually reconstruct the missing
      // ledger debit / rake reversal before mainnet exposure widens.
      console.error('[Refund] Ledger adjustment failed (on-chain refund succeeded):', e);
      if (options?.store) {
        try {
          await options.store.upsertDeadLetter({
            transactionId: mintAuditOrphanId('audit-orphan:refund-ledger', transactionId),
            timestamp: new Date().toISOString(),
            error: `refund ledger adjustment failed after on-chain success: ${e instanceof Error ? e.message : String(e)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'refund_post_success_orphan',
              sourceTxId: transactionId,
              refundTxId,
              userId: depositRecord?.userId,
              humanAmount: humanRefundAmount,
              tokenKey: depositRecord?.tokenId ?? HBAR_TOKEN_KEY,
              rakeAmount: depositRecord?.rakeAmount,
              phase: 'ledger_adjust_failed',
            },
          });
        } catch {
          /* logged above */
        }
      }
      try {
        await escalateUncertainDlFailure({
          kind: 'audit_trail_orphaned',
          uncertainTxId: transactionId,
          userId: depositRecord?.userId,
          cause: e,
        });
      } catch (escErr) {
        console.error('[Refund] ledger-adjust escalation also failed:', escErr);
      }
    }
  }

  // ── HCS-20 v2 audit entry ────────────────────────────────────
  // Write the refund to the on-chain audit topic so external
  // auditors can pair every deposit with its inverse. Without this,
  // a refund leaves a phantom credit on the audit trail (the
  // original mint with no offsetting burn/refund), breaking
  // reconciliation math for any third party reading the topic.
  //
  // Best-effort: the on-chain refund tx already succeeded, so we
  // log on failure but don't throw — the operator can recover the
  // missing audit entry manually if needed.
  if (options?.accounting) {
    try {
      await options.accounting.recordRefund({
        amount: humanRefundAmount,
        from: agentAccountId,
        to: senderAccountId,
        originalDepositTxId: transactionId,
        refundTxId: confirmedRefundTxId,
        reason: options.reason ?? 'operator_initiated',
        performedBy: options.performedBy ?? agentAccountId,
        // F9: include the rake reversal in the audit anchor so a
        // topic-only reader can apply the operator-balance change.
        ...(rakeReversed > 0
          ? {
              rakeReversed,
              rakeReversedToken: refundToken ?? HBAR_TOKEN_KEY,
            }
          : {}),
      });
    } catch (auditErr) {
      // R4-FG-14 (round-4 high): audit-anchor failure post-on-chain-
      // refund is not best-effort; topic-only auditors otherwise see
      // a phantom credit (deposit mint with no paired refund). Write
      // audit_trail_orphaned + page operator. Pre-fix this was just
      // a logger.warn.
      logger.error('CRITICAL: refund HCS-20 audit entry failed — topic missing the refund anchor', {
        component: 'Refund',
        event: 'refund_audit_failed',
        originalTx: transactionId,
        refundTxId: confirmedRefundTxId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      if (options?.store) {
        try {
          await options.store.upsertDeadLetter({
            transactionId: mintAuditOrphanId('audit-orphan:refund-anchor', transactionId),
            timestamp: new Date().toISOString(),
            error: `refund HCS-20 audit anchor failed after on-chain refund: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'refund_post_success_orphan',
              sourceTxId: transactionId,
              refundTxId: confirmedRefundTxId,
              phase: 'audit_anchor_failed',
            },
          });
        } catch {
          /* logged above */
        }
      }
      try {
        await escalateUncertainDlFailure({
          kind: 'audit_trail_orphaned',
          uncertainTxId: transactionId,
          userId: depositRecord?.userId,
          cause: auditErr,
        });
      } catch (escErr) {
        logger.error('refund audit-anchor escalation also failed', {
          component: 'Refund',
          error: escErr instanceof Error ? escErr.message : String(escErr),
        });
      }
    }
  }

  // ── Overwrite the 'pending' claim with the actual refundTxId ────
  // The atomic SET-NX-EX claim earlier wrote 'pending' to the marker.
  // Now that the on-chain refund has completed and we know the
  // refundTxId, overwrite with the real value (resetting the 30-day
  // TTL) so future duplicate attempts get a useful error message.
  //
  // R2-FG-2 (2026-05-06 round-2 audit S-04): also SADD the original
  // txId to the permanent `refundedOriginals` set so a TTL'd claim
  // cannot allow a duplicate on-chain refund. The claim is the
  // diagnostic record (with refundTxId for the user-facing error);
  // the SADD is the permanent gate.
  if (redisLockKey) {
    try {
      const redis = await getRedis();
      await redis.set(redisLockKey, confirmedRefundTxId, { ex: 30 * 24 * 60 * 60 });
    } catch (e) {
      // R4-FG-14 (round-4 high): claim overwrite failure leaves the
      // marker at literal 'pending' for 30 days. Operator retries get
      // a misleading "in progress on another Lambda" error even though
      // the refund completed. Surface as audit_trail_orphaned so an
      // operator can manually reset the marker before TTL.
      logger.error('CRITICAL: refund claim overwrite failed — duplicate-attempt error message will be misleading', {
        component: 'Refund',
        event: 'refund_claim_overwrite_failed',
        originalTx: transactionId,
        refundTxId: confirmedRefundTxId,
        error: e instanceof Error ? e.message : String(e),
      });
      if (options?.store) {
        try {
          await options.store.upsertDeadLetter({
            transactionId: mintAuditOrphanId('audit-orphan:refund-claim-overwrite', transactionId),
            timestamp: new Date().toISOString(),
            error: `refund claim overwrite failed: ${e instanceof Error ? e.message : String(e)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'refund_post_success_orphan',
              sourceTxId: transactionId,
              refundTxId: confirmedRefundTxId,
              phase: 'claim_overwrite_failed',
            },
          });
        } catch {
          /* logged above */
        }
      }
    }
  }
  try {
    const redis = await getRedis();
    await redis.sadd(KEY_PREFIX.refundedOriginals, transactionId);
  } catch (e) {
    // R2-FG-2 + R3-FG-7 (round-3 P1-006): the SADD is the load-bearing
    // duplicate-prevention beyond the 30d claim TTL. Pre-fix this was
    // a silent log + continue, leaving a 30-day double-refund window
    // open. Now: write an audit_trail_orphaned row AND page the
    // operator via escalateUncertainDlFailure. The on-chain refund
    // already succeeded; we cannot rollback. The SADD MUST land or
    // the operator must clear the claim before TTL.
    logger.error(
      'CRITICAL: refunded-originals SADD failed; duplicate-refund window opens after claim TTL',
      {
        component: 'Refund',
        event: 'refunded_originals_sadd_failed',
        originalTx: transactionId,
        refundTxId: confirmedRefundTxId,
        error: e instanceof Error ? e.message : String(e),
      },
    );
    if (options?.store) {
      try {
        await options.store.upsertDeadLetter({
          transactionId: mintAuditOrphanId('audit-orphan:refund-sadd', transactionId),
          timestamp: new Date().toISOString(),
          error: `refundedOriginals SADD failed after on-chain refund: ${e instanceof Error ? e.message : String(e)}`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'refund_post_success_orphan',
            sourceTxId: transactionId,
            refundTxId: confirmedRefundTxId,
            phase: 'refunded_originals_sadd_failed',
          },
        });
      } catch {
        /* logged above */
      }
    }
    try {
      await escalateUncertainDlFailure({
        kind: 'refunded_originals_sadd_failed',
        uncertainTxId: transactionId,
        userId: depositRecord?.userId,
        cause: e,
      });
    } catch (escErr) {
      logger.error('refunded-originals SADD escalation also failed', {
        component: 'Refund',
        error: escErr instanceof Error ? escErr.message : String(escErr),
      });
    }
  }

  return {
    refunded: true,
    originalTx: transactionId,
    sender: withChecksum(senderAccountId),
    amount: amountDisplay,
    refundTxId: confirmedRefundTxId,
    ledgerAdjusted,
  };
  } finally {
    // R3-FG-4: release the outer user lock acquired before the F7
    // guard so concurrent in-band ops on this user can resume.
    if (outerUserLockToken && outerUserLockUserId) {
      await releaseUserLock(outerUserLockUserId, outerUserLockToken);
    }
  }
}

// ── Reconcile-time verification of refund_uncertain dead-letters ──
//
// Walks the dead-letter queue for entries with kind ===
// 'refund_uncertain' (written when awaitReceipt timed out during a
// refund). For each, queries the mirror node:
//
//   - If the mirror returns SUCCESS: the refund landed. Complete the
//     post-conditions (HCS-20 audit, ledger adjustment) and resolve
//     the dead-letter. Leave the SET-NX-EX claim in place (it now
//     correctly records the actual refundTxId) so any retry is
//     rejected as a duplicate.
//
//   - If the mirror returns a non-SUCCESS result: the refund failed
//     on chain. Release the claim so the operator can retry, and
//     resolve the dead-letter with a failure note.
//
//   - If the mirror returns 404 (not yet propagated): leave the
//     entry as-is. The next reconcile pass will re-check.
//
// Returns a per-entry summary so callers (reconcile, admin tool) can
// surface the resolution in their output.

export interface RefundVerificationOutcome {
  refundTxId: string;
  originalTxId: string;
  status: 'confirmed' | 'failed' | 'still_uncertain';
  /** Human-readable note suitable for an admin UI. */
  note: string;
}

/** 24h after entry.timestamp, NOT_FOUND is treated as FAILED (H7). */
const NOT_FOUND_MAX_AGE_MS_REFUND = 24 * 60 * 60 * 1000;
const VERIFY_LOCK_TTL_SEC_REFUND = 60;

export async function verifyUncertainRefunds(
  _client: Client,
  store: IStore,
  accounting?: AccountingService,
): Promise<RefundVerificationOutcome[]> {
  void _client; // reserved; mirror suffices today
  const outcomes: RefundVerificationOutcome[] = [];

  // Reload the dead-letter list so we don't act on a stale snapshot.
  await store.refreshDeadLetters().catch(() => undefined);
  const all = store.getDeadLetters();
  const allOpen = all.filter(
    (e) => e.kind === 'refund_uncertain' && !e.resolvedAt,
  );
  if (allOpen.length === 0) return outcomes;
  // R4-FG-16 (round-4 high): cap entries per pass so reconcile
  // doesn't blow the 900s top-level lock TTL on backlogged DLs.
  const MAX_ENTRIES_PER_PASS = 25;
  const open = allOpen.slice(0, MAX_ENTRIES_PER_PASS);
  if (allOpen.length > MAX_ENTRIES_PER_PASS) {
    logger.warn('verifyUncertainRefunds: deferred entries to next pass', {
      component: 'Refund',
      event: 'verifier_pass_capped',
      kind: 'refund_uncertain',
      total: allOpen.length,
      capped: MAX_ENTRIES_PER_PASS,
      deferred: allOpen.length - MAX_ENTRIES_PER_PASS,
    });
  }

  for (const entry of open) {
    const refundTxId = entry.transactionId;
    const details = (entry.details ?? {}) as {
      originalTxId?: string;
      refundTxId?: string;
      humanAmount?: number;
      tokenKey?: string;
      token?: string | null;
      agentAccountId?: string;
      performedBy?: string;
      reason?: string;
      claimKey?: string | null;
      ledgerAdjustedAt?: string;
    };
    const originalTxId = details.originalTxId ?? '(unknown)';

    // C4: per-txId verifier lock to prevent two reconcile passes
    // double-mutating the same entry.
    //
    // F25 / F26 (2026-05-06 audit SM-01 / C-02): use a fence value
    // so we can compare-and-delete on no-mutation paths and after
    // resolve, freeing the lock for the next pass / a concurrent
    // force-release within the TTL window.
    const refundLockKey = `${KEY_PREFIX.verifying}refund:${refundTxId}`;
    const refundLockFence = `verify-refund-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const redis = await getRedis();
      const lockResult = await redis.set(refundLockKey, refundLockFence, {
        nx: true,
        ex: VERIFY_LOCK_TTL_SEC_REFUND,
      });
      if (lockResult === null) {
        outcomes.push({
          refundTxId,
          originalTxId,
          status: 'still_uncertain',
          note: 'Concurrent reconcile holds verifier lock; will retry next pass.',
        });
        continue;
      }
    } catch (e) {
      logger.warn('refund verifier lock acquisition failed; skipping pass', {
        component: 'Refund',
        event: 'verify_lock_redis_error',
        refundTxId,
        error: e instanceof Error ? e.message : String(e),
      });
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: 'Could not acquire verifier lock; will retry next pass.',
      });
      continue;
    }
    // F25 / F26 / R2-FG-6: best-effort compare-and-delete release.
    // Reuses the lowercase `RELEASE_SCRIPT` from `src/lib/locks.ts` so
    // the in-memory Redis mock (matches `script.includes('get') &&
    // script.includes('del')`, lowercase) actually deletes the key.
    // Previously this had its own uppercase Lua + a racy get-then-del
    // fallback — both gone. If `redis.eval` ever throws (unsupported
    // pattern under a stricter mock), we rely on the TTL.
    const releaseRefundLock = async (): Promise<void> => {
      try {
        const redis = await getRedis();
        await redis.eval(RELEASE_SCRIPT, [refundLockKey], [refundLockFence]);
      } catch {
        /* TTL is the fallback */
      }
    };

    // ── Mirror node lookup (H8: use classifier) ──────────────
    let result: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
    try {
      const url = `${getMirrorBaseUrl()}/transactions/${refundTxId}`;
      // F5 (2026-05-06 audit I-09): 8s timeout so a slow mirror
      // can't wedge the verifier past its per-txId lock TTL.
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (res.status === 404) {
        result = 'NOT_FOUND';
      } else if (!res.ok) {
        // Other errors (5xx, timeouts) — leave for next pass.
        // F25: no mutation; release lock for retry.
        await releaseRefundLock();
        outcomes.push({
          refundTxId,
          originalTxId,
          status: 'still_uncertain',
          note: `Mirror node returned ${res.status}; will retry next reconcile.`,
        });
        continue;
      } else {
        const body = (await res.json()) as MirrorTxResponse;
        const tx = body.transactions?.[0];
        if (!tx) {
          result = 'NOT_FOUND';
        } else {
          result = classifyMirrorResult(tx.result);
        }
      }
    } catch (e) {
      // F25: network error → still uncertain; release lock for retry.
      await releaseRefundLock();
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: `Mirror lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // H7: NOT_FOUND for >24h → FAILED.
    // F27 (2026-05-06 audit SM-06): use the txId's valid-start
    // timestamp, not entry.timestamp (operator-clock-skew vector).
    if (result === 'NOT_FOUND') {
      const txIdMs = parseTxIdTimestamp(refundTxId);
      const referenceMs = txIdMs ?? new Date(entry.timestamp).getTime();
      const ageMs = Date.now() - referenceMs;
      if (ageMs > NOT_FOUND_MAX_AGE_MS_REFUND) {
        result = 'FAILED';
      }
    }

    if (result === 'NOT_FOUND') {
      // F25: recent NOT_FOUND — release lock so next pass can retry
      // within the TTL window (rather than waiting for it to expire).
      await releaseRefundLock();
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: 'Not yet visible on mirror node; will retry next reconcile.',
      });
      continue;
    }

    // ── Confirmed FAILED: overwrite claim, mark resolved ─────
    //
    // F10 (2026-05-06 audit SM-13): we OVERWRITE the claim with
    // `failed:<refundTxId>` and a fresh 30d TTL instead of DELing.
    // Why: prior behaviour DELed → if the resolve-write then failed
    // (Redis blip / Lambda freeze), the entry stayed unresolved AND
    // the claim was gone. A subsequent `processRefund(originalTxId)`
    // call would pass SET-NX-EX and run a second on-chain transfer.
    // Overwriting ensures the claim survives the resolve-write
    // failure window — a retry sees `failed:...` and refuses with a
    // diagnostic message. Operators who want to genuinely retry
    // must clear the claim explicitly via force-release.
    //
    // F2 (2026-05-06 audit I-07): refuse to write keys outside the
    // refund-claim namespace. A tampered/migrated entry with
    // `claimKey: 'lla:testnet:session:victim'` would otherwise let
    // the verifier overwrite arbitrary lla: keys.
    if (result === 'FAILED') {
      if (details.claimKey && !isRefundClaimKey(details.claimKey)) {
        logger.error(
          'refund_uncertain claimKey outside KEY_PREFIX.refunded — refusing to release',
          {
            component: 'Refund',
            event: 'malicious_claim_key',
            refundTxId,
            originalTxId,
            claimKeyPrefix: String(details.claimKey).slice(0, 24),
          },
        );
      } else if (details.claimKey) {
        try {
          const redis = await getRedis();
          await redis.set(details.claimKey, `failed:${refundTxId}`, {
            ex: 30 * 24 * 60 * 60,
          });
        } catch (e) {
          logger.warn(
            'refund_uncertain claim overwrite failed during verification',
            {
              component: 'Refund',
              refundTxId,
              originalTxId,
              error: e instanceof Error ? e.message : String(e),
            },
          );
        }
      }
      try {
        await store.flush();
      } catch {
        /* */
      }
      try {
        // R5-FG-8 (P1-002): refresh-then-spread to avoid clobbering a
        // concurrent force-release's top-level field write (mirrors
        // R4-FG-1 in markResolved).
        let baseFailed: typeof entry = entry;
        try {
          await store.refreshDeadLetters();
          const fresh = store
            .getDeadLetters()
            .find((e) => e.transactionId === entry.transactionId);
          if (fresh) baseFailed = fresh;
        } catch {
          /* fall through with caller-supplied snapshot */
        }
        if (!baseFailed.resolvedAt) {
          await store.upsertDeadLetter({
            ...baseFailed,
            resolvedAt: new Date().toISOString(),
            resolvedBy: 'reconcile',
            // No resolutionTxId — there isn't one; the refund failed.
          });
        }
      } catch (e) {
        logger.warn('refund_uncertain dead-letter resolve write failed', {
          component: 'Refund',
          refundTxId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      // F26: release lock after FAILED resolve so a concurrent
      // force-release can act within the TTL window if needed.
      await releaseRefundLock();
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'failed',
        note: 'On-chain refund failed (or not on mirror after 24h); claim released, retry permitted.',
      });
      continue;
    }

    // ── Confirmed SUCCESS: complete bookkeeping + mark resolved ──
    // R5-FG-60 (P5-AT-002): refuse to process the success branch when
    // required fields are missing. Pre-fix `tokenKey` / `humanAmount`
    // missing (legacy DL or shape regression) caused the entire
    // ledger-adjustment block to be bypassed (didAdjustLedger=false),
    // the audit-anchor block also gated on `humanAmount`, and the
    // resolve-write fired anyway. Outcome: refund landed on chain,
    // user NOT debited locally, topic has NO refund anchor, entry
    // resolved → user retains deposit credit + receives refund. Now:
    // bump verificationAttempts and surface as `still_uncertain` so
    // an operator gets paged via R3-FG-77 / R5-FG-91 ordering check.
    if (
      !details.tokenKey ||
      typeof details.humanAmount !== 'number' ||
      !Number.isFinite(details.humanAmount) ||
      details.humanAmount < 0
    ) {
      logger.error(
        'refund_uncertain SUCCESS branch — required fields missing/malformed; cannot apply post-conditions',
        {
          component: 'Refund',
          event: 'refund_uncertain_malformed_required_fields',
          refundTxId,
          tokenKey: details.tokenKey,
          humanAmount: details.humanAmount,
        },
      );
      try {
        await store.upsertDeadLetter({
          transactionId: mintAuditOrphanId('audit-orphan:refund-malformed', refundTxId),
          timestamp: new Date().toISOString(),
          error: `refund SUCCESS but tokenKey/humanAmount missing — cannot debit ledger or write audit anchor`,
          kind: 'audit_trail_orphaned',
          details: {
            sourceKind: 'refund_verifier_malformed_required',
            sourceTxId: refundTxId,
            tokenKey: details.tokenKey,
            humanAmount: details.humanAmount,
            phase: 'malformed_required_fields',
          },
        });
      } catch {
        /* logged above */
      }
      try {
        await escalateUncertainDlFailure({
          kind: 'refund_uncertain',
          uncertainTxId: refundTxId,
          cause: new Error(
            'refund_uncertain confirmed SUCCESS but details.tokenKey/humanAmount malformed; manual reconstruction required',
          ),
        });
      } catch {
        /* operator-visible via dead-letter row */
      }
      await releaseRefundLock();
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: 'On-chain refund confirmed SUCCESS but details required for ledger/audit are malformed; entry left unresolved for operator manual triage.',
      });
      continue;
    }

    // Best-effort: each post-condition is wrapped so a partial
    // failure (audit, ledger) doesn't block resolution. The claim
    // marker is already in place (kept by the original refund call)
    // so re-attempts are still rejected as duplicates.
    //
    // F6 (2026-05-06 audit U-03): intermediate `stampProgress` calls
    // persist the `ledgerAdjustedAt` and `auditWrittenAt` markers
    // BEFORE the final resolve write. Without these, a single
    // resolve-write failure would lose the markers, and the next
    // reconcile pass would re-debit the user + emit a duplicate
    // HCS-20 burn op (`recordRefund` has no body-level idempotency
    // we can rely on for cross-write dedup).

    // Running progress accumulator — same pattern as F1 in
    // `uncertainTxVerification.ts`. Each stamp writes the full
    // accumulator so a stamp failure self-heals on the next step.
    const refundProgress: {
      ledgerAdjustedAt?: string;
      auditWrittenAt?: string;
    } = {
      ledgerAdjustedAt:
        typeof details.ledgerAdjustedAt === 'string'
          ? details.ledgerAdjustedAt
          : undefined,
      auditWrittenAt:
        typeof (details as { auditWrittenAt?: string }).auditWrittenAt === 'string'
          ? (details as { auditWrittenAt: string }).auditWrittenAt
          : undefined,
    };

    // M15: skip ledger adjustment if a previous verification pass
    // already applied it. Re-running verifiers (idempotency-by-id)
    // must NOT re-debit the user's `available`.
    const ledgerAdjusted = !!refundProgress.ledgerAdjustedAt;
    let didAdjustLedger = false;

    // R5-FG-16 (P5-RU-001 + P1-002): mutationError gate, mirroring
    // R4-FG-6's withdrawal verifier pattern. R4-FG-14 added orphan +
    // escalation on audit-anchor failure but did NOT skip the resolve
    // write — entry stamped resolved while topic was missing the
    // refund anchor → topic-only auditor sees phantom user credit.
    // refund.ts is the 4th sibling miss for this archetype. Track
    // any mutation step that failed; only mark resolved if all of
    // them landed.
    let refundMutationError:
      | { phase: 'ledger_debit' | 'audit_anchor'; cause: unknown }
      | null = null;

    // F8 (2026-05-06 audit U-06): debit the user identified on the
    // recorded `DepositRecord` rather than re-resolving via memo.
    // F9 (2026-05-06 audit OP-01): reverse the operator's rake
    // credit by the deposit's recorded `rakeAmount`.
    let rakeReversedHere = 0;
    const depositRecordForVerifier = await store
      .getDepositByTxId(originalTxId)
      .catch(() => undefined);

    if (!ledgerAdjusted && depositRecordForVerifier) {
      try {
        const user = store.getUser?.(depositRecordForVerifier.userId);
        // R3-FG-16 (round-3 P9-004): require Number.isFinite + >= 0,
        // not just `typeof === 'number'`. Pre-fix Infinity passed the
        // typeof check; `available - Infinity = -Infinity`;
        // `Math.max(0, -Infinity) = 0` silently zeroed the user's
        // available balance.
        if (
          user &&
          details.tokenKey &&
          typeof details.humanAmount === 'number' &&
          Number.isFinite(details.humanAmount) &&
          details.humanAmount >= 0
        ) {
          const tokenKey = details.tokenKey;
          const humanAmount = details.humanAmount;
          let lockToken: string | null = null;
          const backoffMs = [50, 100, 200, 500, 1000];
          for (const delay of backoffMs) {
            lockToken = await acquireUserLock(user.userId, 30);
            if (lockToken) break;
            await new Promise((r) => setTimeout(r, delay));
          }
          if (lockToken) {
            try {
              store.updateBalance(user.userId, (b) => {
                const tokEntry = b.tokens[tokenKey];
                if (!tokEntry) return b;
                tokEntry.available = Math.max(
                  0,
                  tokEntry.available - humanAmount,
                );
                return b;
              });
              didAdjustLedger = true;

              // F9: rake reversal — same conditions as the in-flight
              // path (see processRefund).
              if (depositRecordForVerifier.rakeAmount > 0 && store.updateOperator) {
                store.updateOperator((op) => ({
                  ...op,
                  balances: {
                    ...op.balances,
                    [tokenKey]:
                      (op.balances[tokenKey] ?? 0) -
                      depositRecordForVerifier.rakeAmount,
                  },
                }));
                rakeReversedHere = depositRecordForVerifier.rakeAmount;
              }
            } finally {
              await releaseUserLock(user.userId, lockToken);
            }
          } else {
            // Queue a pending adjustment if locked — same fallback
            // as the in-flight refund path.
            //
            // R4-FG-13 (round-4 high): include the rake reversal in
            // the queued payload so the drain applies BOTH legs.
            // Pre-fix the queue applied only `available -= amount`
            // and the operator silently retained the rake — refund
            // queued = rake-reversal lost.
            const { queuePendingLedgerAdjustment } = await import(
              '../custodial/pendingLedger.js'
            );
            const rakeForQueue =
              depositRecordForVerifier.rakeAmount > 0
                ? {
                    rakeReversal: {
                      tokenKey,
                      amount: depositRecordForVerifier.rakeAmount,
                    },
                  }
                : {};
            await queuePendingLedgerAdjustment({
              userId: user.userId,
              tokenKey,
              amount: humanAmount,
              reason: 'refund',
              sourceTx: originalTxId,
              createdAt: new Date().toISOString(),
              ...rakeForQueue,
            });
            didAdjustLedger = true;
            // R4-FG-13: track that rake reversal was deferred so the
            // audit anchor reflects the queued amount accurately.
            if (depositRecordForVerifier.rakeAmount > 0) {
              rakeReversedHere = depositRecordForVerifier.rakeAmount;
            }
          }
        }
      } catch (e) {
        // R5-FG-16: gate the resolve write on ledger-debit success.
        // Pre-fix the catch logged + swallowed; resolve-write fired
        // unconditionally → user kept their deposit credit AND
        // received the refund (operator-side double-spend).
        refundMutationError = { phase: 'ledger_debit', cause: e };
        logger.warn(
          'refund_uncertain verification: ledger adjustment failed',
          {
            component: 'Refund',
            refundTxId,
            error: e instanceof Error ? e.message : String(e),
          },
        );
      }
    }

    // F6: stamp ledgerAdjustedAt the moment the debit lands. The
    // intermediate stamp protects the next reconcile pass from
    // re-debiting if the resolve-write later fails.
    if (didAdjustLedger && !refundProgress.ledgerAdjustedAt) {
      refundProgress.ledgerAdjustedAt = new Date().toISOString();
      try {
        // R5-FG-8: refresh-then-spread before stamping progress.
        let baseLedger: typeof entry = entry;
        try {
          await store.refreshDeadLetters();
          const fresh = store
            .getDeadLetters()
            .find((e) => e.transactionId === entry.transactionId);
          if (fresh) baseLedger = fresh;
        } catch {
          /* fall through */
        }
        if (!baseLedger.resolvedAt) {
          await store.upsertDeadLetter({
            ...baseLedger,
            details: { ...(baseLedger.details ?? {}), ...refundProgress },
          });
        }
      } catch (e) {
        // Same self-healing semantics as F1: a failed stamp is logged
        // but the running accumulator carries the marker forward to
        // the next stamp attempt.
        logger.warn('refund_uncertain ledgerAdjustedAt stamp failed', {
          component: 'Refund',
          refundTxId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // HCS-20 audit entry (if accounting available and details intact).
    // R-HIGH-1: idempotency-marked via `auditWrittenAt`. A Lambda
    // crash AFTER recordRefund returns but BEFORE the resolve write
    // would otherwise let the next pass emit a SECOND HCS-20 burn op
    // for the same refund (`recordRefund` has no body-level
    // idempotency).
    const auditAlreadyWritten = !!refundProgress.auditWrittenAt;
    let didWriteAudit = false;
    if (
      accounting &&
      details.agentAccountId &&
      entry.sender &&
      // R3-FG-16: require finite + non-negative.
      typeof details.humanAmount === 'number' &&
      Number.isFinite(details.humanAmount) &&
      details.humanAmount >= 0 &&
      details.originalTxId &&
      !auditAlreadyWritten
    ) {
      try {
        await accounting.recordRefund({
          amount: details.humanAmount,
          from: details.agentAccountId,
          to: entry.sender,
          originalDepositTxId: details.originalTxId,
          refundTxId,
          reason: details.reason ?? 'operator_initiated',
          performedBy: details.performedBy ?? details.agentAccountId,
          // F9: include rake reversal (if any) so the topic captures
          // the operator-balance change.
          ...(rakeReversedHere > 0 && details.tokenKey
            ? {
                rakeReversed: rakeReversedHere,
                rakeReversedToken: details.tokenKey,
              }
            : {}),
        });
        didWriteAudit = true;
        // F6: stamp auditWrittenAt the moment the audit anchor lands.
        refundProgress.auditWrittenAt = new Date().toISOString();
        try {
          // R5-FG-8: refresh-then-spread before stamping progress.
          let baseAudit: typeof entry = entry;
          try {
            await store.refreshDeadLetters();
            const fresh = store
              .getDeadLetters()
              .find((e) => e.transactionId === entry.transactionId);
            if (fresh) baseAudit = fresh;
          } catch {
            /* fall through */
          }
          if (!baseAudit.resolvedAt) {
            await store.upsertDeadLetter({
              ...baseAudit,
              details: { ...(baseAudit.details ?? {}), ...refundProgress },
            });
          }
        } catch (stampErr) {
          logger.warn('refund_uncertain auditWrittenAt stamp failed', {
            component: 'Refund',
            refundTxId,
            error: stampErr instanceof Error ? stampErr.message : String(stampErr),
          });
        }
      } catch (e) {
        // R4-FG-14 (round-4 high): orphan-write present, escalation
        // absent on the verifier path. Mirror in-flight processRefund:
        // audit anchor failure post-on-chain-refund must escalate so
        // an operator can manually replay.
        //
        // R5-FG-16 (P5-RU-001): set mutationError so the resolve
        // write at the bottom of the function is skipped — pre-fix
        // the catch wrote orphan + escalated AND fell through to
        // resolve-write. Topic missed the refund anchor; entry
        // marked resolved → operator never re-replayed.
        refundMutationError = { phase: 'audit_anchor', cause: e };
        logger.error('CRITICAL: refund_uncertain verifier audit write failed — topic missing the refund anchor', {
          component: 'Refund',
          refundTxId,
          error: e instanceof Error ? e.message : String(e),
        });
        // M16: audit failure → audit_trail_orphaned dead-letter so
        // the operator surfaces the missing on-chain anchor. Synthetic
        // id so the orphan coexists with the resolved refund_uncertain
        // entry (which has the same refundTxId as transactionId).
        try {
          await store.upsertDeadLetter({
            // R2-FG-17: salt by writer phase.
            transactionId: mintAuditOrphanId('audit-orphan:refund-verifier', refundTxId),
            timestamp: new Date().toISOString(),
            error: `refund verifier audit write failed: ${e instanceof Error ? e.message : String(e)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'refund_uncertain',
              sourceTxId: refundTxId,
              originalTxId: details.originalTxId,
              humanAmount: details.humanAmount,
              phase: 'audit_failed',
            },
          });
        } catch {
          /* logged above */
        }
        try {
          await escalateUncertainDlFailure({
            kind: 'audit_trail_orphaned',
            uncertainTxId: refundTxId,
            cause: e,
          });
        } catch (escErr) {
          logger.error('refund verifier audit-anchor escalation also failed', {
            component: 'Refund',
            error: escErr instanceof Error ? escErr.message : String(escErr),
          });
        }
      }
    }

    // Overwrite the 'pending' claim marker with the real refundTxId
    // for nicer error messages on duplicate-attempt rejection.
    // F2: only overwrite keys actually under KEY_PREFIX.refunded.
    if (details.claimKey && isRefundClaimKey(details.claimKey)) {
      try {
        const redis = await getRedis();
        await redis.set(details.claimKey, refundTxId, {
          ex: 30 * 24 * 60 * 60,
        });
      } catch {
        // The 'pending' marker still gives 30-day replay protection;
        // a less-informative duplicate error is acceptable.
      }
    }

    // R2-FG-2: SADD original txId to the permanent set so a future
    // call after the 30d claim TTL can't fire a duplicate refund.
    //
    // R4-FG-4 (round-4 critical): on SADD failure in the verifier
    // path, write `audit_trail_orphaned` AND page the operator via
    // `escalateUncertainDlFailure` — full parity with the in-flight
    // processRefund block at lines 906-953. Pre-fix the verifier
    // path silently logged + continued, leaving an invisible
    // 30-day duplicate-refund window after the claim TTL'd.
    if (details.originalTxId) {
      const sadd_originalTxId = details.originalTxId;
      try {
        const redis = await getRedis();
        await redis.sadd(KEY_PREFIX.refundedOriginals, sadd_originalTxId);
      } catch (e) {
        logger.error(
          'CRITICAL: verifier refunded-originals SADD failed; duplicate-refund window opens after claim TTL',
          {
            component: 'Refund',
            event: 'refunded_originals_sadd_failed',
            refundTxId,
            originalTxId: sadd_originalTxId,
            error: e instanceof Error ? e.message : String(e),
          },
        );
        try {
          await store.upsertDeadLetter({
            transactionId: mintAuditOrphanId('audit-orphan:refund-verifier-sadd', sadd_originalTxId),
            timestamp: new Date().toISOString(),
            error: `verifier refundedOriginals SADD failed after on-chain refund: ${e instanceof Error ? e.message : String(e)}`,
            kind: 'audit_trail_orphaned',
            details: {
              sourceKind: 'refund_verifier_post_success_orphan',
              sourceTxId: sadd_originalTxId,
              refundTxId,
              phase: 'refunded_originals_sadd_failed',
            },
          });
        } catch {
          /* logged above */
        }
        try {
          await escalateUncertainDlFailure({
            kind: 'refunded_originals_sadd_failed',
            uncertainTxId: sadd_originalTxId,
            cause: e,
          });
        } catch (escErr) {
          logger.error('verifier refunded-originals SADD escalation also failed', {
            component: 'Refund',
            error: escErr instanceof Error ? escErr.message : String(escErr),
          });
          // R5-FG-64 (P3-010): retry once with a 30s gap, then write
          // a SECOND orphan tagged escalation_throw_after_sadd_failure
          // so an operator chasing the dead-letter list sees both the
          // original and the failed-page anchor. Pre-fix this catch
          // logged + continued — operator was UN-paged, the orphan
          // sat forever, after 30d the per-tx claim TTL'd out and a
          // fresh refund attempt opened the duplicate window.
          await new Promise((r) => setTimeout(r, 30_000));
          try {
            await escalateUncertainDlFailure({
              kind: 'refunded_originals_sadd_failed',
              uncertainTxId: sadd_originalTxId,
              cause: e,
            });
          } catch (retryEscErr) {
            // Still failing — write a secondary orphan so the
            // operator's DL list shows the un-paged state.
            try {
              await store.upsertDeadLetter({
                transactionId: mintAuditOrphanId(
                  'audit-orphan:refund-verifier-escalation-fail',
                  sadd_originalTxId,
                ),
                timestamp: new Date().toISOString(),
                error: `verifier escalation throw after SADD failure (after 30s retry): ${retryEscErr instanceof Error ? retryEscErr.message : String(retryEscErr)}`,
                kind: 'audit_trail_orphaned',
                details: {
                  sourceKind: 'refund_verifier_post_success_orphan',
                  sourceTxId: sadd_originalTxId,
                  refundTxId,
                  phase: 'escalation_throw_after_sadd_failure',
                },
              });
            } catch {
              /* the original error log above is the trail */
            }
          }
        }
      }
    }

    // H10: flush before resolve so verifier mutations survive a
    // Lambda freeze between settlement and the resolve marker.
    try {
      await store.flush();
    } catch {
      /* */
    }

    // R5-FG-16 (P5-RU-001): gate the resolve write on mutation
    // success. Pre-fix the resolve-write fired even if the
    // ledger-debit OR audit-anchor failed → entry stamped resolved
    // while topic missing the refund anchor / user not debited.
    // Mirrors R4-FG-6's withdrawal-verifier mutationError gate.
    if (refundMutationError) {
      logger.warn(
        `refund_uncertain verifier: ${refundMutationError.phase} failed; entry left unresolved for retry`,
        {
          component: 'Refund',
          refundTxId,
          phase: refundMutationError.phase,
          error:
            refundMutationError.cause instanceof Error
              ? refundMutationError.cause.message
              : String(refundMutationError.cause),
        },
      );
      await releaseRefundLock();
      outcomes.push({
        refundTxId,
        originalTxId,
        status: 'still_uncertain',
        note: `Mutation step '${refundMutationError.phase}' failed; entry left unresolved for retry on next pass.`,
      });
      continue;
    }

    try {
      // R5-FG-8 (P1-002): refresh-then-spread for SUCCESS resolve.
      let baseSuccess: typeof entry = entry;
      try {
        await store.refreshDeadLetters();
        const fresh = store
          .getDeadLetters()
          .find((e) => e.transactionId === entry.transactionId);
        if (fresh) baseSuccess = fresh;
      } catch {
        /* fall through with caller-supplied snapshot */
      }
      if (!baseSuccess.resolvedAt) {
        await store.upsertDeadLetter({
          ...baseSuccess,
          // F6: persist the running progress accumulator so a future
          // re-run (e.g. operator clears resolvedAt) sees the correct
          // skip gates. The intermediate stamps already wrote these,
          // but include them here as belt-and-braces.
          details: { ...(baseSuccess.details ?? {}), ...refundProgress },
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'reconcile',
          resolutionTxId: refundTxId,
        });
      }
    } catch (e) {
      logger.warn('refund_uncertain dead-letter resolve write failed', {
        component: 'Refund',
        refundTxId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    // F26: release lock after SUCCESS resolve.
    await releaseRefundLock();

    outcomes.push({
      refundTxId,
      originalTxId,
      status: 'confirmed',
      note: 'On-chain refund confirmed; bookkeeping completed.',
    });
  }

  return outcomes;
}
