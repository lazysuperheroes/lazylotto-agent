# Round-4 Adversarial Audit — Findings + Triage

**Date:** 2026-05-08 (round 4)
**Branch:** `testnet`
**Scope:** Re-verify R1+R2+R3 closures (~127 fixes shipped) + hunt new exposure with explicit emphasis on the same double-X family from round 3.

**Methodology:** 12 background agents, one persona each:
1. P1 — R3 regression hunter (R2-FG-0 archetype detection, applied to R3)
2. P2 — Concurrency / cross-Lambda atomicity (R3-aware)
3. P3 — Double-X re-verify
4. P4 — Integration boundary
5. P5 — State-machine walker
6. P6 — Self-heal + F4-wedge critic
7. P7 — API surface
8. P8 — Test-quality auditor
9. P9 — Closure verifier (R1+R2+R3)
10. P10 — Blind-spot agent
11. P11 — Perf / scalability
12. P12 — Audit-trail completeness + conservation invariants

**Raw count:** ~150 findings across 12 personas. Deduplicated to **~85 unique items** below.

The dominant pattern persists from rounds 2 and 3: **fixes ship faster than tests**. Multiple R3 closures have either no regression test or one that would survive a full revert of the fix. That's the third round running where this pattern reappears.

The other dominant pattern: **closures are partial siblings**. R3-FG-8 fixed only the withdrawal verifier, leaving operator-fee and play_uncertain unguarded. R3-FG-7's escalation pattern landed only in `processRefund`, not in the verifier. R3-FG-25 was claimed closed via R3-FG-4's outer lock — but the verifier path still queues rake-less. R3-FG-26 unique-orphan-id helper is in `handlers.ts` but unused at the route-level orphan write.

---

## Phase R4-1 — Critical (5 items)

### `[ ]` R4-FG-1 (C) — `markResolved` still spreads stale `...entry` snapshot
**Closes:** P1-001 (single persona; R3-FG-10 sibling miss).
**Bug:** `src/custodial/uncertainTxVerification.ts:578-584` upserts `{...entry, details:{...entry.details, ...progress}, resolvedAt, ...}`. `entry` is the verifier-loop's pre-mutation snapshot. R3-FG-10 fixed `stampProgress` (refresh-then-spread `...fresh`); `markResolved` is the sibling site missed. A concurrent force-release that wrote a top-level field between loop entry and `markResolved` has its write silently reverted.
**Fix:** Mirror R3-FG-10 in `markResolved` — `await store.refreshDeadLetters(); const fresh = ...; if (fresh?.resolvedAt) return; await upsertDeadLetter({...fresh, ...})`.
**Test:** "markResolved preserves a sibling writer's top-level entry mutation".

### `[ ]` R4-FG-2 (C) — `bumpUserLockContentionAttempts` clobbers concurrent force-release `resolvedAt`
**Closes:** P3-DS-002.
**Bug:** R3-FG-58 added refresh-then-spread to `bumpVerificationAttempts` but the SIBLING `bumpUserLockContentionAttempts` (`uncertainTxVerification.ts:495-502`) still spreads `...entry` (stale). A force-release that resolved an entry between loop entry and the bump has its `resolvedAt` REVERTED. Entry reopens; next reconcile pass re-mutates → double-debit / double-release-reservation.
**Fix:** Apply R3-FG-58's pattern: `refreshDeadLetters` + `getDeadLetters().find(...)` + abort if `resolvedAt` set + spread `...fresh`.
**Test:** "bumpUserLockContentionAttempts preserves concurrent resolvedAt".

### `[ ]` R4-FG-3 (C) — Pre-submit SADD permanently bans pre-submission failures
**Closes:** P1-005 + P3-DR-001 + P5-RU-001 (3-persona corroboration). REGRESSED R3-FG-11.
**Bug:** R3-FG-11 SADDs `refundedOriginals` BEFORE on-chain submit. If `submitHbarTransfer`/`submitTokenTransfer` throws Regime A (pre-submission, e.g. `INSUFFICIENT_PAYER_BALANCE`, network failure pre-submit), the catch DELs the per-tx claim but the SADD permanent set still contains the txId. Next legitimate retry hits `sismember=1` → throws "in the permanent refunded-originals set". User can NEVER be refunded again. Only escape is manual SREM via runbook.
**Fix:** In the Regime-A catch (`refund.ts:660-680`), also `await redis.srem(KEY_PREFIX.refundedOriginals, transactionId)`. Regime B (confirmed on-chain failure) still SADDs (genuinely no rollback). Regime C (uncertain) keeps SADD too.
**Test:** "processRefund pre-submission failure does NOT permanently ban the txId".

### `[ ]` R4-FG-4 (C) — Verifier `verifyUncertainRefunds` SADD failure neither orphans nor escalates
**Closes:** P9-004 (R3-FG-7 sibling miss).
**Bug:** R3-FG-7 added orphan + escalation to in-flight `processRefund` SADD failure. The VERIFIER path at `refund.ts:1462-1480` still only logs CRITICAL and continues. Refund verifier resolves SUCCESS → SADD fails → operator never paged → 30 days later the per-tx claim TTLs out → second `processRefund` passes `sismember=0` → SECOND on-chain refund fires.
**Fix:** Mirror R3-FG-7's orphan-write + `escalateUncertainDlFailure({kind:'refunded_originals_sadd_failed'})` block into the verifier's catch.
**Test:** "verifyUncertainRefunds SADD failure escalates and writes orphan".

### `[ ]` R4-FG-5 (C) — Deposit credit's HCS-20 anchor failure has no orphan or escalation
**Closes:** P12-001 + P12-006 (conservation-invariant breach).
**Bug:** `UserLedger.creditDeposit` (`src/custodial/UserLedger.ts:168-184`) mutates user.available + user.totalDeposited + operator.balances + writes a DepositRecord, then calls `recordDeposit` and `recordRake` — both wrapped in `console.warn`-only catches. If the topic submit fails (HCS congestion, throttle, transient outage), local state moves but topic has no `mint` and no `transfer:rake`. Worse: if `recordDeposit` succeeds but `recordRake` fails (independent try/catch), topic has a mint with no paired rake → operator-balance reconstruction silently understated. Conservation invariants 1+2 BOTH break invisibly. Verify-audit alerts nothing because no rule says "every mint must have a paired rake transfer when rakePercent>0".
**Fix:** Mirror the in-band withdrawal pattern: write `audit_trail_orphaned` (sourceKind: `deposit` / `rake`) AND call `escalateUncertainDlFailure({kind:'audit_trail_orphaned'})` on either submit failure. Add a verify-audit alert that flags `mint` events lacking a paired rake transfer when the deposit had `rakeAmount > 0` — or merge deposit+rake into a single batched submit so they're atomic on-topic.
**Test:** "creditDeposit recordDeposit/recordRake failure escalates and writes orphan".

---

## Phase R4-2 — High (~26 items)

### `[ ]` R4-FG-6 (H) — R3-FG-8 only fixed withdrawal verifier; operator-fee + play_uncertain still partial-execute
**Closes:** P9-001 + P5-OFW-001 + P5-PU-002.
**Bug:** R3-FG-8 added `mutationError` flag + skip-`markResolved` to `verifyUncertainWithdrawals` SUCCESS. The OPERATOR-FEE SUCCESS branch (`uncertainTxVerification.ts:1202-1306`) catches mutation failure, writes orphan, then UNCONDITIONALLY calls `markResolved` at line 1307. The PLAY_UNCERTAIN SUCCESS branch (1490-1581) writes anchor + always calls `markResolved` regardless of anchor failure. Both leave the entry resolved with un-applied state changes and no retry path.
**Fix:** Add `let mutationError` in both other SUCCESS branches; on any catch set it; gate `markResolved` on `!mutationError`; emit orphan with phase before bailing.

### `[ ]` R4-FG-7 (H) — R3-FG-22 reader does NOT actually dedup on `idempotencyKey`
**Closes:** P9-002 + P2-005 + P5-PU-002 + P4-004 (4-persona).
**Bug:** R3-FG-22 stamps `idempotencyKey: 'play-triage:<txId>'` into the message body. Verifier and force-release both produce the same deterministic key. But `hcs20-reader.ts` doesn't reference `idempotencyKey` anywhere (zero grep matches). The reader emits BOTH events as `NormalizedControlEvent`. R3-FG-22's claim "readers can dedup" is wire-only decoration; no actual dedup landed. Two anchors for one logical engagement double-count any reservation/state the reader sums from control events.
**Fix:** Add `idempotencyKey?: string` to `NormalizedControlEvent`. Add a `seenIdempotencyKeys: Set<string>` in the pass-2 reducer; skip control-event reduction when key already seen. Increment `stats.skippedMessages` on dedup.

### `[ ]` R4-FG-8 (H) — Verifier-lock release in force-release route is UNFENCED → Lambda freeze + TTL race
**Closes:** P2-001 + P4-008 + P6-009 (3-persona).
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:284-295` releases the verifier-lock with plain `redis.del(lockKey)`. The route's work (handler + R3-FG-1 refresh + audit anchor + resolve write) can exceed `VERIFY_LOCK_TTL_SEC` (60s) on HCS congestion. Lock TTLs out; sibling reconcile acquires fresh; original force-release's `finally` then DELs the SIBLING's lock; a third caller acquires; both run concurrently → torn state. The R3-FG-5 comment "the SET-NX above guaranteed we own this exact instance" is wrong as soon as TTL expires.
**Fix:** Generate `randomUUID()` fence at acquire, pass to `releaseLock` closure, use `RELEASE_SCRIPT` eval. Mirror the verifier sibling exactly.

### `[ ]` R4-FG-9 (H) — Refund outer user lock TTL (60s) shorter than worst-case work window
**Closes:** P2-002 + P6-010.
**Bug:** R3-FG-4 outer lock with default 60s TTL via `tryAcquireUserLockWithBackoff`. Backoff itself burns ~1.85s. The lock is held across mirror cross-check (8s timeout), refundedOriginals SADD, submit + awaitReceipt (8s ceiling), ledger debit, rake reversal, HCS recordRefund (no explicit ceiling), claim overwrite, second SADD. Conservatively 18-25s on happy path, more on congestion. Operator wallet ratelimiting / mirror flapping / HCS congestion easily push past 60s. Lock TTLs; parallel in-band withdraw acquires `lockUser:<userId>` and races the still-running refund's mutation steps.
**Fix:** (a) Heartbeat-extend (PEXPIRE every 20s) while submit + awaitReceipt + HCS submit are in flight; (b) bump TTL to 180s; (c) split lock window so debit step re-acquires briefly post-receipt.

### `[ ]` R4-FG-10 (H) — `agentSeqSeedFailed` in-process Set never cleared → warm Lambda permanently refuses
**Closes:** P2-007 + P3-X-001 + P6-001 (3-persona).
**Bug:** R3-FG-19 added cluster-wide Redis flag with 10-min TTL. The in-process `agentSeqSeedFailed: Set<string>` (`AccountingService.ts:96`) is checked FIRST (line 638) and is never cleared. Lambda A flags + Redis TTLs out at 10 min — Lambda A keeps refusing every v2 write for the rest of its warm life (could be hours). Sibling Lambdas without the local flag succeed. Inconsistent UX, no operator signal beyond rising dead-letter rate.
**Fix:** On successful Redis-flag-empty check, `this.agentSeqSeedFailed.delete(agentAccountId)` AND `this.agentSeqInitPromises.delete(agentAccountId)`. Or drop the local Set entirely and trust Redis as source of truth.

### `[ ]` R4-FG-11 (H) — Force-release `handleRefund` SUCCESS uses internal `usr_*` UUID as on-chain recipient
**Closes:** P1-008 + P4-002.
**Bug:** R3-FG-15 fallback at `handlers.ts:950`: `const refundTo = entry.sender ?? depositRecord?.userId`. `depositRecord.userId` is a `randomUUID()` (NegotiationHandler.ts:118), NOT a Hedera accountId. When `entry.sender` is missing, the audit anchor records `to: "usr_abc123"` — meaningless garbage that breaks topic-only balance reconstruction.
**Fix:** Look up `ctx.store.getUser(depositRecord.userId)?.hederaAccountId` and use that. Refuse SUCCESS with 400 if both `entry.sender` and the lookup are missing (mirror the verifier's contract — verifier ONLY uses `entry.sender`, no UUID fallback).

### `[ ]` R4-FG-12 (H) — F24 verifier mutates without operator-lock when `acquireOperatorLock` returns null
**Closes:** P5-OFW-001.
**Bug:** R3-FG-12 added `const opLockToken = await acquireOperatorLock('withdraw-fees', 60)` at `uncertainTxVerification.ts:1132`. There is NO `if (!opLockToken)` branch — code stamps `operatorDebitedAt`, runs `updateOperator` ANYWAY without the lock, then calls `releaseOperatorLock` with possibly null token in finally. The very race the lock was added to prevent (concurrent in-band debit on a different token racing on operator.balances RMW) reopens whenever `acquireOperatorLock` returns null.
**Fix:** After `acquireOperatorLock`, on null return: write `audit_trail_orphaned` with `phase: 'op_lock_unavailable'`, release the verify-lock, and `continue`.

### `[ ]` R4-FG-13 (H) — R3-FG-25 verifier path still queues without rake reversal info
**Closes:** P9-005 + P2-004 + P1-010.
**Bug:** R3-FG-25 was claimed closed by R3-FG-4 because "queue path is unreachable". But (1) `verifyUncertainRefunds` at `refund.ts:1313-1327` STILL queues without rake reversal — verifier doesn't acquire an outer lock; falls back to queue. (2) `PendingLedgerAdjustment` interface (`pendingLedger.ts:33-50`) still has no `rakeReversal` field. (3) `drainPendingLedgerAdjustments` still applies only `available -= amount`. Old queued entries (queued before R3-FG-4 deploy) drain WITHOUT rake reversal → operator retains rake forever.
**Fix:** Extend `PendingLedgerAdjustment` with `rakeReversal?: { tokenKey: string; amount: number }`. Update verifier's enqueue and the drain to apply both legs. Migrate any in-flight queued entries on next reconcile pass.

### `[ ]` R4-FG-14 (H) — R3-FG-9 audit-anchor and claim-overwrite failures still silent
**Closes:** P9-003 + P12-007.
**Bug:** R3-FG-9 escalates only on step (d) ledger/rake failure. Step (b) audit anchor at `refund.ts:847-855` still `logger.warn`s only. Step (c) claim overwrite at `refund.ts:872-875` still `console.warn`s only. Topic-only auditor missing a refund anchor sees a phantom credit; missing claim-overwrite stays at `pending` and operator gets misleading "in progress" error on retry.
**Fix:** Add orphan-write + `escalateUncertainDlFailure` to BOTH catches. Same for the verifier-side path at `refund.ts:1422-1444` (orphan-write present, escalation absent).

### `[ ]` R4-FG-15 (H) — Recovery script lock TTL (300s) shorter than worst-case retry ladder
**Closes:** P10-SCRIPT-001 + P6-006.
**Bug:** `src/scripts/recover-stuck-prizes.ts:172` acquires lock with 300s TTL. `transferAllPrizesWithRetry` ladder (14M gas × 3 retries × ~16s receipt ceiling each) ≈ 48s; on slow mainnet day with mirror propagation wait, push past 5 minutes. Lock TTL expires; another caller (in-band MCP recovery, or parallel CLI) acquires + submits SECOND `transferPendingPrizes` for same user. Contract is idempotent at prize-set level (no double-spend) but two `prize_recovery` HCS messages emit, both claiming success. Plus R3-FG-35's snapshot re-read uses wall-clock timestamp, not contract-tx consensus timestamp — concurrent play mid-recovery emits a phantom DL.
**Fix:** Lock TTL ≥ 600s or heartbeat-PEXPIRE. Filter recovery's resolve-loop on contract-tx consensus_timestamp parsed from `txResult.result.transactionId.valid-start`.

### `[ ]` R4-FG-16 (H) — Reconcile cron unbounded over DLs at scale
**Closes:** P10-CRON-002 + P11-001 + P6-007.
**Bug:** R3-FG-29 raised reconcile lock TTL to 900s but did NOT add per-pass DL cap or heartbeat. Verifiers walk every open DL serially. Per-DL cost ~10s mirror-flake-bias. With 90+ open DLs reconcile blows 900s; no `releaseOperatorLock` runs (Lambda ceiling kills it); next 14 cron ticks all see "reconcile already in progress" and skip. Insolvency goes undetected for that window.
**Fix:** (a) Per-verifier `MAX_ENTRIES_PER_PASS` cap (e.g., 25) with "deferred N to next pass" warning. (b) `pLimit(5)` parallel batches per verifier (each entry has own `acquireVerifyLock` — cluster-safe). (c) Top-level 120s ceiling with `503 reconcile_partial`. (d) Optional: heartbeat-PEXPIRE every 60s.

### `[ ]` R4-FG-17 (H) — `transferAllPrizesWithRetry` retries on ReceiptUncertainError, undercounts attempts
**Closes:** P10-HED-001.
**Bug:** `src/hedera/contracts.ts:228-278`. The retry catch only short-circuits on `INSUFFICIENT_GAS`. ReceiptUncertainError is wrapped + re-thrown — but the underlying tx may have landed and burned the prize-loop counter. Next attempt submits a NEW transaction; if first succeeded, second reverts (no-op) and the wrapper logs success. Audit `prizeTransfer.attempts` undercounts true on-chain attempts.
**Fix:** Re-throw `ReceiptUncertainError` immediately (don't retry) — same rationale as withdrawals/refunds.

### `[ ]` R4-FG-18 (H) — Recovery script exits 0 even when HCS-20 audit failed
**Closes:** P10-SCRIPT-003.
**Bug:** `recover-stuck-prizes.ts:233-236` audit log failure prints warning, continues, exits 0. Monitoring shells (cron, ops runbook) see success even though the audit trail is missing — exact failure mode `prizeTransfer.status='succeeded'` exists to surface.
**Fix:** Exit code 4 (or write `audit_trail_orphaned`) when audit submit fails.

### `[ ]` R4-FG-19 (H) — `recordPrizeRecovery` audit-failure has no orphan or escalation
**Closes:** P12-002.
**Bug:** `MultiUserAgent.recoverStuckPrizesForUser` (line 2153-2161) only `logger.warn`s on `recordPrizeRecovery` throw — no `audit_trail_orphaned`, no escalation. Contract tx already shifted prize ownership; recovery is real state change. Topic-only auditor has no record an emergency operator-initiated recovery happened.
**Fix:** Wrap with orphan-write + `escalateUncertainDlFailure({kind:'audit_trail_orphaned'})` capturing userId, contractTxId, pendingPrizesCount, affectedSessions.

### `[ ]` R4-FG-20 (H) — DepositWatcher unknown-token watermark hold blocks ALL subsequent deposits
**Closes:** P11-009.
**Bug:** `DepositWatcher.ts:286-306`. When unknown-token deposit appears, `lastTimestamp` resets to `null` so watermark holds. R3-FG-20 makes `getTokenMeta` rethrow on mirror failure → registry never warms if mirror returns 5xx for that token. `pollOnce` re-encounters same tx every cycle, holds watermark. EVERY subsequent legitimate deposit (HBAR, LAZY, etc.) made AFTER this tx is invisible to the agent until manual operator intervention. Single bad token DoS's deposit detection cluster-wide.
**Fix:** Track `unknownTokenAttempts` per-tx in Redis. After N attempts (e.g., 10 polls = 10 min at 60s cadence), promote to hard dead-letter, advance watermark, log loudly. Operator can replay-deposit later.

### `[ ]` R4-FG-21 (H) — RedisStore `MAX_RECORDS = 10_000` declared but never enforced
**Closes:** P11-005.
**Bug:** `src/custodial/RedisStore.ts:49` declares `MAX_RECORDS = 10_000`; grep shows it's defined and never read. `recordDeposit`/`recordPlaySession`/`recordWithdrawal`/`recordGas` all `push` unconditionally. Warm Lambda accumulates every write since hydration. After 6 months: deposits ~30K × 500B = 15MB, plays ~150K × 800B = 120MB. Cold-start `load()` pipelined GETs at 150K plays generate 100MB+ request bodies → Upstash 4MB request-body limit triggers, cold start fails with 413, getStore() retry storm.
**Fix:** In each `record*` method, after `push` if `arr.length > MAX_RECORDS` shift from front. Make `load()` paginate. Add a prune cron that compacts resolved DLs >30 days old, finalized plays >90 days old.

### `[ ]` R4-FG-22 (H) — Strategy schema `z.number().nonnegative()` accepts NaN/Infinity
**Closes:** P10-STRAT-001.
**Bug:** `src/config/strategy.ts:7-27` Zod's `nonnegative()` and `positive()` accept `NaN` AND `Infinity`. With NaN budgets, `BudgetManager.remainingFor` returns NaN, `canAfford` returns false everywhere → silent strategy DoS for that user. With Infinity reservation, play loop tries to buy Infinity entries; Hedera SDK throws AFTER reservation is held.
**Fix:** Wrap every numeric in `.refine((n) => Number.isFinite(n))` or define a `finiteNumber` helper.

### `[ ]` R4-FG-23 (H) — `computePoolsRoot` does not bind sessionId or user (Merkle replay attack)
**Closes:** P10-HCS-002.
**Bug:** `hcs20-v2.ts:324-337` Merkle root over pool tuples only. Two different sessions with structurally identical pool sequences (same poolIds, spent, prizes) hash to the same root. Attacker who controls one session's writes (compromised submit-key, replay window) can swap a `play_session_close` between sessions and reader's tamper-evidence check passes.
**Fix:** Include `sessionId|user|agent` as first hash input alongside pool tuples. Update reader's recomputation to match.

### `[ ]` R4-FG-24 (H) — `play_session_aborted` carries no Merkle root → forged-abort exfiltration
**Closes:** P5-SR-002 + P12-012.
**Bug:** `recordPlaySessionClose` carries `poolsRoot`. `recordPlaySessionAborted` does NOT. Compromised operator could write an `aborted` message claiming `completedPools: 0` for a session whose pool messages already wrote — verify-audit treats it as aborted, ignores spend, reconstructs user's spent=0. Operator pockets the spend.
**Fix:** Require `poolsRoot` on `play_session_aborted` too. Reader rejects aborts whose root doesn't match the pool_results bucket.

### `[ ]` R4-FG-25 (H) — `RECONCILE_FAILURE_WEBHOOK_URL` not HTTPS/origin-validated at boot
**Closes:** P10-CRON-001.
**Bug:** Boot check requires the env be SET but doesn't validate URL parseability or scheme. Typo (`https//hooks…`) or accidental http:// or `file://` URL boots clean and silently fails forever. The cron payload (reconcile delta info — operational signals) could leak to a misconfigured/malicious URL.
**Fix:** At boot, `new URL(webhook)` and assert `protocol === 'https:'`. Optionally require HMAC signing if going through self-hosted webhook.

### `[ ]` R4-FG-26 (H) — Force-release route `audit-orphan:force-release:${id}` collides; not using uniqueForceReleaseOrphanId helper
**Closes:** P9-012 + P12-005 + P1-011 (R3-FG-26 sibling miss).
**Bug:** R3-FG-26 added `uniqueForceReleaseOrphanId(txId)` helper; six handler sites use it. The route-level audit-orphan write at `route.ts:386` (`transactionId: 'audit-orphan:force-release:${id}'`) does NOT. Repeated route-level audit-anchor failures collide via REPLACE. Plus the route doesn't `escalateUncertainDlFailure` (asymmetric with handlers).
**Fix:** Export `uniqueForceReleaseOrphanId` from handlers.ts, import in route.ts, replace the literal id. Add escalation symmetric with handlers.ts.

### `[ ]` R4-FG-27 (H) — Verifier's recordAuditOrphan still uses unsalted `audit-orphan:verifier:${sourceTxId}`
**Closes:** P5-AT-001.
**Bug:** `uncertainTxVerification.ts:553-554` writes `audit-orphan:verifier:${sourceTxId}` UNSALTED. Multi-pass mutation failures on the same tx clobber prior orphan history. Same bug class also persists at `refund.ts:786,901,1429` and `MultiUserAgent.ts:1428,1820`. R3-FG-26 was a six-site partial repair; same archetype alive at seven other sites.
**Fix:** Add a shared helper `mintAuditOrphanId(prefix, sourceTxId)` returning `${prefix}:${sourceTxId}:${Date.now()}-${randomUUID().slice(0,8)}`; call from every site.

### `[ ]` R4-FG-28 (H) — Killswitch + creditDeposit etc. orphan ids use `Date.now()` collision-prone
**Closes:** P12-004.
**Bug:** R3-FG-27/53 promised orphan rows for killswitch timeouts but use `audit-orphan:killswitch-enable:${Date.now()}` — multiple in-flight catch paths racing on same userId at identical Date.now() millisecond collide via REPLACE, losing failure history. Same pattern at `MultiUserAgent.ts:452,1136`.
**Fix:** Apply `${randomUUID().slice(0, 8)}` suffix pattern from `uniqueForceReleaseOrphanId` to every callsite that uses Date.now() as disambiguator.

### `[ ]` R4-FG-29 (H) — Force-release route resolve-write fallback to stale `freshEntry` on refresh failure
**Closes:** P1-002 + P9-006.
**Bug:** `route.ts:414-421` pattern: `let latestEntry = freshEntry; try { refresh; ... } catch { fall through with freshEntry }`. If refresh throws OR find returns undefined, latestEntry stays as freshEntry — pre-handler snapshot. Resolve write spreads `...freshEntry`, including pre-handler `details`, clobbering every progress marker the handlers stamped. The exact bug R3-FG-1 was meant to fix re-emerges on a transient Redis blip.
**Fix:** On refresh failure, fall back to `store.getDeadLetters().find(...)` directly (no refresh) — handlers wrote to in-process store so cache has the right entry. OR have `applyForceRelease` return the final progress accumulator so route can merge it explicitly.

### `[ ]` R4-FG-30 (H) — `getAccountKey` in `/api/auth/challenge` has no timeout
**Closes:** P10-AUTH-001.
**Bug:** `createChallenge` `await`s `getAccountKey(accountId)` with no timeout. Slow/wedged mirror node holds the request open up to Vercel function ceiling. Combined with rate-limit (10/5min on challenge), an attacker who bursts 10 requests against an account ID that triggers a slow path keeps the route saturated for minutes. Cheap DoS.
**Fix:** Wrap with `AbortSignal.timeout(5000)`, return 504 on timeout.

### `[ ]` R4-FG-31 (H) — REGRESSED tests: 4 R3 fixes that survive a full revert
**Closes:** P8-001 (R3-FG-23 SADD test) + P8-002 (R3-FG-24 available-balance MISSING) + P8-003 (R3-FG-19 MISSING) + P8-004 (R3-FG-46 MISSING) + P8-011 (R3-FG-43 missing negative tests) + P8-012 (R3-FG-68 fixture rename).
**Bug:** Same R2-FG-0 archetype repeats for the third round. Six R3 closures have either no test that drives the fix path or assertions that pass on revert: R3-FG-19 / R3-FG-22 / R3-FG-23 / R3-FG-24 / R3-FG-30 / R3-FG-35 / R3-FG-43 negative branches / R3-FG-44 / R3-FG-46 / R3-FG-58 / R3-FG-68 validation.
**Fix:** Add tightened tests:
- R3-FG-23: assert SADD set membership after SUCCESS
- R3-FG-24: test where `available < humanAmount` and assert 409 with insufficient-balance string
- R3-FG-19: AccountingService.test.ts (entirely new file) for seed-failed flag
- R3-FG-46: oversize-message test asserting slim variant survives 1024B cap
- R3-FG-43: 4 negative tests (missing AUTH_PAGE_ORIGIN, http://, network mismatch, missing LAZYLOTTO_MCP_URL)
- R3-FG-44: lock + refresh + assert new session is locked
- R3-FG-22: assert idempotencyKey present in body + parity between writers
- R3-FG-30: spy flush, assert called BEFORE return
- R3-FG-35: 2 pre-existing DLs + injected mid-tx DL → only 2 resolved
- R3-FG-58: stale snapshot bump test (mirror R2-FG-12)
- R3-FG-68: assert.throws on malformed token id

---

## Phase R4-3 — Medium (~28 items)

### `[ ]` R4-FG-32 (M) — Force-release SUCCESS triage anchor + resolve write produces topic anchor without ledger guarantee
**Closes:** P12-010.
**Bug:** Resolve-write at route.ts step 3 ALWAYS happens regardless of step 2 (`recordControlEvent('force_release')`) success. If step 2 fails, entry is still resolved + orphan row carries different id. Topic never receives the `force_release` anchor. verify-audit alerts on `force_release` events as critical — missing one means topic-only auditor can't tell an operator override happened.
**Fix:** Treat `force_release` audit anchor as a hard pre-condition for resolution.

### `[ ]` R4-FG-33 (M) — F24 fenced release SKIPS legacy DLs without `pendingClaimFence`
**Closes:** P1-004 + P5-OFW-002 + P2-003 + P2-013.
**Bug:** Legacy DLs (written before R3-FG-2 deploy) have no `details.pendingClaimFence`. Verifier + force-release SKIP the release silently. Pending claim sits with full TTL (30 min) blocking concurrent operator-fee withdrawals. Operator may be trained to manually `redis.del` the claim → standing runbook becomes a double-pay vector.
**Fix:** When fence missing AND mirror=FAILED, force-DEL the pending claim (operator-acknowledged risk) OR migrate legacy DLs at startup to add fence. Surface a 200 with `requiresManualReconciliation: true` as fallback.

### `[ ]` R4-FG-34 (M) — `replayDeposit` idempotency cache survives `not_credited` for 24h
**Closes:** P4-011.
**Bug:** When `processTransaction` returns false, replayDeposit returns `{status:'not_credited'}` cached for 24h. Operator fixes underlying reason (registers user, raises max-balance, registers token) → retries within 24h → withIdempotency returns cached `not_credited` from 23h ago without re-running. Route returns `{kind:'duplicate', replayed:true}` — looks like the no-op was confirmed.
**Fix:** When `credited === false`, DEL idempotency claim before returning. Or shorten TTL on `not_credited` to 60s.

### `[ ]` R4-FG-35 (M) — `replayDeposit` no AbortSignal on mirror fetch
**Closes:** P4-007 + P4-014.
**Bug:** No timeout on the mirror fetch inside withIdempotency body; in-flight branch holds the lock for full mirror timeout (Vercel function ceiling). Sibling retries see `in-flight` and back off; if first Lambda dies, claim sits at `pending` for 24h.
**Fix:** Add `signal: AbortSignal.timeout(8000)`. Tighten regex to bounded digit count (`/^0\.0\.\d{1,12}(?:-|@)\d{1,12}(?:[-.])\d{1,12}$/`).

### `[ ]` R4-FG-36 (M) — Force-release `handleRefund` FAILED branch uses `entry.transactionId` not `details.refundTxId`
**Closes:** P4-006.
**Bug:** FAILED branch (`handlers.ts:777-794`) writes `failed:${entry.transactionId}` while SUCCESS branch (line 1059) writes `details.refundTxId`. If `entry.transactionId !== details.refundTxId`, the two branches disagree on which tx id identifies the refund.
**Fix:** Both branches MUST use `details.refundTxId` (validated upfront).

### `[ ]` R4-FG-37 (M) — `processWithdrawal` default-arg `'hbar'` still present (R3-FG-57 not implemented)
**Closes:** P4-005.
**Bug:** `MultiUserAgent.ts:1244` reads `token: string = 'hbar'`. Documented for removal in R3-FG-57 but not done. CLAUDE.md security rule explicitly warns against string-literal token symbols.
**Fix:** Remove default. Make token required.

### `[ ]` R4-FG-38 (M) — `deregisterUserOp` swallows MCP-error vs auth boundary
**Closes:** P4-009.
**Bug:** R3-FG-33 made `deregisterUser` async + throw with free-form Error when open `play_uncertain` exists. userOps.deregisterUserOp doesn't catch — bubbles past as 500. UserOpResult discriminator can't represent "blocked by held play reservations".
**Fix:** Add `{kind:'precondition_failed'; reason:string}` to UserOpResult. Catch open-plays error and map.

### `[ ]` R4-FG-39 (M) — A2A skills omit `agent_*` single-user tool surface (parity gap)
**Closes:** P7-004.
**Bug:** CLAUDE.md states "Skills map 1:1 to MCP tool names" but agent card has only MULTI_USER + OPERATOR skills. MCP server exposes 9 single-user tools (`agent_play`, etc.) absent from A2A.
**Fix:** Either add `SINGLE_USER_SKILLS` to agent card, OR add a comment in agent-card.ts explaining the gap and have `check-protocols` exclude them.

### `[ ]` R4-FG-40 (M) — `/api/health` leaks killswitch reason to unauthenticated callers
**Closes:** P7-005.
**Bug:** Health includes `kill_switch.reason` — operator's free-text explanation. Attackers polling `/api/health` learn (a) when an incident starts, (b) the operator's incident description verbatim. Free recon for window-of-opportunity attacks. `/api/public/stats` already serves this.
**Fix:** Drop `reason` from health payload. Keep only `state`.

### `[ ]` R4-FG-41 (M) — `/api/public/stats` leaks `OPERATOR_WITHDRAW_ADDRESS`
**Closes:** P7-006.
**Bug:** Public stats returns `operatorWithdrawAddress`. Internal config field — its purpose is to lock operator withdrawals. Publishing it focuses social-engineering / key-recovery attacks.
**Fix:** Remove from public stats (or hash if disclosure is desired for trust).

### `[ ]` R4-FG-42 (M) — Force-release lacks Idempotency-Key requirement
**Closes:** P7-009.
**Bug:** Lambda timeout mid-handler + operator retry: handler succeeded mutation but failed audit before timeout, retry runs `applyForceRelease` again on still-unresolved entry that timed-out Lambda never marked. Idempotency-Key would short-circuit retry to cached outcome.
**Fix:** Mandate `Idempotency-Key`, wrap in `withIdempotency('force-release:${id}', key, ...)` mirroring refund/withdraw-fees.

### `[ ]` R4-FG-43 (M) — `/api/admin/replay-deposit` lacks Idempotency-Key requirement
**Closes:** P7-003.
**Bug:** R3-FG-41 mandated for refund + withdraw-fees. replay-deposit also re-credits real funds but only relies on internal txId-based dedup. Two concurrent admin clicks racing the SET-NX inside replayDeposit; loser returns 409, but if winner's Lambda times out post-SET-NX-release, second click re-processes.
**Fix:** Add header gate + `withIdempotency('admin-replay:${transactionId}', key, ...)`.

### `[ ]` R4-FG-44 (M) — Admin write routes don't bind rate-limit to accountId
**Closes:** P7-001.
**Bug:** R3-FG-39 (killswitch) + force-release bind rate-limit to `auth.accountId`. Other admin write routes (refund, replay-deposit, withdraw-fees, reconcile, migrate-schema) call `checkRateLimit` BEFORE `requireTier` and fall back to `identityFor(request)` (first 16 chars of bearer). Admin who rotates session tokens gets fresh bucket per rotation, blowing past the documented per-account cap. Refund route is `limit:10/min` and replay-deposit `limit:10/min` — both move real money.
**Fix:** Move every admin route's `checkRateLimit` AFTER `requireTier` and pass `identity: auth.accountId`.

### `[ ]` R4-FG-45 (M) — Cron rate-limit bucket falls back to bearer prefix `Bearer CRON_SECRET`
**Closes:** P7-010.
**Bug:** R3-FG-63 removed `identity:'cron'` so bucket falls back to `identityFor(request)` — first 16 chars of bearer. `Authorization: Bearer $CRON_SECRET` means EVERY call shares same prefix bucket. The R3-FG-63 fix claimed "buckets by source IP" but `identityFor` checks Bearer BEFORE x-forwarded-for. Same global-bucket problem the fix claimed to address.
**Fix:** When CRON_SECRET succeeds, explicitly compute identity from `xff?.split(',')[0]`.

### `[ ]` R4-FG-46 (M) — `/api/admin/audit` + `/api/user/audit` no per-fetch timeout
**Closes:** P7-011.
**Bug:** R3-FG-42 added timeout to monitoring; both audit endpoints' pagination fetches still no timeout. Slowloris mirror response wedges Lambda for 60s per page. Any logged-in session can sustain N concurrent paginated audit calls and exhaust function concurrency.
**Fix:** Wrap fetches with `AbortSignal.timeout(8000)`. Also add max-page guard (the loop runs until `data.links?.next` is null).

### `[ ]` R4-FG-47 (M) — TOCTOU on killswitch idempotent flip
**Closes:** P9-010.
**Bug:** R3-FG-39 reads `existing.enabled` then acts. Two concurrent POSTs both see `existing.enabled === false`, both pass the check, both call `enableKillSwitch` → both emit HCS anchors. Rate limit blunts but doesn't prevent within boundary. The "idempotent flip" is documentation-only.
**Fix:** SET-NX-EX on `KILL_KEY` inside `enableKillSwitch`; if already set, short-circuit before HCS submit.

### `[ ]` R4-FG-48 (M) — R3-FG-43 boot validation only fires when NODE_ENV=production
**Closes:** P9-008.
**Bug:** Validation gated on `NODE_ENV === 'production'`. If NODE_ENV is unset / set to `preview` / `development`, boot validation no-ops AND `getAudience()` silently testnet-fallbacks. Vercel sets NODE_ENV=production for production AND preview, but a misconfigured serverless deploy outside Vercel (CLI mode, custom Lambda, Render, Fly) without explicit NODE_ENV ships with testnet audience.
**Fix:** Move the `AUTH_PAGE_ORIGIN` requirement OUT of `assertProductionRedis` INTO `getAudience()` itself. If `HEDERA_NETWORK === 'mainnet'` and audience env unset/testnet-shaped → throw — regardless of NODE_ENV.

### `[ ]` R4-FG-49 (M) — Reader phase 3 sort is O(n log n) where n = entire topic
**Closes:** P11-010.
**Bug:** `hcs20-reader.ts:566` resorts events that already arrived in mirror-node consensus order. With 1M topic messages, 200-500ms wasted on every audit page load + every monitoring cron.
**Fix:** Drop the sort. Add a debug assertion in tests.

### `[ ]` R4-FG-50 (M) — Verify-audit / monitoring full-topic walk has no hard cap
**Closes:** P11-002.
**Bug:** Four endpoints loop `while (nextPath)` pulling 100 messages/page into in-memory `allMessages` array, then `parseAuditTopic(allMessages)`. v2 emits ~7+ messages/play. At 1000 plays/day × 365 days = ~2.5M messages → ~2.5GB RSS. Vercel ceiling 1GB/3GB. Audit page 500s, monitoring panel returns nothing.
**Fix:** Add `since:ISODate` parameter to all four endpoints + `parseAuditTopic`, default `now - 90d`. Mirror node `?timestamp=gt:` filter. Audit page paginates by month.

### `[ ]` R4-FG-51 (M) — HCS topic message rate uncapped at producer side
**Closes:** P11-003.
**Bug:** `submitV2Message` does no batching, no retry on `BUSY`/`THROTTLED_AT_CONSENSUS`. At a campaign launch surge (10K users playing once on day 1) the agent emits 70K messages → Hedera node congestion → `submitV2Message` errors → playForUser dead-letters legitimate sessions as audit_trail_orphaned.
**Fix:** Wrap in `Bottleneck`-style limiter (e.g., 50 msg/s). Add retry-with-backoff on `BUSY`/`PLATFORM_NOT_ACTIVE`/`THROTTLED_AT_CONSENSUS`.

### `[ ]` R4-FG-52 (M) — Per-request Redis op count is 15-25 round trips
**Closes:** P11-004.
**Bug:** Single `multi_user_play` does ~15-25 Upstash REST hops. R3 added more (cluster-wide flag, escalation dedup, stamp-then-mutate refresh). At Upstash paid-tier 1000/s on a single hot Lambda, mainnet at 100 plays/min hits the limit. Each command ~30-100ms over REST.
**Fix:** Audit each route handler: fold `refreshUser` + `refreshOperator` + `refreshDeadLetters` into a single `redis.pipeline().get().get().lrange().exec()`. Move per-request rate-limit + session-fetch into one Lua EVAL.

### `[ ]` R4-FG-53 (M) — Idempotency keys at 24h TTL flood Upstash keyspace
**Closes:** P11-007.
**Bug:** Default 24h TTL on every play, withdraw, force-release, withdraw-fees etc. Mainnet 100 plays/min × 24h × 60 = 144K active keys at any time. 200K keys × ~200B = 40MB just for idempotency. Receipt-uncertain spikes retain claims for full 24h.
**Fix:** Drop default TTL to 1h for read-shaped operations, keep 24h only for irreversible-on-chain actions. Add `/api/health` field exposing `redis.dbSize()` + count of `lla:idem:*`.

### `[ ]` R4-FG-54 (M) — `seenAgentSeqByAgent` Map unbounded per-call
**Closes:** P11-006.
**Bug:** Reader builds `Map<string, Map<number, string[]>>` over EVERY agentSeq seen. Phase 3 sorts seqs O(n log n).
**Fix:** Replace with `Map<agent, {lastSeq, seenSet}>` for streaming check. Bound output arrays.

### `[ ]` R4-FG-55 (M) — `truncateError` byte-vs-codepoint UTF-8 split
**Closes:** P10-HCS-001 + P12-008.
**Bug:** `hcs20-v2.ts:366-370` truncates at byte boundary; can split mid-codepoint for non-ASCII errors. Resulting U+FFFD replacement chars re-encoded as 3 bytes each, possibly tipping back over 1024.
**Fix:** Codepoint-safe truncator (walk buffer backward to UTF-8 lead byte). Same fix needed for R3-FG-46's prize-symbol truncation.

### `[ ]` R4-FG-56 (M) — `agent-card.json` version hardcoded to '0.2.0' in fallback
**Closes:** P10-HOL-001.
**Bug:** `process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.npm_package_version ?? '0.2.0'`. Neither env reliably set at runtime on Vercel. Production has shipped at 0.3.4 but agent card advertises '0.2.0'. Other agents discovering us via HOL get stale version.
**Fix:** Wire build-time `package.json` version into `NEXT_PUBLIC_APP_VERSION` via `next.config` or import package.json directly.

### `[ ]` R4-FG-57 (M) — `agent-card.json` advertises `MULTI_AGENT_COORDINATION` capability not implemented
**Closes:** P10-HOL-002.
**Bug:** Capabilities list claims `MULTI_AGENT_COORDINATION` and `WORKFLOW_AUTOMATION` but agent has no negotiation/coordination surface beyond `NegotiationHandler` (best-effort, undocumented).
**Fix:** Remove from capabilities or back with skill entries.

### `[ ]` R4-FG-58 (M) — `recordRefund` reader has no `(originalDepositTxId, refundTxId)` dedup
**Closes:** P3-DRR-002 + P12-011.
**Bug:** F18 added `withdrawTxId` reader-dedup for burns. Refund ops carry `originalDepositTxId` + `refundTxId` but reader doesn't dedup on either. Verifier-side `recordRefund` retry after partial failure (Lambda freeze post-submit-pre-stamp) emits SECOND refund anchor → reader sums `rakeReversed` twice → operator balance reconstruction shows DOUBLE rake reversal vs actual.
**Fix:** Add reader-side dedup on `(op:'refund', refundTxId)` tuple. Same shape as F18.

### `[ ]` R4-FG-59 (M) — Verify-audit doesn't track duplicate `originalDepositTxId` across refund events
**Closes:** P12-011.
**Bug:** `verify-audit.ts` collects `depositTxIds` and `burnTxIds` but doesn't track `originalDepositTxId` from refund events. Two refund anchors referencing same `originalDepositTxId` BOTH credit `totalRefunded` for the user, double-debiting reconstructed balance.
**Fix:** Add `seenRefundedOriginals: Set<string>` mirroring `seenWithdrawTxIdsByKind`.

### `[ ]` R4-FG-60 (M) — `verify-audit` ignores `strategy_change` events; can't validate "strategy active at session N"
**Closes:** P12-003.
**Bug:** `AccountingService.recordStrategyChange` writes a v2 anchor; reader normalizes; but `verify-audit.ts` has zero references to `strategy_change`. Documented intent in code comments not implemented.
**Fix:** Add `strategyHistory` map to verify-audit, walk strategy_change events in seq order. Cross-reference each session's `strategy` field on open against most-recent strategy_change.

### `[ ]` R4-FG-61 (M) — Documentation contradicts runtime tier on 3 routes
**Closes:** P4-001.
**Bug:** `force-release/route.ts:11` says "operator tier" but checks admin (R3-FG-40 downgrade). Same docblock-vs-runtime mismatch on `refund/route.ts:8` and `reconcile/route.ts:7`.
**Fix:** Update all three docblocks to "admin tier (closes R3-FG-40)".

### `[ ]` R4-FG-62 (M) — Replay-deposit hides creditDeposit's R3-FG-6 escalation behind `not_credited`
**Closes:** P4-003.
**Bug:** R3-FG-6's flush-failure throw bubbles to route as 500. Operator clicks "Retry" → `isTransactionProcessed` short-circuits → `not_credited`. Admin UI never sees the page event.
**Fix:** In replayDeposit, catch flush-failure escalation explicitly and return new discriminator `{kind:'partial_credit'; status:'flush_failed_paged'}`.

### `[ ]` R4-FG-63 (M) — Hardcoded `0.000000082` HBAR/gas mis-estimates `untrackedFeesHbar`
**Closes:** P10-HED-002.
**Bug:** `contracts.ts:111,153`. Hedera mainnet gas pricing varies. Underestimating tracked = solvent agents read insolvent. Overestimating = real fee-drain shortfall doesn't get explained.
**Fix:** Replace constant with actual `receipt.transactionFee` from `awaitReceipt`.

### `[ ]` R4-FG-64 (M) — Escalation 6h dedup swallows real second-cause pages
**Closes:** P2-006.
**Bug:** R3-FG-48 keys dedup on `${kind}:${uncertainTxId}` with 6h TTL. Single uncertainTxId can legitimately hit MULTIPLE escalation reasons within 6h: malformed-DL threshold (page #1) → user-lock contention threshold (page #2) → SADD failure (page #3). All three share the same `(kind, uncertainTxId)` if kind collapses (kind is `audit_trail_orphaned` for several). Only first page fires.
**Fix:** Include cause-class hash: `${kind}:${uncertainTxId}:${causeFingerprint}`.

---

## Phase R4-4 — Low (~26 items)

### `[ ]` R4-FG-65 (L) — `idempotency.ts` `withIdempotency` claim release uses unfenced DEL
**Closes:** P2-011. Same fence pattern as F25/F26.

### `[ ]` R4-FG-66 (L) — Reconcile cron 900s TTL has no heartbeat
**Closes:** P2-012. Add PEXPIRE every 60s.

### `[ ]` R4-FG-67 (L) — registerUser flush guarantees nothing about sibling Lambda freshness
**Closes:** P6-005. Add `await store.refreshUserIndex()` at top of pollOnce.

### `[ ]` R4-FG-68 (L) — recoverStuckPrizes refresh-after-tx still drops concurrent DLs written DURING refresh
**Closes:** P6-006. Hold per-user lock through entire recovery; use contract-tx consensus_timestamp for filtering.

### `[ ]` R4-FG-69 (L) — Slimmed v2 messages have no `slimmed: true` flag
**Closes:** P12-008. Add for evidentiary completeness.

### `[ ]` R4-FG-70 (L) — Half-deposit-anchor (mint without paired rake) silently misallocates 1%
**Closes:** P12-006. Folded into R4-FG-5 (atomic deposit+rake).

### `[ ]` R4-FG-71 (L) — `loadStrategy(name)` accepts arbitrary file paths from caller
**Closes:** P10-STRAT-002. Require `--strategy-file` flag for arbitrary paths.

### `[ ]` R4-FG-72 (L) — `verifyChallenge` accepts any `sigPair[0]` regardless of count
**Closes:** P10-AUTH-002. Assert `sigMap.sigPair.length === 1`.

### `[ ]` R4-FG-73 (L) — `audit-deposit-discrepancy.ts` filters strictly on `op:'mint'`
**Closes:** P10-SCRIPT-002. Future-fragility — v2 schema additions break the script.

### `[ ]` R4-FG-74 (L) — `console.warn` in `session.ts` logs raw error objects from Redis ops
**Closes:** P10-LOG-001. Stringify with `e.message` only.

### `[ ]` R4-FG-75 (L) — `console.warn` in recover-stuck-prizes prints `agentState.pendingPrizes` breakdown
**Closes:** P10-LOG-002. Gate behind `--verbose`.

### `[ ]` R4-FG-76 (L) — `loadStrategy` reads from disk synchronously inside Lambda
**Closes:** P10-BUILD-001. Make fallback warn loudly when built-in name file exists but failed to parse.

### `[ ]` R4-FG-77 (L) — `truncateError` byte-vs-codepoint already covered by R4-FG-55
[merged]

### `[ ]` R4-FG-78 (L) — In-flight session boundary flap (R2-FG-18 stale)
[deferred]

### `[ ]` R4-FG-79 (L) — Replay tooling can't tell which writer's params to honor for orphans
[deferred]

### `[ ]` R4-FG-80 (L) — `validateProgressOrdering` doesn't validate ISO-8601 timestamp format
[unreachable — reverted in R3-FG-3]

### `[ ]` R4-FG-81 (L) — Concurrent self-heal back-fills DIFFERENT timestamps
[unreachable — reverted in R3-FG-3]

### `[ ]` R4-FG-82 (L) — Cron webhook fire-and-forget no AbortSignal
[closed in R3-FG-79]

### `[ ]` R4-FG-83 (L) — Verify-audit cross-check cache no LRU
**Closes:** P11-008. Process txIds in batches of 500, drop cached promises after batch.

### `[ ]` R4-FG-84 (L) — `frontend session tokens in localStorage; no CSP header`
[deferred — same as R3-FG-45 / D-2]

### `[ ]` R4-FG-85 (L) — `parseAuditTopic` unbounded session reconstruction memory
[folded into R4-FG-50]

---

## Deferred (~10 items, design-decisions or scope creep)

- **D-13**: F4 escalate-on-incoherent has no recovery path; admin endpoint for clearing wedged markers needed (R3-FG-55 was deferred; this elevates it to design priority post-R3-FG-3 revert).
- **D-14**: Reader-side dedup migration for F18-style burn dedup → all event types (changes consumer contract).
- **D-15**: HCS-20 v3 `play_session_pools_batched` op (drops 5-pool plays from 7 messages to 3; needs dApp coordination).
- **D-16**: Streaming `parseAuditTopic` variant with windowed time filter (cross-cuts the four audit endpoints + verify-audit).
- **D-17**: Move idempotency claim VALUE to a fence (UUID); release via RELEASE_SCRIPT (touches every withIdempotency caller).
- **D-18**: `recordControlEvent` accepts `signal?: AbortSignal`; thread through to Hedera SDK (touches every accounting writer).
- **D-19**: Deposit watcher unknown-token max-attempts (R4-FG-20) refactor to track per-tx attempts in Redis with promotion-to-DL — requires new Redis namespace.
- **D-20**: `RedisStore` MAX_RECORDS enforcement + prune cron — requires data migration story.
- **D-21**: Move session tokens off localStorage (R3-FG-45 deferred) — frontend rewrite.
- **D-22**: Strict CSP header — touches every page; must allow WalletConnect origins.

---

## Plan-of-record decisions for the implementation phase

1. **R4-1 commit** bundles the 5 critical items. R4-FG-1 + R4-FG-2 are the same R3-FG-58 archetype (refresh-then-spread missed siblings); R4-FG-3 + R4-FG-4 are R3-FG-7/11 SADD lifecycle gaps; R4-FG-5 is the conservation breach.
2. **R4-2 commit** the 26 high items. The major themes: missing test discipline (R4-FG-31 is itself a meta-fix bundling 11+ test additions), partial-sibling closures (R4-FG-6/13/14/26/27/28), unfenced locks/TTL races (R4-FG-8/9/10), scale cliffs (R4-FG-16/20/21), schema invariants (R4-FG-22/23/24).
3. **R4-3 commit** the 28 medium items split across 2 phases by domain.
4. **R4-4 commit** the 26 low items, many 1-3 line surgical changes batchable.

## Open questions for the user

1. **All ~85 items in scope**, or any to prune? (Round 3 was "all 82" — same expectation here?)
2. **Phase grouping** — R4-1/2/3/4 above, or different?
3. **R4-FG-23 / R4-FG-24** (Merkle root + aborted Merkle root) — these are HCS-20 v2 wire-schema changes that also touch the reader. Ship as a coordinated reader+writer change in R4-1, or defer to a v3 of the schema along with D-15?
4. **R4-FG-22 strategy schema NaN/Infinity** — Zod refinements add coverage, but should we ALSO version-bump the strategy schema and migrate existing user records? (Defensive vs migrating pre-existing junk.)
5. **CI guard for revert-proof tests** — Round 3 user agreed to this discipline; the R4-FG-31 cluster shows it didn't stick. Should we add a CI check that REJECTS any new `it()` block in test files unless the file or commit message contains a `revert-proof:` comment? More extreme: a static analysis that catches the "mock plumbing changed but assertion didn't" pattern.
