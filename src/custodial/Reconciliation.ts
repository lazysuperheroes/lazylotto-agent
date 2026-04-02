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
import type { Client } from '@hashgraph/sdk';
import type { PersistentStore } from './PersistentStore.js';
import { hbarToNumber } from '../utils/format.js';
import { roundToDecimals } from '../utils/math.js';
import { HBAR_TOKEN_KEY } from '../config/strategy.js';

export interface ReconciliationResult {
  timestamp: string;
  onChain: Record<string, number>;
  ledgerTotal: Record<string, number>;
  actualNetworkFeesHbar: number;
  trackedGasHbar: number;
  untrackedFeesHbar: number;
  delta: Record<string, number>;
  adjustedDelta: Record<string, number>;
  solvent: boolean;
  warnings: string[];
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
  store: PersistentStore,
  fromTimestamp?: string,
): Promise<ReconciliationResult> {
  const warnings: string[] = [];

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

    // Solvency check uses adjusted delta (accounts for known fee drain)
    if (adjustedDelta[token] < -0.01) {
      solvent = false;
      warnings.push(
        `INSOLVENCY: ${token} on-chain=${chain.toFixed(4)}, ledger=${ledger.toFixed(4)}, ` +
          `adjusted_shortfall=${Math.abs(adjustedDelta[token]).toFixed(4)}`
      );
    } else if (adjustedDelta[token] > 1) {
      warnings.push(
        `UNACCOUNTED: ${token} on-chain has ${adjustedDelta[token].toFixed(4)} more than ledger tracks`
      );
    }
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
    solvent,
    warnings,
  };
}
