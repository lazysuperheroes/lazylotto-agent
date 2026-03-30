import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GasTracker } from './GasTracker.js';
import type { PersistentStore } from './PersistentStore.js';
import type { GasRecord, OperatorState } from './types.js';
import { emptyOperatorState } from './types.js';

// ── Mock store ─────────────────────────────────────────────────

function createMockStore(): PersistentStore {
  let operator: OperatorState = { ...emptyOperatorState(), balances: { hbar: 100 } };
  const gasLog: GasRecord[] = [];

  return {
    recordGas(record: GasRecord): void {
      gasLog.push(record);
    },
    updateOperator(updater: (s: OperatorState) => OperatorState): OperatorState {
      operator = updater(operator);
      return operator;
    },
    getGasForUser(userId: string): GasRecord[] {
      return gasLog.filter((g) => g.userId === userId);
    },
    getAllGasRecords(): GasRecord[] {
      return gasLog;
    },
    getOperator(): OperatorState {
      return operator;
    },
  } as unknown as PersistentStore;
}

// ── Tests ──────────────────────────────────────────────────────

describe('GasTracker', () => {
  let store: PersistentStore;
  let tracker: GasTracker;

  beforeEach(() => {
    store = createMockStore();
    tracker = new GasTracker(store);
  });

  it('records gas and deducts from operator', () => {
    tracker.recordGas('tx-gas-1', 'user-1', 'buyAndRoll', 0.5);

    const op = store.getOperator();
    assert.equal(op.balances.hbar, 99.5);  // 100 - 0.5
    assert.equal(op.totalGasSpent, 0.5);

    // Record another
    tracker.recordGas('tx-gas-2', 'user-1', 'transferPrizes', 0.3);
    const op2 = store.getOperator();
    assert.equal(op2.balances.hbar, 99.2);  // 99.5 - 0.3
    assert.equal(op2.totalGasSpent, 0.8);     // 0.5 + 0.3
  });

  it('totalGasForUser sums correctly', () => {
    tracker.recordGas('tx-a', 'user-1', 'buyAndRoll', 0.5);
    tracker.recordGas('tx-b', 'user-2', 'buyAndRoll', 1.0);
    tracker.recordGas('tx-c', 'user-1', 'transferPrizes', 0.3);

    assert.equal(tracker.totalGasForUser('user-1'), 0.8);  // 0.5 + 0.3
    assert.equal(tracker.totalGasForUser('user-2'), 1.0);
    assert.equal(tracker.totalGasForUser('user-3'), 0);     // no records
  });

  it('totalGas reads from operator state', () => {
    assert.equal(tracker.totalGas(), 0); // initial

    tracker.recordGas('tx-1', 'user-1', 'buyAndRoll', 2.0);
    tracker.recordGas('tx-2', 'system', 'tokenAssociate', 0.1);

    assert.equal(tracker.totalGas(), 2.1);
  });
});
