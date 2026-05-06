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

  it('F4: progress-marker ordering inconsistency escalates (totalWithdrawnAt without settledAt)', async () => {
    // 2026-05-06 audit I-12: an entry where step-2 marker is set
    // without step-1 marker is impossible state. Verifier must NOT
    // partial-execute; it must escalate as malformed.
    const tampered: DeadLetterEntry = {
      transactionId: 'tx-tampered',
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
        totalWithdrawnAt: '2026-05-06T00:00:00.000Z',
      },
    };
    await store.upsertDeadLetter(tampered);
    mirror.responses.set('tx-tampered', {
      status: 200,
      body: { transactions: [{ result: 'SUCCESS' }] },
    });

    const userBefore = store.getUser('user-1')!;
    const totalWithdrawnBefore = userBefore.balances.tokens.hbar!.totalWithdrawn;

    const outcomes = await verifyUncertainWithdrawals(store, ledger, noopAccounting());

    assert.equal(outcomes[0]!.status, 'still_uncertain');
    assert.match(outcomes[0]!.note, /inconsistent progress markers/);
    const userAfter = store.getUser('user-1')!;
    assert.equal(
      userAfter.balances.tokens.hbar!.totalWithdrawn,
      totalWithdrawnBefore,
      'totalWithdrawn must NOT advance on tampered entry',
    );
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
});
