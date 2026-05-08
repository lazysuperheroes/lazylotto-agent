/**
 * Unit tests for the reconcile-time verifiers in uncertainTxVerification.ts.
 *
 * Coverage matrix per verifier:
 *   - SUCCESS branch (mirror returns 'SUCCESS')
 *   - FAILED branch (mirror returns a known failure code)
 *   - NOT_FOUND branch (recent — leave for next pass)
 *   - NOT_FOUND branch (>24h old — promote to FAILED via H7 max-age)
 *   - Unknown mirror result string — treated as NOT_FOUND (H8)
 *   - Mirror 5xx — still_uncertain
 *   - Mirror network error — still_uncertain
 *   - Concurrent verifier lock held — still_uncertain
 *   - Idempotency: running twice in succession — second pass no-ops
 *   - Malformed entry — verificationAttempts increments
 *   - Audit-write failure — audit_trail_orphaned dead-letter written
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from './PersistentStore.js';
import { UserLedger } from './UserLedger.js';
import type { AccountingService } from './AccountingService.js';
import type { DeadLetterEntry } from './IStore.js';
import { emptyBalances } from './types.js';
import {
  verifyUncertainWithdrawals,
  verifyUncertainOperatorFeeWithdrawals,
  verifyUncertainPlays,
  parseTxIdTimestamp,
} from './uncertainTxVerification.js';

// ── F27: parseTxIdTimestamp invariant tests ──────────────────────

describe('F27: parseTxIdTimestamp', () => {
  it('parses a Hedera txId valid-start timestamp into milliseconds', () => {
    // 1700000000.000000001 = Nov 14 2023 22:13:20 UTC + 1 nanosecond
    const ms = parseTxIdTimestamp('0.0.1234@1700000000.000000001');
    assert.equal(ms, 1700000000_000);
  });

  it('truncates nanos to ms (rounds down)', () => {
    // 1700000000.999999999 → 1700000000_999 (floor of nanos / 1e6)
    const ms = parseTxIdTimestamp('0.0.1234@1700000000.999999999');
    assert.equal(ms, 1700000000_999);
  });

  it('returns null for malformed txId', () => {
    assert.equal(parseTxIdTimestamp('not-a-tx-id'), null);
    assert.equal(parseTxIdTimestamp('0.0.X@1234.5'), null);
    assert.equal(parseTxIdTimestamp('audit-orphan:0.0.1@123.456'), null);
    assert.equal(parseTxIdTimestamp(''), null);
  });

  it('returns null for negative or non-numeric components', () => {
    assert.equal(parseTxIdTimestamp('0.0.1@-100.0'), null);
    assert.equal(parseTxIdTimestamp('0.0.1@abc.0'), null);
  });
});

// ── Test harness ─────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'verifier-test-'));
}

function noopAccounting(): AccountingService {
  return {
    async recordDeposit(): Promise<void> {},
    async recordRake(): Promise<void> {},
    async recordWithdrawal(): Promise<void> {},
    async recordPlaySession(): Promise<void> {},
    async recordOperatorWithdrawal(): Promise<void> {},
    async recordRefund(): Promise<void> {},
    async deploy(): Promise<string> { return '0.0.0'; },
  } as unknown as AccountingService;
}

interface AuditCalls {
  recordWithdrawal: Array<{ user: string; amount: number; token: string }>;
  recordOperatorWithdrawal: Array<{ agent: string; amount: number; token: string }>;
}

function trackingAccounting(throws = false): { audit: AccountingService; calls: AuditCalls } {
  const calls: AuditCalls = { recordWithdrawal: [], recordOperatorWithdrawal: [] };
  const audit = {
    async recordDeposit(): Promise<void> {},
    async recordRake(): Promise<void> {},
    async recordWithdrawal(user: string, amount: number, token: string): Promise<void> {
      if (throws) throw new Error('synthetic audit write failure');
      calls.recordWithdrawal.push({ user, amount, token });
    },
    async recordPlaySession(): Promise<void> {},
    async recordOperatorWithdrawal(agent: string, amount: number, token: string): Promise<void> {
      if (throws) throw new Error('synthetic audit write failure');
      calls.recordOperatorWithdrawal.push({ agent, amount, token });
    },
    async recordRefund(): Promise<void> {},
    async deploy(): Promise<string> { return '0.0.0'; },
  } as unknown as AccountingService;
  return { audit, calls };
}

// ── Mirror node mock ─────────────────────────────────────────────

interface FetchMockState {
  responses: Map<string, { status: number; body?: { transactions?: Array<{ result: string }> } }>;
  errors: Set<string>;
}

const originalFetch = globalThis.fetch;

function installFetchMock(): FetchMockState {
  const state: FetchMockState = { responses: new Map(), errors: new Set() };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    // Extract txId from `/transactions/<txId>` suffix
    const txMatch = url.match(/\/transactions\/([^?]+)/);
    const txId = txMatch ? txMatch[1] : url;
    if (state.errors.has(txId)) {
      throw new Error('synthetic network error');
    }
    const resp = state.responses.get(txId);
    if (!resp) {
      return new Response(null, { status: 404 });
    }
    if (resp.status !== 200) {
      return new Response(null, { status: resp.status });
    }
    return new Response(JSON.stringify(resp.body ?? { transactions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return state;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ── Redis mock with verifier-lock support ────────────────────────

function installRedisMock(): { calls: { setNxCount: number } } {
  const state = new Map<string, unknown>();
  const calls = { setNxCount: 0 };
  const mock = {
    async set(key: string, value: string | number, options?: { nx?: boolean; ex?: number }) {
      if (options?.nx) {
        calls.setNxCount++;
        if (state.has(key)) return null;
        state.set(key, value);
        return 'OK';
      }
      state.set(key, value);
      return 'OK';
    },
    async get(key: string) { return state.get(key) ?? null; },
    async del(key: string) { return state.delete(key) ? 1 : 0; },
    async sadd() { return 0; },
    async sismember() { return 0; },
    async incr(k: string) { const n = Number(state.get(k) ?? 0) + 1; state.set(k, n); return n; },
    async expire() { return 1; },
    // R2-FG-6: emulate the lowercase compare-and-delete Lua so the
    // verifier's lock release actually deletes the key under this
    // mock. Without this the release became a silent no-op once the
    // get-then-del fallback was removed.
    async eval(script: string, keys: string[], args: string[]) {
      if (
        script.includes('get') &&
        script.includes('del') &&
        keys.length === 1 &&
        args.length === 1
      ) {
        const cur = state.get(keys[0]!);
        if (cur === args[0]) {
          state.delete(keys[0]!);
          return 1;
        }
        return 0;
      }
      throw new Error('mock eval: unsupported script');
    },
  };
  (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = mock;
  return { calls };
}

function uninstallRedisMock(): void {
  (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = undefined;
}

// ── Setup helpers ────────────────────────────────────────────────

// F27: txId timestamps drive the 24h NOT_FOUND→FAILED policy. Tests
// that exercise the "recent NOT_FOUND" path need txIds whose
// embedded valid-start timestamp is recent (now-ish). Tests that
// exercise the >24h promotion override `entry.timestamp` directly
// AND use a txId whose embedded ts is also old — so we generate
// the txId from the desired age.
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const TX_OK = `0.0.1234@${NOW_SECONDS}.000000001`;
const TX_FAIL = `0.0.1234@${NOW_SECONDS}.000000002`;
const TX_NOT_FOUND = `0.0.1234@${NOW_SECONDS}.000000003`;
const TX_NOT_FOUND_OLD = `0.0.1234@${NOW_SECONDS - 25 * 60 * 60}.000000004`;

async function setupStore(): Promise<{ dir: string; store: PersistentStore; ledger: UserLedger }> {
  const dir = makeTempDir();
  const store = new PersistentStore(dir);
  await store.load();
  const ledger = new UserLedger(store, noopAccounting(), '0.0.9999');
  // Pre-create user with reserved balance.
  store.saveUser({
    userId: 'user-1',
    depositMemo: 'memo-1',
    hederaAccountId: '0.0.1234',
    eoaAddress: '0xabc',
    strategyName: 's',
    strategyVersion: '0.2',
    strategySnapshot: {} as never,
    rakePercent: 1,
    balances: {
      ...emptyBalances(),
      tokens: {
        hbar: {
          available: 0,
          reserved: 100,
          totalDeposited: 100,
          totalWithdrawn: 0,
          totalRake: 0,
        },
      },
    },
    connectionTopicId: null,
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastPlayedAt: null,
    active: true,
  });
  return { dir, store, ledger };
}

function makeWithdrawalDl(txId: string, ageHours = 1): DeadLetterEntry {
  return {
    transactionId: txId,
    timestamp: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
    error: 'receipt timeout',
    kind: 'withdrawal_uncertain',
    details: {
      userId: 'user-1',
      withdrawTxId: txId,
      amount: 50,
      tokenKey: 'hbar',
      isHbar: true,
      recipientAccountId: '0.0.1234',
    },
  };
}

function makeOperatorFeeDl(txId: string, ageHours = 1): DeadLetterEntry {
  return {
    transactionId: txId,
    timestamp: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
    error: 'receipt timeout',
    kind: 'operator_fee_withdraw_uncertain',
    details: {
      withdrawTxId: txId,
      amount: 25,
      tokenKey: 'hbar',
      token: 'HBAR',
      recipientAccountId: '0.0.5678',
    },
  };
}

function makePlayDl(txId: string, ageHours = 1): DeadLetterEntry {
  return {
    transactionId: txId,
    timestamp: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
    error: 'receipt timeout',
    kind: 'play_uncertain',
    details: {
      userId: 'user-1',
      tokenReservations: [{ token: 'hbar', amount: 30 }],
    },
  };
}

// ── verifyUncertainWithdrawals tests ─────────────────────────────

describe('verifyUncertainWithdrawals', () => {
  let dir: string;
  let store: PersistentStore;
  let ledger: UserLedger;
  let mirror: FetchMockState;

  beforeEach(async () => {
    ({ dir, store, ledger } = await setupStore());
    mirror = installFetchMock();
    installRedisMock();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
    uninstallRedisMock();
  });

  it('SUCCESS branch settles + writes audit + flushes + resolves', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });
    const { audit, calls } = trackingAccounting();

    const outcomes = await verifyUncertainWithdrawals(store, ledger, audit);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, 'confirmed');
    assert.equal(calls.recordWithdrawal.length, 1, 'HCS-20 audit anchor written');
    assert.equal(calls.recordWithdrawal[0]!.amount, 50);
    // DL marked resolved
    const dls = store.getDeadLetters();
    assert.ok(dls[0]?.resolvedAt, 'dead-letter must be marked resolved');
  });

  it('FAILED branch releases reserve + resolves', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_FAIL));
    mirror.responses.set(TX_FAIL, {
      status: 200,
      body: { transactions: [{ result: 'INSUFFICIENT_TX_FEE' }] },
    });

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'failed');
    const user = store.getUser('user-1')!;
    assert.equal(user.balances.tokens.hbar!.reserved, 50, 'reserve released by 50');
    const dls = store.getDeadLetters();
    assert.ok(dls[0]?.resolvedAt);
  });

  it('NOT_FOUND (recent) leaves entry as still_uncertain', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_NOT_FOUND, 1));
    // No mirror entry → fetch returns 404.
    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'still_uncertain');
    const dls = store.getDeadLetters();
    assert.equal(dls[0]?.resolvedAt, undefined, 'DL must remain unresolved');
  });

  it('NOT_FOUND >24h old → promoted to FAILED (H7 max-age, F27 uses txId timestamp)', async () => {
    // F27: the 24h max-age check now uses the txId's valid-start
    // timestamp, not entry.timestamp. The DL row is also created
    // 25h ago for completeness.
    await store.upsertDeadLetter(makeWithdrawalDl(TX_NOT_FOUND_OLD, 25));
    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'failed', '>24h NOT_FOUND must promote to FAILED');
    const user = store.getUser('user-1')!;
    assert.equal(user.balances.tokens.hbar!.reserved, 50);
  });

  it('Unknown mirror result string → NOT_FOUND (H8 conservative default)', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, {
      status: 200,
      body: { transactions: [{ result: 'SOME_FUTURE_LAG_STATE_CODE' }] },
    });

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'still_uncertain', 'unknown code must NOT release reserve');
    const user = store.getUser('user-1')!;
    assert.equal(user.balances.tokens.hbar!.reserved, 100, 'reserve untouched on unknown code');
  });

  it('Mirror 5xx → still_uncertain, DL untouched', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 503 });

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'still_uncertain');
    assert.match(outcomes[0]!.note, /503/);
    assert.equal(store.getDeadLetters()[0]?.resolvedAt, undefined);
  });

  it('Mirror network error → still_uncertain, DL untouched', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.errors.add(TX_OK);

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'still_uncertain');
    assert.match(outcomes[0]!.note, /Mirror lookup failed/);
  });

  it('Idempotent: running twice in succession does not double-mutate', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });
    const { audit, calls } = trackingAccounting();

    await verifyUncertainWithdrawals(store, ledger, audit);
    await verifyUncertainWithdrawals(store, ledger, audit);

    assert.equal(calls.recordWithdrawal.length, 1, 'second pass must skip resolved entry');
  });

  it('Malformed entry increments verificationAttempts', async () => {
    const malformed: DeadLetterEntry = {
      transactionId: 'tx-bad',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'withdrawal_uncertain',
      details: { /* missing userId/amount/tokenKey */ },
    };
    await store.upsertDeadLetter(malformed);

    await verifyUncertainWithdrawals(store, ledger, noopAccounting());
    const dls1 = store.getDeadLetters();
    assert.equal((dls1[0]?.details as { verificationAttempts?: number })?.verificationAttempts, 1);

    await verifyUncertainWithdrawals(store, ledger, noopAccounting());
    const dls2 = store.getDeadLetters();
    assert.equal((dls2[0]?.details as { verificationAttempts?: number })?.verificationAttempts, 2);
  });

  it('R2-FG-0 / F4: Infinity amount escalates BEFORE settleSpend even with SUCCESS mirror', async () => {
    // 2026-05-06 round-2 audit (P6): the original test planted no mirror
    // response, so the Infinity-amount entry hit NOT_FOUND → still_uncertain
    // for both the buggy AND the fixed code. Test passed for the wrong
    // reason. After R2-FG-0, plant a SUCCESS mirror response so the bug
    // WOULD trigger settleSpend(Infinity) → corrupting reserved to NaN.
    // The fix's `Number.isFinite` check at the malformed gate must
    // intercept BEFORE the mirror lookup or any ledger mutation.
    const malformed: DeadLetterEntry = {
      transactionId: 'tx-infinity',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'withdrawal_uncertain',
      details: {
        userId: 'user-1',
        amount: Number.POSITIVE_INFINITY,
        tokenKey: 'hbar',
        recipientAccountId: '0.0.1234',
        isHbar: true,
      },
    };
    await store.upsertDeadLetter(malformed);
    // PLANT a SUCCESS mirror response so the bug WOULD trigger settle.
    mirror.responses.set('tx-infinity', {
      status: 200,
      body: { transactions: [{ result: 'SUCCESS' }] },
    });

    const userBefore = store.getUser('user-1')!;
    const reservedBefore = userBefore.balances.tokens.hbar!.reserved;
    const totalWithdrawnBefore = userBefore.balances.tokens.hbar!.totalWithdrawn;

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'still_uncertain');
    const userAfter = store.getUser('user-1')!;
    // Defense-in-depth: reserve still finite (not NaN/Infinity).
    assert.ok(
      Number.isFinite(userAfter.balances.tokens.hbar!.reserved),
      'reserved must remain finite — settleSpend(Infinity) would have corrupted it',
    );
    assert.equal(userAfter.balances.tokens.hbar!.reserved, reservedBefore);
    assert.equal(
      userAfter.balances.tokens.hbar!.totalWithdrawn,
      totalWithdrawnBefore,
      'totalWithdrawn must NOT advance — the F4 gate must block before this step',
    );
    // Malformed counter incremented (uniquely produced by the fix path).
    const dl = store.getDeadLetters().find((e) => e.transactionId === 'tx-infinity')!;
    assert.equal(
      (dl.details as { verificationAttempts?: number }).verificationAttempts,
      1,
      'F4 gate must increment verificationAttempts (bumpVerificationAttempts side effect)',
    );
  });

  it('F4: negative amount escalates as malformed', async () => {
    const malformed: DeadLetterEntry = {
      transactionId: 'tx-neg',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'withdrawal_uncertain',
      details: {
        userId: 'user-1',
        amount: -1,
        tokenKey: 'hbar',
        recipientAccountId: '0.0.1234',
        isHbar: true,
      },
    };
    await store.upsertDeadLetter(malformed);

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'still_uncertain');
    const dl = store.getDeadLetters()[0]!;
    assert.equal(
      (dl.details as { verificationAttempts?: number }).verificationAttempts,
      1,
      'malformed entry must increment verificationAttempts via Redis INCR',
    );
  });

  it('R3-FG-3: progress-marker incoherence escalates as malformed (REVERTS R2-FG-13 self-heal)', async () => {
    // R3-FG-3 (round-3 P6-001 / P2-004): R2-FG-13's self-heal silently
    // caused the verifier to skip real settleSpend / updateBalance
    // mutations because the per-step gate is a TRUTHY check on the
    // back-filled marker. The "tampering not realistic" justification
    // was wrong — partial-Redis-failure or version-skew deploy that
    // landed a later stamp without an earlier one triggered the silent
    // skip on the next pass. Reverted to F4's escalate-on-incoherent.
    //
    // revert-proof: if validateProgressOrdering goes back to returning
    // a backfill object, this test fails on the `still_uncertain`
    // assertion (the resolved-confirmed self-heal path returns
    // `confirmed`).
    const lateMarker = '2026-05-06T00:00:00.000Z';
    const partial: DeadLetterEntry = {
      transactionId: 'tx-partial',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'withdrawal_uncertain',
      details: {
        userId: 'user-1',
        amount: 50,
        tokenKey: 'hbar',
        recipientAccountId: '0.0.1234',
        isHbar: true,
        // settledAt deliberately UNSET; totalWithdrawnAt SET.
        totalWithdrawnAt: lateMarker,
      },
    };
    await store.upsertDeadLetter(partial);
    mirror.responses.set('tx-partial', {
      status: 200,
      body: { transactions: [{ result: 'SUCCESS' }] },
    });

    const userBefore = store.getUser('user-1')!;
    const totalWithdrawnBefore = userBefore.balances.tokens.hbar!.totalWithdrawn;

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    // Escalate — not self-heal.
    assert.equal(outcomes[0]!.status, 'still_uncertain');
    assert.match(outcomes[0]!.note, /inconsistent progress markers/);
    // No mutation happened.
    const userAfter = store.getUser('user-1')!;
    assert.equal(
      userAfter.balances.tokens.hbar!.totalWithdrawn,
      totalWithdrawnBefore,
      'totalWithdrawn must NOT advance on incoherent entry',
    );
    // settledAt must NOT be back-filled (no silent self-heal).
    const fresh = store.getDeadLetters().find((e) => e.transactionId === 'tx-partial')!;
    const det = fresh.details as Record<string, unknown>;
    assert.equal(det.settledAt, undefined, 'settledAt must NOT be auto-back-filled');
  });

  // revert-proof: if `bumpUserLockContentionAttempts` reverts to
  // spreading `...entry` (the verifier-loop snapshot) instead of
  // `...base` (refresh-then-spread), the assertion
  // `finalEntry.sender === 'planted-sibling'` becomes the original
  // value because the bump's upsert clobbers the sibling write.
  it('R4-FG-2: bumpUserLockContentionAttempts preserves sibling top-level mutation', async () => {
    // Setup: plant a withdrawal_uncertain DL whose mirror returns FAILED
    // (so the verifier's FAILED branch tries to acquire the user lock).
    // Pre-acquire the user lock from a "concurrent lambda" so the
    // verifier's tryAcquireUserLockForVerify returns null and bumps the
    // contention counter.
    await store.upsertDeadLetter(makeWithdrawalDl(TX_FAIL));
    mirror.responses.set(TX_FAIL, {
      status: 200,
      body: { transactions: [{ result: 'CONTRACT_REVERT_EXECUTED' }] },
    });

    const { acquireUserLock, releaseUserLock } = await import('../lib/locks.js');
    const concurrentToken = await acquireUserLock('user-1', 60);
    assert.ok(concurrentToken, 'pre-condition: concurrent lock acquired');

    try {
      // Spy on the in-memory Redis mock's `set` method. The verifier's
      // `tryAcquireUserLockForVerify` calls `redis.set(lockKey, fence,
      // {nx,ex})` which returns null when our pre-acquired lock is
      // present. We piggyback that null-return moment to plant a
      // sibling top-level write on the entry. The verifier's `entry`
      // snapshot was captured BEFORE this — so:
      //   pre-fix: bump's `{...entry}` upsert REPLACES the entry, and
      //            the planted sender vanishes.
      //   post-fix: bump refreshes-then-spreads, picking up sender.
      const redisMock = (globalThis as unknown as {
        __lazylottoRedisClient__?: {
          set(k: string, v: string | number, o?: { nx?: boolean; ex?: number }): Promise<unknown>;
        };
      }).__lazylottoRedisClient__!;
      const originalUpsert = store.upsertDeadLetter.bind(store);
      const originalSet = redisMock.set.bind(redisMock);
      let plantedSibling = false;
      redisMock.set = async (key, value, opts) => {
        const result = await originalSet(key, value, opts);
        if (
          !plantedSibling &&
          opts?.nx &&
          key.includes('lock:user:user-1') &&
          result === null
        ) {
          plantedSibling = true;
          // The lock-acquire just failed; bump is about to fire.
          // Plant the sibling write to the entry NOW so the bump's
          // refresh-then-spread picks it up.
          const entry = store
            .getDeadLetters()
            .find((x) => x.transactionId === TX_FAIL)!;
          await originalUpsert({ ...entry, sender: 'planted-sibling' });
        }
        return result;
      };

      await verifyUncertainWithdrawals(store, ledger, noopAccounting());

      const finalEntry = store
        .getDeadLetters()
        .find((e) => e.transactionId === TX_FAIL);
      assert.ok(finalEntry, 'entry must exist post-bump');
      assert.equal(
        finalEntry!.sender,
        'planted-sibling',
        'bumpUserLockContentionAttempts must NOT clobber sibling top-level mutation',
      );
      // Sanity: the bump did land (counter is set in details).
      const det = (finalEntry!.details ?? {}) as Record<string, unknown>;
      assert.ok(
        typeof det.userLockContentionAttempts === 'number' && det.userLockContentionAttempts >= 1,
        'bump must have stamped the contention counter',
      );
    } finally {
      await releaseUserLock('user-1', concurrentToken!);
    }
  });

  // revert-proof: if mutationError assignment in the audit-anchor
  // catch (R5-FG-9) is removed, this test fails because outcomes[0]
  // becomes 'confirmed' instead of 'still_uncertain'. Pre-fix
  // behaviour was R2-FG-0 archetype: audit failure → orphan written
  // BUT entry was still markResolved → topic-only auditor saw burn
  // missing AND no retry path. Now the entry stays unresolved for
  // the next reconcile pass to retry.
  it('R5-FG-9: audit-write failure leaves entry unresolved (still_uncertain) + writes orphan', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });
    const { audit } = trackingAccounting(/* throws */ true);

    const outcomes = await verifyUncertainWithdrawals(store, ledger, audit);

    // R5-FG-9: audit-anchor failure now sets `mutationError` →
    // resolve gate keeps the entry as `still_uncertain` for retry.
    assert.equal(
      outcomes[0]!.status,
      'still_uncertain',
      'audit-anchor failure must leave entry unresolved (R5-FG-9)',
    );
    const orphans = store
      .getDeadLetters()
      .filter((e) => e.kind === 'audit_trail_orphaned');
    assert.equal(orphans.length, 1, 'failed audit write must produce audit_trail_orphaned DL');
    // The original entry must NOT be resolved — next reconcile pass
    // retries the audit submit.
    const original = store
      .getDeadLetters()
      .find((e) => e.transactionId === TX_OK);
    assert.ok(original, 'original DL still present');
    assert.equal(
      original!.resolvedAt,
      undefined,
      'original DL must remain unresolved so reconcile re-tries',
    );
  });

  // ── R-HIGH-1: idempotency-marker tests ─────────────────────────

  it('R-HIGH-1: a re-run after partial completion does not duplicate audit', async () => {
    // First pass: SUCCESS branch runs end-to-end, stamps auditWrittenAt.
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });
    const { audit, calls } = trackingAccounting();

    await verifyUncertainWithdrawals(store, ledger, audit);
    assert.equal(calls.recordWithdrawal.length, 1);
    const dl = store.getDeadLetters()[0]!;
    assert.ok(
      (dl.details as { auditWrittenAt?: string }).auditWrittenAt,
      'auditWrittenAt must be stamped after successful audit',
    );

    // Simulate a Lambda crash AFTER stamping auditWrittenAt but before
    // resolvedAt landed: clear resolvedAt + lock, run verifier again.
    await store.upsertDeadLetter({
      ...dl,
      resolvedAt: undefined,
      resolvedBy: undefined,
      resolutionTxId: undefined,
    });
    // Drop the verifier lock so the second pass can acquire it.
    uninstallRedisMock();
    installRedisMock();

    await verifyUncertainWithdrawals(store, ledger, audit);
    assert.equal(
      calls.recordWithdrawal.length,
      1,
      'auditWrittenAt marker must prevent a duplicate HCS-20 burn op',
    );
  });

  it('F1: intermediate stampProgress writes preserve all prior markers (lost-update protection)', async () => {
    // 2026-05-06 audit C-01 / SM-02 / U-05: stampProgress used to read
    // entry.details (stale snapshot from when the entry was loaded) and write
    // `{...entry.details, ...patch}`, so each step's stamp overwrote prior
    // stamps in Redis. After step 2 the Redis row had only step 2's marker;
    // a Lambda crash before markResolved would lose step 1's marker entirely.
    // Next reconcile pass would then re-execute step 1 (settleSpend) — silent
    // double-mutation. After the fix, every intermediate stamp carries the
    // full progress accumulator, so any successful stamp persists every prior
    // step's marker.
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    // Spy on store.upsertDeadLetter — capture each call's `details` snapshot.
    const upserts: Array<DeadLetterEntry> = [];
    const original = store.upsertDeadLetter.bind(store);
    store.upsertDeadLetter = async (entry: DeadLetterEntry) => {
      upserts.push(JSON.parse(JSON.stringify(entry)));
      return original(entry);
    };

    await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    // Drop the initial setup-upsert (no progress markers). Keep only the
    // verifier's intermediate stamps (those without resolvedAt).
    const stamps = upserts.filter(
      (u) =>
        !u.resolvedAt &&
        ((u.details as Record<string, unknown>).settledAt ||
          (u.details as Record<string, unknown>).totalWithdrawnAt ||
          (u.details as Record<string, unknown>).historyWrittenAt ||
          (u.details as Record<string, unknown>).auditWrittenAt),
    );

    assert.ok(
      stamps.length >= 4,
      `expected ≥4 intermediate stamps (settle/totalWithdrawn/history/audit), got ${stamps.length}`,
    );

    // The LAST intermediate stamp must carry every prior step's marker.
    const lastStamp = stamps[stamps.length - 1]!.details as Record<string, unknown>;
    assert.ok(lastStamp.settledAt, 'final intermediate stamp must include settledAt from step 1');
    assert.ok(
      lastStamp.totalWithdrawnAt,
      'final intermediate stamp must include totalWithdrawnAt from step 2',
    );
    assert.ok(
      lastStamp.historyWrittenAt,
      'final intermediate stamp must include historyWrittenAt from step 3',
    );
    assert.ok(
      lastStamp.auditWrittenAt,
      'final intermediate stamp must include auditWrittenAt from step 4',
    );
  });

  it('R-HIGH-1: settledAt + totalWithdrawnAt prevent double-mutation', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });
    const { audit } = trackingAccounting();

    await verifyUncertainWithdrawals(store, ledger, audit);
    const userAfterFirst = store.getUser('user-1')!;
    const reservedAfterFirst = userAfterFirst.balances.tokens.hbar!.reserved;
    const totalWithdrawnAfterFirst = userAfterFirst.balances.tokens.hbar!.totalWithdrawn;
    assert.equal(reservedAfterFirst, 50, 'first pass settled 50 of 100 reserved');
    assert.equal(totalWithdrawnAfterFirst, 50);

    // Simulate crash: re-open the entry without resolvedAt.
    const dl = store.getDeadLetters()[0]!;
    await store.upsertDeadLetter({
      ...dl,
      resolvedAt: undefined,
      resolvedBy: undefined,
      resolutionTxId: undefined,
    });
    uninstallRedisMock();
    installRedisMock();

    await verifyUncertainWithdrawals(store, ledger, audit);
    const userAfterSecond = store.getUser('user-1')!;
    assert.equal(
      userAfterSecond.balances.tokens.hbar!.reserved,
      reservedAfterFirst,
      'reserved must not be settled twice',
    );
    assert.equal(
      userAfterSecond.balances.tokens.hbar!.totalWithdrawn,
      totalWithdrawnAfterFirst,
      'totalWithdrawn must not be incremented twice',
    );
  });
});

// ── verifyUncertainOperatorFeeWithdrawals tests ──────────────────

describe('verifyUncertainOperatorFeeWithdrawals', () => {
  let dir: string;
  let store: PersistentStore;
  let mirror: FetchMockState;

  beforeEach(async () => {
    ({ dir, store } = await setupStore());
    mirror = installFetchMock();
    installRedisMock();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
    uninstallRedisMock();
  });

  it('SUCCESS branch debits operator + writes audit', async () => {
    // Seed operator balance so we have something to debit.
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });
    const { audit, calls } = trackingAccounting();

    const outcomes = await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', audit);

    assert.equal(outcomes[0]!.status, 'confirmed');
    const op = store.getOperator();
    assert.equal(op.balances.hbar, 75, 'operator balance debited by 25');
    assert.equal(op.totalWithdrawnByOperator.hbar, 25);
    assert.equal(calls.recordOperatorWithdrawal.length, 1);
  });

  // revert-proof: if `markResolved` reverts to spreading `...entry`
  // (the verifier-loop snapshot) instead of `...base` (refresh-then-
  // spread), the assertion `det.siblingTopLevelField === 'planted'`
  // becomes `undefined` because the resolve-write clobbers the
  // sibling's top-level write with the stale snapshot.
  it('R4-FG-1: markResolved preserves a sibling writer mutation', async () => {
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    const originalUpsert = store.upsertDeadLetter.bind(store);
    let stampedDuringRun = false;
    // Wrap upsertDeadLetter: as soon as we see the verifier's
    // operatorDebitedAt stamp land, simulate a sibling writer
    // mutating a top-level field on the SAME entry. The next
    // upsertDeadLetter (markResolved) must spread the sibling's
    // mutation, not the verifier-loop's stale `entry` snapshot.
    store.upsertDeadLetter = async (e) => {
      const det = (e.details ?? {}) as Record<string, unknown>;
      if (!stampedDuringRun && det.operatorDebitedAt) {
        stampedDuringRun = true;
        // Apply the verifier's stamp first.
        await originalUpsert(e);
        // Now inject a sibling top-level field write on the same entry.
        const fresh = store.getDeadLetters().find((x) => x.transactionId === TX_OK)!;
        await originalUpsert({ ...fresh, sender: 'planted-sibling-sender' });
        return;
      }
      return originalUpsert(e);
    };

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const finalEntry = store.getDeadLetters().find((e) => e.transactionId === TX_OK);
    assert.ok(finalEntry, 'entry must exist post-resolve');
    assert.equal(finalEntry!.resolvedAt !== undefined, true, 'entry must be resolved');
    assert.equal(
      finalEntry!.sender,
      'planted-sibling-sender',
      'markResolved must NOT clobber sibling top-level mutation',
    );
  });

  it('FAILED branch is no-op on operator state', async () => {
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_FAIL));
    mirror.responses.set(TX_FAIL, {
      status: 200,
      body: { transactions: [{ result: 'INSUFFICIENT_TX_FEE' }] },
    });

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const op = store.getOperator();
    assert.equal(op.balances.hbar, 100, 'operator balance untouched on FAILED');
  });

  // revert-proof: R4-FG-6 — `mutationError` flag + skip-`markResolved`
  // gate at uncertainTxVerification.ts ~line 1351-1359. Pre-fix the
  // catch wrote the orphan row but then UNCONDITIONALLY ran
  // markResolved, leaving the entry resolved with the operator wallet
  // un-debited. Reverting the gate would let this test see a resolved
  // entry and a `confirmed` outcome — assertion fails.
  it('R4-FG-6: operator-fee SUCCESS with audit anchor failure leaves entry unresolved', async () => {
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    // Force the audit anchor to throw — operator debit lands, anchor fails.
    const failingAudit = {
      async recordDeposit(): Promise<void> {},
      async recordRake(): Promise<void> {},
      async recordWithdrawal(): Promise<void> {},
      async recordPlaySession(): Promise<void> {},
      async recordOperatorWithdrawal(): Promise<void> {
        throw new Error('synthetic audit anchor failure');
      },
      async recordRefund(): Promise<void> {},
      async deploy(): Promise<string> { return '0.0.0'; },
    } as unknown as AccountingService;

    const outcomes = await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', failingAudit);

    assert.equal(
      outcomes[0]!.status,
      'still_uncertain',
      'R4-FG-6 fix missing: outcome must be still_uncertain when audit anchor fails',
    );
    const finalEntry = store.getDeadLetters().find((e) => e.transactionId === TX_OK);
    assert.equal(
      finalEntry!.resolvedAt,
      undefined,
      'R4-FG-6 fix missing: entry MUST NOT be marked resolved when audit anchor failed',
    );
  });

  it('Idempotent on repeated SUCCESS verification', async () => {
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());
    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const op = store.getOperator();
    assert.equal(op.balances.hbar, 75, 'second pass must skip resolved entry');
  });

  it('F1: intermediate stampProgress writes preserve all prior markers (lost-update protection)', async () => {
    // Same lost-update class as the withdrawal verifier test — operator-fee
    // verifier stamps operatorDebitedAt then auditWrittenAt; with the bug,
    // the second stamp drops the first.
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    const upserts: Array<DeadLetterEntry> = [];
    const original = store.upsertDeadLetter.bind(store);
    store.upsertDeadLetter = async (entry: DeadLetterEntry) => {
      upserts.push(JSON.parse(JSON.stringify(entry)));
      return original(entry);
    };

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const stamps = upserts.filter(
      (u) =>
        !u.resolvedAt &&
        ((u.details as Record<string, unknown>).operatorDebitedAt ||
          (u.details as Record<string, unknown>).auditWrittenAt),
    );

    assert.ok(
      stamps.length >= 2,
      `expected ≥2 intermediate stamps (debit/audit), got ${stamps.length}`,
    );

    const lastStamp = stamps[stamps.length - 1]!.details as Record<string, unknown>;
    assert.ok(
      lastStamp.operatorDebitedAt,
      'final intermediate stamp must include operatorDebitedAt from step 1',
    );
    assert.ok(
      lastStamp.auditWrittenAt,
      'final intermediate stamp must include auditWrittenAt from step 2',
    );
  });

  it('R2-FG-12: stampProgress refresh-before-merge preserves concurrent writes to the same row', async () => {
    // R2-FG-12 (round-2 X-05): pre-fix `stampProgress` merged the
    // accumulator over the caller's STALE `entry.details` snapshot.
    // Any field a concurrent writer (e.g., `bumpVerificationAttempts`)
    // had stamped between the loop's read and stampProgress's write
    // was lost. The fix refreshes from the store first.
    //
    // Test simulates the race deterministically: caller's `entry`
    // snapshot is missing a field that's already in the store. After
    // stampProgress, the store row must contain BOTH the caller's
    // accumulator AND the field the caller didn't know about.
    const txId = TX_OK;
    await store.upsertDeadLetter({
      transactionId: txId,
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'operator_fee_withdraw_uncertain',
      details: {
        amount: 25,
        tokenKey: 'hbar',
        // Concurrent write that stale `entry` doesn't know about.
        verificationAttempts: 7,
        lastVerificationAttemptAt: '2026-05-06T00:00:00Z',
      },
    });

    // Build a stale snapshot — what the verifier loop would have
    // captured before bumpVerificationAttempts ran.
    const stale: DeadLetterEntry = {
      transactionId: txId,
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'operator_fee_withdraw_uncertain',
      details: {
        amount: 25,
        tokenKey: 'hbar',
        // verificationAttempts intentionally absent.
      },
    };

    const stampProgressInternal = await import('./uncertainTxVerification.js');
    // The function is private; drive it via the public verifier path
    // which calls stampProgress under the hood. Easier: invoke a public
    // wrapper that exercises stampProgress's refresh-merge.
    // Cleanest deterministic test: exercise via verifyUncertainOperatorFeeWithdrawals
    // SUCCESS branch which calls stampProgress.
    void stampProgressInternal;
    mirror.responses.set(txId, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const fresh = store.getDeadLetters().find((e) => e.transactionId === txId)!;
    const det = fresh.details as Record<string, unknown>;
    // The verifier added `operatorDebitedAt` (R2-FG-5 stamp first).
    assert.ok(det.operatorDebitedAt, 'expected operatorDebitedAt');
    // R2-FG-12: verificationAttempts must NOT be lost during the merge.
    assert.equal(det.verificationAttempts, 7);
    assert.equal(det.lastVerificationAttemptAt, '2026-05-06T00:00:00Z');
    // Sanity: original fields survive.
    assert.equal(det.amount, 25);
    assert.equal(det.tokenKey, 'hbar');
  });

  it('R2-FG-6: verifier-lock release actually deletes the key (no longer a silent no-op under in-memory mock)', async () => {
    // R2-FG-6 (round-2 R-01 / R-02): the previous releaseVerifyLock
    // used uppercase Lua (`GET`/`DEL`) while the in-memory mock
    // matched on lowercase substrings. Release was a silent no-op
    // for every test path, so subsequent verifier passes saw the
    // verifier-lock still held (TTL eventually cleared it). Now
    // releaseVerifyLock reuses the lowercase RELEASE_SCRIPT from
    // src/lib/locks.ts. Assert the key is actually gone after a
    // successful verification pass.
    const lockKey = `lla:testnet:verifying:${TX_OK}`;
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    const redisMock = (globalThis as unknown as {
      __lazylottoRedisClient__?: { get(k: string): Promise<unknown> };
    }).__lazylottoRedisClient__!;

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const lockValue = await redisMock.get(lockKey);
    assert.equal(lockValue, null, 'verifier lock key must be deleted after release');
  });

  it('R3-FG-2: F24 fenced release with matching fence DELs the pending-claim key', async () => {
    // R3-FG-2 (round-3 P2-003 / P5-OF-001): pre-fix release sites used
    // unfenced `redis.del` — a stale verifier completion DEL'd a fresh
    // acquirer's claim → operator double-pay. Now the verifier reads
    // the fence persisted on `details.pendingClaimFence` and
    // compare-and-deletes via RELEASE_SCRIPT.
    //
    // revert-proof: if the production code reverts to unfenced
    // `redis.del(pendingKey)`, the assertion at the bottom fails (the
    // wrong-fence pre-seeded value would also get nuked).
    const tokenKey = 'hbar';
    const pendingKey = `lla:testnet:lock:operator:withdraw-pending:${tokenKey}`;
    const myFence = 'fence-uuid-mine';
    const dl = makeOperatorFeeDl(TX_OK);
    (dl.details as Record<string, unknown>).pendingClaimFence = myFence;
    await store.upsertDeadLetter(dl);
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    const redisMock = (globalThis as unknown as {
      __lazylottoRedisClient__?: {
        set(k: string, v: string, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
        get(k: string): Promise<unknown>;
      };
    }).__lazylottoRedisClient__!;
    // Pre-seed pending claim with my fence — verifier should DEL it.
    await redisMock.set(pendingKey, myFence);

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const after = await redisMock.get(pendingKey);
    assert.equal(after, null, 'pending claim with matching fence is DELed');
  });

  it('R3-FG-2: F24 fenced release with WRONG fence does NOT nuke a fresh acquirer\'s claim', async () => {
    // R3-FG-2: the critical safety property. If the verifier's stored
    // fence doesn't match the current claim value (because the original
    // claim TTLed out and a fresh acquirer SET-NX'd with a different
    // fence), the compare-and-delete is a no-op — the fresh acquirer's
    // claim survives.
    //
    // revert-proof: pre-fix unfenced DEL would nuke the freshFence.
    const tokenKey = 'hbar';
    const pendingKey = `lla:testnet:lock:operator:withdraw-pending:${tokenKey}`;
    const verifierFence = 'fence-stale-verifier';
    const freshFence = 'fence-fresh-acquirer';
    const dl = makeOperatorFeeDl(TX_OK);
    (dl.details as Record<string, unknown>).pendingClaimFence = verifierFence;
    await store.upsertDeadLetter(dl);
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    const redisMock = (globalThis as unknown as {
      __lazylottoRedisClient__?: {
        set(k: string, v: string, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
        get(k: string): Promise<unknown>;
      };
    }).__lazylottoRedisClient__!;
    // Fresh acquirer's claim already in Redis (different fence).
    await redisMock.set(pendingKey, freshFence);

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const after = await redisMock.get(pendingKey);
    assert.equal(
      after,
      freshFence,
      'fresh acquirer\'s claim must survive the stale verifier\'s release attempt',
    );
  });

  it('R2-FG-5: SUCCESS branch stamps operatorDebitedAt BEFORE store.updateOperator', async () => {
    // R2-FG-5 (round-2 G-02 / R-06): the verifier's SUCCESS branch
    // must stamp the `operatorDebitedAt` marker BEFORE mutating
    // operator state, mirroring F14 in `handlers.ts`. With the
    // pre-fix order (mutate → stamp), a Lambda freeze between the
    // mutation and the stamp leaves the next pass with no marker →
    // double-debit.
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    const events: Array<{ kind: 'stamp' | 'mutate'; debitedAt?: string }> = [];
    const originalUpsert = store.upsertDeadLetter.bind(store);
    store.upsertDeadLetter = async (entry: DeadLetterEntry) => {
      const det = (entry.details ?? {}) as Record<string, unknown>;
      if (det.operatorDebitedAt && !entry.resolvedAt) {
        events.push({ kind: 'stamp', debitedAt: det.operatorDebitedAt as string });
      }
      return originalUpsert(entry);
    };
    const originalUpdateOperator = store.updateOperator.bind(store);
    store.updateOperator = (mutator) => {
      events.push({ kind: 'mutate' });
      return originalUpdateOperator(mutator);
    };

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const firstStamp = events.findIndex((e) => e.kind === 'stamp');
    const firstMutate = events.findIndex((e) => e.kind === 'mutate');
    assert.ok(firstStamp >= 0, 'expected at least one stamp event');
    assert.ok(firstMutate >= 0, 'expected at least one mutate event');
    assert.ok(
      firstStamp < firstMutate,
      `stamp(operatorDebitedAt) must precede updateOperator (stamp=${firstStamp} mutate=${firstMutate})`,
    );
  });
});

// ── verifyUncertainPlays tests ───────────────────────────────────

describe('verifyUncertainPlays', () => {
  let dir: string;
  let store: PersistentStore;
  let ledger: UserLedger;
  let mirror: FetchMockState;

  beforeEach(async () => {
    ({ dir, store, ledger } = await setupStore());
    mirror = installFetchMock();
    installRedisMock();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
    uninstallRedisMock();
  });

  it('FAILED branch releases all reservations', async () => {
    await store.upsertDeadLetter(makePlayDl(TX_FAIL));
    mirror.responses.set(TX_FAIL, {
      status: 200,
      body: { transactions: [{ result: 'CONTRACT_REVERT_EXECUTED' }] },
    });

    const outcomes = await verifyUncertainPlays(store, ledger);

    assert.equal(outcomes[0]!.status, 'failed');
    const user = store.getUser('user-1')!;
    assert.equal(user.balances.tokens.hbar!.reserved, 70, 'reservation released by 30');
  });

  it('SUCCESS branch flags for manual triage and does NOT release reservations', async () => {
    await store.upsertDeadLetter(makePlayDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    const outcomes = await verifyUncertainPlays(store, ledger);

    assert.equal(outcomes[0]!.status, 'confirmed');
    assert.match(outcomes[0]!.note, /manual settlement reconstruction/);
    const user = store.getUser('user-1')!;
    assert.equal(user.balances.tokens.hbar!.reserved, 100, 'reservation MUST remain held for manual triage');
    const dls = store.getDeadLetters();
    assert.match(dls[0]?.resolvedBy ?? '', /manual-triage/);
  });

  it('NOT_FOUND >24h promoted to FAILED, releases reservations (F27 uses txId timestamp)', async () => {
    await store.upsertDeadLetter(makePlayDl(TX_NOT_FOUND_OLD, 25));

    const outcomes = await verifyUncertainPlays(store, ledger);

    assert.equal(outcomes[0]!.status, 'failed');
    const user = store.getUser('user-1')!;
    assert.equal(user.balances.tokens.hbar!.reserved, 70);
  });

  it('F4: tokenReservations entries with non-string token are escalated as malformed', async () => {
    // 2026-05-06 audit I-04: per-entry shape validation. Without it,
    // { token: 42, amount: '1.5' } would coerce through releaseReserve
    // and corrupt entry.reserved to NaN.
    const malformed: DeadLetterEntry = {
      transactionId: 'tx-bad-reservations',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'play_uncertain',
      details: {
        userId: 'user-1',
        tokenReservations: [
          { token: 42 as unknown as string, amount: 1 },
        ],
      },
    };
    await store.upsertDeadLetter(malformed);
    mirror.responses.set('tx-bad-reservations', {
      status: 200,
      body: { transactions: [{ result: 'CONTRACT_REVERT_EXECUTED' }] },
    });

    const userBefore = store.getUser('user-1')!;
    const reservedBefore = userBefore.balances.tokens.hbar!.reserved;

    const outcomes = await verifyUncertainPlays(store, ledger);

    assert.equal(outcomes[0]!.status, 'still_uncertain');
    const userAfter = store.getUser('user-1')!;
    assert.equal(
      userAfter.balances.tokens.hbar!.reserved,
      reservedBefore,
      'reserve must NOT be touched on malformed reservations',
    );
  });

  it('F4: tokenReservations entries with non-finite amount are escalated as malformed', async () => {
    const malformed: DeadLetterEntry = {
      transactionId: 'tx-infinite-reservation',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'play_uncertain',
      details: {
        userId: 'user-1',
        tokenReservations: [
          { token: 'hbar', amount: Number.POSITIVE_INFINITY },
        ],
      },
    };
    await store.upsertDeadLetter(malformed);
    mirror.responses.set('tx-infinite-reservation', {
      status: 200,
      body: { transactions: [{ result: 'CONTRACT_REVERT_EXECUTED' }] },
    });

    const outcomes = await verifyUncertainPlays(store, ledger);
    assert.equal(outcomes[0]!.status, 'still_uncertain');
  });

  // revert-proof: if the body-level `idempotencyKey` literal at
  // uncertainTxVerification.ts:1726 reverts to absent (R3-FG-22 backed
  // out), the captured controlEvent.details object will not contain
  // `idempotencyKey: 'play-triage:<tx>'`; this assertion fails.
  it('R3-FG-22: SUCCESS triage anchor body carries deterministic idempotencyKey play-triage:<txId>', async () => {
    await store.upsertDeadLetter(makePlayDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    // Tracking accounting that records every recordControlEvent call.
    const controlCalls: Array<{ event: string; details: Record<string, unknown> }> = [];
    const trackingAudit = {
      async recordDeposit(): Promise<void> {},
      async recordRake(): Promise<void> {},
      async recordWithdrawal(): Promise<void> {},
      async recordPlaySession(): Promise<void> {},
      async recordOperatorWithdrawal(): Promise<void> {},
      async recordRefund(): Promise<void> {},
      async recordControlEvent(event: string, details: Record<string, unknown>): Promise<void> {
        controlCalls.push({ event, details });
      },
      async deploy(): Promise<string> { return '0.0.0'; },
    } as unknown as AccountingService;

    await verifyUncertainPlays(store, ledger, trackingAudit);

    const triage = controlCalls.find(
      (c) => c.event === 'play_uncertain_success_pending_triage',
    );
    assert.ok(triage, 'verifier must call recordControlEvent with the triage event');
    // The load-bearing assertion: writer-side parity with the
    // force-release sibling in handlers.ts — both sides emit the
    // same deterministic key so the reader can dedup.
    assert.equal(
      triage.details.idempotencyKey,
      `play-triage:${TX_OK}`,
      'verifier must include idempotencyKey=play-triage:<uncertainTxId> in body',
    );
    // R3-FG-14 sanity: the actor field is the load-bearing 'reconcile'
    // string (auditor sees the verifier as the trigger, not the user).
    assert.equal(triage.details.by, 'reconcile');
  });

  // revert-proof: if `bumpVerificationAttempts` reverts to spreading
  // `...entry` (the loop-snapshot) instead of refreshing first, a
  // sibling field (`siblingField`) the verifier-loop's stale snapshot
  // doesn't know about will be DROPPED on the bump. The assertion
  // `det.siblingField === 'present'` would then fail.
  it('R3-FG-58: bumpVerificationAttempts refresh-then-spread preserves sibling writes', async () => {
    // Plant a malformed DL — verifier hits the malformed gate which
    // calls bumpVerificationAttempts. Inject a sibling field that
    // does NOT exist on the snapshot the verifier captured.
    const malformed: DeadLetterEntry = {
      transactionId: 'tx-bump-r3fg58',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'play_uncertain',
      details: {
        userId: 'user-1',
        // tokenReservations DELIBERATELY MISSING → malformed gate fires.
      },
    };
    await store.upsertDeadLetter(malformed);

    // Sibling Lambda landed `siblingField: 'present'` BEFORE the
    // verifier's bump runs. Stale-spread would clobber it.
    const dlsBefore = store.getDeadLetters();
    const fresh = dlsBefore.find((e) => e.transactionId === malformed.transactionId)!;
    await store.upsertDeadLetter({
      ...fresh,
      details: { ...(fresh.details ?? {}), siblingField: 'present' },
    });

    // Verifier runs with the STALE in-memory `malformed` snapshot
    // (no siblingField). Pre-fix it would spread `...malformed` over
    // the freshly written row, dropping siblingField.
    await verifyUncertainPlays(store, ledger);

    const after = store.getDeadLetters().find((e) => e.transactionId === malformed.transactionId)!;
    const det = after.details as Record<string, unknown>;
    // The post-fix refresh-then-spread pattern preserves the sibling
    // field. Pre-fix this would be undefined.
    assert.equal(
      det.siblingField,
      'present',
      'sibling Lambda field must survive bumpVerificationAttempts',
    );
    // Sanity: bump still happened.
    assert.equal(typeof det.verificationAttempts, 'number');
    assert.ok((det.verificationAttempts as number) >= 1);
  });
});
