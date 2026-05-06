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
} from './uncertainTxVerification.js';

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
  };
  (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = mock;
  return { calls };
}

function uninstallRedisMock(): void {
  (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = undefined;
}

// ── Setup helpers ────────────────────────────────────────────────

const TX_OK = '0.0.1234@1700000000.000000001';
const TX_FAIL = '0.0.1234@1700000000.000000002';
const TX_NOT_FOUND = '0.0.1234@1700000000.000000003';

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

  it('NOT_FOUND >24h old → promoted to FAILED (H7 max-age)', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_NOT_FOUND, 25));
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

  it('Audit-write failure produces audit_trail_orphaned DL (M16)', async () => {
    await store.upsertDeadLetter(makeWithdrawalDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });
    const { audit } = trackingAccounting(/* throws */ true);

    const outcomes = await verifyUncertainWithdrawals(store, ledger, audit);

    assert.equal(outcomes[0]!.status, 'confirmed');
    const orphans = store
      .getDeadLetters()
      .filter((e) => e.kind === 'audit_trail_orphaned');
    assert.equal(orphans.length, 1, 'failed audit write must produce audit_trail_orphaned DL');
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

  it('Idempotent on repeated SUCCESS verification', async () => {
    store.updateOperator((op) => ({ ...op, balances: { ...op.balances, hbar: 100 } }));
    await store.upsertDeadLetter(makeOperatorFeeDl(TX_OK));
    mirror.responses.set(TX_OK, { status: 200, body: { transactions: [{ result: 'SUCCESS' }] } });

    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());
    await verifyUncertainOperatorFeeWithdrawals(store, '0.0.9999', noopAccounting());

    const op = store.getOperator();
    assert.equal(op.balances.hbar, 75, 'second pass must skip resolved entry');
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

  it('NOT_FOUND >24h promoted to FAILED, releases reservations', async () => {
    await store.upsertDeadLetter(makePlayDl(TX_NOT_FOUND, 25));

    const outcomes = await verifyUncertainPlays(store, ledger);

    assert.equal(outcomes[0]!.status, 'failed');
    const user = store.getUser('user-1')!;
    assert.equal(user.balances.tokens.hbar!.reserved, 70);
  });
});
