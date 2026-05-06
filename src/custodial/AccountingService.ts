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
  type StrategyChangeMessage,
  type PrizeEntry,
  computePoolsRoot,
  truncateError,
  enforceTopicMessageSizeLimit,
} from './hcs20-v2.js';
import type { IStore } from './IStore.js';

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
  /**
   * Store for the agentSeq counter. RedisStore backs the counter via
   * SETNX (seed) + INCR (claim), so two cold-warm Lambdas writing v2
   * messages for different users cannot emit the same agentSeq.
   * PersistentStore (CLI mode) uses an in-memory Map. Optional only
   * for legacy call sites that pre-date 0.3.3 — without a store the
   * service falls back to a per-process counter and logs a warning;
   * production code paths always pass one.
   */
  store?: IStore;
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
   * Store backing the cross-Lambda agentSeq counter. When present,
   * `initializeAgentSeq` recovers the highest-seen value from mirror
   * node and SETNXs it; `nextAgentSeq` then INCRs the shared counter.
   * Two warm Lambdas writing v2 messages for different users cannot
   * emit the same agentSeq.
   *
   * When absent (legacy / test paths), falls back to a per-process
   * counter with a one-time warning. Pre-0.3.3 behaviour.
   */
  private readonly store: IStore | null;
  /**
   * Track which agent account IDs have run their `initializeAgentSeq`
   * (mirror scan + SETNX seed). Per-process so cold lambdas re-scan
   * but Redis SETNX makes the seed itself idempotent across instances.
   */
  private readonly agentSeqInitPromises = new Map<string, Promise<void>>();
  /**
   * Fallback per-process counter used only when no store is provided.
   * Documented as deprecated; logs a warning on first use so the
   * caller knows they're in the unsafe-on-serverless path.
   */
  private fallbackAgentSeqs = new Map<string, number>();
  private fallbackWarningLogged = false;
  /**
   * 0.3.4 hardening: agents whose mirror-node seed scan failed after
   * retries are marked here. `nextAgentSeq` throws when a seed-failed
   * agent attempts a write, so `playForUser` dead-letters the session
   * via `audit_trail_orphaned` instead of emitting a duplicate seq.
   */
  private agentSeqSeedFailed = new Set<string>();

  constructor(config: AccountingConfig) {
    this.client = config.client;
    this.tick = config.tick;
    this.topicId = config.topicId ?? null;
    this.store = config.store ?? null;
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

  // ── About the `token` field ──────────────────────────────
  //
  // HCS-20's `tick` is the credit ledger label (always "LLCRED" in
  // our deployment). It does NOT identify the underlying asset that
  // was actually deposited/withdrawn. A 50 HBAR deposit and a 50 LAZY
  // deposit both wrote `tick: LLCRED, amt: "50"` historically — the
  // reader had to guess from the memo or fall back to a LLCRED→HBAR
  // heuristic, which is how the verify-audit forensic walk got the
  // wrong totals when LAZY users showed up.
  //
  // We now stamp every balance-affecting v1 op with an explicit
  // `token` field ("HBAR", "LAZY", or a token id like "0.0.1183558")
  // alongside the legacy `tick`. The reader prefers `token` when
  // present and falls back to the LLCRED heuristic only for
  // pre-fix legacy messages on existing topics. New topics get
  // unambiguous per-op token attribution from day one.
  //
  // The `token` field is OPTIONAL on the writer side so callers
  // that don't yet have a token in scope (we shouldn't have any —
  // every call site has been updated) won't break, but the field
  // is documented as required for new readers in the v2 schema doc.

  /**
   * Normalize a token symbol or ID for the HCS-20 `token` field.
   *
   * - Hedera token IDs (0.0.X) pass through unchanged
   * - 'hbar' / 'HBAR' → 'HBAR' (canonical uppercase)
   * - everything else upper-cased so symbol names are consistent
   */
  private normalizeTokenField(token: string): string {
    if (!token) return 'HBAR';
    if (token.startsWith('0.0.')) return token;
    return token.toUpperCase();
  }

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
    token: string = 'HBAR',
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'mint',
      tick: this.tick,
      token: this.normalizeTokenField(token),
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
    token: string = 'HBAR',
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'transfer',
      tick: this.tick,
      token: this.normalizeTokenField(token),
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
    token: string = 'HBAR',
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'burn',
      tick: this.tick,
      token: this.normalizeTokenField(token),
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
    token: string = 'HBAR',
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'burn',
      tick: this.tick,
      token: this.normalizeTokenField(token),
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
    event:
      | 'killswitch_enabled'
      | 'killswitch_disabled'
      | 'force_release_override'
      | 'force_release',
    details: {
      reason?: string;
      by: string;
      /** For force_release: the dead-letter id being released. */
      uncertainTxId?: string;
      /** For force_release: the dead-letter kind. */
      kind?: string;
      /** For force_release_override: mirror outcome at time of override. */
      mirrorResult?: string;
    },
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'control',
      tick: this.tick,
      event,
      reason: details.reason ?? null,
      by: details.by,
      ...(details.uncertainTxId ? { uncertainTxId: details.uncertainTxId } : {}),
      ...(details.kind ? { kind: details.kind } : {}),
      ...(details.mirrorResult ? { mirrorResult: details.mirrorResult } : {}),
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
    let p = this.agentSeqInitPromises.get(agentAccountId);
    if (p) return p;
    p = (async () => {
      // No topic configured: seed at -1 so the first nextAgentSeq
      // INCR returns 0. Matches pre-fix behaviour for empty topics.
      if (!this.topicId) {
        if (this.store) await this.store.seedAgentSeq(agentAccountId, -1);
        else this.fallbackAgentSeqs.set(agentAccountId, -1);
        return;
      }
      // 0.3.4 hardening: retry the mirror scan up to 3 times with
      // exponential backoff before falling back. Pre-fix a single
      // transient mirror-node hiccup seeded at -1, so the next INCR
      // returned 0 — duplicating any existing agentSeq on a topic
      // that may have months of valid data. The reader rejects the
      // duplicate session as `corrupt`. Now we retry; only on terminal
      // failure do we mark the seed as failed and let `nextAgentSeq`
      // throw so `playForUser`'s v2 catch dead-letters the session
      // (audit_trail_orphaned) instead of writing a duplicate.
      const SCAN_RETRY_DELAYS_MS = [200, 1000, 3000];
      let lastError: unknown = undefined;
      let highestSeq = -1;
      let succeeded = false;
      for (let attempt = 0; attempt <= SCAN_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, SCAN_RETRY_DELAYS_MS[attempt - 1]!));
          console.warn(
            `[AccountingService] agentSeq scan retry ${attempt}/${SCAN_RETRY_DELAYS_MS.length}`,
          );
        }
        try {
          const network = process.env.HEDERA_NETWORK ?? 'testnet';
          const mirrorBase =
            network === 'mainnet'
              ? 'https://mainnet.mirrornode.hedera.com/api/v1'
              : 'https://testnet.mirrornode.hedera.com/api/v1';

          let scanned = 0;
          const maxScan = 500;
          let attemptHighest = -1;
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
                const isFromUs =
                  payload.agent === agentAccountId ||
                  payload.from === agentAccountId ||
                  payload.performedBy === agentAccountId;
                if (
                  isFromUs &&
                  typeof payload.agentSeq === 'number' &&
                  payload.agentSeq > attemptHighest
                ) {
                  attemptHighest = payload.agentSeq;
                }
              } catch {
                // Skip messages we can't decode
              }
            }
            nextPath = data.links?.next ?? null;
            if (attemptHighest >= 0 && scanned > 100) break;
          }
          highestSeq = attemptHighest;
          succeeded = true;
          break;
        } catch (err) {
          lastError = err;
          // Continue to next retry attempt; if exhausted, drop out.
        }
      }

      if (succeeded) {
        if (this.store) {
          await this.store.seedAgentSeq(agentAccountId, highestSeq);
        } else {
          this.fallbackAgentSeqs.set(agentAccountId, highestSeq);
        }
        console.log(
          `[AccountingService] agentSeq initialized for ${agentAccountId}: ` +
            `next=${highestSeq + 1} (last seen seq ${highestSeq})`,
        );
      } else {
        // Terminal failure after all retries. Mark this agent as
        // seed-failed so any v2 write throws AGENT_SEQ_SEED_FAILED
        // and `playForUser` dead-letters via the new
        // audit_trail_orphaned path rather than emitting a duplicate
        // sequence number into the audit topic.
        console.error(
          `[AccountingService] agentSeq init scan FAILED after ${SCAN_RETRY_DELAYS_MS.length + 1} attempts ` +
            `for ${agentAccountId}. Marking as seed-failed; v2 writes for this agent will refuse. ` +
            `Last error: ${lastError instanceof Error ? lastError.message : lastError}`,
        );
        this.agentSeqSeedFailed.add(agentAccountId);
      }
    })();
    this.agentSeqInitPromises.set(agentAccountId, p);
    return p;
  }

  /**
   * Claim the next agentSeq for this agent. Routes through the store
   * (Redis INCR for cross-Lambda atomicity, in-memory Map for CLI).
   * Lazily seeds via mirror-node scan on first use per agent.
   */
  private async nextAgentSeq(agentAccountId: string): Promise<number> {
    if (!this.agentSeqInitPromises.has(agentAccountId)) {
      await this.initializeAgentSeq(agentAccountId);
    }
    // 0.3.4: refuse v2 writes for any agent whose seed scan failed
    // after retries. Caller (`playForUser`'s v2 sequence) catches
    // this and dead-letters the session via `audit_trail_orphaned`
    // instead of emitting a duplicate sequence number.
    if (this.agentSeqSeedFailed.has(agentAccountId)) {
      throw new Error(
        `AGENT_SEQ_SEED_FAILED: cannot emit v2 message for ${agentAccountId} — ` +
        `mirror-node seed scan failed after retries. Investigate mirror-node ` +
        `health; restart agent process to retry the scan.`,
      );
    }
    if (this.store) {
      return await this.store.nextAgentSeq(agentAccountId);
    }
    // Fallback path — per-process counter. Production should always
    // pass a store; this branch exists for legacy callers that haven't
    // been migrated yet.
    if (!this.fallbackWarningLogged) {
      console.warn(
        '[AccountingService] no store configured — agentSeq is per-process. ' +
          'On serverless this can produce duplicate sequence numbers across ' +
          'concurrent Lambdas. Pass `store` to the constructor.',
      );
      this.fallbackWarningLogged = true;
    }
    const cur = this.fallbackAgentSeqs.get(agentAccountId) ?? -1;
    const next = cur + 1;
    this.fallbackAgentSeqs.set(agentAccountId, next);
    return next;
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
   * Write a strategy_change audit anchor. Not a balance-moving op,
   * purely an audit trail entry so third parties can reconstruct
   * which strategy was active for any given play session by looking
   * back at the most recent strategy_change message before that
   * session's open message on the topic.
   *
   * Caller (NegotiationHandler.updateUserStrategy) invokes this
   * AFTER the store write succeeds — a failure here should not roll
   * back the local change, just log. See the caller's try/catch.
   */
  async recordStrategyChange(details: {
    user: string;
    previousStrategy: string;
    newStrategy: string;
    newStrategyVersion: string;
    performedBy: string;
  }): Promise<void> {
    const message: StrategyChangeMessage = {
      p: 'hcs-20',
      op: 'strategy_change',
      user: details.user,
      previousStrategy: details.previousStrategy,
      newStrategy: details.newStrategy,
      newStrategyVersion: details.newStrategyVersion,
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
      | RefundMessage
      | StrategyChangeMessage,
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
    const sessionRef = 'sessionId' in payload ? payload.sessionId : 'n/a';
    enforceTopicMessageSizeLimit(message, `v2 op=${payload.op}, sessionId=${sessionRef}`);
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
    enforceTopicMessageSizeLimit(message, `v1 op=${payload.op}`);

    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(message)
      .execute(this.client);
  }
}
