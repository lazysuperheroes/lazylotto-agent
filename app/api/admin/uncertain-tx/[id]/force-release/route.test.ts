/**
 * Unit tests for the per-kind force-release handlers extracted into
 * `handlers.ts`. The full route handler couples Next.js + withStore +
 * getAgentContext + requireTier + checkRateLimit + getRedis +
 * lookupMirrorOutcome — too much surface to mock end-to-end. Instead,
 * the safety-critical per-kind logic lives in `applyForceRelease`,
 * which is testable with a fake context.
 *
 * F12 / F13 / F14 / F15 are exercised here. F2/F3/F5 invariants
 * remain enforced at the route layer (auth, rate limit, body parse,
 * id shape) — those are exercised by the existing rate-limit and
 * auth tests.
 */

import { describe, it, expect } from 'vitest';
import { applyForceRelease, type ForceReleaseContext } from './handlers';
import type { DeadLetterEntry } from '~/custodial/IStore';

// ── Fake context ─────────────────────────────────────────────────

interface FakeStoreState {
  dls: Map<string, DeadLetterEntry>;
  balances: Map<string, { tokens: Record<string, { available: number; reserved: number; totalDeposited: number; totalWithdrawn: number; totalRake: number }> }>;
  operator: {
    balances: Record<string, number>;
    totalWithdrawnByOperator: Record<string, number>;
  };
  withdrawals: Array<{ userId: string; amount: number; tokenId: string | null; recipientAccountId: string; transactionId: string; timestamp: string }>;
  deposits: Map<string, {
    transactionId: string;
    userId: string;
    grossAmount: number;
    rakeAmount: number;
    netAmount: number;
    tokenId: string | null;
    memo: string;
    timestamp: string;
  }>;
}

function makeContext(initialState: Partial<FakeStoreState> = {}) {
  const state: FakeStoreState = {
    dls: initialState.dls ?? new Map(),
    balances: initialState.balances ?? new Map(),
    operator: initialState.operator ?? {
      balances: {},
      totalWithdrawnByOperator: {},
    },
    withdrawals: initialState.withdrawals ?? [],
    deposits: initialState.deposits ?? new Map(),
  };

  const redisStore = new Map<string, unknown>();

  const accountingCalls: Array<{ method: string; args: unknown[] }> = [];

  const ledgerOps: Array<{ method: string; args: unknown[] }> = [];

  const ctx: ForceReleaseContext = {
    store: {
      async refreshDeadLetters() {},
      getDeadLetters() {
        return Array.from(state.dls.values());
      },
      async upsertDeadLetter(entry: DeadLetterEntry) {
        state.dls.set(entry.transactionId, JSON.parse(JSON.stringify(entry)));
      },
      async flush() {},
      async getDepositByTxId(txId: string) {
        return state.deposits.get(txId);
      },
      // We need just enough surface for the handlers to function.
      updateBalance(userId: string, fn: (b: { tokens: Record<string, { available: number; reserved: number; totalDeposited: number; totalWithdrawn: number; totalRake: number }> }) => unknown) {
        const b = state.balances.get(userId) ?? { tokens: {} };
        fn(b);
        state.balances.set(userId, b);
        return b as never;
      },
      updateOperator(fn: (op: typeof state.operator) => typeof state.operator) {
        state.operator = fn(state.operator);
        return state.operator as never;
      },
      recordWithdrawal(record: typeof state.withdrawals[number]) {
        state.withdrawals.push(record);
      },
      // Stubs for unused IStore surface.
      isTransactionProcessed: () => false,
      tryClaimTransaction: async () => true,
      releaseTransactionClaim: async () => {},
      isDepositCredited: async () => false,
      recordDeposit: () => {},
      getDepositsForUser: () => [],
      recordPlaySession: () => {},
      getPlaySessionsForUser: () => [],
      recordGas: () => {},
      getOperator: () => state.operator,
      saveUser: () => {},
      getUser: () => undefined,
      getUserByMemo: () => undefined,
      getUserByEvm: () => undefined,
      getAllUsers: () => [],
      refreshUserIndex: async () => {},
      refreshOperator: async () => {},
      getDeadLetterById: () => undefined,
      load: async () => {},
      close: async () => {},
    } as never,
    ledger: {
      releaseReserve(userId: string, amount: number, token: string) {
        ledgerOps.push({ method: 'releaseReserve', args: [userId, amount, token] });
        const b = state.balances.get(userId);
        const tok = b?.tokens[token];
        if (tok) {
          tok.reserved -= amount;
          tok.available += amount;
        }
      },
      settleSpend(userId: string, amount: number, token: string) {
        ledgerOps.push({ method: 'settleSpend', args: [userId, amount, token] });
        const b = state.balances.get(userId);
        const tok = b?.tokens[token];
        if (tok) {
          tok.reserved -= amount;
        }
      },
    } as never,
    accounting: {
      async recordWithdrawal(...args: unknown[]) {
        accountingCalls.push({ method: 'recordWithdrawal', args });
      },
      async recordOperatorWithdrawal(...args: unknown[]) {
        accountingCalls.push({ method: 'recordOperatorWithdrawal', args });
      },
      async recordRefund(details: unknown) {
        accountingCalls.push({ method: 'recordRefund', args: [details] });
      },
    } as never,
    agentAccountId: '0.0.9999',
    redis: {
      async set(key: string, value: string) {
        redisStore.set(key, value);
        return 'OK';
      },
      async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) if (redisStore.delete(k)) n++;
        return n;
      },
    },
    log: {
      warn() {},
      error() {},
    },
  };

  return { ctx, state, redisStore, accountingCalls, ledgerOps };
}

function makeBalance(token: string, available: number, reserved: number) {
  return {
    tokens: {
      [token]: {
        available,
        reserved,
        totalDeposited: available + reserved,
        totalWithdrawn: 0,
        totalRake: 0,
      },
    },
  };
}

// ── F12: withdrawal_uncertain SUCCESS settles + writes audit ──────

describe('F12: applyForceRelease — withdrawal_uncertain', () => {
  it('SUCCESS settles reserve, debits totalWithdrawn, records history, writes audit anchor', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-w1',
      timestamp: new Date().toISOString(),
      error: 'receipt timeout',
      kind: 'withdrawal_uncertain',
      details: {
        userId: 'u1',
        amount: 50,
        tokenKey: 'hbar',
        isHbar: true,
        recipientAccountId: '0.0.123',
      },
    };
    const { ctx, state, accountingCalls } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
      balances: new Map([['u1', makeBalance('hbar', 0, 100)]]),
    });

    const result = await applyForceRelease(entry, 'SUCCESS', ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toMatch(/SUCCESS/);
    // settleSpend: reserved 100 → 50 (settled 50).
    expect(state.balances.get('u1')!.tokens.hbar!.reserved).toBe(50);
    // totalWithdrawn += 50.
    expect(state.balances.get('u1')!.tokens.hbar!.totalWithdrawn).toBe(50);
    // Audit anchor written.
    expect(
      accountingCalls.some((c) => c.method === 'recordWithdrawal'),
    ).toBe(true);
    // Markers stamped.
    const final = state.dls.get('tx-w1')!;
    const d = final.details as Record<string, unknown>;
    expect(d.settledAt).toBeTypeOf('string');
    expect(d.totalWithdrawnAt).toBeTypeOf('string');
    expect(d.historyWrittenAt).toBeTypeOf('string');
    expect(d.auditWrittenAt).toBeTypeOf('string');
  });

  it('FAILED releases reserve only', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-w2',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'withdrawal_uncertain',
      details: { userId: 'u1', amount: 50, tokenKey: 'hbar' },
    };
    const { ctx, state, accountingCalls } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
      balances: new Map([['u1', makeBalance('hbar', 0, 100)]]),
    });

    const result = await applyForceRelease(entry, 'FAILED', ctx);

    expect(result.ok).toBe(true);
    expect(state.balances.get('u1')!.tokens.hbar!.reserved).toBe(50);
    expect(state.balances.get('u1')!.tokens.hbar!.available).toBe(50);
    // No audit anchor on FAILED.
    expect(accountingCalls.length).toBe(0);
  });

  it('F13: SUCCESS with prior settledAt does NOT re-settle (idempotent under partial verifier run)', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-w3',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'withdrawal_uncertain',
      details: {
        userId: 'u1',
        amount: 50,
        tokenKey: 'hbar',
        isHbar: true,
        recipientAccountId: '0.0.123',
        settledAt: '2026-05-06T00:00:00.000Z', // verifier already settled
      },
    };
    const { ctx, state, ledgerOps } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
      // Balance already-settled state (verifier already moved 50 out of reserved).
      balances: new Map([['u1', makeBalance('hbar', 0, 50)]]),
    });

    await applyForceRelease(entry, 'SUCCESS', ctx);

    // settleSpend NOT called again.
    expect(ledgerOps.find((o) => o.method === 'settleSpend')).toBeUndefined();
    expect(state.balances.get('u1')!.tokens.hbar!.reserved).toBe(50);
  });
});

// ── F12: operator_fee_withdraw_uncertain ──────────────────────────

describe('F12: applyForceRelease — operator_fee_withdraw_uncertain', () => {
  it('SUCCESS debits operator + writes audit', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-of1',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'operator_fee_withdraw_uncertain',
      details: { amount: 25, tokenKey: 'hbar' },
    };
    const { ctx, state, accountingCalls } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
      operator: {
        balances: { hbar: 100 },
        totalWithdrawnByOperator: {},
      },
    });

    const result = await applyForceRelease(entry, 'SUCCESS', ctx);

    expect(result.ok).toBe(true);
    expect(state.operator.balances.hbar).toBe(75);
    expect(state.operator.totalWithdrawnByOperator.hbar).toBe(25);
    expect(
      accountingCalls.some((c) => c.method === 'recordOperatorWithdrawal'),
    ).toBe(true);
    // F14: operatorDebitedAt stamped first (then auditWrittenAt).
    const final = state.dls.get('tx-of1')!;
    const d = final.details as Record<string, unknown>;
    expect(d.operatorDebitedAt).toBeTypeOf('string');
    expect(d.auditWrittenAt).toBeTypeOf('string');
  });

  it('FAILED is true no-op on operator state (tightened per R2-FG-0)', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-of2',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'operator_fee_withdraw_uncertain',
      details: { amount: 25, tokenKey: 'hbar' },
    };
    const { ctx, state, accountingCalls } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
      operator: {
        balances: { hbar: 100 },
        totalWithdrawnByOperator: {},
      },
    });

    await applyForceRelease(entry, 'FAILED', ctx);

    // Tightened: assert NO state mutation AND NO audit calls.
    expect(state.operator.balances.hbar).toBe(100);
    expect(state.operator.totalWithdrawnByOperator.hbar ?? 0).toBe(0);
    expect(accountingCalls.length).toBe(0);
  });
});

// ── F12 + F15: play_uncertain ─────────────────────────────────────

describe('F12 + F15: applyForceRelease — play_uncertain', () => {
  it('SUCCESS keeps ALL reservations held + stamps successTriagedAt + action message references manual reconstruction (tightened per R2-FG-0)', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-p1',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'play_uncertain',
      details: {
        userId: 'u1',
        tokenReservations: [
          { token: 'hbar', amount: 30 },
          { token: 'lazy', amount: 100 },
        ],
      },
    };
    const { ctx, state, ledgerOps } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
    });

    const result = await applyForceRelease(entry, 'SUCCESS', ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Tightened: assert ZERO releaseReserve calls (not just "find returns undefined").
    expect(ledgerOps.filter((o) => o.method === 'releaseReserve').length).toBe(0);
    expect(ledgerOps.filter((o) => o.method === 'settleSpend').length).toBe(0);
    // F15: successTriagedAt stamped.
    const final = state.dls.get('tx-p1')!;
    expect((final.details as Record<string, unknown>).successTriagedAt).toBeTypeOf(
      'string',
    );
    // Action message must reference manual reconstruction — locks the
    // user-facing string against silent refactor.
    expect(result.action).toMatch(/manual settlement reconstruction/);
  });

  it('FAILED releases EVERY reservation (tightened: multi-token, exact count) per R2-FG-0', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-p2',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'play_uncertain',
      details: {
        userId: 'u1',
        // Multi-token: catches early-exit-after-one-token regressions.
        tokenReservations: [
          { token: 'hbar', amount: 30 },
          { token: 'lazy', amount: 100 },
        ],
      },
    };
    const { ctx, ledgerOps } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
      balances: new Map([['u1', makeBalance('hbar', 0, 30)]]),
    });

    await applyForceRelease(entry, 'FAILED', ctx);

    const releaseCalls = ledgerOps.filter((o) => o.method === 'releaseReserve');
    expect(releaseCalls.length).toBe(2); // exact count, both tokens
    expect(releaseCalls.map((c) => c.args[2])).toEqual(
      expect.arrayContaining(['hbar', 'lazy']),
    );
  });

  it('F15: refuses already-triaged play_uncertain', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'tx-p3',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'play_uncertain',
      details: {
        userId: 'u1',
        tokenReservations: [{ token: 'hbar', amount: 30 }],
        successTriagedAt: '2026-05-06T00:00:00.000Z',
      },
    };
    const { ctx, ledgerOps } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
    });

    const result = await applyForceRelease(entry, 'SUCCESS', ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/already been SUCCESS-triaged/);
    expect(ledgerOps.length).toBe(0);
  });
});

// ── F12 + F8 + F9 + F10: refund_uncertain ─────────────────────────

describe('F12 + F8 + F9 + F10: applyForceRelease — refund_uncertain', () => {
  it('SUCCESS debits user via deposit record, writes audit anchor with rake reversal, overwrites claim with refundTxId', async () => {
    const claimKey = 'lla:testnet:refunded:original-tx-r1';
    const entry: DeadLetterEntry = {
      transactionId: 'refund-tx-r1',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'refund_uncertain',
      details: {
        claimKey,
        originalTxId: 'original-tx-r1',
        refundTxId: 'refund-tx-r1',
        humanAmount: 95,
        tokenKey: 'hbar',
        agentAccountId: '0.0.9999',
      },
    };
    const { ctx, state, accountingCalls, redisStore } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
      balances: new Map([['u-bob', makeBalance('hbar', 95, 0)]]),
      deposits: new Map([
        [
          'original-tx-r1',
          {
            transactionId: 'original-tx-r1',
            userId: 'u-bob',
            grossAmount: 100,
            rakeAmount: 5,
            netAmount: 95,
            tokenId: null,
            memo: 'memo-bob',
            timestamp: '2026-05-01T00:00:00Z',
          },
        ],
      ]),
      operator: {
        balances: { hbar: 5 }, // rake credit on the deposit
        totalWithdrawnByOperator: {},
      },
    });
    redisStore.set(claimKey, 'pending');

    const result = await applyForceRelease(entry, 'SUCCESS', ctx);

    expect(result.ok).toBe(true);
    // F8: user-bob (canonical owner) debited 95.
    expect(state.balances.get('u-bob')!.tokens.hbar!.available).toBe(0);
    // F9: operator rake reversed.
    expect(state.operator.balances.hbar).toBe(0);
    // Audit anchor includes rakeReversed.
    const refundCall = accountingCalls.find((c) => c.method === 'recordRefund')!;
    expect(refundCall).toBeDefined();
    expect(
      (refundCall.args[0] as { rakeReversed?: number }).rakeReversed,
    ).toBe(5);
    // Claim overwritten with refundTxId.
    expect(redisStore.get(claimKey)).toBe('refund-tx-r1');
  });

  it('F10: FAILED overwrites claim with failed:<refundTxId> instead of DEL', async () => {
    const claimKey = 'lla:testnet:refunded:original-tx-r2';
    const entry: DeadLetterEntry = {
      transactionId: 'refund-tx-r2',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'refund_uncertain',
      details: {
        claimKey,
        originalTxId: 'original-tx-r2',
        refundTxId: 'refund-tx-r2',
        humanAmount: 10,
        tokenKey: 'hbar',
      },
    };
    const { ctx, redisStore } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
    });
    redisStore.set(claimKey, 'pending');

    const result = await applyForceRelease(entry, 'FAILED', ctx);

    expect(result.ok).toBe(true);
    const stored = redisStore.get(claimKey);
    expect(typeof stored).toBe('string');
    expect((stored as string).startsWith('failed:')).toBe(true);
  });

  it('F2: refuses claimKey outside KEY_PREFIX.refunded', async () => {
    const entry: DeadLetterEntry = {
      transactionId: 'refund-tx-r3',
      timestamp: new Date().toISOString(),
      error: 'x',
      kind: 'refund_uncertain',
      details: {
        claimKey: 'lla:testnet:session:victim',
        originalTxId: 'original-tx-r3',
        refundTxId: 'refund-tx-r3',
        humanAmount: 10,
        tokenKey: 'hbar',
      },
    };
    const { ctx, redisStore } = makeContext({
      dls: new Map([[entry.transactionId, entry]]),
    });
    redisStore.set('lla:testnet:session:victim', 'session-data');

    const result = await applyForceRelease(entry, 'FAILED', ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(redisStore.get('lla:testnet:session:victim')).toBe('session-data');
  });
});

// ── F12: mirror outcome refusals ─────────────────────────────────

describe('F12: applyForceRelease — mirror outcome refusals', () => {
  const baseEntry: DeadLetterEntry = {
    transactionId: 'tx-x',
    timestamp: new Date().toISOString(),
    error: 'x',
    kind: 'withdrawal_uncertain',
    details: { userId: 'u1', amount: 10, tokenKey: 'hbar' },
  };

  it('transient mirror returns 503', async () => {
    const { ctx } = makeContext({});
    const result = await applyForceRelease(baseEntry, 'transient', ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
  });

  it('NOT_FOUND mirror returns 409 (wait for verifier)', async () => {
    const { ctx } = makeContext({});
    const result = await applyForceRelease(baseEntry, 'NOT_FOUND', ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });
});
