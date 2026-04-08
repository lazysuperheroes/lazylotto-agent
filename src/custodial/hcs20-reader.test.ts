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
): Promise<RawTopicMessage> {
  const poolsRoot = await computePoolsRoot(pools);
  return {
    sequence: seq,
    timestamp: ts,
    payload: {
      p: 'hcs-20',
      op: 'play_session_close',
      sessionId,
      user: USER,
      agentSeq: seq,
      poolsPlayed,
      poolsRoot,
      totalWins,
      prizeTransfer: { status: 'succeeded', txId: 'tx-1', attempts: 1, gasUsed: 5_450_000 },
      ts,
    },
  };
}

function aborted(
  seq: number,
  sessionId: string,
  completedPools: number,
  reason = 'v2_write_failure',
  ts = T0,
): RawTopicMessage {
  return {
    sequence: seq,
    timestamp: ts,
    payload: {
      p: 'hcs-20',
      op: 'play_session_aborted',
      sessionId,
      user: USER,
      agentSeq: seq,
      completedPools,
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
      aborted(4, sessionId, 2),
    ];

    const result = await parseAuditTopic(messages, NOW);

    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_aborted');
    assert.equal(session.pools.length, 2);
    assert.equal(session.totalSpent, 14);
    assert.equal(result.stats.sessionsByStatus.closed_aborted, 1);
  });

  it('emits a warning when aborted completedPools disagrees with observed', async () => {
    const sessionId = 'sess-3';
    const messages: RawTopicMessage[] = [
      open(1, sessionId, 5),
      pool(2, sessionId, 0, 1, 4, 0),
      pool(3, sessionId, 1, 2, 10, 0),
      aborted(4, sessionId, 5), // claims 5 but only 2 observed
    ];

    const result = await parseAuditTopic(messages, NOW);
    const session = result.sessions[0]!;
    assert.equal(session.status, 'closed_aborted');
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
});
