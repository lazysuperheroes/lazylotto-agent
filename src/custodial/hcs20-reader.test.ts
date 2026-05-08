import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditTopic, type RawTopicMessage } from './hcs20-reader.js';
import { computePoolsRoot, type PrizeEntry } from './hcs20-v2.js';

// ── Test fixtures ─────────────────────────────────────────────
//
// Each test builds a small in-memory topic stream as RawTopicMessage[]
// and asserts that the reader's state machine produces the expected
// session status + warnings + totals. Pure data tests, no I/O.

const NOW = new Date('2026-04-08T00:00:00.000Z').getTime();
const T0 = '2026-04-07T23:59:00.000Z'; // 1 minute before NOW
const T_OLD = '2026-04-07T23:50:00.000Z'; // 10 minutes before NOW (orphan timeout)
const USER = '0.0.7349994';
const AGENT = '0.0.8456987';

function open(seq: number, sessionId: string, expectedPools: number, ts = T0): RawTopicMessage {
  return {
    sequence: seq,
    timestamp: ts,
    payload: {
      p: 'hcs-20',
      op: 'play_session_open',
      v: 2,
      sessionId,
      user: USER,
      agent: AGENT,
      agentSeq: seq,
      strategy: 'balanced',
      boostBps: 0,
      expectedPools,
      ts,
    },
  };
}

function pool(
  seq: number,
  sessionId: string,
  poolId: number,
  poolSeq: number,
  spent: number,
  wins: number,
  prizes: PrizeEntry[] = [],
  ts = T0,
): RawTopicMessage {
  return {
    sequence: seq,
    timestamp: ts,
    payload: {
      p: 'hcs-20',
      op: 'play_pool_result',
      sessionId,
      user: USER,
      agentSeq: seq,
      poolId,
      seq: poolSeq,
      entries: 2,
      spent: String(spent),
      spentToken: 'HBAR',
      wins,
      prizes,
      ts,
    },
  };
}

async function close(
  seq: number,
  sessionId: string,
  poolsPlayed: number,
  pools: { poolId: number; spent: number; spentToken: string; wins: number; prizes: PrizeEntry[] }[],
  totalWins: number,
  ts = T0,
  opts: { legacyBinding?: boolean; user?: string; agent?: string } = {},
): Promise<RawTopicMessage> {
  // R4-FG-23: post-fix writers always include the (sessionId, user,
  // agent) binding. Tests for legacy close messages opt in via
  // `legacyBinding: true` to forge a pre-fix root and exercise the
  // reader's back-compat fallback path.
  const u = opts.user ?? USER;
  const a = opts.agent ?? AGENT;
  const poolsRoot = opts.legacyBinding
    ? await computePoolsRoot(pools)
    : await computePoolsRoot(pools, { sessionId, user: u, agent: a });
  return {
    sequence: seq,
    timestamp: ts,
    payload: {
      p: 'hcs-20',
      op: 'play_session_close',
      sessionId,
      user: u,
      agentSeq: seq,
      poolsPlayed,
      poolsRoot,
      totalWins,
      prizeTransfer: { status: 'succeeded', txId: 'tx-1', attempts: 1, gasUsed: 5_450_000 },
      ts,
    },
  };
}

async function aborted(
  seq: number,
  sessionId: string,
  completedPools: number,
  reason = 'v2_write_failure',
  ts = T0,
  opts: {
    /** R4-FG-24: include `poolsRoot` derived from these pools. Default: omit (legacy). */
    pools?: { poolId: number; spent: number; spentToken: string; wins: number; prizes: PrizeEntry[] }[];
    /** Force a specific root (for tampering tests). Wins over `pools`. */
    forgePoolsRoot?: string;
    user?: string;
    agent?: string;
  } = {},
): Promise<RawTopicMessage> {
  let poolsRoot: string | undefined;
  if (opts.forgePoolsRoot !== undefined) {
    poolsRoot = opts.forgePoolsRoot;
  } else if (opts.pools) {
    poolsRoot = await computePoolsRoot(opts.pools, {
      sessionId,
      user: opts.user ?? USER,
      agent: opts.agent ?? AGENT,
    });
  }
  return {
    sequence: seq,
    timestamp: ts,
    payload: {
      p: 'hcs-20',
      op: 'play_session_aborted',
      sessionId,
      user: opts.user ?? USER,
      agentSeq: seq,
      completedPools,
      ...(poolsRoot ? { poolsRoot } : {}),
      reason,
      lastError: 'something broke',
      abortedAt: ts,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('hcs20-reader: complete v2 session', () => {
  it('reconstructs a successful session and verifies poolsRoot', async () => {
    const sessionId = 'sess-1';
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
      { poolId: 1, spent: 10, spentToken: 'HBAR', wins: 1, prizes: [{ t: 'ft', tk: 'HBAR', amt: 50 } as PrizeEntry] },
      { poolId: 2, spent: 20, spentToken: 'HBAR', wins: 1, prizes: [{ t: 'ft', tk: 'HBAR', amt: 100 } as PrizeEntry] },
    ];
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 3),
      pool(2, sessionId, 0, 1, 4, 0, []),
      pool(3, sessionId, 1, 2, 10, 1, [{ t: 'ft', tk: 'HBAR', amt: 50 }]),
      pool(4, sessionId, 2, 3, 20, 1, [{ t: 'ft', tk: 'HBAR', amt: 100 }]),
      await close(5, sessionId, 3, poolsData, 2),
    ];

    const result = await parseAuditTopic(messages, NOW);

    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_success');
    assert.equal(session.warnings.length, 0);
    assert.equal(session.totalSpent, 34);
    assert.equal(session.totalWins, 2);
    assert.equal(session.totalPrizeValue, 150);
    assert.equal(session.totalPrizeValueByToken['HBAR'], 150);
    assert.equal(session.pools.length, 3);
    assert.equal(session.prizeTransfer?.status, 'succeeded');
    assert.equal(result.stats.sessionsByStatus.closed_success, 1);
  });
});

describe('hcs20-reader: aborted session', () => {
  it('reconstructs an aborted session as closed_aborted', async () => {
    const sessionId = 'sess-2';
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 5),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 0),
      await aborted(4, sessionId, 2),
    ];

    const result = await parseAuditTopic(messages, NOW);

    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_aborted');
    assert.equal(session.pools.length, 2);
    assert.equal(session.totalSpent, 14);
    assert.equal(result.stats.sessionsByStatus.closed_aborted, 1);
  });

  it('R3-FG-36: aborted with pool-count mismatch promotes to corrupt (was closed_aborted+warning)', async () => {
    // R3-FG-36 (round-3 P5-SR-002): aborted-with-mismatch now matches
    // closed-success-with-mismatch behavior — both promote to `corrupt`.
    // Pre-fix the closed_success branch promoted while the closed_aborted
    // branch only logged a warning; topic-only auditor saw a clean
    // abort despite the count contradiction.
    //
    // revert-proof: status assertion fails if status reverts to
    // 'closed_aborted'.
    const sessionId = 'sess-3';
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 5),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 0),
      await aborted(4, sessionId, 5), // claims 5 but only 2 observed
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'corrupt');
    assert.ok(
      session.warnings.some((w) => w.includes('pool count mismatch')),
      'expected pool count mismatch warning',
    );
  });
});

describe('hcs20-reader: orphan detection', () => {
  it('marks pools without open as orphaned', async () => {
    const sessionId = 'sess-4';
    const messages: RawTopicMessage[] = [
      pool(1, sessionId, 0, 1, 4, 0),
      pool(2, sessionId, 1, 2, 10, 0),
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'orphaned');
    assert.ok(session.warnings.some((w) => w.includes('without a matching')));
  });

  it('marks open with no terminal past timeout as orphaned', async () => {
    const sessionId = 'sess-5';
    const messages: RawTopicMessage[] = [
      // T_OLD is 10 minutes ago — past the 5 minute timeout
      open(1, sessionId, 3, T_OLD),
      pool(2, sessionId, 0, 1, 4, 0, [], T_OLD),
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'orphaned');
  });

  it('marks open with no terminal within timeout as in_flight', async () => {
    const sessionId = 'sess-6';
    const messages: RawTopicMessage[] = [
      // T0 is 1 minute ago — within the 5 minute timeout
      open(1, sessionId, 3, T0),
      pool(2, sessionId, 0, 1, 4, 0, [], T0),
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'in_flight');
  });
});

describe('hcs20-reader: corruption detection', () => {
  it('marks pool count mismatch on close as corrupt', async () => {
    const sessionId = 'sess-7';
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
      { poolId: 1, spent: 10, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const closedMsg = await close(4, sessionId, 3, poolsData, 0); // claims 3 played
    // But only 2 pool messages exist
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 3),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 0),
      closedMsg,
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'corrupt');
    assert.ok(session.warnings.some((w) => w.includes('Pool count mismatch')));
  });

  it('marks poolsRoot mismatch as corrupt', async () => {
    const sessionId = 'sess-8';
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 2),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 1, [{ t: 'ft', tk: 'HBAR', amt: 50 }]),
      // Forge a close message with a wrong poolsRoot
      {
        sequence: 4,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'play_session_close',
          sessionId,
          user: USER,
          agentSeq: 4,
          poolsPlayed: 2,
          poolsRoot: 'sha256:DEADBEEF',
          totalWins: 1,
          prizeTransfer: { status: 'succeeded', txId: 'tx-1', attempts: 1, gasUsed: 1000000 },
          ts: T0,
        },
      },
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'corrupt');
    assert.ok(session.warnings.some((w) => w.includes('poolsRoot mismatch')));
  });
});

describe('hcs20-reader: R4-FG-23 cross-session Merkle replay', () => {
  // R4-FG-23 (round-4 high): pre-fix, two sessions with structurally
  // identical pool data hashed to the same poolsRoot, so a compromised
  // submit-key holder could swap a `play_session_close` between
  // sessions and the reader's tamper-evidence check passed. Binding
  // sessionId|user|agent into the root makes that swap detectable.
  //
  // revert-proof: assertion #1 (different roots) fails if computePoolsRoot
  // reverts to hashing pool tuples only. Assertion #2 (corrupt status)
  // fails if the reader stops binding-aware recomputation.

  it('two sessions with identical pool data produce different roots when binding included', async () => {
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
      { poolId: 1, spent: 10, spentToken: 'HBAR', wins: 1, prizes: [{ t: 'ft', tk: 'HBAR', amt: 50 } as PrizeEntry] },
    ];
    const rootA = await computePoolsRoot(poolsData, {
      sessionId: 'sess-A',
      user: USER,
      agent: AGENT,
    });
    const rootB = await computePoolsRoot(poolsData, {
      sessionId: 'sess-B',
      user: USER,
      agent: AGENT,
    });
    assert.notEqual(rootA, rootB, 'binding should make roots distinct');

    // And: replay the close from session A onto session B's pool
    // messages → reader marks B as corrupt because the bound root
    // recomputation does not match A's bound root.
    const messages: RawTopicMessage[] = [
      open(1, 'sess-A', 2),
      pool(2, 'sess-A', 0, 1, 4, 0),
      pool(3, 'sess-A', 1, 2, 10, 1, [{ t: 'ft', tk: 'HBAR', amt: 50 }]),
      // close emitted under sessionId 'sess-A' with rootA
      {
        sequence: 4,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'play_session_close',
          sessionId: 'sess-A',
          user: USER,
          agentSeq: 4,
          poolsPlayed: 2,
          poolsRoot: rootA,
          totalWins: 1,
          prizeTransfer: { status: 'succeeded', txId: 'tx-1', attempts: 1, gasUsed: 5_450_000 },
          ts: T0,
        },
      },
      open(5, 'sess-B', 2),
      pool(6, 'sess-B', 0, 1, 4, 0),
      pool(7, 'sess-B', 1, 2, 10, 1, [{ t: 'ft', tk: 'HBAR', amt: 50 }]),
      // Adversarial: close for B claims rootA (cross-session replay)
      {
        sequence: 8,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'play_session_close',
          sessionId: 'sess-B',
          user: USER,
          agentSeq: 8,
          poolsPlayed: 2,
          poolsRoot: rootA, // forged: actually session A's bound root
          totalWins: 1,
          prizeTransfer: { status: 'succeeded', txId: 'tx-2', attempts: 1, gasUsed: 5_450_000 },
          ts: T0,
        },
      },
    ];

    const result = await parseAuditTopic(messages, NOW);
    const sessA = result.sessions.find((s) => s.sessionId === 'sess-A')!;
    const sessB = result.sessions.find((s) => s.sessionId === 'sess-B')!;
    assert.equal(sessA.status, 'closed_success', 'session A validates against its own root');
    assert.equal(sessB.status, 'corrupt', 'session B rejects A-bound root as Merkle mismatch');
    assert.ok(
      sessB.warnings.some((w) => w.includes('poolsRoot mismatch')),
      'expected poolsRoot mismatch warning on replayed close',
    );
  });

  // revert-proof: if the reader's close-validation drops the legacy
  // unbound fallback (R4-FG-23 back-compat path), this test fails
  // with status='corrupt' instead of 'closed_success' + warning.
  it('legacy unbound close validates with legacy_merkle_binding warning (back-compat)', async () => {
    const sessionId = 'sess-legacy';
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 1),
      pool(2, sessionId, 0, 1, 4, 0),
      // Pre-R4-FG-23 close: root computed without binding
      await close(3, sessionId, 1, poolsData, 0, T0, { legacyBinding: true }),
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_success');
    assert.ok(
      session.warnings.some((w) => w.includes('legacy_merkle_binding')),
      'expected legacy_merkle_binding warning',
    );
  });

  // revert-proof: if `isPostLegacyCutoff` is removed from
  // `reconstructSession` close branch, this test fails — the legacy
  // fallback would accept the unbound root post-cutoff and produce
  // 'closed_success' instead of 'corrupt'. R5-FG-2 (P1-004 + P3-005).
  it('R5-FG-2: post-cutoff legacy unbound close is corrupt, not closed_success', async () => {
    const sessionId = 'sess-post-cutoff';
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    // Set cutoff to the unix epoch so any test message is "post-cutoff".
    const prev = process.env.LEGACY_MERKLE_CUTOFF_TIMESTAMP;
    process.env.LEGACY_MERKLE_CUTOFF_TIMESTAMP = '1970-01-01T00:00:00.000Z';
    try {
      const messages: RawTopicMessage[] = [
        open(1, sessionId, 1),
        pool(2, sessionId, 0, 1, 4, 0),
        // Pre-R4-FG-23 root, but message timestamp is post-cutoff.
        await close(3, sessionId, 1, poolsData, 0, T0, { legacyBinding: true }),
      ];
      const result = await parseAuditTopic(messages, NOW);
      const session = result.sessions[0]!;
      assert.equal(
        session.status,
        'corrupt',
        'post-cutoff legacy unbound close MUST refuse the legacy fallback',
      );
    } finally {
      if (prev === undefined) delete process.env.LEGACY_MERKLE_CUTOFF_TIMESTAMP;
      else process.env.LEGACY_MERKLE_CUTOFF_TIMESTAMP = prev;
    }
  });
});

describe('hcs20-reader: R4-FG-24 aborted Merkle root', () => {
  // R4-FG-24 (round-4 high): pre-fix the aborted message carried no
  // poolsRoot. A compromised operator could write an aborted with
  // forged completedPools alongside legitimate pool messages — the
  // count check catches obvious mismatches but the Merkle bind closes
  // the residual hole where the forged abort matches by count.
  //
  // revert-proof: status assertion fails if the reader stops
  // recomputing the Merkle root for aborted messages.

  it('aborted with mismatched poolsRoot is corrupt', async () => {
    const sessionId = 'sess-abort-tampered';
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
      { poolId: 1, spent: 10, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 2),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 0),
      // Aborted forges a root that doesn't match the observed pools
      // (e.g., from a different session with the same pool count).
      await aborted(4, sessionId, 2, 'v2_write_failure', T0, {
        forgePoolsRoot: 'sha256:DEADBEEF', // wrong root
      }),
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'corrupt');
    assert.ok(
      session.warnings.some((w) => w.includes('Aborted poolsRoot mismatch')),
      'expected Aborted poolsRoot mismatch warning',
    );
  });

  // revert-proof: if recordPlaySessionAborted stops emitting
  // poolsRoot or the reader's aborted branch stops recomputing it
  // (R4-FG-24), this test fails because the warning will be
  // 'legacy_abort_no_merkle' instead of clean.
  it('aborted with matching bound poolsRoot is closed_aborted', async () => {
    const sessionId = 'sess-abort-clean';
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
      { poolId: 1, spent: 10, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 5),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 0),
      // Honest aborted with the correct bound Merkle root
      await aborted(4, sessionId, 2, 'v2_write_failure', T0, {
        pools: poolsData,
      }),
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_aborted');
    assert.ok(
      !session.warnings.some((w) => w.includes('legacy_abort_no_merkle')),
      'should not emit legacy warning when poolsRoot is present',
    );
  });

  // revert-proof: if the reader's aborted branch drops the
  // 'legacy_abort_no_merkle' warning (R4-FG-24 back-compat path),
  // this test fails because no warning will be emitted on
  // pre-fix abort messages.
  it('aborted without poolsRoot still works (back-compat) with warning', async () => {
    const sessionId = 'sess-abort-legacy';
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 5),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 0),
      // Pre-R4-FG-24 abort: no poolsRoot field (default branch of helper)
      await aborted(4, sessionId, 2),
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_aborted');
    assert.ok(
      session.warnings.some((w) => w.includes('legacy_abort_no_merkle')),
      'expected legacy_abort_no_merkle warning on pre-R4-FG-24 abort',
    );
  });
});

describe('hcs20-reader: v1 backward compat', () => {
  it('reconstructs a v1 batch session as closed_success with no wins', async () => {
    const sessionId = 'sess-v1';
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'batch',
          tick: 'LLCRED',
          sessionId,
          operations: [
            { op: 'burn', amt: '4', memo: 'play:pool-0:2-entries', from: USER },
            { op: 'burn', amt: '10', memo: 'play:pool-1:2-entries', from: USER },
          ],
          timestamp: T0,
        },
      },
    ];

    const result = await parseAuditTopic(messages, NOW);
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_success');
    assert.equal(session.totalSpent, 14);
    assert.equal(session.totalWins, 0); // v1 doesn't track wins
    assert.ok(session.warnings.some((w) => w.includes('v1 legacy')));
  });
});

describe('hcs20-reader: mixed v1 and v2 streams', () => {
  it('handles a topic with both legacy batch and new sequence messages', async () => {
    const v1Session = 'sess-v1-mixed';
    const v2Session = 'sess-v2-mixed';
    const v2Pools = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const messages: RawTopicMessage[] = [
      // v1 first
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'batch',
          sessionId: v1Session,
          operations: [{ op: 'burn', amt: '5', memo: 'play:pool-0:1-entries', from: USER }],
        },
      },
      // v2 next
      open(2, v2Session, 1),
      pool(3, v2Session, 0, 1, 4, 0),
      await close(4, v2Session, 1, v2Pools, 0),
    ];

    const result = await parseAuditTopic(messages, NOW);
    assert.equal(result.sessions.length, 2);
    const v1 = result.sessions.find((s) => s.sessionId === v1Session)!;
    const v2 = result.sessions.find((s) => s.sessionId === v2Session)!;
    assert.equal(v1.status, 'closed_success');
    assert.equal(v2.status, 'closed_success');
    assert.equal(result.stats.v1Messages, 1);
    assert.equal(result.stats.v2Messages, 3);
  });
});

describe('hcs20-reader: agentSeq gap detection', () => {
  it('detects gaps in agentSeq from a single agent', async () => {
    const sessionId = 'sess-gap';
    const poolsData = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 1),
      pool(2, sessionId, 0, 1, 4, 0),
      // Skip seq 3 (simulating a dropped message)
      await close(4, sessionId, 1, poolsData, 0),
    ];
    // Manually overwrite the sequence numbers used as agentSeq to force a gap
    (messages[0]!.payload as { agentSeq: number }).agentSeq = 1;
    (messages[1]!.payload as { agentSeq: number }).agentSeq = 2;
    (messages[2]!.payload as { agentSeq: number }).agentSeq = 5; // gap from 2 to 5

    const result = await parseAuditTopic(messages, NOW);
    assert.ok(
      result.stats.agentSeqGaps.length >= 1,
      'expected at least one agentSeq gap',
    );
    assert.equal(result.stats.agentSeqGaps[0]!.agent, AGENT);
  });
});

describe('hcs20-reader: refund parsing', () => {
  // revert-proof: if seenRefundTxIds is removed (R4-FG-58 reverted) the
  // reader emits TWO refund events instead of one and the second
  // assertion (refund event count === 1) fails.
  it('R4-FG-58: duplicate refundTxId emits ONE refund event (reader-side dedup)', async () => {
    // Two refund messages with the same `refundTxId` — happens when
    // verifier-side `recordRefund` retries after a Lambda freeze.
    const dupRefundTxId = '0.0.456@789.012';
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'refund',
          tick: 'LLCRED',
          amt: '100',
          from: AGENT,
          to: USER,
          originalDepositTxId: '0.0.123@456.789',
          refundTxId: dupRefundTxId,
          reason: 'admin',
          performedBy: '0.0.OPERATOR',
          rakeReversed: '5',
          rakeReversedToken: 'HBAR',
          ts: T0,
        },
      },
      {
        sequence: 2,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'refund',
          tick: 'LLCRED',
          amt: '100',
          from: AGENT,
          to: USER,
          originalDepositTxId: '0.0.123@456.789',
          refundTxId: dupRefundTxId, // SAME refundTxId — verifier retry
          reason: 'admin',
          performedBy: '0.0.OPERATOR',
          rakeReversed: '5',
          rakeReversedToken: 'HBAR',
          ts: T0,
        },
      },
    ];

    const result = await parseAuditTopic(messages, NOW);
    const refundEvents = result.events.filter((e) => e.type === 'refund');
    assert.equal(
      refundEvents.length,
      1,
      'reader must dedup duplicate refund anchors on refundTxId',
    );
    assert.equal(result.stats.skippedMessages, 1, 'duplicate must increment skippedMessages');
  });

  it('parses refund messages into NormalizedRefundEvent', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'refund',
          tick: 'LLCRED',
          amt: '100',
          from: AGENT,
          to: USER,
          originalDepositTxId: '0.0.123@456.789',
          refundTxId: '0.0.456@789.012',
          reason: 'admin',
          performedBy: '0.0.OPERATOR',
          ts: T0,
        },
      },
    ];

    const result = await parseAuditTopic(messages, NOW);
    const refund = result.events.find((e) => e.type === 'refund');
    assert.ok(refund, 'expected refund event');
    if (refund?.type === 'refund') {
      assert.equal(refund.user, USER);
      assert.equal(refund.amount, 100);
      assert.equal(refund.originalDepositTxId, '0.0.123@456.789');
      assert.equal(refund.refundTxId, '0.0.456@789.012');
      assert.equal(refund.reason, 'admin');
    }
  });
});

describe('hcs20-reader: deposit/rake/withdrawal v1 parsing', () => {
  it('parses mint as deposit', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: { p: 'hcs-20', op: 'mint', tick: 'LLCRED', amt: '855', to: USER },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const ev = result.events.find((e) => e.type === 'deposit');
    assert.ok(ev);
    if (ev?.type === 'deposit') {
      assert.equal(ev.amount, 855);
      assert.equal(ev.user, USER);
    }
  });

  it('parses rake transfer', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'transfer',
          tick: 'LLCRED',
          amt: '45',
          from: USER,
          to: AGENT,
          memo: 'rake',
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const ev = result.events.find((e) => e.type === 'rake');
    assert.ok(ev);
    if (ev?.type === 'rake') {
      assert.equal(ev.amount, 45);
      assert.equal(ev.user, USER);
      assert.equal(ev.agent, AGENT);
    }
  });

  it('parses withdrawal burn', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'burn',
          tick: 'LLCRED',
          amt: '50',
          from: USER,
          memo: 'withdrawal',
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const ev = result.events.find((e) => e.type === 'withdrawal');
    assert.ok(ev);
    if (ev?.type === 'withdrawal') {
      assert.equal(ev.amount, 50);
      assert.equal(ev.user, USER);
    }
  });
});

describe('hcs20-reader: multi-session interleaving', () => {
  it('correctly groups messages from two interleaved sessions', async () => {
    const sessA = 'sess-A';
    const sessB = 'sess-B';
    const poolsA = [
      { poolId: 0, spent: 4, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const poolsB = [
      { poolId: 1, spent: 10, spentToken: 'HBAR', wins: 0, prizes: [] as PrizeEntry[] },
    ];
    const messages: RawTopicMessage[] = [
      open(1, sessA, 1),
      open(2, sessB, 1),
      pool(3, sessA, 0, 1, 4, 0),
      pool(4, sessB, 1, 1, 10, 0),
      await close(5, sessA, 1, poolsA, 0),
      await close(6, sessB, 1, poolsB, 0),
    ];

    const result = await parseAuditTopic(messages, NOW);
    assert.equal(result.sessions.length, 2);
    const sA = result.sessions.find((s) => s.sessionId === sessA)!;
    const sB = result.sessions.find((s) => s.sessionId === sessB)!;
    assert.equal(sA.status, 'closed_success');
    assert.equal(sB.status, 'closed_success');
    assert.equal(sA.totalSpent, 4);
    assert.equal(sB.totalSpent, 10);
  });
});

// ── v1 token attribution ──────────────────────────────────────
//
// Locks in the contract from task #220: every v1 mint/transfer/burn
// op MUST honour the explicit `token` field when present and fall
// back to LLCRED→HBAR for legacy messages on existing topics. The
// reader is the single source of truth for this resolution; both the
// audit page (server-side) and verify-audit (CLI) consume the
// reader's normalized output, so a regression here would cascade.

describe('hcs20-reader: v1 token attribution', () => {
  it('mint with explicit token=LAZY produces a LAZY deposit event', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'mint',
          tick: 'LLCRED',
          token: 'LAZY',
          amt: '100',
          to: USER,
          memo: 'deposit:0.0.X@1775596937.272650838',
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const deposit = result.events.find((e) => e.type === 'deposit');
    assert.ok(deposit, 'deposit event missing');
    assert.equal(deposit!.type, 'deposit');
    if (deposit!.type === 'deposit') {
      assert.equal(deposit!.token, 'LAZY');
      assert.equal(deposit!.amount, 100);
      assert.equal(deposit!.user, USER);
    }
  });

  it('legacy mint with only tick=LLCRED falls back to HBAR', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'mint',
          tick: 'LLCRED',
          // no `token` field — pre-fix legacy message
          amt: '50',
          to: USER,
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const deposit = result.events.find((e) => e.type === 'deposit');
    assert.ok(deposit, 'deposit event missing');
    if (deposit!.type === 'deposit') {
      assert.equal(deposit!.token, 'HBAR', 'LLCRED should fall back to HBAR');
    }
  });

  it('rake transfer respects explicit token field', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'transfer',
          tick: 'LLCRED',
          token: 'LAZY',
          amt: '5',
          from: USER,
          to: AGENT,
          memo: 'rake',
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const rake = result.events.find((e) => e.type === 'rake');
    assert.ok(rake, 'rake event missing');
    if (rake!.type === 'rake') {
      assert.equal(rake!.token, 'LAZY');
      assert.equal(rake!.amount, 5);
    }
  });

  it('user withdrawal burn respects explicit token field', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'burn',
          tick: 'LLCRED',
          token: 'LAZY',
          amt: '25',
          from: USER,
          memo: 'withdrawal',
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const withdrawal = result.events.find((e) => e.type === 'withdrawal');
    assert.ok(withdrawal, 'withdrawal event missing');
    if (withdrawal!.type === 'withdrawal') {
      assert.equal(withdrawal!.token, 'LAZY');
      assert.equal(withdrawal!.amount, 25);
    }
  });

  it('R2-FG-18: detects agentSeq duplicates as critical (Set→Map<seq,sessionIds>)', async () => {
    // R2-FG-18 (round-2 S-08 / TR-09): pre-fix reader used a
    // Set<number> for seen agentSeqs — two messages with the same
    // agentSeq from the same agent silently collapsed and the
    // duplicate went undetected. The fix tracks `Map<seq, sessions[]>`
    // so duplicates surface as `agentSeqDuplicates` for the verifier
    // to flag as critical.
    const sessionA = 'session-aaaa';
    const sessionB = 'session-bbbb';
    const messages: RawTopicMessage[] = [
      open(10, sessionA, 1),
      pool(11, sessionA, 1, 0, 5, 0, [], T0),
      // Session A close — uses agentSeq=12.
      await close(12, sessionA, 1, [{ poolId: 1, spent: 5, spentToken: 'HBAR', wins: 0, prizes: [] }], 0),
      // Session B opens at agentSeq=12 — DUPLICATE with session A's close.
      // Same agent (AGENT). Pre-fix: silently collapsed; post-fix: surfaces.
      open(13, sessionB, 1),
    ];
    // Re-stamp session B's open with agentSeq=12 by mutating the payload.
    (messages[3]!.payload as { agentSeq: number }).agentSeq = 12;

    const result = await parseAuditTopic(messages, NOW);

    assert.ok(
      result.stats.agentSeqDuplicates.length >= 1,
      `expected at least one duplicate, got ${result.stats.agentSeqDuplicates.length}`,
    );
    const dup = result.stats.agentSeqDuplicates.find((d) => d.seq === 12);
    assert.ok(dup, 'expected dup at seq=12');
    assert.equal(dup!.agent, AGENT);
    assert.ok(dup!.sessions.includes(sessionA), 'expected sessionA in collision');
    assert.ok(dup!.sessions.includes(sessionB), 'expected sessionB in collision');
  });

  it('operator withdrawal burn respects explicit token field', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'burn',
          tick: 'LLCRED',
          token: 'LAZY',
          amt: '15',
          from: AGENT,
          memo: 'operator_withdrawal',
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const opWith = result.events.find((e) => e.type === 'operator_withdrawal');
    assert.ok(opWith, 'operator_withdrawal event missing');
    if (opWith!.type === 'operator_withdrawal') {
      assert.equal(opWith!.token, 'LAZY');
      assert.equal(opWith!.amount, 15);
    }
  });

  // revert-proof: R4-FG-7 — `seenControlIdempotencyKeys` Set + skip-
  // when-seen at hcs20-reader.ts:~407-415. Pre-fix R3-FG-22 stamped
  // `idempotencyKey: 'play-triage:<txId>'` into the body but the
  // reader had zero references to it; both verifier + force-release
  // sibling triage anchors emitted as separate control events. With
  // the dedup, the second anchor is dropped (counted as skipped) and
  // only the first remains in `events`. Reverting the dedup would let
  // this test see TWO control events with the same idempotencyKey.
  it('R4-FG-7: control events with the same idempotencyKey are deduped', async () => {
    const messages: RawTopicMessage[] = [
      {
        sequence: 1,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'control',
          v: 1,
          event: 'play_uncertain_success_pending_triage',
          by: 'reconcile',
          uncertainTxId: '0.0.123-1234567890-987654321',
          userId: USER,
          tokenReservations: [{ token: 'HBAR', amount: 50 }],
          idempotencyKey: 'play-triage:0.0.123-1234567890-987654321',
        },
      },
      {
        // The sibling force-release writer fires the SAME logical event
        // for the SAME uncertainTxId — same deterministic key.
        sequence: 2,
        timestamp: T0,
        payload: {
          p: 'hcs-20',
          op: 'control',
          v: 1,
          event: 'play_uncertain_success_pending_triage',
          by: 'force-release',
          uncertainTxId: '0.0.123-1234567890-987654321',
          userId: USER,
          tokenReservations: [{ token: 'HBAR', amount: 50 }],
          idempotencyKey: 'play-triage:0.0.123-1234567890-987654321',
        },
      },
    ];
    const result = await parseAuditTopic(messages, NOW);
    const triageEvents = result.events.filter(
      (e) => e.type === 'control' && e.idempotencyKey === 'play-triage:0.0.123-1234567890-987654321',
    );
    assert.equal(
      triageEvents.length,
      1,
      'R4-FG-7 fix missing: two control events with same idempotencyKey both emitted (downstream consumers will double-count)',
    );
    assert.equal(
      result.stats.skippedMessages,
      1,
      'R4-FG-7 fix missing: deduped sibling must be counted as skipped for observability',
    );
  });
});
