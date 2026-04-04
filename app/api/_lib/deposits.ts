/**
 * On-demand deposit detection for serverless API routes.
 *
 * Calls DepositWatcher.pollOnce() to check for new deposits
 * since the last watermark. Idempotent — already-processed
 * transactions are skipped via store.isTransactionProcessed().
 *
 * Called before any balance-dependent operation so users
 * always see fresh data without requiring a background poller.
 */

import { DepositWatcher } from '~/custodial/DepositWatcher';
import { UserLedger } from '~/custodial/UserLedger';
import { AccountingService } from '~/custodial/AccountingService';
import { getOperatorAccountId } from '~/hedera/wallet';
import { loadCustodialConfig } from '~/custodial/types';
import { getStore } from './store';
import { getClient } from './hedera';

let watcher: DepositWatcher | null = null;

/**
 * Check for new deposits on the Hedera mirror node.
 * Returns the number of deposits processed in this poll cycle.
 */
export async function checkDeposits(): Promise<number> {
  if (!watcher) {
    const store = await getStore();
    const client = getClient();
    const agentAccountId = getOperatorAccountId(client);
    const config = loadCustodialConfig();

    const accounting = new AccountingService({
      client,
      tick: config.hcs20Tick,
      topicId: config.hcs20TopicId ?? undefined,
    });

    const ledger = new UserLedger(store, accounting, agentAccountId);
    watcher = new DepositWatcher(agentAccountId, store, ledger, config);
  }

  return watcher.pollOnce();
}
