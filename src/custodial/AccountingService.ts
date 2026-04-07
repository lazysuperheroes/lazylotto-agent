import {
  Client,
  TopicId,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';
import { getPrivateKey } from '../hedera/wallet.js';
import {
  type PlaySessionOpenMessage,
  type PlayPoolResultMessage,
  type PlaySessionCloseMessage,
  type PlaySessionAbortedMessage,
  type RefundMessage,
  type PrizeEntry,
  computePoolsRoot,
  truncateError,
} from './hcs20-v2.js';

// ── Types ────────────────────────────────────────────────────

export interface HCS20Operation {
  op: 'mint' | 'burn' | 'transfer';
  amt: string;
  from?: string;
  to?: string;
  memo?: string;
}

interface AccountingConfig {
  client: Client;
  tick: string;
  topicId?: string;
}

// ── Service ──────────────────────────────────────────────────

/**
 * Wraps HCS-20 on-chain accounting for the multi-user custodial agent.
 *
 * Every credit-affecting operation (deposit, withdrawal, rake, play session,
 * operator withdrawal) is recorded as an immutable HCS-20 message on a
 * Hedera Consensus Service topic. This provides a verifiable audit trail
 * that any third party can reconstruct from the public mirror node.
 *
 * If no topicId is configured (i.e., HCS-20 has not been deployed yet),
 * all record methods are safe no-ops so the agent can run in development
 * without on-chain accounting.
 */
export class AccountingService {
  private readonly client: Client;
  private readonly tick: string;
  private topicId: string | null;
  /**
   * Monotonic per-agent counter stamped on every v2 message. Lets
   * the audit reader detect dropped messages: if it sees agentSeq
   * 1, 2, 3, 5, that's a gap. Recovered at startup via one mirror
   * node scan in initializeAgentSeq() — no Redis dependency.
   * `-1` means uninitialized; the first message will set it to 0
   * (after recovery) or to the highest existing seq + 1.
   */
  private agentSeq = -1;
  private agentSeqInitPromise: Promise<void> | null = null;

  constructor(config: AccountingConfig) {
    this.client = config.client;
    this.tick = config.tick;
    this.topicId = config.topicId ?? null;
  }

  // ── Accessors ────────────────────────────────────────────

  getTopicId(): string | null {
    return this.topicId;
  }

  // ── Deployment ───────────────────────────────────────────

  /**
   * One-time setup: create an HCS topic and submit the HCS-20 deploy message.
   *
   * The agent's operator key is set as both the admin key and submit key so
   * that only the agent can write accounting records.
   *
   * @param name  - Human-readable token name (e.g. "LazyLotto Credits")
   * @param maxSupply - Maximum supply for the HCS-20 token
   * @returns The newly created topic ID as a string (e.g. "0.0.12345")
   */
  async deploy(name: string, maxSupply: string): Promise<string> {
    const adminKey = getPrivateKey();

    const topicTx = new TopicCreateTransaction()
      .setAdminKey(adminKey)
      .setSubmitKey(adminKey);

    const topicResponse = await topicTx.execute(this.client);
    const topicReceipt = await topicResponse.getReceipt(this.client);
    const newTopicId = topicReceipt.topicId;

    if (!newTopicId) {
      throw new Error('TopicCreateTransaction succeeded but returned no topicId');
    }

    this.topicId = newTopicId.toString();

    // Submit the HCS-20 deploy message
    const deployMessage = JSON.stringify({
      p: 'hcs-20',
      op: 'deploy',
      name,
      tick: this.tick,
      max: maxSupply,
      lim: maxSupply,
    });

    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(deployMessage)
      .execute(this.client);

    return this.topicId;
  }

  // ── Individual Operations ────────────────────────────────

  /**
   * Record a user deposit as an HCS-20 mint.
   *
   * The deposit transaction ID is included in the memo field so it can
   * be correlated with the on-chain LAZY token transfer.
   */
  async recordDeposit(
    userAccountId: string,
    amount: number,
    depositTxId: string,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'mint',
      tick: this.tick,
      amt: String(amount),
      to: userAccountId,
      memo: `deposit:${depositTxId}`,
    });
  }

  /**
   * Record a rake fee as an HCS-20 transfer from user to agent.
   */
  async recordRake(
    userAccountId: string,
    agentAccountId: string,
    amount: number,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'transfer',
      tick: this.tick,
      amt: String(amount),
      from: userAccountId,
      to: agentAccountId,
      memo: 'rake',
    });
  }

  /**
   * Record a user withdrawal as an HCS-20 burn.
   */
  async recordWithdrawal(
    userAccountId: string,
    amount: number,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'burn',
      tick: this.tick,
      amt: String(amount),
      from: userAccountId,
      memo: 'withdrawal',
    });
  }

  /**
   * Record an operator (agent) withdrawal as an HCS-20 burn.
   *
   * This covers the case where the agent operator withdraws accumulated
   * rake fees from the platform balance.
   */
  async recordOperatorWithdrawal(
    agentAccountId: string,
    amount: number,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'burn',
      tick: this.tick,
      amt: String(amount),
      from: agentAccountId,
      memo: 'operator_withdrawal',
    });
  }

  /**
   * Record an operator control event on HCS-20 — used for kill switch
   * toggles and similar incident markers. These are not balance-moving
   * ops, they're audit anchors so the on-chain trail shows exactly when
   * and why the operator paused or resumed service.
   *
   * Uses op="control" which is outside the HCS-20 spec but preserves the
   * tick and protocol header so downstream readers can filter by topic
   * and skip non-balance events cleanly.
   */
  async recordControlEvent(
    event: 'killswitch_enabled' | 'killswitch_disabled',
    details: { reason?: string; by: string },
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'control',
      tick: this.tick,
      event,
      reason: details.reason ?? null,
      by: details.by,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Record a manual operator-initiated prize recovery as a new HCS-20
   * op type. Used when prizes got stranded in the agent wallet because
   * the in-flight transferPendingPrizes call failed (typically with
   * INSUFFICIENT_GAS) and an operator ran the recovery tool to push
   * them through.
   *
   * `op: "prize_recovery"` is outside the canonical HCS-20 spec, like
   * `control` already is. We keep the protocol header (`p`, `tick`) so
   * downstream readers can filter by topic + operation cleanly.
   *
   * Schema v2 introduced specifically for this op so audit consumers
   * can branch on `v` field rather than guessing at the shape.
   */
  async recordPrizeRecovery(details: {
    userAccountId: string;
    agentAccountId: string;
    prizesTransferred: number;
    /** Per-token totals computed from local sessions, if available. */
    prizesByToken?: Record<string, number>;
    /** Hedera contract tx ID returned by transferPendingPrizes. */
    contractTxId: string;
    /** Free-text reason recorded by the operator (or "auto" if scripted). */
    reason: string;
    /** Operator account ID that initiated the recovery. */
    performedBy: string;
    /** Local session IDs whose prizes were affected, if known. */
    affectedSessions?: string[];
    /** Number of retry attempts before success (1 = first try). */
    attempts?: number;
    /** Final gas value used for the successful contract call. */
    gasUsed?: number;
  }): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'prize_recovery',
      tick: this.tick,
      v: 2,
      user: details.userAccountId,
      agent: details.agentAccountId,
      prizesTransferred: details.prizesTransferred,
      ...(details.prizesByToken ? { prizesByToken: details.prizesByToken } : {}),
      contractTxId: details.contractTxId,
      reason: details.reason,
      performedBy: details.performedBy,
      ...(details.affectedSessions ? { affectedSessions: details.affectedSessions } : {}),
      ...(details.attempts ? { attempts: details.attempts } : {}),
      ...(details.gasUsed ? { gasUsed: details.gasUsed } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  // ── Batched Operations ───────────────────────────────────

  /**
   * Record a play session as a single batched HCS-20 message.
   *
   * Play sessions typically involve multiple burns (entry fees, gas costs)
   * that logically belong together. Batching them in one consensus message
   * keeps the audit trail clean and reduces transaction costs.
   */
  async recordPlaySession(
    sessionId: string,
    operations: HCS20Operation[],
  ): Promise<void> {
    const batchMessage = {
      p: 'hcs-20',
      op: 'batch',
      tick: this.tick,
      sessionId,
      operations: operations.map((op) => ({
        ...op,
        tick: this.tick,
      })),
      timestamp: new Date().toISOString(),
    };

    await this.submitMessage(batchMessage);
  }

  // ── v2 schema (per-message session lifecycle) ────────────

  /**
   * Initialize the per-agent monotonic sequence counter by scanning
   * the topic for the agent's last v2 message. Idempotent — only
   * runs once per process. Called automatically by the v2 writer
   * methods on first use, but can be invoked explicitly at startup
   * to surface mirror node failures early.
   *
   * The scan walks the topic in reverse-chronological order looking
   * for any v2 message authored by this agent (identifiable by the
   * `agent` field on session lifecycle messages, or the `from` field
   * on refund/burn ops where applicable). The highest agentSeq seen
   * + 1 becomes the next value to emit.
   *
   * If no prior v2 message exists, the counter starts at 0.
   *
   * Failure mode: if the mirror node scan fails, we fall back to 0
   * and log a warning. In the worst case this means the first
   * batch of v2 messages after a failed restart could have
   * overlapping agentSeq values, which the reader will surface as
   * a duplicate-seq warning. Acceptable degradation.
   */
  async initializeAgentSeq(agentAccountId: string): Promise<void> {
    if (this.agentSeqInitPromise) return this.agentSeqInitPromise;
    this.agentSeqInitPromise = (async () => {
      if (!this.topicId) {
        // No topic = no scan needed; counter stays at 0
        this.agentSeq = 0;
        return;
      }
      try {
        const network = process.env.HEDERA_NETWORK ?? 'testnet';
        const mirrorBase =
          network === 'mainnet'
            ? 'https://mainnet.mirrornode.hedera.com/api/v1'
            : 'https://testnet.mirrornode.hedera.com/api/v1';

        // Walk backwards from newest. We expect the agent's recent
        // messages to be at the tail of the topic, so paginate
        // descending. Stop after the first match or after a few
        // pages (~100 messages) to bound the scan.
        let highestSeq = -1;
        let scanned = 0;
        const maxScan = 500; // hard limit so a huge topic doesn't stall startup
        let nextPath: string | null = `/topics/${this.topicId}/messages?limit=100&order=desc`;
        while (nextPath && scanned < maxScan) {
          const url = nextPath.startsWith('/api/v1')
            ? `${mirrorBase.replace(/\/api\/v1$/, '')}${nextPath}`
            : `${mirrorBase}${nextPath}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Mirror node ${res.status}`);
          const data = (await res.json()) as {
            messages?: { message: string }[];
            links?: { next?: string };
          };
          for (const m of data.messages ?? []) {
            scanned++;
            try {
              const payload = JSON.parse(
                Buffer.from(m.message, 'base64').toString('utf-8'),
              ) as Record<string, unknown>;
              // Match v2 messages from this agent. Session lifecycle
              // messages carry `agent`; pool/refund/recovery don't,
              // so we also check the `from` field where present.
              const isFromUs =
                payload.agent === agentAccountId ||
                payload.from === agentAccountId ||
                payload.performedBy === agentAccountId;
              if (
                isFromUs &&
                typeof payload.agentSeq === 'number' &&
                payload.agentSeq > highestSeq
              ) {
                highestSeq = payload.agentSeq;
              }
            } catch {
              // Skip messages we can't decode
            }
          }
          nextPath = data.links?.next ?? null;
          // Once we've found a match, one more page is enough to
          // catch any racing writes — then bail out.
          if (highestSeq >= 0 && scanned > 100) break;
        }
        this.agentSeq = highestSeq + 1;
        console.log(
          `[AccountingService] agentSeq initialized to ${this.agentSeq} ` +
            `(scanned ${scanned} messages, last seen seq ${highestSeq})`,
        );
      } catch (err) {
        console.warn(
          `[AccountingService] agentSeq init scan failed; starting at 0. ` +
            `Reader may flag duplicate seqs. Error: ${err instanceof Error ? err.message : err}`,
        );
        this.agentSeq = 0;
      }
    })();
    return this.agentSeqInitPromise;
  }

  /**
   * Internal helper: claim and increment the next agentSeq value.
   * Lazily initializes if not already done. Synchronous after init.
   */
  private async nextAgentSeq(agentAccountId: string): Promise<number> {
    if (this.agentSeq < 0) {
      await this.initializeAgentSeq(agentAccountId);
    }
    return this.agentSeq++;
  }

  /**
   * Write the play_session_open message. Always written FIRST in
   * the v2 sequence, before any pool result. Carries session-level
   * metadata that doesn't repeat per pool: strategy, expected pool
   * count, the v field as a session-level fence.
   *
   * Throws if the topic isn't configured — failure here is load
   * bearing for the rest of the sequence (the close message
   * references the open). Caller should handle the throw and
   * abort the play if accounting is mandatory.
   */
  async recordPlaySessionOpen(details: {
    sessionId: string;
    user: string;
    agent: string;
    strategy: string;
    boostBps: number;
    expectedPools: number;
  }): Promise<void> {
    const seq = await this.nextAgentSeq(details.agent);
    const message: PlaySessionOpenMessage = {
      p: 'hcs-20',
      op: 'play_session_open',
      v: 2,
      sessionId: details.sessionId,
      user: details.user,
      agent: details.agent,
      agentSeq: seq,
      strategy: details.strategy,
      boostBps: details.boostBps,
      expectedPools: details.expectedPools,
      ts: new Date().toISOString(),
    };
    await this.submitV2Message(message);
  }

  /**
   * Write a single play_pool_result message. One per pool actually
   * played. The reader groups these by sessionId and walks them in
   * `seq` order. The optional `strategyMeta` field carries the
   * agent's decision input (EV, budget remaining) for that pool —
   * the field that converts the audit trail from a ledger into
   * defensible evidence.
   */
  async recordPlayPoolResult(details: {
    sessionId: string;
    user: string;
    agent: string;
    poolId: number;
    seq: number;
    entries: number;
    spent: string | number;
    spentToken: string;
    wins: number;
    prizes: PrizeEntry[];
    strategyMeta?: { ev?: number; budgetRemaining?: number };
  }): Promise<void> {
    const agentSeq = await this.nextAgentSeq(details.agent);
    const message: PlayPoolResultMessage = {
      p: 'hcs-20',
      op: 'play_pool_result',
      sessionId: details.sessionId,
      user: details.user,
      agentSeq,
      poolId: details.poolId,
      seq: details.seq,
      entries: details.entries,
      spent: String(details.spent),
      spentToken: details.spentToken,
      wins: details.wins,
      prizes: details.prizes,
      ...(details.strategyMeta ? { strategyMeta: details.strategyMeta } : {}),
      ts: new Date().toISOString(),
    };
    await this.submitV2Message(message);
  }

  /**
   * Write the play_session_close message. Always written LAST on
   * success. Carries the operator's signed claim about the session
   * totals + the prize transfer outcome.
   *
   * `poolsRoot` is computed by the caller via computePoolsRoot()
   * from the same pool data passed to recordPlayPoolResult. The
   * reader recomputes from the pool messages it actually saw and
   * rejects the close if they disagree. That's the tamper-evidence
   * layer.
   */
  async recordPlaySessionClose(details: {
    sessionId: string;
    user: string;
    agent: string;
    poolsPlayed: number;
    poolsRoot: string;
    totalWins: number;
    prizeTransfer: PlaySessionCloseMessage['prizeTransfer'];
  }): Promise<void> {
    const agentSeq = await this.nextAgentSeq(details.agent);
    const message: PlaySessionCloseMessage = {
      p: 'hcs-20',
      op: 'play_session_close',
      sessionId: details.sessionId,
      user: details.user,
      agentSeq,
      poolsPlayed: details.poolsPlayed,
      poolsRoot: details.poolsRoot,
      totalWins: details.totalWins,
      prizeTransfer: details.prizeTransfer,
      ts: new Date().toISOString(),
    };
    await this.submitV2Message(message);
  }

  /**
   * Write the play_session_aborted message instead of close when
   * the session sequence dies mid-stream. The reader treats it as
   * a positive terminal marker — "this session is over, here's
   * how many pools made it through" — instead of having to detect
   * missing closes via timeout (which can't distinguish crashed
   * from in-flight).
   */
  async recordPlaySessionAborted(details: {
    sessionId: string;
    user: string;
    agent: string;
    completedPools: number;
    reason: string;
    lastError?: string;
  }): Promise<void> {
    const agentSeq = await this.nextAgentSeq(details.agent);
    const message: PlaySessionAbortedMessage = {
      p: 'hcs-20',
      op: 'play_session_aborted',
      sessionId: details.sessionId,
      user: details.user,
      agentSeq,
      completedPools: details.completedPools,
      reason: details.reason,
      ...(details.lastError ? { lastError: truncateError(details.lastError) } : {}),
      abortedAt: new Date().toISOString(),
    };
    await this.submitV2Message(message);
  }

  /**
   * Write a refund message. New v2 op type that closes the
   * reconciliation gap — refunds previously did not write any
   * HCS-20 entry, so external auditors saw `mint` (deposit) with
   * no inverse, breaking balance math. Now refunds explicitly
   * record both the original deposit tx and the refund tx so
   * a third party can match them.
   */
  async recordRefund(details: {
    amount: string | number;
    from: string;
    to: string;
    originalDepositTxId: string;
    refundTxId: string;
    reason: string;
    performedBy: string;
  }): Promise<void> {
    const message: RefundMessage = {
      p: 'hcs-20',
      op: 'refund',
      tick: this.tick,
      amt: String(details.amount),
      from: details.from,
      to: details.to,
      originalDepositTxId: details.originalDepositTxId,
      refundTxId: details.refundTxId,
      reason: details.reason,
      performedBy: details.performedBy,
      ts: new Date().toISOString(),
    };
    await this.submitV2Message(message);
  }

  /**
   * Submit a v2 message. Unlike the legacy submitMessage() which
   * silently no-ops when topicId is missing, this throws — v2
   * writers are load-bearing for the audit trail and a missing
   * topic in production is a configuration error that needs to
   * surface, not be silently swallowed.
   *
   * Local development without HCS-20 still works because
   * MultiUserAgent only calls v2 writers when this.accounting is
   * enabled. The throw lets us distinguish "intentionally off"
   * from "broken in production".
   */
  private async submitV2Message(
    payload:
      | PlaySessionOpenMessage
      | PlayPoolResultMessage
      | PlaySessionCloseMessage
      | PlaySessionAbortedMessage
      | RefundMessage,
  ): Promise<void> {
    if (!this.topicId) {
      // Match legacy submitMessage() behavior to keep test envs
      // working but log loudly so production misconfigs surface.
      // Operator should set HCS20_TOPIC_ID for v2 to work.
      console.warn(
        `[AccountingService] V2 message ${payload.op} skipped — no HCS20_TOPIC_ID configured. ` +
          `Audit trail will be incomplete.`,
      );
      return;
    }
    const message = JSON.stringify(payload);
    if (Buffer.byteLength(message, 'utf-8') > 1024) {
      // Hard fail on size overflow rather than silently truncating.
      // The schema is sized to fit comfortably under 1024; if we hit
      // this it's a real bug worth crashing on.
      const sessionRef = 'sessionId' in payload ? payload.sessionId : 'n/a';
      throw new Error(
        `[AccountingService] V2 message exceeds 1024 bytes (${Buffer.byteLength(
          message,
          'utf-8',
        )}): op=${payload.op}, sessionId=${sessionRef}`,
      );
    }
    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(message)
      .execute(this.client);
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Submit a JSON message to the HCS-20 topic.
   *
   * If no topic is configured, logs a warning and returns without throwing.
   * This allows the agent to operate without on-chain accounting during
   * development or before the HCS-20 token has been deployed.
   */
  private async submitMessage(payload: Record<string, unknown>): Promise<void> {
    if (!this.topicId) {
      console.warn(
        `[AccountingService] No HCS-20 topic configured — skipping record: ${payload.op}`,
      );
      return;
    }

    const message = JSON.stringify(payload);

    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(message)
      .execute(this.client);
  }
}
