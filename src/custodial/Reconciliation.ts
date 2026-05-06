/**
 * On-chain balance reconciliation for the multi-user custodial agent.
 *
 * Compares the sum of all internal ledger balances (user + operator)
 * against the actual on-chain wallet balance, accounting for actual
 * network transaction fees fetched from the mirror node.
 *
 * This is a read-only diagnostic — it does not modify balances.
 * Best run after processing completes (mirror node has ~4s delay).
 */

import { getTokenBalances, sumTransactionFees } from '../hedera/mirror.js';
import { getWalletInfo } from '../hedera/wallet.js';
import {
  verifyUncertainRefunds,
  type RefundVerificationOutcome,
} from '../hedera/refund.js';
import {
  verifyUncertainWithdrawals,
  verifyUncertainOperatorFeeWithdrawals,
  verifyUncertainPlays,
  type WithdrawalVerificationOutcome,
  type OperatorFeeWithdrawVerificationOutcome,
  type PlayVerificationOutcome,
} from './uncertainTxVerification.js';
import { getOperatorAccountId } from '../hedera/wallet.js';
import type { Client } from '@hashgraph/sdk';
import type { IStore } from './IStore.js';
import type { AccountingService } from './AccountingService.js';
import type { UserLedger } from './UserLedger.js';
import { hbarToNumber } from '../utils/format.js';
import { roundToDecimals, getTokenMeta } from '../utils/math.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';
import { CURRENT_SCHEMA_VERSION } from './types.js';
import {
  drainPendingLedgerAdjustments,
  getPendingLedgerCount,
  type DrainResult,
} from './pendingLedger.js';
import { logger } from '../lib/logger.js';

export interface SchemaVersionReport {
  /** Version constant the current code stamps at write time. */
  current: number;
  /** Count of user records by stamped version. `0` key = legacy/unstamped. */
  users: Record<number, number>;
  /** Operator record's stamped version (0 if legacy). */
  operator: number;
  /** True when every record matches the current version. */
  allAtCurrent: boolean;
}

export interface ReconciliationResult {
  timestamp: string;
  onChain: Record<string, number>;
  ledgerTotal: Record<string, number>;
  actualNetworkFeesHbar: number;
  trackedGasHbar: number;
  untrackedFeesHbar: number;
  delta: Record<string, number>;
  adjustedDelta: Record<string, number>;
  /**
   * Display symbols for each token ID seen in onChain or ledgerTotal.
   * "hbar" → "HBAR", "0.0.6011249" → "LAZY", etc. Populated by warming
   * the token registry (mirror node lookup with fallback) so the admin
   * UI doesn't have to render raw IDs the operator can't read at a
   * glance. If lookup fails, the symbol falls back to the raw ID so
   * the table still renders something.
   */
  symbols: Record<string, string>;
  solvent: boolean;
  warnings: string[];
  /** Schema version divergence report — PR6 addition. */
  schema: SchemaVersionReport;
  /** Pending ledger adjustments drained at the start of this run. */
  pendingLedgerDrained: DrainResult;
  /** How many pending adjustments are still queued after the drain. */
  pendingLedgerRemaining: number;
  /**
   * Per-entry verification outcomes for `refund_uncertain` dead-letters
   * encountered at the start of this run. Empty when no uncertain
   * refunds exist. Populated for both confirmed (success/failure) and
   * still-uncertain entries — the admin UI can render each.
   */
  uncertainRefundsVerified: RefundVerificationOutcome[];
  /**
   * Per-entry verification outcomes for `withdrawal_uncertain` dead-letters.
   * Same shape as the refund verification block — present so the admin
   * UI can show "tx X for user Y was confirmed" / "released, retry OK".
   */
  uncertainWithdrawalsVerified: WithdrawalVerificationOutcome[];
  /**
   * Per-entry verification outcomes for `operator_fee_withdraw_uncertain`
   * dead-letters.
   */
  uncertainOperatorFeeWithdrawalsVerified: OperatorFeeWithdrawVerificationOutcome[];
  /**
   * Per-entry verification outcomes for `play_uncertain` dead-letters.
   * SUCCESS entries here always carry a manual-triage flag — see
   * `verifyUncertainPlays` for why settlement state can't be auto-
   * reconstructed.
   */
  uncertainPlaysVerified: PlayVerificationOutcome[];
}

/**
 * Run a balance reconciliation check.
 *
 * 1. Fetches actual on-chain balances (SDK + mirror node)
 * 2. Sums all user (available + reserved) + operator balances from ledger
 * 3. Fetches actual transaction fees from mirror node
 * 4. Computes per-token delta, adjusting HBAR for untracked network fees
 *
 * @param fromTimestamp  Optional — only sum fees from this timestamp forward
 * @returns Reconciliation result with per-token delta
 */
export async function reconcile(
  client: Client,
  store: IStore,
  fromTimestamp?: string,
  accounting?: AccountingService,
  ledger?: UserLedger,
): Promise<ReconciliationResult> {
  const warnings: string[] = [];

  // 0a. Verify any refund_uncertain dead-letters BEFORE we drain
  //     pending ledger adjustments. A confirmed-success verification
  //     queues a ledger debit (when the user lock is contended), and
  //     we want that debit to flow through the very next drain so the
  //     reconcile snapshot reflects it.
  let uncertainRefundsVerified: RefundVerificationOutcome[] = [];
  try {
    uncertainRefundsVerified = await verifyUncertainRefunds(
      client,
      store,
      accounting,
    );
  } catch (e) {
    logger.warn('refund_uncertain verification failed during reconcile', {
      component: 'Reconciliation',
      error: e instanceof Error ? e.message : String(e),
    });
  }
  for (const o of uncertainRefundsVerified) {
    if (o.status === 'failed') {
      warnings.push(
        `Refund ${o.refundTxId} for original ${o.originalTxId} confirmed FAILED on chain — claim released, retry permitted.`,
      );
    } else if (o.status === 'still_uncertain') {
      warnings.push(
        `Refund ${o.refundTxId} for original ${o.originalTxId} still unverified: ${o.note}`,
      );
    }
  }

  // 0a-bis. Same treatment for withdrawal_uncertain dead-letters.
  //         Requires a UserLedger so we can settle/release the
  //         user-side reserve when the on-chain outcome is confirmed.
  //         When ledger is undefined (CLI script with bare store, etc.)
  //         we skip — the row remains for next reconcile to pick up
  //         once a real ledger is wired in.
  let uncertainWithdrawalsVerified: WithdrawalVerificationOutcome[] = [];
  if (ledger) {
    try {
      uncertainWithdrawalsVerified = await verifyUncertainWithdrawals(
        store,
        ledger,
        accounting,
      );
    } catch (e) {
      logger.warn('withdrawal_uncertain verification failed during reconcile', {
        component: 'Reconciliation',
        error: e instanceof Error ? e.message : String(e),
      });
    }
    for (const o of uncertainWithdrawalsVerified) {
      if (o.status === 'failed') {
        warnings.push(
          `Withdrawal ${o.withdrawTxId} for user ${o.userId} confirmed FAILED on chain — reserve released, retry permitted.`,
        );
      } else if (o.status === 'still_uncertain') {
        warnings.push(
          `Withdrawal ${o.withdrawTxId} for user ${o.userId} still unverified: ${o.note}`,
        );
      }
    }
  }

  // 0a-ter. Same for operator_fee_withdraw_uncertain. No ledger
  //         dependency — operator state mutation is on the store
  //         directly.
  let uncertainOperatorFeeWithdrawalsVerified: OperatorFeeWithdrawVerificationOutcome[] = [];
  try {
    const agentAccountId = getOperatorAccountId(client);
    uncertainOperatorFeeWithdrawalsVerified =
      await verifyUncertainOperatorFeeWithdrawals(store, agentAccountId, accounting);
  } catch (e) {
    logger.warn(
      'operator_fee_withdraw_uncertain verification failed during reconcile',
      {
        component: 'Reconciliation',
        error: e instanceof Error ? e.message : String(e),
      },
    );
  }
  for (const o of uncertainOperatorFeeWithdrawalsVerified) {
    if (o.status === 'failed') {
      warnings.push(
        `Operator fee withdrawal ${o.withdrawTxId} confirmed FAILED on chain — operator state untouched, retry permitted.`,
      );
    } else if (o.status === 'still_uncertain') {
      warnings.push(
        `Operator fee withdrawal ${o.withdrawTxId} still unverified: ${o.note}`,
      );
    }
  }

  // 0a-quater. play_uncertain — the C1 path. SUCCESS entries always
  //            need manual triage (settlement state can't be
  //            auto-reconstructed); FAILED entries release reservations.
  let uncertainPlaysVerified: PlayVerificationOutcome[] = [];
  if (ledger) {
    try {
      uncertainPlaysVerified = await verifyUncertainPlays(store, ledger, accounting);
    } catch (e) {
      logger.warn('play_uncertain verification failed during reconcile', {
        component: 'Reconciliation',
        error: e instanceof Error ? e.message : String(e),
      });
    }
    for (const o of uncertainPlaysVerified) {
      if (o.status === 'failed') {
        warnings.push(
          `Play ${o.uncertainTxId} for user ${o.userId} confirmed FAILED on chain — reservations released.`,
        );
      } else if (o.status === 'confirmed') {
        warnings.push(
          `MANUAL TRIAGE: play ${o.uncertainTxId} for user ${o.userId} confirmed on chain — settlement state must be reconstructed manually.`,
        );
      } else {
        warnings.push(
          `Play ${o.uncertainTxId} for user ${o.userId} still unverified: ${o.note}`,
        );
      }
    }
  }

  // 0b. Drain pending ledger adjustments before snapshotting balances.
  //     The queue exists because refunds can't always grab the per-user
  //     lock at settle time — draining here ensures the ledger is caught
  //     up before we measure drift, so we don't false-flag drift that's
  //     just a queue waiting to be applied.
  //
  //     L22 — Ordering note for step 1 (balance snapshot reads):
  //     The verifiers above (0a / 0a-bis / 0a-ter / 0a-quater) mutate
  //     in-process state directly (`store.updateBalance`,
  //     `store.updateOperator`, `ledger.settleSpend/releaseReserve`).
  //     Because IStore implementations write through the in-process
  //     cache synchronously, step 1's `getAllUsers()` and
  //     `getOperator()` reads see those mutations without a fresh
  //     remote pull. We do NOT call `refreshUserIndex()` /
  //     `refreshOperator()` here — that would clobber the verifier
  //     mutations until the deferred flush completes. The trade-off:
  //     this reconcile is single-Lambda; another Lambda's recent
  //     writes won't be visible. That's fine — reconcile is wrapped
  //     in an operator lock and serialised by the cron schedule.
  const pendingLedgerDrained = await drainPendingLedgerAdjustments(store);
  if (pendingLedgerDrained.applied > 0) {
    warnings.push(
      `Applied ${pendingLedgerDrained.applied} pending ledger adjustment(s) before reconciling.`,
    );
  }
  if (pendingLedgerDrained.deferred > 0) {
    warnings.push(
      `${pendingLedgerDrained.deferred} pending ledger adjustment(s) still deferred (user locks held).`,
    );
  }

  // 1. Fetch on-chain balances
  const info = await getWalletInfo(client);
  const accountId = info.accountId.toString();
  const hbar = hbarToNumber(info.hbarBalance);
  const tokenBalances = await getTokenBalances(accountId);

  const onChain: Record<string, number> = { [HBAR_TOKEN_KEY]: hbar };
  for (const tb of tokenBalances) {
    onChain[tb.token_id] = roundToDecimals(tb.balance / Math.pow(10, tb.decimals), tb.decimals);
  }

  // 2. Sum all user balances
  const ledgerTotal: Record<string, number> = {};
  const users = store.getAllUsers();
  for (const user of users) {
    for (const [token, entry] of Object.entries(user.balances.tokens)) {
      const userTotal = entry.available + entry.reserved;
      ledgerTotal[token] = (ledgerTotal[token] ?? 0) + userTotal;
    }
  }

  // 3. Add operator balances
  const op = store.getOperator();
  for (const [token, balance] of Object.entries(op.balances)) {
    ledgerTotal[token] = (ledgerTotal[token] ?? 0) + balance;
  }

  // 4. Fetch actual transaction fees from mirror node
  let actualNetworkFeesHbar = 0;
  try {
    actualNetworkFeesHbar = await sumTransactionFees(accountId, fromTimestamp);
  } catch (e) {
    warnings.push(`Could not fetch actual transaction fees: ${e instanceof Error ? e.message : e}`);
  }

  // The operator's GasTracker records estimated gas, not actual fees.
  // The difference is untracked HBAR drain that explains part of the delta.
  const trackedGasHbar = op.totalGasSpent;
  const untrackedFeesHbar = Math.max(0, actualNetworkFeesHbar - trackedGasHbar);

  // 5. Compute raw deltas
  const allTokens = new Set([...Object.keys(onChain), ...Object.keys(ledgerTotal)]);

  // 5a. Warm the token registry for every token we're about to report
  //     on. getTokenMeta caches in-process and falls back to the raw
  //     ID if mirror node lookup fails. We do this BEFORE building the
  //     delta + warnings so the warning strings can use display symbols
  //     ("LAZY", "HBAR") instead of raw token IDs that operators can't
  //     read at a glance ("0.0.6011249"). Best-effort — if any single
  //     lookup fails the entire reconcile still returns.
  const symbols: Record<string, string> = {};
  await Promise.all(
    Array.from(allTokens).map(async (token) => {
      try {
        const meta = await getTokenMeta(token);
        symbols[token] = meta.symbol;
      } catch {
        symbols[token] = token;
      }
    }),
  );

  const delta: Record<string, number> = {};
  const adjustedDelta: Record<string, number> = {};
  let solvent = true;

  for (const token of allTokens) {
    const chain = onChain[token] ?? 0;
    const ledger = ledgerTotal[token] ?? 0;
    delta[token] = chain - ledger;

    // For HBAR, adjust by the untracked network fees (these explain expected shortfall)
    adjustedDelta[token] = token === HBAR_TOKEN_KEY
      ? delta[token] + untrackedFeesHbar
      : delta[token];

    const display = symbols[token] ?? token;

    // Solvency check uses adjusted delta (accounts for known fee drain)
    if (adjustedDelta[token] < -0.01) {
      solvent = false;
      warnings.push(
        `INSOLVENCY: ${display} on-chain=${chain.toFixed(4)}, ledger=${ledger.toFixed(4)}, ` +
          `adjusted_shortfall=${Math.abs(adjustedDelta[token]).toFixed(4)}`
      );
    } else if (adjustedDelta[token] > 1) {
      warnings.push(
        `UNACCOUNTED: ${display} on-chain has ${adjustedDelta[token].toFixed(4)} more than ledger tracks`
      );
    }
  }

  // 6. Schema version divergence report. We walk the user records and
  //    operator state once, counting how many records carry each
  //    stamped version. `0` means no schemaVersion field (legacy /
  //    pre-PR4 write). When the operator plans a migration they can
  //    see exactly how many records are behind the current version.
  //
  //    NOTE: schema drift is *not* added to the warnings array. It's
  //    informational state, surfaced through the structured `schema`
  //    field on the result so the admin UI can render it as its own
  //    section instead of mixing it in with insolvency / unaccounted
  //    warnings (which are real concerns). Operators run the migrate-
  //    schema endpoint to clear it; until then v0 and v1 records are
  //    structurally identical so there's nothing actionable.
  const schemaUserCounts: Record<number, number> = {};
  for (const user of users) {
    const v = user.schemaVersion ?? 0;
    schemaUserCounts[v] = (schemaUserCounts[v] ?? 0) + 1;
  }
  const schemaOperator = op.schemaVersion ?? 0;
  const allAtCurrent =
    schemaOperator === CURRENT_SCHEMA_VERSION &&
    Object.keys(schemaUserCounts).every(
      (k) => Number(k) === CURRENT_SCHEMA_VERSION,
    );

  const pendingLedgerRemaining = await getPendingLedgerCount();
  if (pendingLedgerRemaining > 0) {
    warnings.push(
      `${pendingLedgerRemaining} pending ledger adjustment(s) still queued.`,
    );
  }

  return {
    timestamp: new Date().toISOString(),
    onChain,
    ledgerTotal,
    actualNetworkFeesHbar,
    trackedGasHbar,
    untrackedFeesHbar,
    delta,
    adjustedDelta,
    symbols,
    solvent,
    warnings,
    schema: {
      current: CURRENT_SCHEMA_VERSION,
      users: schemaUserCounts,
      operator: schemaOperator,
      allAtCurrent,
    },
    pendingLedgerDrained,
    pendingLedgerRemaining,
    uncertainRefundsVerified,
    uncertainWithdrawalsVerified,
    uncertainOperatorFeeWithdrawalsVerified,
    uncertainPlaysVerified,
  };
}
