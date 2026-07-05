/**
 * Unit tests for AccountingService specific to R4-FG-31 cluster.
 *
 * R3-FG-19 (round-3 P5-AS-001): `nextAgentSeq` must consult a Redis-
 * backed `agentseq-seed-failed:<agent>` flag and throw
 * `AGENT_SEQ_SEED_FAILED (cluster-wide)` when set. Pre-fix the
 * seed-failed flag was an in-process Set, so a Lambda whose seed scan
 * failed refused while a sibling warm Lambda (seeded earlier) kept
 * INCRing — inconsistent UX, no escalation, no cluster-wide visibility.
 *
 * The test installs a fake Redis via `globalThis.__lazylottoRedisClient__`
 * (the same hook the rest of the suite uses to short-circuit getRedis())
 * and confirms that a flagged key produces the documented throw.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@hashgraph/sdk';
import { AccountingService } from './AccountingService.js';
import { validateV2Message } from './hcs20-schema.js';

const AGENT_ACCOUNT = '0.0.9999';

interface RedisMockState {
  store: Map<string, string>;
  setCalls: Array<{ key: string; value: string; options?: unknown }>;
  getCalls: string[];
}

function installRedisMock(seed?: Record<string, string>): RedisMockState {
  const state: RedisMockState = {
    store: new Map(Object.entries(seed ?? {})),
    setCalls: [],
    getCalls: [],
  };
  const mock = {
    async get<T = string>(key: string): Promise<T | null> {
      state.getCalls.push(key);
      const v = state.store.get(key);
      return (v ?? null) as T | null;
    },
    async set(key: string, value: string, options?: unknown) {
      state.setCalls.push({ key, value, options });
      state.store.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (state.store.delete(k)) n++;
      return n;
    },
    async sadd() { return 0; },
    async sismember() { return 0; },
    async incr(k: string) { const n = Number(state.store.get(k) ?? 0) + 1; state.store.set(k, String(n)); return n; },
    async expire() { return 1; },
    async eval() { return 0; },
  };
  (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = mock;
  return state;
}

function uninstallRedisMock(): void {
  (globalThis as unknown as { __lazylottoRedisClient__?: unknown }).__lazylottoRedisClient__ = undefined;
}

/** Build an AccountingService instance whose `nextAgentSeq` is reachable. */
function makeService(): AccountingService {
  // No client connection actually required — `nextAgentSeq` reads
  // `this.agentSeqInitPromises` (which we pre-populate via a tiny
  // hook below) and does not touch the Hedera SDK at all.
  const svc = new AccountingService({
    client: {} as unknown as Client,
    tick: 'TEST',
    // Intentionally no topicId so initializeAgentSeq is the no-topic
    // branch — it seeds at -1 and returns immediately.
    topicId: undefined,
  });
  return svc;
}

describe('R3-FG-46: recordPlayPoolResult oversize-message slim fallback', () => {
  const prevNetwork = process.env.HEDERA_NETWORK;

  beforeEach(() => {
    process.env.HEDERA_NETWORK = 'testnet';
  });

  afterEach(() => {
    uninstallRedisMock();
    if (prevNetwork === undefined) delete process.env.HEDERA_NETWORK;
    else process.env.HEDERA_NETWORK = prevNetwork;
  });

  // revert-proof: if the slim-fallback at AccountingService.ts:780-806
  // (R3-FG-46) is reverted, the oversized message hits
  // `enforceTopicMessageSizeLimit` (1024-byte cap) inside
  // submitV2Message and THROWS. The test's
  // `submittedMessages.length === 1` assertion AND `bytes <= 1024`
  // assertion both fail because no submission lands.
  it('drops strategyMeta + truncates symbols when full message would exceed 1024 bytes', async () => {
    installRedisMock();
    // Capture the message that would've gone on-chain by stubbing the
    // private submitV2Message via prototype reflection. This is a test
    // seam — production code path is unchanged.
    const submittedMessages: Record<string, unknown>[] = [];
    const svc = new AccountingService({
      client: {} as unknown as Client,
      tick: 'TEST',
      // We MUST set topicId so submitV2Message doesn't early-return.
      // The size-check fallback runs BEFORE submitV2Message regardless.
      topicId: '0.0.123456',
    });
    // Replace submitV2Message with a spy. Bypass TS's `private`
    // by indexing through `as any`.
    (svc as unknown as { submitV2Message: (m: Record<string, unknown>) => Promise<void> })
      .submitV2Message = async (m) => {
      submittedMessages.push(m);
    };

    // Build a payload the original message would push past 1024 bytes,
    // but the slim variant (no strategyMeta + 8-char-truncated symbols)
    // still fits. 4 NFT prizes with long multi-byte symbols + large
    // strategyMeta clears the threshold deterministically.
    const longSym = '日本語シンボルテスト_long_payload_that_exceeds_normal_caps';
    const prizes = Array.from({ length: 4 }, (_, i) => ({
      t: 'nft' as const,
      tk: `0.0.${1000000 + i}`,
      sym: longSym,
      ser: [i * 10, i * 10 + 1, i * 10 + 2, i * 10 + 3],
    }));

    await svc.recordPlayPoolResult({
      sessionId: '0.0.9999@1700000000.000000001',
      user: '0.0.1234',
      agent: AGENT_ACCOUNT,
      poolId: 42,
      seq: 0,
      entries: 5,
      spent: '100',
      spentToken: 'hbar',
      wins: 3,
      prizes,
      strategyMeta: {
        ev: 1.234567,
        budgetRemaining: 99.876543,
        // R3-FG-46 documents: strategyMeta is dropped first (info-only).
        notes: 'a'.repeat(400),
      } as never,
    });

    assert.equal(
      submittedMessages.length,
      1,
      'exactly one v2 message should have been submitted (slim fallback survives the cap)',
    );
    const submitted = submittedMessages[0]!;
    const bytes = Buffer.byteLength(JSON.stringify(submitted), 'utf-8');
    // The load-bearing assertion: the slim variant fits the cap.
    // Pre-fix the throw inside enforceTopicMessageSizeLimit aborted
    // the call — submittedMessages.length would be 0.
    assert.ok(
      bytes <= 1024,
      `submitted message must fit 1024-byte HCS cap (got ${bytes} bytes)`,
    );
    // strategyMeta must be absent on the slim variant (the fallback
    // drops it first).
    assert.equal(
      (submitted as { strategyMeta?: unknown }).strategyMeta,
      undefined,
      'slim variant drops strategyMeta',
    );
    // Load-bearing fields preserved.
    assert.equal(submitted.poolId, 42);
    assert.equal(submitted.spent, '100');
    assert.equal(submitted.wins, 3);
    assert.ok(Array.isArray(submitted.prizes));
  });
});

describe('R3-FG-19: nextAgentSeq cluster-wide seed-failed flag', () => {
  const prevNetwork = process.env.HEDERA_NETWORK;
  const prevAcctOptional = process.env.HCS20_ACCOUNTING_OPTIONAL;

  beforeEach(() => {
    process.env.HEDERA_NETWORK = 'testnet';
    // F13 (2026-07-05): these tests use a topic-LESS service to exercise the
    // agentSeq seed-failed path; opt out of the now fail-loud v2 write so
    // recordPlaySessionOpen reaches nextAgentSeq without throwing on the
    // (irrelevant here) missing topic.
    process.env.HCS20_ACCOUNTING_OPTIONAL = 'true';
  });

  afterEach(() => {
    uninstallRedisMock();
    if (prevNetwork === undefined) delete process.env.HEDERA_NETWORK;
    else process.env.HEDERA_NETWORK = prevNetwork;
    if (prevAcctOptional === undefined) delete process.env.HCS20_ACCOUNTING_OPTIONAL;
    else process.env.HCS20_ACCOUNTING_OPTIONAL = prevAcctOptional;
  });

  // revert-proof: if the Redis-flag check at AccountingService.ts:646-675
  // is removed (R3-FG-19 reverted to the in-process-only Set), the
  // sibling Lambda would happily INCR and `nextAgentSeq` would resolve
  // to a number; this test's `assert.rejects(/AGENT_SEQ_SEED_FAILED.*cluster-wide/)`
  // would then fail because no throw happens.
  it('throws AGENT_SEQ_SEED_FAILED (cluster-wide) when Redis flag is set', async () => {
    // Sibling Lambda already wrote the cluster-wide flag.
    installRedisMock({
      [`lla:testnet:agentseq-seed-failed:${AGENT_ACCOUNT}`]: '1',
    });
    const svc = makeService();
    // Drive the public surface that calls nextAgentSeq. Use
    // recordPlaySessionOpen — it's the simplest v2 entrypoint and
    // calls nextAgentSeq before any other I/O.
    await assert.rejects(
      () =>
        svc.recordPlaySessionOpen({
          sessionId: 's-1',
          user: '0.0.1234',
          agent: AGENT_ACCOUNT,
          strategy: 'balanced',
          boostBps: 0,
          expectedPools: 1,
        }),
      (err: Error) => {
        // Pre-fix: only the local-flag throw existed. The cluster-wide
        // wording is the load-bearing literal that proves the Redis
        // path executed.
        assert.match(err.message, /AGENT_SEQ_SEED_FAILED \(cluster-wide\)/);
        return true;
      },
    );
  });

  // revert-proof: confirms the test's NO-flag baseline doesn't accidentally
  // throw — without this, the throwing assertion above could be a false
  // positive caused by an unrelated init failure rather than the Redis
  // check itself.
  it('does NOT throw when Redis flag is absent and no local flag', async () => {
    installRedisMock(/* no seed */);
    const svc = makeService();
    // No topic + clean state → resolves cleanly. submitV2Message no-ops
    // here because HCS20_ACCOUNTING_OPTIONAL=true (set in beforeEach) —
    // F13 made a missing topic FAIL-LOUD by default, so opt-out is explicit.
    await svc.recordPlaySessionOpen({
      sessionId: 's-2',
      user: '0.0.1234',
      agent: AGENT_ACCOUNT,
      strategy: 'balanced',
      boostBps: 0,
      expectedPools: 1,
    });
    // If we get here, no throw. Sanity-check we did consult Redis.
    // (Soft assertion — not the load-bearing one.)
  });
});

describe('F8 / F13: HCS-20 audit-trail integrity (2026-07-05 custodial audit)', () => {
  const prevNetwork = process.env.HEDERA_NETWORK;
  const prevAcctOptional = process.env.HCS20_ACCOUNTING_OPTIONAL;

  beforeEach(() => {
    process.env.HEDERA_NETWORK = 'testnet';
  });

  afterEach(() => {
    uninstallRedisMock();
    if (prevNetwork === undefined) delete process.env.HEDERA_NETWORK;
    else process.env.HEDERA_NETWORK = prevNetwork;
    if (prevAcctOptional === undefined) delete process.env.HCS20_ACCOUNTING_OPTIONAL;
    else process.env.HCS20_ACCOUNTING_OPTIONAL = prevAcctOptional;
  });

  // revert-proof: re-adding the `isFromUs` gate to the agentSeq scan makes
  // the author-LESS pool_result (seq 7) invisible, so the scan recovers only
  // the open's seq (5); this asserts the seeded value is the true max 7, not 5
  // (seeding 5 → next INCR reuses 6, an already-on-chain seq).
  it('F8: seeds agentSeq from author-less pool/close messages, not just the open', async () => {
    installRedisMock();
    delete process.env.HCS20_ACCOUNTING_OPTIONAL;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            // desc order; the MAX seq (7) sits on an author-less pool_result
            {
              message: Buffer.from(
                JSON.stringify({ op: 'play_pool_result', agentSeq: 7 }),
              ).toString('base64'),
            },
            {
              message: Buffer.from(
                JSON.stringify({ op: 'play_session_open', agent: AGENT_ACCOUNT, agentSeq: 5 }),
              ).toString('base64'),
            },
          ],
          links: {},
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const svc = new AccountingService({
        client: {} as unknown as Client,
        tick: 'TEST',
        topicId: '0.0.999',
      });
      await svc.initializeAgentSeq(AGENT_ACCOUNT);
      const seeded = (
        svc as unknown as { fallbackAgentSeqs: Map<string, number> }
      ).fallbackAgentSeqs.get(AGENT_ACCOUNT);
      assert.equal(
        seeded,
        7,
        'must recover the true max seq (7) from the author-less pool_result, not the open (5)',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // revert-proof: reverting F13 (silent no-op on a missing topic) makes
  // recordPlaySessionOpen RESOLVE instead of reject — the assertion that it
  // throws "HCS20_TOPIC_ID is not configured" then fails, and audit writes
  // silently vanish while Redis balances mutate.
  it('F13: throws (not silent no-op) on a missing topic without the opt-out', async () => {
    installRedisMock();
    delete process.env.HCS20_ACCOUNTING_OPTIONAL;
    const svc = makeService(); // topic-less
    await assert.rejects(
      () =>
        svc.recordPlaySessionOpen({
          sessionId: 's-f13',
          user: '0.0.1234',
          agent: AGENT_ACCOUNT,
          strategy: 'balanced',
          boostBps: 0,
          expectedPools: 1,
        }),
      /HCS20_TOPIC_ID is not configured/,
    );
  });
});

describe('recordX402RakeHoliday: x402 commerce audit anchor', () => {
  const prevNetwork = process.env.HEDERA_NETWORK;
  beforeEach(() => {
    process.env.HEDERA_NETWORK = 'testnet';
  });
  afterEach(() => {
    uninstallRedisMock();
    if (prevNetwork === undefined) delete process.env.HEDERA_NETWORK;
    else process.env.HEDERA_NETWORK = prevNetwork;
  });

  // revert-proof: if 'x402_rake_holiday_granted' is removed from the
  // ControlEventKind enum (hcs20-schema.ts), the strict writer schema rejects
  // the message and `validateV2Message` below throws — failing this test. The
  // anchor maps onto the existing `control` op, so this also guards that the
  // settlement tx rides `idempotencyKey` (reader de-dup) and that the event is
  // non-balance-affecting (no grossAmount).
  it('emits a schema-valid control anchor that de-dups on the settlement tx', async () => {
    installRedisMock();
    const submitted: Record<string, unknown>[] = [];
    const svc = new AccountingService({
      client: {} as unknown as Client,
      tick: 'LLCRED',
      topicId: '0.0.123456',
    });
    (
      svc as unknown as {
        submitV2Message: (m: Record<string, unknown>) => Promise<void>;
      }
    ).submitV2Message = async (m) => {
      submitted.push(m);
    };

    await svc.recordX402RakeHoliday({
      userAccountId: '0.0.7777',
      recordedBy: AGENT_ACCOUNT,
      settlementTxId: '0.0.7162784@1781031765.000000001',
      asset: 'HBAR',
      amount: '6279000000',
      priceUsdCents: 500,
      durationDays: 30,
      untilIso: '2026-07-09T00:00:00.000Z',
    });

    assert.equal(submitted.length, 1, 'exactly one control anchor emitted');
    const msg = submitted[0]!;
    assert.equal(msg.op, 'control');
    assert.equal(msg.event, 'x402_rake_holiday_granted');
    assert.equal(msg.userId, '0.0.7777');
    assert.equal(msg.by, AGENT_ACCOUNT);
    assert.equal(msg.token, 'HBAR');
    // Settlement tx is the dedup key (reader collapses replays of the same
    // on-chain payment to a single anchor).
    assert.equal(msg.idempotencyKey, '0.0.7162784@1781031765.000000001');
    assert.match(String(msg.cause), /settlementTx=0\.0\.7162784@1781031765\.000000001/);
    // Non-balance-affecting: no grossAmount (verify-audit's reducers ignore it).
    assert.equal(msg.grossAmount, undefined);
    // Load-bearing: the strict writer schema must accept the new kind.
    assert.doesNotThrow(() =>
      validateV2Message(msg as Parameters<typeof validateV2Message>[0]),
    );
  });
});
