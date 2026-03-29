import type { GasRecord, OperatorState } from './types.js';
import type { PersistentStore } from './PersistentStore.js';

export class GasTracker {
  constructor(private store: PersistentStore) {}

  /**
   * Record a gas cost from a transaction and deduct from operator balance.
   *
   * @param operation - Descriptive label: 'buyAndRoll', 'transferPrizes',
   *   'withdraw', 'tokenAssociate', 'tokenApprove', 'hcs20Message', etc.
   */
  recordGas(
    transactionId: string,
    userId: string | 'system',
    operation: string,
    gasCostHbar: number,
  ): void {
    const record: GasRecord = {
      transactionId,
      userId,
      operation,
      gasCostHbar,
      timestamp: new Date().toISOString(),
    };

    this.store.recordGas(record);
    this.deductFromOperator(gasCostHbar);
  }

  /** Deduct gas cost from the operator's platform balance. */
  private deductFromOperator(gasCostHbar: number): void {
    this.store.updateOperator((op: OperatorState) => ({
      ...op,
      platformBalance: op.platformBalance - gasCostHbar,
      totalGasSpent: op.totalGasSpent + gasCostHbar,
    }));
  }

  /** Sum of all gas costs attributed to a specific user. */
  totalGasForUser(userId: string): number {
    return this.store
      .getGasForUser(userId)
      .reduce((sum, r) => sum + r.gasCostHbar, 0);
  }

  /** Sum of all gas costs within a timestamp range (ISO-8601 strings). */
  totalGasForPeriod(fromTimestamp: string, toTimestamp: string): number {
    return this.store
      .getAllGasRecords()
      .filter((r) => r.timestamp >= fromTimestamp && r.timestamp <= toTimestamp)
      .reduce((sum, r) => sum + r.gasCostHbar, 0);
  }

  /** Cumulative gas spent across all operations (from operator state). */
  totalGas(): number {
    return this.store.getOperator().totalGasSpent;
  }

  /** All gas records for a given user. */
  getGasRecords(userId: string): GasRecord[] {
    return this.store.getGasForUser(userId);
  }
}
