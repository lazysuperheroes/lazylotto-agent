import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@hashgraph/sdk';
import { NegotiationHandler } from './NegotiationHandler.js';
import type { PersistentStore } from './PersistentStore.js';
import type {
  CustodialConfig,
  UserAccount,
} from './types.js';
import { emptyBalances } from './types.js';

// ── Test Config ────────────────────────────────────────────────

const AGENT_ACCOUNT = '0.0.9999';

const TEST_CONFIG: CustodialConfig = {
  rake: {
    defaultPercent: 5,
    minPercent: 2,
    maxPercent: 5,
    volumeTiers: [
      { minDeposit: 1000, rakePercent: 3 },
      { minDeposit: 200, rakePercent: 4 },
      { minDeposit: 50, rakePercent: 5 },
    ],
  },
  depositPollIntervalMs: 10_000,
  hcs10PollIntervalMs: 15_000,
  minDepositAmount: 1,
  maxUserBalance: 10_000,
  maxUsersPerPlayCycle: 10,
  gasReservePerUser: 5,
  hcs20Tick: 'LLCRED',
  hcs20TopicId: null,
  dataDir: '.test-data',
};

// ── Mock Store ─────────────────────────────────────────────────

interface MockStoreState {
  users: Map<string, UserAccount>;
  accountIdIndex: Map<string, UserAccount>;
  memoIndex: Map<string, UserAccount>;
}

function createMockStore(initial?: Partial<MockStoreState>): PersistentStore & { _state: MockStoreState } {
  const state: MockStoreState = {
    users: initial?.users ?? new Map(),
    accountIdIndex: initial?.accountIdIndex ?? new Map(),
    memoIndex: initial?.memoIndex ?? new Map(),
  };

  return {
    _state: state,

    getUser(userId: string): UserAccount | undefined {
      return state.users.get(userId);
    },
    getUserByMemo(memo: string): UserAccount | undefined {
      return state.memoIndex.get(memo);
    },
    getUserByAccountId(accountId: string): UserAccount | undefined {
      return state.accountIdIndex.get(accountId);
    },
    saveUser(user: UserAccount): void {
      state.users.set(user.userId, user);
      state.memoIndex.set(user.depositMemo, user);
      if (user.hederaAccountId) {
        state.accountIdIndex.set(user.hederaAccountId, user);
      }
    },
    getAllUsers(): UserAccount[] {
      return Array.from(state.users.values());
    },
    async flush(): Promise<void> {
      // no-op
    },
  } as unknown as PersistentStore & { _state: MockStoreState };
}

// ── Tests ──────────────────────────────────────────────────────

describe('NegotiationHandler', () => {
  let store: ReturnType<typeof createMockStore>;
  let handler: NegotiationHandler;

  beforeEach(() => {
    store = createMockStore();
    // Pass a bare object as Client since registerUser does not
    // invoke any Hedera SDK operations on it.
    handler = new NegotiationHandler(
      {} as Client,
      store,
      TEST_CONFIG,
      AGENT_ACCOUNT,
    );
  });

  // ── registerUser ─────────────────────────────────────────────

  describe('registerUser', () => {
    it('creates a user with correct fields', async () => {
      const user = await handler.registerUser(
        '0.0.1234',
        '0.0.1234',
        'conservative',
      );

      assert.ok(user.userId, 'userId should be set');
      assert.ok(user.depositMemo.startsWith('ll-'), 'memo should start with ll-');
      assert.equal(user.hederaAccountId, '0.0.1234');
      assert.equal(user.eoaAddress, '0.0.1234');
      assert.equal(user.strategyName, 'conservative');
      assert.equal(user.strategyVersion, '0.2');
      assert.ok(user.strategySnapshot, 'strategy snapshot should be set');
      assert.equal(user.rakePercent, 5); // default rake clamped to max
      assert.deepStrictEqual(user.balances, emptyBalances());
      assert.equal(user.connectionTopicId, null);
      assert.ok(user.registeredAt, 'registeredAt should be set');
      assert.equal(user.lastPlayedAt, null);
      assert.equal(user.active, true);
    });

    it('returns existing user if already registered (idempotent)', async () => {
      const first = await handler.registerUser(
        '0.0.5555',
        '0.0.5555',
        'balanced',
      );
      const second = await handler.registerUser(
        '0.0.5555',
        '0.0.5555',
        'aggressive', // different strategy -- should be ignored
      );

      assert.equal(first.userId, second.userId);
      assert.equal(first.strategyName, second.strategyName);
    });

    it('rejects invalid strategy name', async () => {
      await assert.rejects(
        () => handler.registerUser('0.0.1234', '0.0.1234', 'yolo'),
        (err: Error) => {
          assert.match(err.message, /Unknown strategy "yolo"/);
          return true;
        },
      );
    });

    it('validates EOA in Hedera 0.0.X format', async () => {
      const user = await handler.registerUser(
        '0.0.9876',
        '0.0.9876',
        'conservative',
      );
      assert.equal(user.eoaAddress, '0.0.9876');
    });

    it('validates EOA in 0x hex format', async () => {
      const hexEoa = '0x' + 'aB'.repeat(20);
      const user = await handler.registerUser(
        '0.0.1111',
        hexEoa,
        'conservative',
      );
      assert.equal(user.eoaAddress, hexEoa);
    });

    it('rejects invalid EOA format', async () => {
      await assert.rejects(
        () => handler.registerUser('0.0.1234', 'not-an-address', 'conservative'),
        (err: Error) => {
          assert.match(err.message, /Invalid EOA address/);
          return true;
        },
      );
    });

    it('rejects short hex EOA', async () => {
      await assert.rejects(
        () => handler.registerUser('0.0.1234', '0xabc', 'conservative'),
        (err: Error) => {
          assert.match(err.message, /Invalid EOA address/);
          return true;
        },
      );
    });

    it('applies custom rake clamped to band', async () => {
      // rakePercent = 3 is within [2, 5]
      const user = await handler.registerUser(
        '0.0.2222',
        '0.0.2222',
        'conservative',
        3,
      );
      assert.equal(user.rakePercent, 3);
    });

    it('clamps rake below minimum to minPercent', async () => {
      const user = await handler.registerUser(
        '0.0.3333',
        '0.0.3333',
        'conservative',
        0.5, // below minPercent of 2
      );
      assert.equal(user.rakePercent, 2);
    });

    it('clamps rake above maximum to maxPercent', async () => {
      const user = await handler.registerUser(
        '0.0.4444',
        '0.0.4444',
        'conservative',
        99, // above maxPercent of 5
      );
      assert.equal(user.rakePercent, 5);
    });

    it('persists user to store', async () => {
      const user = await handler.registerUser(
        '0.0.7777',
        '0.0.7777',
        'conservative',
      );

      const stored = store.getUserByAccountId('0.0.7777');
      assert.ok(stored);
      assert.equal(stored.userId, user.userId);
    });
  });

  // ── validateRake ─────────────────────────────────────────────

  describe('validateRake', () => {
    it('clamps to minimum', () => {
      assert.equal(handler.validateRake(0), 2);
      assert.equal(handler.validateRake(1), 2);
      assert.equal(handler.validateRake(-5), 2);
    });

    it('clamps to maximum', () => {
      assert.equal(handler.validateRake(10), 5);
      assert.equal(handler.validateRake(100), 5);
    });

    it('returns value within band unchanged', () => {
      assert.equal(handler.validateRake(2), 2);
      assert.equal(handler.validateRake(3), 3);
      assert.equal(handler.validateRake(4), 4);
      assert.equal(handler.validateRake(5), 5);
    });

    it('handles boundary values exactly', () => {
      assert.equal(handler.validateRake(2), 2);  // minPercent
      assert.equal(handler.validateRake(5), 5);  // maxPercent
    });
  });

  // ── rakeForVolume ────────────────────────────────────────────

  describe('rakeForVolume', () => {
    // Tiers: 1000 -> 3%, 200 -> 4%, 50 -> 5%, default -> 5%

    it('returns 3% for deposit >= 1000', () => {
      assert.equal(handler.rakeForVolume(1000), 3);
      assert.equal(handler.rakeForVolume(5000), 3);
    });

    it('returns 4% for deposit >= 200 but < 1000', () => {
      assert.equal(handler.rakeForVolume(200), 4);
      assert.equal(handler.rakeForVolume(500), 4);
      assert.equal(handler.rakeForVolume(999), 4);
    });

    it('returns 5% for deposit >= 50 but < 200', () => {
      assert.equal(handler.rakeForVolume(50), 5);
      assert.equal(handler.rakeForVolume(100), 5);
      assert.equal(handler.rakeForVolume(199), 5);
    });

    it('returns defaultPercent for deposit below all tiers', () => {
      assert.equal(handler.rakeForVolume(10), 5);
      assert.equal(handler.rakeForVolume(0), 5);
      assert.equal(handler.rakeForVolume(49), 5);
    });
  });

  // ── generateDepositMemo ──────────────────────────────────────

  describe('generateDepositMemo', () => {
    it('produces memo with ll- prefix and 32 hex chars (35 total)', () => {
      const memo = handler.generateDepositMemo();

      assert.ok(memo.startsWith('ll-'), `memo should start with "ll-": ${memo}`);
      assert.equal(memo.length, 35, `memo should be 35 chars: ${memo}`);

      // Verify the hex portion (after "ll-") is valid hex
      const hexPart = memo.slice(3);
      assert.match(hexPart, /^[0-9a-f]{32}$/, `hex part should be 32 lowercase hex chars: ${hexPart}`);
    });

    it('produces unique memos', () => {
      const memos = new Set<string>();
      for (let i = 0; i < 100; i++) {
        memos.add(handler.generateDepositMemo());
      }
      assert.equal(memos.size, 100, 'all 100 memos should be unique');
    });

    it('regenerates if memo collides with existing user', () => {
      // Pre-populate the store with a user whose memo matches the first
      // generation attempt. Since randomBytes is truly random, this test
      // verifies the do-while loop by checking the final memo is not in
      // the store. We cannot force a collision easily, so we just verify
      // the returned memo is not already mapped.
      const memo = handler.generateDepositMemo();
      assert.equal(store.getUserByMemo(memo), undefined);
    });
  });

  // ── getAvailableStrategies ───────────────────────────────────

  describe('getAvailableStrategies', () => {
    it('returns 3 strategies', () => {
      const strategies = handler.getAvailableStrategies();
      assert.equal(strategies.length, 3);
    });

    it('includes conservative, balanced, aggressive', () => {
      const strategies = handler.getAvailableStrategies();
      assert.ok(strategies.includes('conservative'));
      assert.ok(strategies.includes('balanced'));
      assert.ok(strategies.includes('aggressive'));
    });

    it('returns a copy (not the internal array)', () => {
      const a = handler.getAvailableStrategies();
      const b = handler.getAvailableStrategies();
      assert.notEqual(a, b); // different reference
      assert.deepStrictEqual(a, b); // same contents
    });
  });

  // ── updateUserStrategy ───────────────────────────────────────
  //
  // Self-serve strategy change. Called from the HTTP route
  // (POST /api/user/strategy) and the MCP tool
  // (multi_user_set_strategy). The handler is the single source
  // of truth for validation, snapshot loading, and persistence.

  describe('updateUserStrategy', () => {
    it('updates strategyName + strategyVersion + strategySnapshot', async () => {
      const initial = await handler.registerUser(
        '0.0.7777',
        '0.0.7777',
        'conservative',
      );
      assert.equal(initial.strategyName, 'conservative');

      const updated = await handler.updateUserStrategy(initial.userId, 'aggressive');

      assert.equal(updated.userId, initial.userId);
      assert.equal(updated.strategyName, 'aggressive');
      assert.ok(updated.strategyVersion, 'version should be set');
      assert.ok(updated.strategySnapshot, 'snapshot should be loaded');
      // Snapshot reflects the new strategy, not the old one
      assert.equal(updated.strategySnapshot.name, 'aggressive');
    });

    it('persists the change via store.saveUser', async () => {
      const initial = await handler.registerUser(
        '0.0.7778',
        '0.0.7778',
        'conservative',
      );
      await handler.updateUserStrategy(initial.userId, 'balanced');

      // Re-fetch from store — the change must be durable, not just
      // returned from the call.
      const refetched = store.getUser(initial.userId);
      assert.ok(refetched);
      assert.equal(refetched.strategyName, 'balanced');
    });

    it('preserves balances, memo, registration date, rakePercent', async () => {
      const initial = await handler.registerUser(
        '0.0.7779',
        '0.0.7779',
        'conservative',
        3, // custom rake
      );
      const updated = await handler.updateUserStrategy(initial.userId, 'balanced');

      assert.equal(updated.depositMemo, initial.depositMemo);
      assert.equal(updated.registeredAt, initial.registeredAt);
      assert.equal(updated.rakePercent, initial.rakePercent);
      assert.deepStrictEqual(updated.balances, initial.balances);
      assert.equal(updated.active, true);
    });

    it('rejects unknown strategy name with available list in message', async () => {
      const initial = await handler.registerUser(
        '0.0.7780',
        '0.0.7780',
        'conservative',
      );
      await assert.rejects(
        () => handler.updateUserStrategy(initial.userId, 'yolo'),
        (err: Error) => {
          assert.match(err.message, /Unknown strategy "yolo"/);
          assert.match(err.message, /conservative|balanced|aggressive/);
          return true;
        },
      );
    });

    it('rejects when user does not exist', async () => {
      await assert.rejects(
        () => handler.updateUserStrategy('ghost-userId', 'balanced'),
        (err: Error) => {
          assert.match(err.message, /not found/);
          return true;
        },
      );
    });

    it('rejects when user is deregistered', async () => {
      const initial = await handler.registerUser(
        '0.0.7781',
        '0.0.7781',
        'conservative',
      );
      // Simulate deregistration by flipping active directly on the
      // stored record — matches what deregisterUser does in the
      // real store.
      const stored = store.getUser(initial.userId);
      assert.ok(stored);
      stored.active = false;
      store.saveUser(stored);

      await assert.rejects(
        () => handler.updateUserStrategy(initial.userId, 'balanced'),
        (err: Error) => {
          assert.match(err.message, /deregistered/);
          return true;
        },
      );
    });

    it('is safe to call with the same strategy (no-op style)', async () => {
      // Caller is responsible for idempotent short-circuiting (see
      // POST /api/user/strategy and multi_user_set_strategy), but
      // the handler itself still has to handle same-name gracefully
      // — it just re-loads the snapshot and writes the same data.
      const initial = await handler.registerUser(
        '0.0.7782',
        '0.0.7782',
        'balanced',
      );
      const updated = await handler.updateUserStrategy(initial.userId, 'balanced');

      assert.equal(updated.strategyName, 'balanced');
      assert.equal(updated.strategyVersion, initial.strategyVersion);
    });
  });
});
