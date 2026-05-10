# Round-5 Adversarial Audit — Findings + Triage

**Date:** 2026-05-09 (round 5)
**Branch:** `testnet`
**Scope:** Re-verify R1+R2+R3+R4 closures (~210 fixes) + scrutinize R4's NEW code surface (Merkle binding fallback at `hcs20-reader.ts`, fenced idempotency at `idempotency.ts`, lock heartbeat at `locks.ts`, kill-switch SET-NX-EX gate at `killswitch.ts`, refund SREM at `refund.ts`, agentSeq seed-fail TTL clear at `AccountingService.ts`, mintAuditOrphanId at `orphanIds.ts`).

**Methodology:** 12 background agents, one persona each:
1. P1 — R4 regression hunter
2. P2 — Concurrency / cross-Lambda atomicity
3. P3 — Double-X re-verify
4. P4 — Integration boundary
5. P5 — State-machine walker
6. P6 — Self-heal critic
7. P7 — API surface
8. P8 — Test-quality auditor (R2-FG-0 archetype, fourth recurrence)
9. P9 — Closure verifier (R1+R2+R3+R4)
10. P10 — Blind-spot agent
11. P11 — Perf / scalability
12. P12 — Audit-trail completeness + conservation invariants

**Raw count:** ~165 findings across 12 personas. Deduplicated to ~95 unique items below.

The dominant theme this round: **R4's helpers were correct in isolation but applied unevenly**.
- `mintAuditOrphanId` (R4-FG-27/28) exists but ~10 sites still use unsalted literals.
- `mutationError` gate (R4-FG-6) landed in 3 of 4 verifier SUCCESS branches.
- Fenced compare-and-DEL (R4-FG-65) landed in `idempotency.ts` but `refund.ts`'s claim DEL is still unfenced.
- `startOperatorLockHeartbeat` (R4-FG-66) is wired to reconcile but not to refund / recover-stuck-prizes / force-release.
- `Idempotency-Key` requirement (R4-FG-43) has no test, no docs entry, no CORS allow-list.
- Merkle binding (R4-FG-23/24) ships without a doc update or cutover marker — external auditors using `docs/hcs20-v2-schema.md` as the spec compute different roots.

The other dominant theme: **R4 introduced new surface, and the new surface introduced new bugs**.
- The slim-fallback for oversized pool messages (R3-FG-46) **breaks** the Merkle root that R4-FG-23 binds (writer hashes pre-slim, reader hashes post-slim).
- The fenced idempotency catch DELs the claim on **non**-`ReceiptUncertainError` post-submit throws → double-spend window.
- The kill-switch SET-NX has no `ex` TTL → flag is permanent → second engagement silently no-ops.
- The agentSeq seed-fail TTL clear bypasses re-seed → INCR runs against a stale counter → topic agentSeq goes to 0.
- The heartbeat's mock test fixture does not match real Upstash eval — silent no-op in CLI/tests.

---

## Phase R5-1 — Critical (15 items)

### `[ ]` R5-FG-1 (C) — Pool-message slim path corrupts the Merkle root the writer signed
**Closes:** P4-001 (R3-FG-46 ↔ R4-FG-23 collision).
**Bug:** `AccountingService.recordPlayPoolResult` (`src/custodial/AccountingService.ts:780-811`) silently truncates `prizes[].sym` to 8 chars when the message exceeds 900 bytes. The writer in `MultiUserAgent.playForUser` (`src/custodial/MultiUserAgent.ts:976-989`) computes `poolsRoot` over the FULL untruncated prize list. The reader (`hcs20-reader.ts:783-797`) recomputes from the wire-format prize list (truncated). `canonicalizePrizes` (`hcs20-v2.ts:404-419`) hashes `sym` — so the two roots disagree. **Any pool with NFT symbol > 8 chars (campaign-launch branded prizes) silently corrupts the audit trail.** R4-FG-69 added the `slim:1` flag but the reader does not branch on it.
**Fix:** Either (a) compute `poolsRoot` from the post-slim wire shape (writer mutates the prize tuple before hashing), OR (b) drop `sym` from the canonical hash input — `sym` is display metadata, not load-bearing for tamper-evidence. Option (b) is the cleaner contract.
**Test:** Session with NFT prize whose symbol exceeds 8 chars survives `recordPlayPoolResult` slim and reader marks `closed_success`.

### `[ ]` R5-FG-2 (C) — Merkle legacy fallback has no cutover; bound writes can be replayed as legacy
**Closes:** P1-004, P3-005, P4-010, P6-005.
**Bug:** `hcs20-reader.ts:790-823` tries `computePoolsRoot(pools, binding)` first; on mismatch falls back to `computePoolsRoot(pools)` (legacy unbound) and accepts with a `legacy_merkle_binding` warning. There is NO cutover timestamp. An attacker who can write topic messages (operator-key compromise — the explicit threat model for tamper-evidence) crafts a `play_session_close` for arbitrary historical poolsets using the legacy unbound form: bound check fails, legacy succeeds, `usedLegacy=true`, status becomes `closed_success` with a buried warning. R4-FG-23's protection is opt-out for the attacker forever. `verify-audit.ts` does not promote the warning to an alert (P1-010 / P12-307). Same hole for aborted (P1-004/24 fallback).
**Fix:** Read `LEGACY_MERKLE_CUTOFF_TIMESTAMP` env (the R4-FG-23 deploy time). For sessions with consensus_timestamp > cutoff, refuse the legacy fallback — promote to `corrupt`. Also: surface `legacy_merkle_binding` / `legacy_abort_no_merkle` as critical alerts in `verify-audit.ts`.
**Test:** Post-cutover close with legacy unbound root → status='corrupt'.

### `[ ]` R5-FG-3 (C) — `withIdempotency` catch DELs claim on non-ReceiptUncertainError post-submit throws → double-spend
**Closes:** P2-001 + P3-002 (corroborated by Regime-A SDK-internal-retries hazard).
**Bug:** `src/lib/idempotency.ts:142-173` only treats `PreserveClaimError` (concretely `ReceiptUncertainError`) as "keep claim". Every OTHER error thrown by the body — including raw SDK errors emitted AFTER `tx.execute()` returns successfully but before `awaitReceipt` wraps the timeout (signer disposed, network reset mid-fetch, V8 OOM), AND post-internal-retry errors that the SDK rejected to JS as a non-receipt-uncertain shape — falls through to the RELEASE_SCRIPT compare-and-DEL. The on-chain submit may have landed; the claim is gone; client retries with the same `Idempotency-Key` see a fresh SET-NX win and re-execute. `transfers.ts` only wraps `awaitReceipt` in `ReceiptUncertainError`, leaving the gap from `submit` until `awaitReceipt` is invoked exposed.
**Fix:** Wrap the entire `submit + awaitReceipt` pair in a try whose catch lifts ANY post-submit error to `PreserveClaimError`. Document and enforce the contract: every helper that does `tx.execute()` MUST throw a PreserveClaim-flavored error if execute() returned.
**Test:** stub `processWithdrawal` to call `submit()` then throw vanilla `Error` (not `ReceiptUncertainError`); assert claim survives.

### `[ ]` R5-FG-4 (C) — `drainPendingLedgerAdjustments` double-applies entry under concurrent drain
**Closes:** P3-001 + P5-RU-003.
**Bug:** `src/custodial/pendingLedger.ts:268-380`. Two concurrent drain passes (eager drain inside `withUserLock` for user A on Lambda A, periodic reconcile drain on Lambda B) both `lrange(LIST_KEY, 0, -1)` and capture overlapping snapshots. Each pass acquires the per-user lock, applies the debit + rake reversal, then `lrem`s. The Redis user lock is RELEASED between A's apply and B's acquire. B's `rawEntries` still contains the row A just lrem'd (B's lrange pre-dates A's lrem) → B re-applies → `available -= amount` runs **twice**, `op.balances[token] -= rakeAmount` runs **twice**. R4-FG-13 fixed only the rake leg shape; concurrency was untouched.
**Fix:** Use Redis `LMPOP` (atomic pop) to claim each row before mutation, OR `SET-NX` a per-`(userId, sourceTx)` claim key inside the lock body before applying (matches the F18/refund SADD pattern). The `lrem` becomes belt-and-braces.
**Test:** Two simulated drain passes against the same queue; assert applied total == entries.length, not 2×.

### `[ ]` R5-FG-5 (C) — `nextAgentSeq` Redis-flag-clear bypasses re-seed → INCR against stale counter → topic corrupt
**Closes:** P2-005.
**Bug:** `src/custodial/AccountingService.ts:659-666` clears both `agentSeqSeedFailed` AND `agentSeqInitPromises` when Redis says the flag has TTL'd out, then immediately calls `if (this.store) return await this.store.nextAgentSeq(agentAccountId)`. The freshly-cleared init promise is NOT awaited; INCR runs against the cluster Redis counter which was last seeded who knows when (possibly never, since seed previously failed). Result: counter at 0, agent emits `agentSeq=0` for a topic where the highest existing v2 message has `agentSeq=147` → reader marks `corrupt`, breaking the audit-topic invariant.
**Fix:** After `agentSeqInitPromises.delete(...)`, immediately `await this.initializeAgentSeq(agentAccountId)` BEFORE falling through to INCR.
**Test:** "agentSeq seed-fail TTL expiry: next nextAgentSeq invocation re-seeds via mirror scan before INCR".

### `[ ]` R5-FG-6 (C) — Killswitch double-fault leaves Redis engaged with no audit trail and no retry path
**Closes:** P2-003 + P12-304.
**Bug:** `src/lib/killswitch.ts:218-296`. R4-FG-47's atomic SET-NX flips Redis BEFORE the HCS anchor write. If the anchor times out AND the orphan-write fails (Redis throttle on the same outage) AND the escalation webhook also fails (all caught with empty `catch {}`), Redis is engaged (rejecting plays) and the topic + DL queue have NO record. Operator dashboard reads `getKillSwitchState` and shows `enabled:true` — looks fine. To an external auditor reconstructing from HCS, the agent silently stopped accepting plays for hours with zero evidence. Worse: SET-NX has no `ex` TTL (R4-FG-47 comment claims "SET NX EX" but code is `{nx:true}` only — see R5-FG-7 below); subsequent `enableKillSwitch` short-circuits at the SET-NX → no path to retry the anchor.
**Fix:** When BOTH anchor AND orphan-write fail, REVERT the SET-NX (DEL the kill key) and rethrow — better to fail loudly. OR persist a minimal anchor-pending marker in a separate Redis key that a reconcile job replays (R5-FG-9 followup).
**Test:** "enableKillSwitch with anchor failure + DL-write failure throws and reverts the Redis flag".

### `[ ]` R5-FG-7 (C) — Killswitch SET-NX has no TTL; permanent flag with no auto-expiry
**Closes:** P1-009.
**Bug:** `src/lib/killswitch.ts:224` is `redis.set(KILL_KEY, ..., { nx: true })` — NO `ex`. The comment at line 197 claims "atomic SET NX EX" but the code is missing the EX. Once flipped, the kill flag is permanent until an explicit `disableKillSwitch` succeeds. A future operator engaging again with a NEW reason silently no-ops at line 225 (returns 'kill switch already engaged') — second engagement reason+by is LOST from Redis AND the topic.
**Fix:** Either (a) add `ex: 24*60*60` so engagements auto-expire daily and operator must re-engage, OR (b) on `claimed === null`, fall through to read existing state and write a `killswitch_re_engaged` audit anchor with the new reason/by.
**Test:** "second enable after stuck flag emits audit anchor".

### `[ ]` R5-FG-8 (C) — `play_uncertain` verifier SUCCESS resolve-write spreads `...entry` (R4-FG-1 sibling miss)
**Closes:** P1-001 + P5-PU-001 (corroborated by P9-004).
**Bug:** `src/custodial/uncertainTxVerification.ts:1781` does `await store.upsertDeadLetter({ ...entry, details: {...entry.details, successTriagedAt}, resolvedAt, resolvedBy, resolutionTxId })` — spreading the verifier-loop pre-mutation snapshot. R4-FG-1 fixed `markResolved` and R4-FG-2 fixed `bumpUserLockContentionAttempts` for exactly this archetype; this site was overlooked. A concurrent force-release that wrote a top-level field between loop entry and this write has its mutation REVERTED.
**Fix:** Refresh-then-spread: `await store.refreshDeadLetters(); const fresh = store.getDeadLetters().find(e => e.transactionId === entry.transactionId); if (fresh?.resolvedAt) return; await upsertDeadLetter({ ...fresh, ... })`. Same fix needed at `refund.ts:1542`, `:1679`, `:1303` (P1-002), and 4 stamp helpers in `force-release/handlers.ts:250,446,707,858` (P9-004).
**Test:** "PU verifier SUCCESS preserves a sibling writer's top-level mutation".

### `[ ]` R5-FG-9 (C) — WU verifier SUCCESS audit-anchor failure not gated by `mutationError` (R4-FG-6 sibling miss)
**Closes:** P5-WU-001.
**Bug:** `src/custodial/uncertainTxVerification.ts:1051-1077`. R3-FG-8 + R4-FG-6 introduced `mutationError` to gate `markResolved`. The catch block tracks settle/total/history failures only; the audit-anchor catch writes `recordAuditOrphan` but **never assigns `mutationError`**. Control falls through past `if (mutationError)` and runs `markResolved`. After this: local state has `settledAt/totalWithdrawnAt/historyWrittenAt` set but `auditWrittenAt` UNSET; `resolvedAt` set; topic state has NO burn anchor. Topic-only auditor reconstructs balance with deposit but no withdrawal; no retry path.
**Fix:** In the catch at 1051, set `mutationError = { phase: 'audit_anchor', cause: auditErr }` after writing the orphan.
**Test:** "WU verifier audit-anchor failure leaves entry unresolved".

### `[ ]` R5-FG-10 (C) — Force-release `handleOperatorFee` SUCCESS doesn't acquire `withdraw-fees` operator-lock (R3-FG-12 sibling miss)
**Closes:** P5-OFW-001 + P9-002.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:458-481`. R3-FG-12 added `acquireOperatorLock('withdraw-fees', 60)` around the verifier's operator-balance RMW; R4-FG-12 fixed the null-acquire branch. The force-release sibling for the SAME mutation acquires NO operator-lock. A concurrent in-band `operatorWithdrawFees` on a DIFFERENT token RMW races the force-release's debit on `op.balances` — the very race R3-FG-12 prevented.
**Fix:** Wrap handler's debit block in `acquireOperatorLock('withdraw-fees', 60)` + finally release. On null acquire, return `{ok:false, status:409, error:'withdraw-fees lock contention; retry'}`. Mirror the verifier's contract exactly.
**Test:** "force-release operator-fee SUCCESS contends with concurrent withdraw-fees on different token".

### `[ ]` R5-FG-11 (C) — `/api/public/stats` leaks killswitch operator reason to anonymous callers (R4-FG-40 sibling miss)
**Closes:** P7-001.
**Bug:** `app/api/public/stats/route.ts:113` — `statusReason: killState.enabled ? (killState.reason ?? null) : null`. R4-FG-40 dropped `reason` from `/api/health` precisely because anonymous polling could read the operator's free-text incident description verbatim. R4-FG-41 trimmed `OPERATOR_WITHDRAW_ADDRESS` from this same route. `statusReason` was missed. `Cache-Control: public, max-age=15, s-maxage=30` (line 120) means CDN amplifies the leak.
**Fix:** Remove `statusReason` from the public payload. Surface only in admin-tier endpoints.
**Test:** Snapshot test asserting `statusReason` and `reason` absent from `/api/public/stats`.

### `[ ]` R5-FG-12 (C) — `refundedOriginals` SREM has no self-heal; failure leaves permanent ban
**Closes:** P6-001.
**Bug:** R4-FG-3's SREM at `src/hedera/refund.ts:687-698` logs `refunded_originals_srem_failed` but does NOT escalate, does NOT write a dead-letter, does NOT retry. If the SREM throws (Redis blip mid-recovery), the per-tx claim is DEL'd but `refundedOriginals` still contains the txId → next legitimate retry hits `sismember=1` → permanent ban. The exact bug R4-FG-3 was supposed to close, just rarer (requires SREM to fail). Pure logging is not recovery.
**Fix:** (a) Reorder SREM to land AFTER the per-tx claim DEL — if both fail the operator has the lock as forensic anchor. (b) On SREM failure, write `audit_trail_orphaned` + `escalateUncertainDlFailure({kind:'refunded_originals_srem_failed'})`. Add a verifier-side SREM-retry that walks DLs of this kind.
**Test:** "SREM failure during Regime-A is enqueued for retry; reconcile self-heals next pass".

### `[ ]` R5-FG-13 (C) — `agentSeq` re-init has no exponential backoff → fan-out attack against degraded mirror
**Closes:** P6-002.
**Bug:** `src/custodial/AccountingService.ts:659-666`. When Redis says the seed-fail flag has TTL'd out, the fix `delete`s both `agentSeqSeedFailed` AND `agentSeqInitPromises`. Next `nextAgentSeq` call → `initializeAgentSeq` → mirror scan with 4 retries × delays = ~4.2s. If mirror is still degraded, terminal failure → re-flag both Redis (10min TTL) and local Set. ~10 minutes later flag TTLs out → next call re-runs the 4.2s scan. Each warm Lambda burns 4.2s of mirror calls every 10 minutes for the entire degradation window. Multiply by N warm Lambdas: a single bad mirror cycle becomes a fan-out DoS against the mirror itself, prolonging the degradation.
**Fix:** Track `lastSeedFailureAt` per-agent in Redis; refuse re-init if last failure was within an exponential window (10min → 20min → 40min, capped at 1h). Surface via health endpoint as `seed_recovery_pending`.
**Test:** "agentSeq re-init backs off after sequential failures".

### `[ ]` R5-FG-14 (C) — `recordRake` has no `originalDepositTxId` field; conservation invariant unprovable on topic
**Closes:** P12-301 + P1-011.
**Bug:** `src/custodial/AccountingService.ts:221-237` emits `recordRake` with `memo:'rake'` only. The companion `recordDeposit` carries `memo:'deposit:<txId>'`. There is NO `originalDepositTxId` field on the rake message. Conservation invariant 1 ("every mint with rakePercent>0 has a paired rake transfer") is unprovable on the topic alone. A topic-only auditor can compute aggregate rake but can't say "this $1000 deposit had no rake — investigate". R4-FG-5 fixed the in-band escalation; the topic cross-check that would detect a missing rake (legacy half-anchor pre-fix, or future writer regression) is impossible without pairing.
**Fix:** Add `depositTxId` field to `recordRake` body. Add a verify-audit cross-check: every mint with `rakeAmount > 0` must have a paired rake transfer with matching `depositTxId`.
**Test:** "rake event missing depositTxId is flagged as critical alert in verify-audit".

### `[ ]` R5-FG-15 (C) — `docs/hcs20-v2-schema.md` does not reflect R4-FG-23/24 wire changes; external auditors mark every session corrupt
**Closes:** P10-DOC-001.
**Bug:** R4-FG-23 prepends `bv:1|${sessionId}|${user}|${agent}` line to the Merkle hash input (`hcs20-v2.ts:393`). R4-FG-24 added optional `poolsRoot` to `play_session_aborted`. Neither change is documented in `docs/hcs20-v2-schema.md` "poolsRoot derivation" (steps 1-8 still match the pre-R4 algorithm). An external auditor implementing the spec verbatim computes a DIFFERENT root than the writer and flags every legitimate session as `corrupt`. This violates CLAUDE.md's "external auditors can reconstruct from the topic alone" guarantee. User memory rule "docs are the spec" is inverted here — code shipped ahead of doc.
**Fix:** Update the schema doc to: (1) add a "binding line" prefix step to `poolsRoot derivation`, (2) document `bv:1` version stamp, (3) document `poolsRoot` optionality on aborted with `legacy_abort_no_merkle` semantics. Cross-link from CHANGELOG.

---

## Phase R5-2 — High (~32 items)

### `[ ]` R5-FG-16 (H) — Refund verifier SUCCESS resolves even when audit-anchor failed (R4-FG-6 archetype not applied to refund)
**Closes:** P5-RU-001 + P1-002 (resolve-write spreads).
**Bug:** `src/hedera/refund.ts:1552-1597, 1678-1696`. R4-FG-14 added orphan + escalation on audit-anchor failure but did NOT add a `mutationError` gate. The catch logs CRITICAL, writes orphan, escalates, falls through to claim-overwrite + SADD + flush + unconditional `upsertDeadLetter({...entry, resolvedAt, resolvedBy:'reconcile', resolutionTxId})`. Outcome: ledger debited, rake reversed, but topic missing the refund anchor → resolve fires → topic-only reconstruction shows phantom user credit. R4-FG-6 patched 3 of 4 verifiers; refund is the 4th sibling miss.
**Fix:** Introduce `let refundMutationError`; set in audit-anchor catch; gate the resolve-write at 1678 on `!refundMutationError`. Also gate on ledger-debit failure (currently logged + swallowed).

### `[ ]` R5-FG-17 (H) — Force-release `handlePlay` SUCCESS asymmetric with verifier (R4-FG-6 sibling)
**Closes:** P5-PU-002.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:669-719`. Verifier (R4-FG-6 patched): on triage-anchor failure, set `playMutationError`, skip resolve. Force-release `handlePlay` SUCCESS: anchor catch writes orphan, then UNCONDITIONALLY proceeds to stamp `successTriagedAt` and returns `ok:true`. Route's resolve-write fires unconditionally. Outcome: entry resolved with `successTriagedAt` set but topic has NO `play_uncertain_success_pending_triage` anchor. F15 gate refuses any future re-trigger. Topic-only auditor sees user pre-play balance + operator wallet short; no manual-triage anchor; no path back. Force-release anchor-failure does NOT call `escalateUncertainDlFailure` either.
**Fix:** Return a discriminated outcome from `handlePlay` indicating anchor failure; route gates resolve on `!result.partialMutation`. Add `escalateUncertainDlFailure` to the catch.

### `[ ]` R5-FG-18 (H) — Force-release `handleOperatorFee` FAILED with no `pendingClaimFence` skips legacy-DL release (R4-FG-33 sibling miss)
**Closes:** P5-OFW-002.
**Bug:** `handlers.ts:406-431`. R4-FG-33 added a legacy-DL fallback `redis.del(pendingKey)` to the VERIFIER's FAILED branch but the FORCE-RELEASE FAILED branch only releases when fence is present. Legacy DLs hit force-release: handler returns `ok:true` "operator state untouched", route resolves, pending claim sits with full 30-min TTL blocking concurrent operator-fee withdrawals. Operators trained to manually `redis.del` the claim → standing runbook becomes a double-pay vector.
**Fix:** Mirror the verifier's R4-FG-33 fallback in the handler — on missing fence + FAILED, force-DEL the pending-claim key with a loud warn.

### `[ ]` R5-FG-19 (H) — Force-release route SUCCESS triage anchor + resolve write produces topic anchor without ledger guarantee
**Closes:** R4-FG-32 (deferred → re-opened) + P9-001.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:386-403,491-498`. The resolve-write at "step 3" ALWAYS happens regardless of step 2 (`recordControlEvent('force_release')`) success. If step 2 fails, entry is still resolved + orphan row carries different id; topic never receives the `force_release` anchor. P9-001 also flags the related "two upserts not bundled" issue: handler writes `successTriagedAt` separately from route's `resolvedAt` write — Lambda freeze between → entry has `successTriagedAt` but no `resolvedAt` → permanent wedge requiring Redis surgery. R4 deferred R4-FG-32 due to handler-idempotency tension; the deferral is now unsafe given P9-001.
**Fix:** Have handler return `progressFromHandler: { successTriagedAt }`; merge into single resolve upsert. Treat `force_release` audit anchor as a hard pre-condition for resolution: on anchor failure, leave entry unresolved + escalate.

### `[ ]` R5-FG-20 (H) — Force-release control event lacks `idempotencyKey` → reader emits double event after Lambda timeout retry
**Closes:** P1-005 + P5-PU-003.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:397`. R3-FG-22 + R4-FG-7 wired body-level dedup for `play_uncertain_success_pending_triage`. The route's `recordControlEvent('force_release', { ... })` passes NO `idempotencyKey`. Operator double-clicking after a 504 timeout (or two distinct admin sessions racing) emits TWO `force_release` anchors for the same `uncertainTxId`. Reader has no way to dedup; verify-audit alerts on `force_release` as critical and double-counts.
**Fix:** Pass `idempotencyKey: 'force-release:' + id + ':' + new Date(entry.timestamp).getTime()`.

### `[ ]` R5-FG-21 (H) — Verifier-side refund SADD fails open + force-release refund SADD fails open (R3-FG-7 archetype, two sibling misses)
**Closes:** P9-003 + P3-007.
**Bug:** Two paths still silently fail-open on `refundedOriginals` SADD: (1) `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:1098-1109` only `ctx.log.warn`s; R3-FG-7 / R3-FG-23 promised escalation. (2) `src/hedera/refund.ts:562-570` in-flight pre-submit SADD failure throws to the route as 500 with no DL/page. After 30-day TTL → second on-chain refund window in either path.
**Fix:** Both sites: write `audit_trail_orphaned` + `escalateUncertainDlFailure({kind:'refunded_originals_sadd_failed', ...})` before returning/throwing.

### `[ ]` R5-FG-22 (H) — `play_session_aborted` `v2WrittenPools` undercounts on transient mid-loop SDK throw → `poolsRoot` mismatch
**Closes:** P5-SR-001.
**Bug:** `src/custodial/MultiUserAgent.ts:951-1043`. Pool-write loop increments `v2WrittenPools++` AFTER the await resolves. If pool i submits, message lands on topic, but SDK await throws ReceiptUncertainError or transient network error, `v2WrittenPools` stays at i-1. Catch path computes `abortedPoolsRoot` over `playedPools.slice(0, v2WrittenPools)` = `slice(0, i-1)`, missing pool i — but the topic HAS the message. Reader recomputes Merkle over i pool messages it observes; abort marker carries root over i-1. Roots disagree → reader treats session as orphaned (not aborted).
**Fix:** Increment `v2WrittenPools` BEFORE the await (decrement on catch best-effort). Or have the abort path query topic for actual messages emitted under sessionId + recompute over those.

### `[ ]` R5-FG-23 (H) — Reader's `parseAuditTopic` does NOT dedup on `originalDepositTxId` (R4-FG-58 / R4-FG-59 asymmetry)
**Closes:** P3-004 + P3-012.
**Bug:** R4-FG-58 added reader-side dedup by `refundTxId`. R4-FG-59 closed the orthogonal case (different refundTxIds for same originalDepositTxId) only in `verify-audit.ts`. The reader fed to `/api/admin/audit`, `/api/user/audit`, and the audit page UI does NOT track `seenRefundedOriginals`. Two refund anchors for same originalDepositTxId — one from in-flight `processRefund`, one from verifier with fresh refundTxId — both pass through. SessionCard sums `rakeReversed` across both → operator-balance reconstruction off by exactly the rake.
**Fix:** Add `seenRefundedOriginals` to `parseAuditTopic` pass-2 reducer mirroring `seenRefundTxIds`.

### `[ ]` R5-FG-24 (H) — Reader's v1 `mint` and `transfer` (rake) parsers have no dedup
**Closes:** P1-003 + P1-011.
**Bug:** `src/custodial/hcs20-reader.ts:964,979`. R4-FG-58 added refund dedup; v1 `mint` (deposit) and `transfer` (rake) anchors have no reader-side dedup. `/api/admin/replay-deposit` or any operator retry that re-fires `recordDeposit` produces TWO mint anchors with identical body → reconstructed user balance shows DOUBLE the actual deposit. Same shape as R4-FG-58 but for the deposit side.
**Fix:** Stamp `depositTxId` into v1 mint/transfer body (R5-FG-14 dovetails); add `seenDepositTxIds` and `seenRakeTxIds` to `parseAuditTopic`.

### `[ ]` R5-FG-25 (H) — 10+ `audit-orphan:*` IDs still unsalted (R4-FG-27/28 sibling sweep incomplete)
**Closes:** P1-006/007/008 + P3-006 + P4-004 + P5-AT-001 + P6-012 + P9-007/008.
**Bug:** `mintAuditOrphanId(prefix, sourceKey)` exists in `src/lib/orphanIds.ts`. R4-FG-27/28 promised "every site". Inventory of remaining unsalted sites:
- `src/hedera/refund.ts:822` `audit-orphan:refund-ledger:${transactionId}`
- `src/hedera/refund.ts:899` `audit-orphan:refund-anchor:${transactionId}`
- `src/hedera/refund.ts:961` `audit-orphan:refund-claim-overwrite:${transactionId}`
- `src/hedera/refund.ts:1002` `audit-orphan:refund-sadd:${transactionId}`
- `src/hedera/refund.ts:1569` `audit-orphan:refund-verifier:${refundTxId}`
- `src/hedera/refund.ts:1641` `audit-orphan:refund-verifier-sadd:${sadd_originalTxId}`
- `src/custodial/UserLedger.ts:190` `audit-orphan:in-band:deposit-anchor:${txId}`
- `src/custodial/UserLedger.ts:231` `audit-orphan:in-band:rake-anchor:${txId}`
- `src/custodial/UserLedger.ts:287` `audit-orphan:in-band:credit-flush:${txId}`
- `src/custodial/MultiUserAgent.ts:2224` `audit-orphan:prize-recovery:${txResult.result.transactionId}` (R4-FG-19 introduced this NEW unsalted site even after R4-FG-27 was committed)
Test `UserLedger.test.ts:327` even hardcodes the unsalted form, locking in the wrong shape.
**Fix:** Replace all 10 with `mintAuditOrphanId(prefix, sourceKey)`. Update `UserLedger.test.ts:327` assertion to prefix match. Add a CI lint banning the literal pattern outside `orphanIds.ts`.

### `[ ]` R5-FG-26 (H) — Force-release verifier-lock has no heartbeat (R4-FG-66 sibling miss)
**Closes:** P4-007.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:282-285` acquires the verifier lock with `VERIFY_LOCK_TTL_SEC = 60`. Route's work after acquire includes mirror cross-check + ledger mutation + HCS submit (~3-8s) + R4-FG-29 fallback + resolve upsert + flush. R4-FG-9 fixed the same TTL exhaustion concern for refunds; reconcile got R4-FG-66's heartbeat. Force-release didn't. R4-FG-8 fenced the release so a TTL-out doesn't nuke a sibling — but the bug we fenced AGAINST (handler exceeds TTL on HCS congestion → sibling acquires → torn state) is still reachable.
**Fix:** Wrap the route's verifier-lock window with `startOperatorLockHeartbeat` at 20s interval. Mirror reconcile's pattern.

### `[ ]` R5-FG-27 (H) — `recover-stuck-prizes` script user-lock not in `finally`; `process.exit` skips finalizers
**Closes:** P6-009.
**Bug:** `src/scripts/recover-stuck-prizes.ts:183-281`. `acquireUserLock` at line 183. `releaseUserLock` is called only on transfer-fail (line 204) and happy path (line 274). Between 183 and 204 there's `transferAllPrizesWithRetry`; between 216 and 274 there's `recordPrizeRecovery`, `setTimeout(5000)`, two `getUserState` MCP calls. None wrapped in try/finally → any throw or `process.exit(N)` (lines 152, 169, 190, 213, 280) leaves lock held until 600s TTL.
**Fix:** Wrap entire post-acquire body in `try { ... } finally { await releaseUserLock(...) }`. Replace `process.exit` calls after lock acquire with `releaseUserLock` + `process.exit`.

### `[ ]` R5-FG-28 (H) — `recover-stuck-prizes` lock has TTL but NO heartbeat (asymmetric with reconcile cron)
**Closes:** P6-003.
**Bug:** R4-FG-15 bumped TTL 300s→600s. The script's actual sequence: `transferAllPrizesWithRetry` (3×~16s) + 5s mirror wait + 2× `getUserState` (no timeout) + `recordPrizeRecovery` HCS submit + verification — comfortably exceeds 600s on slow mainnet. R4-FG-66 added heartbeat for reconcile's identical pattern; recover-stuck-prizes was missed.
**Fix:** Generalize `startOperatorLockHeartbeat` to a `startLockHeartbeat(prefix, key, token, intervalMs, ttlSec)` helper; wire into recovery script with `intervalMs=60_000, ttlSec=600`. Also wire into `processRefund`'s outer user lock (R4-FG-9 deferred this).

### `[ ]` R5-FG-29 (H) — `error.name` mutation in UserLedger could clobber typed-error class signatures
**Closes:** P4-005.
**Bug:** `src/custodial/UserLedger.ts:326-328` mutates `flushErr.name = 'DepositCreditFlushFailedError'` to tag for downstream branching. Today `flushErr` is plain Error — fine. But the codebase has TWO classes that branch on `err.name`: `isPreserveClaim` (`src/lib/idempotency.ts:60`) and `transferAllPrizesWithRetry` (`src/hedera/contracts.ts:279`). If a future codepath ever lets a `ReceiptUncertainError` propagate through `store.flush()`, the mutation overwrites `name` → idempotency catch DELs the on-chain claim → double-spend window opens.
**Fix:** Wrap rather than mutate: `throw Object.assign(new Error('flush failed post-record'), { name: 'DepositCreditFlushFailedError', cause: flushErr })`. Preserves the original error as `cause`.

### `[ ]` R5-FG-30 (H) — Cron rate-limit takes FIRST `x-forwarded-for` entry → attacker-spoofable
**Closes:** P4-006.
**Bug:** `app/api/cron/reconcile/route.ts:90-91`. R4-FG-45 normalized identity to xff-first-element. Vercel's edge prepends real IP to xff but does NOT strip caller-supplied prefixes — `X-Forwarded-For: 1.2.3.4` from client lands as `1.2.3.4, <real-ip>`. `.split(',')[0]` reads the attacker-supplied value. With a leaked CRON_SECRET, an attacker rotating xff per request gets a fresh per-IP bucket each call. Plus IPv6+port issues + empty xff fallback (P7-008).
**Fix:** Use the LAST element of xff (`xff?.split(',').at(-1)?.trim()`), OR read `x-real-ip` (Vercel-controlled). Normalize IPv6 by stripping bracket+port.

### `[ ]` R5-FG-31 (H) — User-tier write routes bind rate-limit to bearer prefix, NOT `auth.accountId` (R4-FG-44 sibling miss)
**Closes:** P7-002.
**Bug:** `app/api/user/play/route.ts:51`, `withdraw/route.ts:48`, `register/route.ts:38`, `strategy/route.ts:43-46` all call `checkRateLimit` BEFORE `requireTier` and pass no `identity`. Token rotation defeats the per-action cap. `play` (3/60s) and `withdraw` (5/60s) gate real-money ops.
**Fix:** Move `checkRateLimit` AFTER `requireTier`; pass `identity: auth.accountId`.

### `[ ]` R5-FG-32 (H) — `/api/admin/migrate-schema` rate-limits before `requireTier` (R4-FG-44 sibling miss)
**Closes:** P7-003.
**Bug:** `app/api/admin/migrate-schema/route.ts:49-54`. R4-FG-44 promised "every admin route's checkRateLimit AFTER requireTier and pass identity: auth.accountId". migrate-schema was missed.
**Fix:** Move + `identity: auth.accountId`.

### `[ ]` R5-FG-33 (H) — `KillSwitchError`'s `reason` leaked to user-tier 503 bodies (R4-FG-40 sibling miss)
**Closes:** P7-005.
**Bug:** `KillSwitchError` constructor (`src/lib/killswitch.ts:46-53`) bakes the operator's free-text reason into `message`; routes (`/api/user/play:144`, `/api/user/register:92`, `/api/user/strategy:130`) add `reason` as top-level response field. R4-FG-40 closed `/api/health` but the same recon class is still wide-open via authenticated polls.
**Fix:** Sanitized 503 body; drop `reason`; replace `message` with fixed string.

### `[ ]` R5-FG-34 (H) — `/api/admin/audit` user-filter substring match leaks other users' history
**Closes:** P7-006.
**Bug:** `app/api/admin/audit/route.ts:142-160` `involvesAccount` uses `memo.includes(accountId)`. `userFilter='0.0.123'` matches `0.0.1234567`. Plus filter is unvalidated — empty/regex-special/partial values silently match. `/api/user/audit` was hardened with word-boundary regex; admin sibling stayed buggy.
**Fix:** Word-boundary regex; validate `userFilter` against `^0\.0\.\d{1,12}$`. De-dupe `involvesAccount`/`classifyType`/`toAuditEntry` into a shared module.

### `[ ]` R5-FG-35 (H) — `/api/cron/reconcile` has no `maxDuration` export → 15s default kills R4-FG-16
**Closes:** P10-CFG-001.
**Bug:** R4-FG-16 added per-pass DL cap with 900s lock. The function timeout for `/api/cron/reconcile` is the platform default (10s Hobby / 15s Pro) since no `export const maxDuration` exists. Function dies at 15s, lock held 900s, next 14 cron ticks skip with "in progress" — exactly the failure mode R4-FG-16 was meant to guard. Compounds with R4-FG-66 (heartbeat is a no-op if function dies first).
**Fix:** `export const maxDuration = 300` (or 800 if Enterprise). Reduce reconcile lock TTL to match function ceiling + 1.5× safety.

### `[ ]` R5-FG-36 (H) — CORS `Allow-Headers` doesn't include `Idempotency-Key` → browser preflight fails
**Closes:** P10-CFG-002.
**Bug:** `app/api/_lib/cors.ts:118,137` lists `Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version` and OMITS `Idempotency-Key`. Five routes (refund, withdraw-fees, replay-deposit, user-withdraw, user-play) require the header. Cross-origin browser requests from the dashboard fail preflight before the handler runs.
**Fix:** Add `Idempotency-Key` to both `corsHeadersFor` and `staticCorsHeaders`. Add OPTIONS regression test.

### `[ ]` R5-FG-37 (H) — Stale `dist/` ships broken `.d.ts` imports (`PersistentStore.js`)
**Closes:** P10-BUILD-001.
**Bug:** `dist/custodial/NegotiationHandler.d.ts:2` imports `./PersistentStore.js` but src moved to `./IStore.js` (R3 era). `package.json:6` declares `main: dist/index.js`; `files` includes `dist`. R4 shipped 80+ src changes with no `dist/` rebuild. Any `npm publish` would ship broken stubs.
**Fix:** Untrack `dist/`; have `prepublishOnly` rebuild on every publish. Add CI job that builds and asserts no `dist/` diff.

### `[ ]` R5-FG-38 (H) — `docs/incident-playbook.md` has no runbook for R4 escalation kinds
**Closes:** P10-RUN-001.
**Bug:** Four new kinds shipped: `deposit_anchor_failed`, `rake_anchor_failed`, `refunded_originals_sadd_failed`, plus new `audit_trail_orphaned` sourceKinds (`deposit`, `rake`, `prize_recovery`, `replay_deposit`); plus `legacy_abort_no_merkle` warning; plus `flush_failed_paged` discriminator. Symptom 17 covers `audit_trail_orphaned` only generically. Operator paged at 2am for `kind: 'deposit_anchor_failed'` has zero documented action.
**Fix:** Add Symptoms 20-25 to playbook covering each kind: diagnosis (which Redis key / on-chain tx), reconciliation (forward-fix via `operator_refund` or corrective `recordDeposit`), prevention.

### `[ ]` R5-FG-39 (H) — `/api/admin/audit` + `/api/user/audit` decode every topic message TWICE → quadratic memory pressure
**Closes:** P11-001 + P7-015.
**Bug:** `route.ts:429,497-501` runs `decodeMessage(msg)` twice over `allMessages`. At MAX_PAGES=1000 × 100 msg/page = 100K messages × ~500B = 50MB doubled = 100MB before parseAuditTopic adds another ~50MB. Vercel 1GB; 4 concurrent OOM range.
**Fix:** Decode once into shared `RawTopicMessage[]`; feed both consumers.

### `[ ]` R5-FG-40 (H) — `/api/admin/audit` unfiltered enrichment is O(users × refreshPlaysForUser) → DoS at scale
**Closes:** P11-002.
**Bug:** `route.ts:457` does `for (const u of store.getAllUsers()) { await store.refreshPlaysForUser(u.userId); }` when no user filter. At 10K users × ~15 sessions = 150K Redis hops, sequentially awaited. ~5-10 min — function-ceiling timeout. Operator can never load unfiltered admin audit.
**Fix:** Bulk-load via SCAN+pipeline OR denormalize a cross-user `plays:all` LIST.

### `[ ]` R5-FG-41 (H) — DepositWatcher `pollOnce` hydrates ALL users every 60s (R4-FG-67 perf cliff)
**Closes:** P11-005.
**Bug:** R4-FG-67 added `await this.store.refreshUserIndex?.()` at top of every `pollOnce`. `RedisStore.refreshUserIndex` does SMEMBERS + pipelined GET per user. At 10K users × 60s cadence = 167 GETs/sec just for the watcher × N warm Lambdas. Pipeline payload (~5MB) hits Upstash REST cap. The R4 fix introduced the perf regression.
**Fix:** Move index refresh to per-N-poll or on first unmatched-memo. Use a watermark-based "users-since" set.

### `[ ]` R5-FG-42 (H) — `MAX_RECORDS = 10_000` doesn't bound `deadLetters` → cold-start LRANGE 0 -1 exceeds Upstash 4MB body cap
**Closes:** P11-006.
**Bug:** `RedisStore.ts:579-580,619-620,638-639,723-725` enforces MAX_RECORDS on deposits/plays/withdrawals/gas. `upsertDeadLetter` at line 672 does NOT trim. Audit-orphan + uncertainTx + prize-transfer DLs accumulate. Worst impact: cold-start `load()` reads via `LRANGE 0 -1` — at 50K × 800B = 40MB single Upstash response → exceeds 4MB cap → cold start fails 413.
**Fix:** Trim `deadLetters` in `rotateRecords` AND on `upsertDeadLetter` push past cap. Paginate `load()` via `LRANGE 0 999` partial-load with paged admin viewer.

### `[ ]` R5-FG-43 (H) — `submitV2Message` not parallelized in play loop → exceeds Hedera per-account TPS cap
**Closes:** P11-007.
**Bug:** A 7-pool play emits 1 open + 6 pool_result + 1 close = 7 sequential `submitV2Message` calls, ~500-1000ms each = 3.5-7s per play holding the per-user lock. At 100 plays/min × 7 = 11.7 TPS — exceeds default per-account ~10 TPS Hedera cap → `BUSY`/throttled. R4-FG-51 deferred batching.
**Fix:** Stream pool_result submits with bounded concurrency (`Promise.all` with limit 3-5). Consider HCS topic batching where body packs N pool_results per submit.

### `[ ]` R5-FG-44 (H) — Verify-audit ignores `audit_trail_orphaned` dead-letter rows entirely
**Closes:** P12-305.
**Bug:** Grep `audit_trail_orphaned` in `src/scripts/verify-audit.ts` returns zero matches. R4-FG-5/19/62 all rely on the orphan row as the recovery anchor — but verify-audit only reads the topic. Operator running `npm run read-accounting` on a healthy-looking topic gets clean "Conservation OK" report while the agent is silently dead-lettering 50 orphans/hour.
**Fix:** Optional `--store-snapshot` flag that loads orphan DLs and merges into the alerts list.

### `[ ]` R5-FG-45 (H) — `flush_failed_paged` deposits cannot be detected by topic-only DR replay
**Closes:** P12-306.
**Bug:** R4-FG-62 stamps `DepositCreditFlushFailedError`; route returns `flush_failed_paged`. User's local in-memory balance has the credit; Redis is the lagging side. Topic has the `mint`. If Redis is then lost and operator reconstructs from topic, topic-derived `totalDeposited` includes the mint. The audit-orphan row (`in_band_credit_flush`) is in Redis (lost). Topic-only auditor over-credits by the flush-failed amount.
**Fix:** Write the flush-failed orphan as an HCS `recordControlEvent` (event=`deposit_credit_flush_orphaned`, txId=X) so the orphan trail is on-chain and survives Redis loss.

### `[ ]` R5-FG-46 (H) — `prize_recovery` event doesn't update session's `prizeTransfer.outcome` to "recovered"
**Closes:** P12-308.
**Bug:** R4-FG-19 emits `prize_recovery` anchor when operator runs `recover-stuck-prizes.ts`. Reader emits both `closed_success_with_prizeTransfer.outcome='failed'` AND a separate `prize_recovery` event; verify-audit ignores `prize_recovery` for per-user reconstruction (`verify-audit.ts:729` comment: `// deploy/prize_recovery/unknown not credited per-user`). Auditor sees session with `prizeTransfer.outcome='failed'` and concludes user never received prize, even after recovery succeeded.
**Fix:** When `prize_recovery` references `affectedSessions`, post-process those sessions to update `prizeTransfer.outcome` to `recovered` (third state) + emit `recovered_via_prize_recovery` warning.

### `[ ]` R5-FG-47 (H) — `legacy_abort_no_merkle` and `legacy_merkle_binding` warnings buried in `session.warnings`, never alerted
**Closes:** P12-307 + P1-010.
**Bug:** `verify-audit.ts:640-642` collects `session.warnings` into `led.warnings` (per-user) which is printed but never added to `alerts` array. External monitoring scraping `--json` for `severity` will completely miss the legacy-Merkle warnings — and combined with R5-FG-2 (no cutover), forged unbound roots pass with only a buried warning.
**Fix:** Promote both legacy-Merkle warnings to top-level `alerts` with severity:'warning'; promote to 'critical' if post-cutover (R5-FG-2 dovetails).

### `[ ]` R5-FG-48 (H) — `withIdempotency` RELEASE_SCRIPT eval failure has no fallback DEL → claim sticks for 24h
**Closes:** P6-006.
**Bug:** `src/lib/idempotency.ts:166-171` catch on the eval is bare. If eval throws (Redis cluster failover, eval not yet supported in mock, network blip), claim sticks at `pending:<uuid>` for 24h. Sibling retries get `kind:'in-flight'` for 24h. The "operator manually DELs" path requires the operator to KNOW which key — `fullKey` is constructed inside `withIdempotency` and never logged on eval failure.
**Fix:** On eval failure, fall back to `redis.del(fullKey)` (the body threw non-uncertain so plain DEL is safe). Log the released key. `escalateUncertainDlFailure({kind:'idempotency_release_failed'})` if even the plain DEL fails.

### `[ ]` R5-FG-49 (H) — Heartbeat tick zombie callbacks under hung Redis re-extend lock after sibling acquires
**Closes:** P6-008 + P2-002 + P4-009 + P7-014.
**Bug:** `src/lib/locks.ts:285-294`. setInterval fires every 60s. If work hangs AND Redis is also wedged, heartbeat's `getRedis()` itself can hang. setInterval keeps firing, queuing more pending heartbeats sharing the same hung Redis connection. When Vercel ceiling kills Lambda, dozens of zombie heartbeat promises stacked. Cancel never fired (synchronous in catch path on Lambda kill). Lock TTLs at last successful heartbeat → sibling reconcile starts → original Lambda's stacked heartbeats finally resolve → one lands a HEARTBEAT_RELEASE_OR_EXTEND_SCRIPT compare-and-EXPIRE that MATCHES (cancelled checked in JS, not in Lua) → original's lock silently re-extended out from under sibling.
**Fix:** Pass `cancelled` flag check INTO the Lua script (EXPIRE only if value matches AND a separate "active" flag isn't "cancelled"). Or replace setInterval with self-rescheduling setTimeout that re-checks cancelled before scheduling NEXT tick (caps stacked queue at 1). Or `await Promise.race([eval, AbortSignal.timeout(5_000)])`.

### `[ ]` R5-FG-50 (H) — Reader skips Merkle binding entirely when `bucket.open` is missing → silent legacy-form acceptance
**Closes:** P4-010.
**Bug:** `src/custodial/hcs20-reader.ts:792-810` only attempts the bound Merkle when `agent` is non-null (line 792). `agent` comes from `bucket.open.agent`. Edge case: attacker who controls submit-key writes pool messages for a fabricated session, omits the open, then writes a close with a forged unbound root. Reader takes `bucket.close` branch, `agent` undefined, falls through to `usedLegacy=true`, validates against unbound legacy root, marks `closed_success`. The R4-FG-23 protection is unavailable for ANY session whose open is missing.
**Fix:** When `!agent` AND a close exists, refuse to validate — treat as `corrupt` with warning `cannot_verify_root_binding_open_missing`. Document a soft `mirror_lag_grace_window` for real lag.

### `[ ]` R5-FG-51 (H) — Eight R4-FG fixes have zero or shallow tests (P8 cluster — fourth recurrence of R2-FG-0 archetype)
**Closes:** P8-001 + P8-002 + P8-003 + P8-004 + P8-005 + P8-006 + P8-007 + P8-008.
**Bug:** Same archetype as R2-FG-0 / R3-P8 / R4-FG-31 — fourth round running:
- **R3-FG-58** stale-snapshot bump test mistimes the sibling write; passes on revert
- **R4-FG-66** `startOperatorLockHeartbeat` has zero tests
- **R4-FG-72** `sigPair.length === 1` check has no test
- **R4-FG-65** fenced compare-and-DEL behaviour not directly tested (mock + production both implement the check independently)
- **R4-FG-21** `MAX_RECORDS=10_000` cap has zero tests
- **R4-FG-20** unknown-token max-attempts has no test
- **R4-FG-25** webhook URL HTTPS validation has no test
- **R4-FG-5** rake-anchor failure leg untested + no escalation assertion
**Fix:** Add tests for each. Establish a "revert-proof drill" CI step that mentally reverts a sample of tagged tests.

---

## Phase R5-3 — Medium (~32 items)

### `[ ]` R5-FG-52 (M) — Force-release route `applyForceRelease` lacks `Idempotency-Key` requirement (R4-FG-42 deferred → still open)
**Closes:** R4-FG-42 deferral. Decided in P7-010 + P9-001.
**Fix:** Refactor force-release route to fold multi-branch responses into a serializable cached outcome; wrap in `withIdempotency('force-release:${id}')`.

### `[ ]` R5-FG-53 (M) — `replayDeposit` `flush_failed_paged` outcome caches for 24h with no operator override
**Closes:** P4-011 + P6-011.
**Bug:** `src/services/userOps.ts:586-592` returns `{credited:true, status:'flush_failed_paged'}` — counts as success → `withIdempotency` caches for 24h. Operator fixes Redis issue + retries within 24h → cached `flush_failed_paged` returned without re-attempting. R4-FG-34's self-heal only fires on `credited === false`.
**Fix:** Mirror R4-FG-34: when `idempotent.kind==='duplicate' && idempotent.result.status==='flush_failed_paged'`, DEL the idempotency claim before returning.

### `[ ]` R5-FG-54 (M) — `/api/admin/replay-deposit` route has no `flush_failed_paged` switch case → admin UI hides paged signal
**Closes:** P12-312.
**Bug:** `app/api/admin/replay-deposit/route.ts:99-130` only branches on `'invalid_input' | 'in_flight' | 'duplicate' | 'ok' | 'lock_held' | 'access_denied' | 'not_found'`. **No case for `flush_failed_paged`.** Switch falls through silently; response shows `credited:true` with no admin-UI banner that operator was paged.
**Fix:** Add `case 'flush_failed_paged'` returning HTTP 207 with body `{credited:true, status:'flush_failed_paged', warning:'Local state mutated; Redis flush failed; orphan row written; operator paged. Run reconcile to confirm.'}`.

### `[ ]` R5-FG-55 (M) — A2A `flush_failed_paged` outcome surfaces as "completed" not "failed"
**Closes:** P7-009.
**Bug:** `src/a2a/adapter.ts:117-127` sets `state='completed'` unless `toolResult.isError`. R4-FG-62's `flush_failed_paged` is non-error from MCP perspective. A2A wraps as clean Task with no failure status. External agents calling via A2A see `status='completed'` and assume nothing went wrong.
**Fix:** Inspect `resultData.status === 'flush_failed_paged'` in `wrapAsTask`; map to `state='completed'` but include status-message DataPart noting paged condition.

### `[ ]` R5-FG-56 (M) — `package.json` version fallback ordering wrong → env always wins, package import is dead code
**Closes:** P4-008.
**Bug:** `src/a2a/agent-card.ts:167-170` chains `process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.npm_package_version ?? PACKAGE_VERSION`. Build-time inlining drift (operator deploys via `next build && next start` without rebuilding) leaves env stale at the previously-built value while package.json moves on. Fallback NEVER fires.
**Fix:** Invert: `PACKAGE_VERSION ?? process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0-unknown'`. Build-time imports beat runtime envs for an immutable repo fact.

### `[ ]` R5-FG-57 (M) — `recordRake` has no idempotency key; retry can double-count `totalRakeCollected`
**Closes:** P12-310.
**Bug:** Reader-side `seenRefundTxIds` (R4-FG-58) protects `rakeReversed`. But `totalRakeCollected` (operator-side credit at `verify-audit.ts:466`) has no equivalent dedup — `recordRake` has no idempotency key. A retry of deposit credit (rare but possible) produces two rake transfers on topic, double-counting `totalRakeCollected` while `totalRakeReversed` matches one of them on refund.
**Fix:** Add `depositTxId` to recordRake (R5-FG-14 dovetails); dedup rake events by `(from, depositTxId)` at reader.

### `[ ]` R5-FG-58 (M) — Strategy_change cross-check uses `firstSeq` (whole-session min) instead of `play_session_open`'s sequence
**Closes:** P12-311.
**Bug:** `verify-audit.ts:651-656` finds `activeStrategy` via `ch.sequence < session.firstSeq`. For an out-of-order session (rare but possible), `firstSeq` could equal a pool message's sequence. A strategy_change between open's logical time and firstSeq's actual time would be applied incorrectly — cross-check compares to strategy active when the *first pool* landed, not when user *initiated* the play.
**Fix:** Track `bucket.open.sequence` separately; pass through as `openSeq`. Use `openSeq` for strategy comparison.

### `[ ]` R5-FG-59 (M) — Mid-session strategy deviation has no topic representation
**Closes:** P12-309.
**Bug:** `MultiUserAgent.playForUser` snapshots strategy ONCE at session-open. If agent legitimately deviates (budget exhaustion, killswitch, per-pool fee filter), session's actual behavior diverges from `session.strategy` — no field on `play_pool_result` or `play_session_close` records the deviation. R4-FG-60 detects only disagreement between `strategy_change` and `session_open`, not between `session_open` and actual play.
**Fix:** Add optional `strategyDeviation: { reason, field }` field on `play_session_close`/`play_session_aborted`. Surface as `info` alerts.

### `[ ]` R5-FG-60 (M) — Refund verifier SUCCESS skips ledger debit silently when `details.tokenKey`/`humanAmount` missing
**Closes:** P5-AT-002.
**Bug:** `src/hedera/refund.ts:1374-1476`. The `if` requires `user && details.tokenKey && finite(humanAmount) && humanAmount >= 0`. If any missing (legacy DL or shape regression), entire ledger-adjustment block is bypassed; `didAdjustLedger` stays false; audit-anchor block also gates on `details.humanAmount`; resolve-write fires anyway. Outcome: refund landed on chain, user NOT debited locally, topic has NO refund anchor, entry resolved → user retains deposit credit + receives refund.
**Fix:** Treat malformed-required-fields as `bumpVerificationAttempts` + `still_uncertain`. Resolve only when all post-conditions either applied or stamped.

### `[ ]` R5-FG-61 (M) — `applyPendingLedgerForUser` eager-drain skips `store.flush()` after rake-reversal mutation
**Closes:** P5-RU-002.
**Bug:** Eager-drain at `pendingLedger.ts:217-265` calls `updateBalance` + `updateOperator` (R4-FG-13) then `redis.lrem`, NO `store.flush()`. Sibling Lambda or cold-start reads stale Redis state. Periodic drain flushes; eager doesn't.
**Fix:** Add `await store.flush().catch(...)` after `lrem` succeeds.

### `[ ]` R5-FG-62 (M) — `applyPendingLedgerForUser` doesn't validate `entry.userId`; queue corruption can debit wrong user
**Closes:** P3-008.
**Bug:** `pendingLedger.ts:168-266`. Function filters to `entry.userId !== userId` (line 201). If queued entry's userId corresponds to a deleted user and a new user registered with the same userId (theoretically impossible but operator-side migrations could), debit applies to wrong user. Same race surface as R5-FG-4 from a different door.
**Fix:** SET-NX a per-`(userId, sourceTx)` claim before applying; DEL on success.

### `[ ]` R5-FG-63 (M) — `pendingLedger` drain non-atomic across Lambda crash
**Closes:** P2-007.
**Bug:** Sequence: (1) updateBalance, (2) updateOperator (rake reversal), (3) flush, (4) lrem. Lambda crash between (1) and (2): user debited but rake not reversed AND queue entry persists. Next drain re-applies BOTH (1) and (2) → user debited twice, rake reversed once. Crash between (3) and (4): both legs applied, queue still has entry → next drain re-applies both → 2× user debit + 2× rake reversal.
**Fix:** SET-NX a per-entry "applied" marker before mutation; check at top of loop. Or collapse all writes into single Lua eval (multi-key supported).

### `[ ]` R5-FG-64 (M) — Refund verifier escalation throws → operator un-paged, no on-page knowledge
**Closes:** P3-010.
**Bug:** `refund.ts:1639-1666`. Sequence: SADD throws → orphan write succeeds → `escalateUncertainDlFailure` throws (Redis dedup-check available; webhook fetch failed). Outer try/catch logs and continues. Net: SADD never landed (no permanent ban), orphan row on disk, operator NOT paged. Reconcile cron next pass: `verifyUncertainRefunds` doesn't process `audit_trail_orphaned` kind. Orphan sits forever. After 30d the per-tx claim TTLs out → fresh refund attempt passes `sismember=0` → second on-chain refund.
**Fix:** When escalation fetch fails, retry once with 30s gap; write a SECOND orphan row tagged `phase:'escalation_throw_after_sadd_failure'`.

### `[ ]` R5-FG-65 (M) — `prize_transfer_failed` DL doesn't carry the contract txId for the failed attempt
**Closes:** P3-011.
**Bug:** `MultiUserAgent.ts:856-880`. When `safeTransferPrizes` returns `failed`, DL `details` carries `attemptsLog` (with each attempt's gas + error string) but no `contractTxId` field. If any attempt's submit DID land (P3-003 / P5-PT-001), no record of which txId to mirror-check. Recovery proceeds blindfold.
**Fix:** Add `lastSubmittedTxId?: string` to attempt logs; surface on DL.

### `[ ]` R5-FG-66 (M) — `safeTransferPrizes` strips the `receiptUncertain` wrapper signal; recovery script re-submits
**Closes:** P3-003.
**Bug:** `src/agent/LottoAgent.ts:743-762`. `transferAllPrizesWithRetry` re-throws wrapped Error with `receiptUncertain:true` (R4-FG-17). `safeTransferPrizes` catches with `errorMsg(e)` and stashes `attemptsLog` only — flag DROPPED. The `prize_transfer_failed` DL has no field distinguishing "INSUFFICIENT_GAS exhausted" (safe to retry) from "receipt uncertain — tx may have landed" (must NOT retry without contract-state cross-check). Recovery script reads `pendingPrizesCount` and submits a SECOND `transferPendingPrizes`.
**Fix:** Carry `receiptUncertain` flag onto DL `details`. In recovery, when DL has `receiptUncertain:true`, FIRST mirror-query the original txId before any new contract call. Pin contract idempotency assumption with a testnet test.

### `[ ]` R5-FG-67 (M) — Cause-class fingerprint `first whitespace token` is gameable; per-txId-prefixed errors break dedup
**Closes:** P2-009 + P1-012.
**Bug:** `src/lib/escalation.ts:72-78` `causeFingerprint = ${causeClass}:${rawCauseMsg.split(/\s+/, 1)[0]}`. Many SDK errors have format `"transactionId 0.0.X@Y receipt failed"` — first token is "transactionId" (good). But `"0.0.123@456: receipt timeout"` — first token includes the txId, so EVERY error with txId-at-start produces unique fingerprint per txId. Dedup window collapses to per-txId-per-class. Operator gets every bounce paged. Conversely `"Error: ECONNRESET"` — five different network errors collapse to same fingerprint.
**Fix:** Hash the WHOLE cause message (truncated): `crypto.createHash('sha256').update(rawCauseMsg.slice(0, 256)).digest('hex').slice(0, 16)`.

### `[ ]` R5-FG-68 (M) — Refund claim DEL is unfenced (R4-FG-65 sibling miss in `refund.ts`)
**Closes:** P6-010.
**Bug:** `refund.ts:699-715`. Regime A/B failure: claim acquired with `'pending'` value (line 374). On failure, `redis.del(redisLockKey)` deletes unconditionally — no fence. Same unfenced-DEL pattern R4-FG-65 fenced for `withIdempotency`. The refund's in-function claim still uses the older shape.
**Fix:** Generate fence at acquire (`pending:<uuid>`); pass to release via RELEASE_SCRIPT. Reuse fence-aware compare-and-DEL for the success path's `'failed:<refundTxId>'` overwrite (line ~870).

### `[ ]` R5-FG-69 (M) — DepositCreditFlushFailedError tagging is unsalted (overlap with R5-FG-25 but in same file)
**Closes:** P6-013 (deposit/rake anchor failures get 2 pages).
**Bug:** R4-FG-64 differentiates `deposit_anchor_failed` and `rake_anchor_failed` kinds — pages fire correctly. But operator triaging a flood of HCS failures sees them as separate incidents requiring separate replays, when in fact a single `recordDeposit` retry would NOT re-fire the rake (separate try block at `UserLedger.ts:222`). Replay-deposit re-runs both, but operator confusion during incident is real.
**Fix:** Add `relatedTxId` field to escalation payload so page text reads "(part of deposit credit pair, see also rake_anchor_failed for same txId)". Long-term: batch deposit+rake into a single submit via `submitMessageBatched`.

### `[ ]` R5-FG-70 (M) — Killswitch GET leaks operator account ID via `enabledBy` to admin tier
**Closes:** P7-004.
**Bug:** Admin tier (WalletConnect-authenticated address in ADMIN_ACCOUNTS) and operator tier (MCP_AUTH_TOKEN bearer) are NOT the same population. `app/api/admin/killswitch/route.ts:51` returns the full `getKillSwitchState()` (with `enabledBy: operator's accountId`). An admin's curiosity (or compromise) yields the operator's primary Hedera account.
**Fix:** Lock killswitch GET to operator-tier; admin GET strips `enabledBy`/`enabledAt`. Or hash `enabledBy` with process-stable salt.

### `[ ]` R5-FG-71 (M) — `/api/admin/dead-letters`, `/users`, `/overview`, `/audit`, `/monitoring` GETs rate-limit before requireTier; no identity (R4-FG-44 sibling miss for reads)
**Closes:** P7-012.
**Bug:** Admin GETs expose user PII (eoaAddress, balances, full DL context). Leaked admin token rotated across rotations → unbounded access bypassing the documented 20-60/min cap.
**Fix:** Apply R4-FG-44 pattern to admin GETs.

### `[ ]` R5-FG-72 (M) — `/api/a2a` rate-limit not bound to accountId; token rotation defeats 30/min cap
**Closes:** P7-007.
**Bug:** `app/api/a2a/route.ts:55` calls `checkRateLimit({action:'a2a', limit:30})` with no identity — runs BEFORE bearer parse for auth.
**Fix:** Inside route, after extracting `authToken`, hash it (sha256) and pass `identity: hashed` to checkRateLimit. Or call `resolveAuth(authToken)` first.

### `[ ]` R5-FG-73 (M) — `/api/admin/monitoring` mirror walk has NO `MAX_PAGES` cap (R4-FG-46 sibling miss)
**Closes:** P7-011.
**Bug:** `app/api/admin/monitoring/route.ts:97-133` `while (nextPath)` with `AbortSignal.timeout(8000)` per fetch but no page limit. With 1M-message topic and 8s/page, easily blows 60s function ceiling.
**Fix:** Apply MAX_PAGES=1000 + AbortSignal parity. Use windowed `since:` once R4-FG-50 lands.

### `[ ]` R5-FG-74 (M) — `/api/admin/audit` `userFilter` unvalidated + no per-account audit-aggregation budget
**Closes:** P7-010.
**Bug:** Direct use of `userFilter = url.searchParams.get('user')` with no shape check. R4-FG-46 added MAX_PAGES per request, but admin can poll with 100 different `user` filters and amplify the work.
**Fix:** Validate `userFilter` against `^0\.0\.\d{1,12}$`. Add per-account "audit page-walk budget" (e.g., 5000 page-fetches/hour/accountId, INCRBY pages each call).

### `[ ]` R5-FG-75 (M) — `bumpUserLockContentionAttempts` runs `escalateUncertainDlFailure` with wrong-kind fallback
**Closes:** P5-WU-002.
**Bug:** `uncertainTxVerification.ts:539-551` fallback `entry.kind ?? 'withdrawal_uncertain'`. Malformed legacy DL with missing kind → escalation fires under wrong category → operator runbook keyed on `kind` mis-routes.
**Fix:** Refuse to escalate when `entry.kind` undefined; log and bail.

### `[ ]` R5-FG-76 (M) — Mid-flight mirror flap leaves stale `userLockContentionAttempts`
**Closes:** P5-AT-003.
**Bug:** `uncertainTxVerification.ts:466-552`. Counter increments every pass that hits user-lock contention but never RESETS on subsequent successful mutation paths. If operator clears `resolvedAt` to re-run (mid-incident), next pass sees stale counter and threshold (default 5) is closer to firing than it should be.
**Fix:** Reset `userLockContentionAttempts` on every successful lock acquisition. Likewise reset `verificationAttempts` on definitive (SUCCESS|FAILED) mirror result.

### `[ ]` R5-FG-77 (M) — PU SUCCESS escalation always fires even when triage anchor succeeded
**Closes:** P5-PU-004.
**Bug:** `uncertainTxVerification.ts:1757-1764`. R4-FG-6's gate at 1769 is correct, but `escalateUncertainDlFailure` at 1757 is OUTSIDE the gate AND fires even when `playMutationError === null` (anchor succeeded). On first encounter this is fair, but if force-release later clears `resolvedAt`, verifier re-walks and pages again with no new info. R4-FG-64's cause-class hash will fire the duplicate page once that finding lands.
**Fix:** Gate the escalation behind `if (!entry.details?.successTriagedAt)`.

### `[ ]` R5-FG-78 (M) — Strategy NaN/Infinity rejection has no migration path for pre-fix stored strategies
**Closes:** P6-007.
**Bug:** `src/config/strategy.ts:11-14` rejects NaN/Infinity at parse time. Pre-fix strategies stored with NaN serialized as `null` → Zod's `.default(0)` swallows silently. Multi-Lambda mid-deploy: Lambda A (old code) accepts the strategy, Lambda B (new code) rejects it → user's play succeeds on A, fails on B with cryptic Zod error.
**Fix:** Startup probe walks all stored strategies + emits structured warning per non-finite leaf. Provide `npx tsx src/scripts/audit-strategies.ts` that scans Redis + strategies/ dir.

### `[ ]` R5-FG-79 (M) — Unknown-token DL promotion is one-way; registering token AFTER promotion has no batch-retry tool
**Closes:** P6-004.
**Bug:** R4-FG-20 promotion to hard DL with `autoRetry:false`. No operator alert (only `logger.error`). Admin UI has no `unknown-token-promoted` filter. Under load, attacker stamps 100 unknown-token deposits → 100 promotions hide a real bug under noise. When operator finally registers token, no batch-retry tool — must manually call `/api/admin/replay-deposit` per `transactionId`.
**Fix:** Escalate on promotion via `escalateUncertainDlFailure({kind:'unknown_token_promoted'})`. Add `/api/admin/replay-promoted` that walks DLs with `promotedAt` field. Rate-limit promotions per source-account so single sender can't generate >5/hour.

### `[ ]` R5-FG-80 (M) — Strategy_mismatch alerts buried in standalone CLI output
**Closes:** P10-OBS-002.
**Bug:** R4-FG-60's alerts go into generic `alerts` array. CLI human-readable output bundles all under one "Warnings:" section. Whole point of R4-FG-60 is "agent ignored a strategy change request" — that's a *trust-model* alert, not a noisy warning.
**Fix:** Dedicated section "STRATEGY MISMATCHES (auditable trust signal)". Bump severity from `warning` to `critical` when `strategy_change` post-dates session by >24h (clear ignore vs accidental race).

### `[ ]` R5-FG-81 (M) — Admin dead-letters API has no `kind` filter or grouping
**Closes:** P10-OBS-001.
**Bug:** `app/api/admin/dead-letters/route.ts:24-48` returns flat `{deadLetters, count}` with zero filter, zero grouping. With R4 adding ~5 new DL flavors, high-priority `deposit_anchor_failed` is visually identical to low-priority `prize_transfer_failed`.
**Fix:** Add `?kind=&sourceKind=&since=` query params; group response by `kind` with counts; sort by severity.

### `[ ]` R5-FG-82 (M) — `package.json` JSON import requires Node 20.10+; `engines` says >=20.0
**Closes:** P10-BUILD-002.
**Bug:** R4-FG-56 uses `with { type: 'json' }`. Node 20.0-20.9 throws at runtime. `package.json:55` `engines.node >= 20.0.0` warns but doesn't enforce.
**Fix:** Either bump engines to 20.10.0, OR replace JSON import with `readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)))`, OR use `process.env.npm_package_version` injected at build time.

### `[ ]` R5-FG-83 (M) — Missing `.gitattributes` → CRLF/LF drift across Windows checkout vs Linux CI
**Closes:** P10-CFG-003.
**Bug:** No `.gitattributes` at repo root. Windows clone gets CRLF; Vercel CI gets LF. Phantom diffs throughout R4 work (visible in `git status` warnings).
**Fix:** Add `.gitattributes` with `* text=auto eol=lf`. Run `git add --renormalize .` and one cleanup commit.

### `[ ]` R5-FG-84 (M) — README/CLAUDE.md don't document mandatory `Idempotency-Key` on five mutating routes
**Closes:** P10-DOC-002.
**Bug:** `/api/user/withdraw`, `/api/user/play`, `/api/admin/refund`, `/api/admin/withdraw-fees`, `/api/admin/replay-deposit` all hard-fail 400 without `Idempotency-Key`. README/CLAUDE.md/incident-playbook curl examples don't mention it. External integration scripts will silently fail.
**Fix:** Add "Required headers for mutating endpoints" to README. Update every curl example in incident-playbook with `-H "Idempotency-Key: $(uuidgen)"`.

### `[ ]` R5-FG-85 (M) — Operator scripts truncate consensus_timestamp; hide alert stats
**Closes:** P10-CLI-001.
**Bug:** `src/scripts/test-v2-reader.ts:46`, `audit-deposit-discrepancy.ts` (similar). `new Date(Number(m.consensus_timestamp.split('.')[0]) * 1000).toISOString()` discards nanosecond fraction. Two messages sharing same integer second collapse to identical timestamps. Loses sub-second order. `test-v2-reader.ts` also doesn't surface `agentSeqGaps`/`agentSeqDuplicates`/strategy mismatches.
**Fix:** Parse `consensus_timestamp` keeping fractional precision. Print all alert stats verify-audit computes.

### `[ ]` R5-FG-86 (M) — Idempotency mock in test fixture more permissive than real Upstash; mock matches ANY script
**Closes:** P4-002 + P4-003.
**Bug:** `src/auth/redis.ts:515-522` in-memory mock `eval` only matches `'get' + 'del'` 1-key-1-arg patterns; HEARTBEAT script (R4-FG-66) doesn't match → silent no-op. `src/lib/idempotency.test.ts:59-70` mock ignores script content entirely → survives revert of RELEASE_SCRIPT. Both make R4 work (heartbeat, fenced idempotency) effectively untested.
**Fix:** Extend mock to recognize the heartbeat compare-and-extend pattern. Have idempotency mock parse the script (cheap regex on `redis.call("get", KEYS[1]) == ARGV[1]`) so it implements the SPECIFIC compare. Or assert mock receives `RELEASE_SCRIPT` verbatim.

### `[ ]` R5-FG-87 (M) — Cumulative Redis ops/withdrawal at Upstash 1000/s cliff
**Closes:** P11-009.
**Bug:** Withdraw flow does ~15-20 Redis ops per request: withStore preflight + requireTier session + checkRateLimit + assertRedisHealthy + withIdempotency (1-2) + withUserLock (1 SET-NX + 1 EVAL release) + pollDepositsOnce + refreshUserIndex + refreshUser + velocity cap + HCS-20 burn. R4-FG-65 added eval to catch path. At Upstash 1000/s per Lambda → hard ceiling ~50 withdrawals/sec.
**Fix:** Combine `requireTier` + `refreshUser` into single pipeline. Lazy-claim idempotency only when body succeeded.

### `[ ]` R5-FG-88 (M) — `submitV2Message` is fire-and-forget but Hedera SDK errors after submit aren't routed back
**Closes:** P11-007 (perf side); P3-002/P5-RU-... (correctness side).
**Bug:** `submitV2Message` calls `.execute(this.client)` without `getReceipt()`. SDK can throw post-submit errors that the caller never sees. Combined with R5-FG-22 the writer state machine can lose track of which messages landed.
**Fix:** Track per-submit promise outcome; if SDK throws post-execute, treat as `submitted_uncertain` and write a retry-marker.

### `[ ]` R5-FG-89 (M) — `prizesByToken` optional on `recordPrizeRecovery`; conservation math best-effort
**Closes:** P12-313.
**Bug:** `AccountingService.ts:430` spreads `prizesByToken` only if defined. Reader keeps it optional. Mix of "carries token detail" and "carries only count" events makes conservation math best-effort.
**Fix:** Make `prizesByToken` required for new emissions; emit `{}` with the count instead of omitting.

### `[ ]` R5-FG-90 (M) — Verify-audit `--agent` flag enforcement is WARN-only (R3-FG-50 fix shallow)
**Closes:** P9-006.
**Bug:** `src/scripts/verify-audit.ts:777-787` only emits `console.warn` and proceeds with cross-check that "passes for any incoming positive transfer of right amount to ANY account". Operators following standard playbook get green check that doesn't actually verify recipient.
**Fix:** `process.exitCode = 2; throw` if `args.agentAccountId === null && allCrossCheckTxIds.length > 0`. CI-callers can pass `--allow-no-agent` to opt out.

### `[ ]` R5-FG-91 (M) — `validateProgressOrdering` doesn't validate ISO-8601 (R3-FG-77 fix shallow)
**Closes:** P9-005.
**Bug:** `uncertainTxVerification.ts:160-174` only checks `typeof === 'string'`. Attacker-controlled or buggy-writer string (e.g. literal `'pending'`) passes the gate. Combined with R3-FG-3's gate-on-truthiness pattern, non-timestamp truthy string causes verifier to skip mutation step.
**Fix:** Add `if (set && Number.isNaN(Date.parse(details[marker])))` arm; return parse-error string and escalate.

### `[ ]` R5-FG-92 (M) — A2A unknown-skill error leaks operator skill names to unauthenticated callers
**Closes:** P7-013.
**Bug:** `src/a2a/adapter.ts:200-216` returns `availableSkills:skills` (full enumerated list incl. `operator_*`) on unknown-skill error WITHOUT requiring auth.
**Fix:** Only list multi_user skills in error response, OR gate on bearer presence.

### `[ ]` R5-FG-93 (M) — In-flight refund pre-submit SADD-refused has no orphan trail
**Closes:** P3-007.
**Bug:** `src/hedera/refund.ts:562-570`. Pre-submit SADD wrapped in try/catch; on failure throws to route as 5xx with no DL/page. Operator retries, SADD still fails, throws again. Once Redis recovers and operator retries, SADD succeeds and refund fires. No record of the route having attempted.
**Fix:** Mirror R4-FG-4: write `audit_trail_orphaned` with `phase:'refunded_originals_sadd_pre_submit_failed'` AND escalate before throwing.

---

## Phase R5-4 — Low (~16 items)

### `[ ]` R5-FG-94 (L) — Reader phase-2 reducer doesn't sanity-check `rakeReversed` consistency on dedup
**Closes:** P3-012. When dedup-skipping, sanity-check skipped event's `rakeReversed` matches kept event; emit warning if not.

### `[ ]` R5-FG-95 (L) — `seenAgentSeqByAgent` reader dedup vs control-event idempotencyKey is inconsistent
**Closes:** P3-013. Dedup control events on `(idempotencyKey, kind)` tuple in pass-2 reducer.

### `[ ]` R5-FG-96 (L) — `applyPendingLedgerForUser` operator-rake reversal not re-checked against deposit record
**Closes:** P3-014. Re-read deposit record on drain; if `rakeAmount` differs, log and reconcile.

### `[ ]` R5-FG-97 (L) — `escalateUncertainDlFailure` "fail open and page anyway" branch can double-page
**Closes:** P3-015. When dedup throws, write a local-process Map flag (per Lambda warm) before sending; suppress within 5min same Lambda.

### `[ ]` R5-FG-98 (L) — `audit-deposit-discrepancy.ts` filters strictly on `op:'mint'` (future-fragility)
**Closes:** R4-FG-73 deferred. Use `parseAuditTopic` events instead of raw payload filter.

### `[ ]` R5-FG-99 (L) — `recover-stuck-prizes` prints `agentState.pendingPrizes` breakdown unconditionally
**Closes:** P10-CLI-001 sub. Gate behind `--verbose`.

### `[ ]` R5-FG-100 (L) — `loadStrategy` parse-failure silently falls through to inline (R4-FG-76 still open)
**Closes:** R4-FG-76 deferred. Make fallback warn loudly when built-in name file exists but failed to parse.

### `[ ]` R5-FG-101 (L) — Verify-audit cross-check has no LRU
**Closes:** R4-FG-83 deferred. Process txIds in batches of 500; drop cached promises after batch.

### `[ ]` R5-FG-102 (L) — `recordPlayPoolResult` slim path drops strategyMeta via spread mutation pattern (cosmetic)
**Closes:** P4-012. Extract slim transformation into pure helper `slimPoolResult(msg, byteCap)`.

### `[ ]` R5-FG-103 (L) — Lambda local-clock for advisory `expiresAt` on auth challenge/session
**Closes:** P10-TIME-001. Document Redis EX is authoritative; expiresAt is advisory.

### `[ ]` R5-FG-104 (L) — Heartbeat setInterval in serverless cron may persist past Lambda freeze
**Closes:** P11-012. Document the freeze behavior; consider explicit `.unref()` on the timer handle.

### `[ ]` R5-FG-105 (L) — Mirror cross-checks in verify-audit are uncached per run
**Closes:** P11-008. Bump batch to 25; add per-batch throttle; cache cross-check results by txId on disk.

### `[ ]` R5-FG-106 (L) — `seenRefundTxIds` Set in reader has no soft cap
**Closes:** P11-010. Bound the dedup to a recent window (timestamp-cutoff 60 days).

### `[ ]` R5-FG-107 (L) — `RedisStore.load()` cold start O(users + records); registration-storm boot unbounded
**Closes:** P11-013. Lazy-load users only on first access; never bulk-hydrate full set on cold start.

### `[ ]` R5-FG-108 (L) — Mirror page fetch 8s timeout × 1000 pages = 133 min worst case
**Closes:** P11-014. Wall-clock budget (45s) separate from per-page timeout; return partial data with `partial:true` flag.

### `[ ]` R5-FG-109 (L) — `getDepositsForUser`/`getPlaySessionsForUser` use array.filter; O(records) per call
**Closes:** P11-015. Maintain `Map<userId, Set<sessionId>>` alongside flat array.

### `[ ]` R5-FG-110 (L) — `recordPlayPoolResult` slim STILL exceeds 1024 for worst-case multi-NFT pools
**Closes:** P11-011. Cap `prizes[]` count in slim fallback (e.g. truncate to top-10 by value, stamp `slim_truncated_prizes:<count>`).

### `[ ]` R5-FG-111 (L) — Concurrent self-heal back-fills different timestamps (closed in R3-FG-3 revert; reopened by R3-FG-77 + R5-FG-91)
**Closes:** R4-FG-81 deferred — re-evaluated after R5-FG-91.

---

## Deferred (~10 items, design-decisions or out-of-scope)

- **D-23**: Drain queue `LMPOP`-based atomic claim — requires Redis 7.0+ (Upstash supports).
- **D-24**: Fenced compare-and-DEL pattern lifted into a shared `releaseClaim(scope, key, fence)` helper used by every withIdempotency-style caller (idempotency.ts, refund.ts, force-release route, locks.ts) — touches every claim site.
- **D-25**: `submitMessageBatched` for HCS messages so deposit+rake (and play_session_open + first pool_result) are atomic on-topic — needs SDK + reader work.
- **D-26**: `bv:1` binding-version field on `play_session_close` / `play_session_aborted` envelopes (cleaner than try-bound-then-legacy fallback) — schema bump.
- **D-27**: Move idempotency claim VALUE to a fence (UUID); release via RELEASE_SCRIPT (R4-FG-65 generalized to other claim sites — refund, force-release, killswitch).
- **D-28**: `recordControlEvent` accepts `signal?: AbortSignal`; thread through to Hedera SDK.
- **D-29**: `since:ISODate` cap on parseAuditTopic walk — cross-cuts four audit endpoints + verify-audit (R4-FG-50 deferred).
- **D-30**: HCS topic-level rate limit (Bottleneck-style limiter at submit level, retry-with-backoff on `BUSY`/`THROTTLED_AT_CONSENSUS`) — touches every writer (R4-FG-51 deferred).
- **D-31**: Streaming `parseAuditTopic` variant with windowed time filter (cross-cuts audit endpoints + verify-audit) (R4-FG-50 design alternative).
- **D-32**: Move session tokens off localStorage (R3-FG-45 / R4-FG-84 deferred) — frontend rewrite.
- **D-33**: Strict CSP header (R4-FG-84 deferred) — touches every page.

---

## Plan-of-record decisions for the implementation phase

1. **R5-1 commit** bundles the 15 critical items. Themes: schema/wire-format consistency (R5-FG-1 / 2 / 14 / 15), concurrency double-debit (R5-FG-3 / 4 / 5), kill-switch double-fault + missing TTL (R5-FG-6 / 7), force-release verifier-parity criticals (R5-FG-8 / 9 / 10 / 11), self-heal black holes (R5-FG-12 / 13).

2. **R5-2 commit** the ~32 high items. Major themes:
   - **handlers.ts ↔ verifier parity sweep** (R5-FG-16 / 17 / 18 / 19 / 20 / 21 / 26)
   - **Reader dedup completeness** (R5-FG-23 / 24, plus R5-FG-50 binding hardening)
   - **Orphan-id sweep** (R5-FG-25, 10 sites)
   - **Lifecycle/lock hygiene** (R5-FG-27 / 28 / 29 / 49)
   - **API-surface R4-FG-44 sibling sweep** (R5-FG-30 / 31 / 32 / 33 / 34)
   - **Build/deploy gaps** (R5-FG-35 / 36 / 37 / 38)
   - **Perf cliffs** (R5-FG-39 / 40 / 41 / 42 / 43)
   - **Topic-only DR completeness** (R5-FG-44 / 45 / 46 / 47)
   - **Test discipline (fourth recurrence)** (R5-FG-51, bundles 8 test additions)

3. **R5-3 commit** the ~32 medium items split across 2 phases by domain. Significant chunk on **observability + UX** (R5-FG-54 / 55 / 70 / 71 / 80 / 81), the rest spread across audit invariants and minor sibling sweeps.

4. **R5-4 commit** the ~16 low items, plus take some that R4 deferred (R4-FG-73 / 76 / 83).

## Open questions for the user

1. **All ~95 items in scope**, or any to prune? (R4 was "all 85" — same expectation here?)
2. **R5-1 includes wire-schema concerns (R5-FG-1, R5-FG-14, R5-FG-15)**. R5-FG-1 (slim path corrupts Merkle) is a real-money correctness issue we should ship soon. R5-FG-14 (depositTxId on rake) is a wire change — ship in R5-1 or defer to D-26 alongside `bv:1`?
3. **R5-FG-2 cutover timestamp** — set the cutoff to the R5 deploy time (so R5 adoption gates the binding-only-strict mode), or to the R4 deploy time retroactively (catch any pre-R5 testnet sessions that lacked the binding)?
4. **R5-FG-3 PreserveClaim contract enforcement** — make `processWithdrawal` etc. wrap their submit/awaitReceipt to lift any post-submit error to `PreserveClaimError`, OR wrap the wrapping at the helper level (e.g. a new `safeSubmit` helper)? Latter is more invasive but catches future writers automatically.
5. **R5-FG-51 test discipline for the FOURTH round** — the R4-0 baseline gate counts comments not actual revert-fail behavior. Should we add a CI guard that mentally reverts a sample of tagged tests and asserts each fails (a "revert-proof drill" job), OR ship strict static-analysis that catches the "mock plumbing changed but assertion didn't" pattern?
