# Round-3 Adversarial Audit — Findings + Triage

**Date:** 2026-05-06 (round 3)
**Branch:** `testnet`
**Scope:** Re-verify Round-1 (`f1..f27`) and Round-2 (`R2-FG-1..R2-FG-30`) closures + hunt new exposure, with explicit focus on double-spend / double-play / double-credit / double-loss / double-withdraw / double-refund / double-rake / double-rake-reversal.

**Methodology:** 10 background agents, one persona each:
1. P1 — Round-2 regression hunter (R2-FG-0 archetype detection)
2. P2 — Concurrency / cross-Lambda atomicity
3. P3 — Double-X explicit checklist
4. P4 — Integration boundary hunter
5. P5 — State-machine walker
6. P6 — Self-heal critic
7. P7 — API surface hunter
8. P8 — Test-quality auditor
9. P9 — Closure verifier (R1 + R2)
10. P10 — Blind-spot agent (areas R1+R2 didn't touch)

**Raw count:** ~127 findings across 10 personas. Deduplicated to **87 unique items** below: **22 critical/high → R3-1**, **30 medium → R3-2/3/4**, **35 low → R3-5/deferred**.

The dominant pattern: the R2-FG-0 archetype repeats. Multiple Round-2 fixes were applied in production code but the regression test doesn't actually drive the fix path; some fixes are partial vs the doc claim; some are outright not implemented (commit message ahead of code).

---

## Phase R3-1 — Critical (4 items)

### `[x]` R3-FG-1 (C) — Force-release route resolve-write clobbers ALL handler progress markers
**Closes:** P2-002 + P4-001 + P9-003 (three-persona corroboration). Worsens R2-FG-9.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:380` spreads `...entry` (the pre-lock snapshot from line 200) into the final `upsertDeadLetter` resolve write. Every progress marker (`settledAt`, `totalWithdrawnAt`, `historyWrittenAt`, `auditWrittenAt`, `operatorDebitedAt`, `successTriagedAt`, `ledgerAdjustedAt`) the handler stamped via the post-lock `freshEntry` is REVERTED on the final write. Subsequent re-runs of the entry (operator clears `resolvedAt`, or the play-uncertain SUCCESS triage path which intentionally retains visible state) re-execute every step → double-debit / double-burn.
**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:313` — `freshEntry` is passed to handler ✓
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:380` — resolve-write spreads `...entry` ✗ (must be `...freshEntry` or re-refresh)

**Fix:** After `applyForceRelease` returns, re-refresh + re-fetch the entry, then spread that into the resolve write. Or have `applyForceRelease` return the final progress accumulator and merge it explicitly.
**Test:** `'force-release SUCCESS preserves all handler-stamped progress markers in the final resolve write'`.

---

### `[x]` R3-FG-2 (C) — F24 `withdraw-pending:<token>` claim DEL is unfenced → operator double-pay
**Closes:** P2-003 + P5-OF-001.
**Bug:** F24 acquired `withdraw-pending:<token>` with SET-NX-EX (atomic) but releases via plain `redis.del()` at SIX sites: `uncertainTxVerification.ts:1081, 1218`, `handlers.ts:393, 533`, `MultiUserAgent.ts:1649, 1726`. The claim's TTL can naturally expire between A's acquisition and A's DEL; a fresh acquirer B's claim (different `withdrawTxId`) gets nuked by A's stale DEL. C then acquires, submits a SECOND on-chain transfer for the same token. Operator double-pay.
**Files:**
- `src/custodial/MultiUserAgent.ts:1599` — claim acquisition (no fence)
- All 6 DEL sites listed above

**Fix:** Encode the in-flight `withdrawTxId` (or a fresh UUID) as the claim VALUE; release via the lowercase `RELEASE_SCRIPT` (R2-FG-6) so DEL only fires when value matches. Persist the fence on `details.pendingClaimFence` so verifier + force-release can match it.
**Test:** `'F24 pending-claim DEL only fires when fence matches; stale verifier completion cannot nuke a fresh acquirer'`.

---

### `[x]` R3-FG-3 (C) — `validateProgressOrdering` self-heal silently corrupts ledger (REVERTS R2-FG-13)
**Closes:** P6-001 + P2-004 (two-persona corroboration). Regresses R2-FG-13.
**Bug:** R2-FG-13 made the ordering validator self-heal by back-filling unset earlier markers from the latest set marker's timestamp. The verifier's per-step gate at `uncertainTxVerification.ts:850` is `if (!progress.settledAt)` — TRUTHY check on the field value. Back-fill marks `settledAt` set with a timestamp → gate skips → `ledger.settleSpend()` NEVER RUNS. Reservation held forever, balance silently understated. The code path is realistic: any partial-Redis-failure or version-skew deploy that lands `historyWrittenAt` without `settledAt` triggers the silent skip on next pass.
**Files:**
- `src/custodial/uncertainTxVerification.ts:142-180` — `validateProgressOrdering`
- `src/custodial/uncertainTxVerification.ts:692-706` — back-fill stamp BEFORE `acquireVerifyLock` at line 709 (also a race per P2-004)

**Fix:** Don't write back-fill into the same field the gate reads. Either:
- (a) write to `*_inferred` field and have the gate check both,
- (b) require BOTH `historyWrittenAt` AND `auditWrittenAt` to be present before back-filling earlier markers (only the last 2 prove the prior steps actually ran),
- (c) escalate via `escalateUncertainDlFailure` instead of self-healing — preferred for safety.

Also acquire the verify-lock BEFORE the back-fill stamp.
**Test:** `'R2-FG-13: back-fill must NOT cause verifier to skip a real settleSpend mutation'` — entry with only `historyWrittenAt` set, mirror=SUCCESS, verifier MUST call `ledger.settleSpend` exactly once.

---

### `[x]` R3-FG-4 (C) — R2-FG-19 missing user-lock around F7 guard + on-chain submit (FIX'S OWN CLAIM IS FALSE)
**Closes:** P1-001.
**Bug:** R2-FG-19 commit message + doc say: "the guard now runs UNDER the user lock acquired upstream so `available` can't drift between the check and the on-chain submit." There is **no upstream lock**. `processRefund` runs the guard at `src/hedera/refund.ts:164`, then proceeds through mirror lookup → SET-NX-EX claim → `submitHbarTransfer/submitTokenTransfer` → `awaitReceipt` (line ~526) — all without holding `lockUser:<userId>`. The lock at line 682 is acquired only for the ledger debit AFTER the on-chain refund has already settled. Concurrent in-band play can reserve+settle between the guard and the submit: operator pays the refund AND the play.
**Files:** `src/hedera/refund.ts:134-526` (no lock around this region).
**Fix:** Acquire `lockUser:<depositRecord.userId>` at top of `processRefund` (after `getDepositByTxId`), HOLD across guard → mirror cross-check → claim → submit → awaitReceipt. The existing lock at line 682 should reuse the same fence (extend TTL via PEXPIRE if needed).
**Test:** `'processRefund holds lockUser:<userId> across guard-and-submit; concurrent reserve+settle cannot pass the guard then drain available'`.

---

## Phase R3-2 — High (18 items)

### `[x]` R3-FG-5 (H) — R2-FG-1 force-release verifier-lock LEAKS on every code path
**Closes:** P9-002.
**Bug:** R2-FG-1 said "release verifier-lock on ok=false paths". The route does NOT release the `KEY_PREFIX.verifying:<id>` lock anywhere — not on ok=true (line 404), not on ok=false (line 326), not in the catch (line 415). Every force-release call leaks the 60s TTL. Concurrent reconcile + force-release on the same id are blocked for 60s.
**Files:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:248-415`.
**Fix:** Wrap the post-lock block in try/finally; DEL `lockKey` on every exit.
**Test:** `'force-release route DELs the verifying-lock on every exit (ok / not-ok / throw)'`.

### `[x]` R3-FG-6 (H) — `creditDeposit` flush failure has no retry + no escalation
**Closes:** P1-003 + P6-004 + P9-006 (three-persona corroboration). Regresses R2-FG-30.
**Bug:** R2-FG-30 commit said "retry once + escalate via `escalateUncertainDlFailure` (extend the union to accept `'deposit_credit_flush_failed'`)". Production: no retry, no `escalateUncertainDlFailure`, union not extended. The local cache stays mutated, the lock releases with stale Redis, subsequent `replay-deposit` finds the SADD'd claim and returns early without crediting → user under-credited forever.
**Files:** `src/custodial/UserLedger.ts:194-244`; `src/lib/escalation.ts:18-22`.
**Fix:** (a) one-shot retry with ~250ms delay; (b) extend escalation kind union; (c) call `escalateUncertainDlFailure` in the catch; (d) invalidate local cache so the warm Lambda doesn't return stale balance to subsequent reads.
**Test:** `'creditDeposit flush failure retries once then pages via escalateUncertainDlFailure; subsequent replay-deposit succeeds'`.

### `[x]` R3-FG-7 (H) — R2-FG-2 SADD permanent set fails open on Redis error
**Closes:** P1-006.
**Bug:** The `KEY_PREFIX.refundedOriginals` SADD call at `src/hedera/refund.ts:838-856` (in-flight) and `1370-1386` (verifier) is wrapped in `try/catch` that ONLY logs CRITICAL and continues. If Redis is briefly unavailable on the SADD (after the on-chain refund + claim overwrite have already succeeded), the permanent gate doesn't land. After 30 days the per-tx claim TTLs out → second `processRefund` passes `sismember`+SET-NX → fires a SECOND on-chain refund. The "permanent gate" doc claim is aspirational.
**Files:** `src/hedera/refund.ts:838-856, 1370-1386`.
**Fix:** On SADD failure, write `audit_trail_orphaned` DL with `phase: 'refunded_originals_sadd_failed'` AND fire `escalateUncertainDlFailure`. Refuse to return success from the route until SADD lands (retry once, then page).
**Test:** `'processRefund SADD failure writes audit_trail_orphaned + escalates — silent fail-open is forbidden'`.

### `[x]` R3-FG-8 (H) — Verifier SUCCESS falls through after mutation throw → entry resolves with no history row
**Closes:** P5-WU-001.
**Bug:** Each step in the verifier SUCCESS branch is `try/catch/log`. Errors are swallowed; control falls through to the audit step + `markResolved`. If `recordWithdrawal` throws after `settleSpend + totalWithdrawn` succeeded, the entry is marked resolved with `historyWrittenAt` UNSET — but the topic shows the burn. Validator self-heal would back-fill on the next pass, except the entry is `resolvedAt` and never re-walked.
**Files:** `src/custodial/uncertainTxVerification.ts` SUCCESS branches (withdrawal + operator-fee + play).
**Fix:** Track a local `mutationError` flag in each SUCCESS block. If any mutation step threw, write `audit_trail_orphaned` with `phase: '<step>_failed'` and SKIP `markResolved` so the next pass retries.
**Test:** `'verifier SUCCESS does NOT mark resolved when any mutation step threw'`.

### `[x]` R3-FG-9 (H) — Refund's 5 SUCCESS post-conditions are not atomic; rake reversal failure permanently locked-out
**Closes:** P5-RU-001.
**Bug:** In-flight `processRefund` SUCCESS path runs (a) ledger debit (b) audit anchor (c) claim overwrite (d) operator rake reversal (e) permanent SADD — sequentially with logged-and-swallowed errors. If (d) throws (operator entry null, etc.) but (a/b/c/e) succeed, the operator retains the rake forever AND the SADD permanent set blocks any future retry. Cross-machine inconsistency: ledger says debit, operator says credit, topic says refund without rake reversal.
**Files:** `src/hedera/refund.ts:689-840` (in-flight SUCCESS); same pattern in `verifyUncertainRefunds`.
**Fix:** Track each post-condition with a progress accumulator (like F1's). On failure of any step, write `audit_trail_orphaned` with the exact phase, DON'T SADD until all 5 succeed. Force-release symmetry too (R3-FG-23).
**Test:** `'refund SUCCESS is all-or-none: rake-reversal failure does NOT SADD the permanent set'`.

### `[x]` R3-FG-10 (H) — `stampProgress` refresh-before-merge spreads stale top-level entry fields
**Closes:** P2-001.
**Bug:** R2-FG-12 closes the `details` overwrite race but `stampProgress` at `uncertainTxVerification.ts:608-611` still spreads `...entry` (the verifier-loop's pre-refresh snapshot) for top-level fields like `resolvedAt`, `resolvedBy`, `kind`. If a concurrent writer (force-release sibling, prior verifier pass) set `resolvedAt` between Lambda A's refresh and Lambda A's upsert, A's upsert REVERTS `resolvedAt` to undefined → next pass re-runs the entry from scratch.
**Files:** `src/custodial/uncertainTxVerification.ts:583-621`; same pattern in `handlers.ts` stamp helpers (lines 231, 421, 809).
**Fix:** Spread `...fresh` (the refreshed entry) instead of `...entry`. If `fresh.resolvedAt` is set, ABORT the stamp (someone else resolved).
**Test:** `'stampProgress preserves concurrent resolvedAt writes from a sibling writer'`.

### `[x]` R3-FG-11 (H) — Refund Lambda freeze between HCS-20 audit and SADD → second refund fires after 30-day TTL
**Closes:** P3-DR-001.
**Bug:** processRefund's order: claim 'pending' → on-chain refund → ledger debit → rake reversal → HCS-20 audit → SADD permanent set → claim overwrite. Lambda freeze between `recordRefund` (line 791) and `redis.sadd` (line 840) leaves claim 'pending' for 30 days. After TTL: sismember=0, SET-NX succeeds, second processRefund proceeds with a SECOND on-chain refund. F7+R2-FG-19 may pass if user re-deposited.
**Files:** `src/hedera/refund.ts:790-840`.
**Fix:** SADD `refundedOriginals` BEFORE the on-chain submit (right after the 'pending' claim), so any post-submit freeze still has the permanent gate set. Alternative: write a `refund_post_success_orphan` DL on SADD failure so verifier ensures SADD next pass.
**Test:** `'processRefund Lambda freeze post-HCS-pre-SADD does not allow second refund after claim TTL'`.

### `[x]` R3-FG-12 (H) — Verifier operator-fee debit bypasses `withdraw-fees` operator-lock
**Closes:** P4-005.
**Bug:** In-band `MultiUserAgent.operatorWithdrawFees` acquires `acquireOperatorLock('withdraw-fees', 120)` around the entire balance-check → transfer → state-update. The verifier's `verifyUncertainOperatorFeeWithdrawals` does the operator state debit at `uncertainTxVerification.ts:1129-1139` WITHOUT this lock — only the per-txId verifying lock. `updateOperator` is read-modify-write at the JS layer; concurrent in-band debit of a DIFFERENT token + verifier debit on the uncertain entry race on `operator.balances`. Last-write-wins → one debit lost.
**Files:** `src/custodial/uncertainTxVerification.ts:1129-1139` and force-release `handleOperatorFee` SUCCESS at `handlers.ts:413-425`.
**Fix:** Acquire `acquireOperatorLock('withdraw-fees', 60)` before `updateOperator`, release in finally. Same primitive as in-band.
**Test:** `'verifier + in-band debit on different tokens both reflected in operator balance'`.

### `[x]` R3-FG-13 (H) — MCP `resolveUserId` doesn't do eoaAddress fallback
**Closes:** P4-007.
**Bug:** HTTP routes resolve user via `getUserByAccountId(accountId)` AND fall back to `getAllUsers().find(u => u.eoaAddress.toLowerCase() === accountId.toLowerCase())`. MCP's `app/api/_lib/mcp.ts:193::resolveUserId` only does the first lookup. A user who registered with `eoaAddress` differing from auth `accountId` (EVM-form vs Hedera-form) can play via HTTP but gets "Not registered" via MCP → asymmetric per-user enforcement.
**Files:** `app/api/_lib/mcp.ts:193`; HTTP routes for comparison: `app/api/user/play/route.ts:60`, `withdraw/route.ts:88`, `strategy/route.ts:69`, `audit/route.ts:326`.
**Fix:** Extract `resolveUserByAuth(store, accountId)` shared helper; use from both sites.
**Test:** `'MCP multi_user_play resolves a user whose authenticated accountId matches their eoaAddress'`.

### `[x]` R3-FG-14 (H) — Verifier triage anchor `by: details.userId` instead of system actor
**Closes:** P4-003.
**Bug:** Both verifier and force-release write `recordControlEvent('play_uncertain_success_pending_triage', { by, ... })`. Force-release correctly passes `by: ctx.by` (operator's accountId). Verifier passes `by: details.userId` — the lottery user, who is NOT the actor. Topic-only auditors reading "who triaged this play" get a misleading attribution.
**Files:** `src/custodial/uncertainTxVerification.ts:1410`.
**Fix:** Change to `by: 'reconcile'` (or `'system:verifier'`).
**Test:** `'verifier triage anchor uses by: reconcile, not the user'`.

### `[x]` R3-FG-15 (H) — `handleRefund` records `to: agentAccountId` self-loop instead of `entry.sender`
**Closes:** P4-002.
**Bug:** Verifier's refund anchor records `from: agentAccountId, to: entry.sender` (the original deposit sender — meaningful). Force-release sibling at `handlers.ts:892` records `to: details.agentAccountId` (self-loop with comment "sender unknown at force-release time"). But `entry.sender` IS available on the dead-letter row. Asymmetric; force-release anchors are meaningless tautologies.
**Files:** `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:892`.
**Fix:** Use `entry.sender` (when present); refuse SUCCESS if both `agentAccountId` and `sender` are missing.
**Test:** `'force-release refund SUCCESS records to: entry.sender, not the agent'`.

### `[x]` R3-FG-16 (H) — F4 Infinity-check missing in refund verifier (settleSpend(Infinity) zeros user balance)
**Closes:** P9-004.
**Bug:** R1's F4 added `isValidDetailAmount` (`Number.isFinite && >= 0`) at every read site of withdrawal / operator-fee / play verifier. Refund verifier (`refund.ts::verifyUncertainRefunds`) at lines 1182 and 1285 still uses only `typeof === 'number'`. Infinity is a number → `available - Infinity = -Infinity` → `Math.max(0, -Infinity) = 0` → silently zeros the user's available balance.
**Files:** `src/hedera/refund.ts:1182, 1285`.
**Fix:** Import / duplicate `isValidDetailAmount`; replace both checks.
**Test:** `'verifyUncertainRefunds rejects Infinity humanAmount as malformed'`.

### `[x]` R3-FG-17 (H) — F17 in-band audit-failure paths missing escalation
**Closes:** P9-001.
**Bug:** `MultiUserAgent.ts:1392-1413` (in-band withdrawal audit), `1754-1772` (in-band operator-fee audit), `430-449` (strategy change audit) write `audit_trail_orphaned` DLs but DON'T call `escalateUncertainDlFailure`. The escalation kind union only accepts the four `*_uncertain` kinds — couldn't page even if they wanted to.
**Files:** `src/custodial/MultiUserAgent.ts` (3 sites); `src/lib/escalation.ts:18-22` (kind union).
**Fix:** Extend the kind union to accept `'audit_trail_orphaned'` (or a generic `'cause'` sentinel), call escalation in all 3 catch blocks.
**Test:** `'in-band withdrawal audit-write failure escalates via webhook'`.

### `[x]` R3-FG-18 (H) — Idempotency keys not network-scoped (testnet/mainnet collide)
**Closes:** P7-001.
**Bug:** `src/lib/idempotency.ts:88` builds `fullKey = \`idem:${scope}:${key}\`` with NO `KEY_PREFIX` (lla:${NET}:...). Every other Redis primitive in the codebase uses `KEY_PREFIX.*`. Testnet+mainnet sharing one Upstash (the documented topology) collide on the same idempotency key. An operator who reuses an Idempotency-Key on both networks would get the OTHER network's cached response.
**Files:** `src/lib/idempotency.ts:88`; `src/auth/redis.ts` (KEY_PREFIX block).
**Fix:** Add `idempotency: \`lla:${NET}:idem:\`` to `KEY_PREFIX`; use it.
**Test:** `'idempotency key under testnet does NOT serve cached result for the same key under mainnet'`.

### `[x]` R3-FG-19 (H) — `agentSeqSeedFailed` is per-process, not per-cluster
**Closes:** P5-AS-001.
**Bug:** In-process `Set` flag. Lambda A marks seed failed (mirror hiccup); Lambda B (warm, seeded earlier) keeps INCRing successfully. Inconsistent UX, no escalation. Cross-Lambda visibility doesn't exist.
**Files:** `src/custodial/AccountingService.ts` (the `agentSeqSeedFailed` set).
**Fix:** Move to Redis with TTL (10 min) so all Lambdas see the same failure state and recover together. Or drop the seed-failed gate entirely after the seed step (Redis INCR is monotonic post-seed).
**Test:** `'agentSeq seed failure state is visible across Lambdas via Redis'`.

### `[x]` R3-FG-20 (H) — Token registry cache poisoning from one mirror failure → silent decimals corruption forever
**Closes:** P10-TOK-001.
**Bug:** `src/utils/math.ts:42-55` `getTokenMeta` catches mirror failure and writes `{decimals: 0, symbol: tokenId}` PERMANENTLY into cache. Every subsequent op on that token computes `Math.round(amount * 10^0)` → user receives whole-token amounts (or integer base units with no decimals scaling). Process restart required to clear. Vercel warm Lambdas carry the poison across many user requests.
**Files:** `src/utils/math.ts:42-55`.
**Fix:** Don't cache the failure. Either rethrow so callers fail loudly, or cache with `{value, cachedAt}` + 60s TTL.
**Test:** `'token registry survives a transient mirror failure on first lookup; second lookup re-resolves correctly'`.

### `[x]` R3-FG-21 (H) — Test-quality regression class (R2-FG-0 archetype repeating)
**Closes:** P8-001 (R2-FG-12 test decorative) + P8-002 (F1 lost-update test decorative) + P8-007 (refund.test sismember mock no-op) + P8-013 (R2-FG-24 cross-check test only fail-closed).
**Bug:** Four R2 tests would survive a full revert of the production fix:
- `R2-FG-12 test` (uncertainTxVerification.test.ts:812) plants `verificationAttempts: 7` BEFORE verifier runs; loop's `entry` already contains it.
- `F1 lost-update test` (line 616) asserts the OUTPUT structure but production accumulates `progress` locally and passes whole accumulator to each stamp call.
- `refund.test.ts:563-566 sismember mock` is hard-coded `() => 0` — masks any future "skip if already in set" check.
- `R2-FG-24 cross-check test` (refund.test.ts:367-427) only proves the 404 fail-closed path; the actual transfer-amount logic at lines 218-260 is never exercised.

**Files:** as listed above.
**Fix:** For each: inject the actual race / planted state the production code is supposed to defend against; assert that reverting the fix would produce the wrong observable outcome.
**Test:** the tightened versions.

### `[x]` R3-FG-22 (H) — Triage anchor + `successTriagedAt` stamp + route resolveAt split across writes; `recordControlEvent` not body-idempotent
**Closes:** P5-PU-001.
**Bug:** Verifier path: `recordControlEvent` succeeds → escalation → final `upsertDeadLetter` with `resolvedAt + successTriagedAt`. If only the final write throws, the anchor IS on the topic AND the entry stays unresolved → next pass re-emits the anchor → DUPLICATE topic anchor for the same tx. Force-release path: anchor + stamp + route's resolvedAt are 3 separate writes; partial failures leave inconsistent terminal shapes between paths.
**Files:** `src/custodial/uncertainTxVerification.ts:1452`; `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts handlePlay`.
**Fix:** Bundle `successTriagedAt` stamp into the route's final resolve write (one upsert). Add body-level dedup to `recordControlEvent` (include `uncertainTxId` + writer phase as a dedup key the reader honors).
**Test:** `'play_uncertain SUCCESS triage emits exactly one topic anchor across verifier + force-release retries'`.

---

## Phase R3-3 — Medium (refund / state-machine / API surface; ~14 items)

### `[x]` R3-FG-23 (M) — Force-release `handleRefund` SUCCESS missing SADD permanent set
**Closes:** P3-DR-003. Refund SUCCESS writes claim overwrite at `handlers.ts:988` but doesn't SADD `refundedOriginals` (verifier + processRefund both SADD). After 30-day claim TTL, a fresh refund attempt for the same originalTxId passes sismember=0 and fires a second on-chain refund.
**Fix:** Mirror the verifier's SADD line at `refund.ts:1370-1386` into the force-release SUCCESS branch.

### `[x]` R3-FG-24 (M) — Force-release `handleRefund` SUCCESS missing the F7+R2-FG-19 available-balance pre-check
**Closes:** P3-DS-001. Force-release SUCCESS uses `Math.max(0, available - humanAmount)` clamp at `handlers.ts:860` — silently swallows underflow. Should mirror processRefund's `available >= netAmount` refusal.
**Fix:** Add the guard.

### `[x]` R3-FG-25 (M) — `processRefund` queue path drops rake reversal info
**Closes:** P3-DRR-001. `queuePendingLedgerAdjustment` queues only the user-balance debit; `drainPendingLedgerAdjustments` doesn't apply rake reversal. Operator silently retains rake.
**Fix:** Persist `rakeReversal: { token, amount }` in queued payload; drain applies both legs.

### `[x]` R3-FG-26 (M) — Audit-orphan id collisions WITHIN force-release on retry
**Closes:** P2-005 + P4-009 + P5-AT-001. Six force-release sites use `audit-orphan:force-release:${entry.transactionId}` — repeated audit failures clobber prior orphan history.
**Fix:** Salt by phase + timestamp: `audit-orphan:force-release:${phase}:${entry.transactionId}:${Date.now()}-${rand}`.

### `[x]` R3-FG-27 (M) — Killswitch HCS timeout writes no DL row + no escalation
**Closes:** P1-002 + P6-005 + P9-005 (3-persona). R2-FG-25 doc said write `audit_trail_orphaned` + flip Redis. Production only logs.
**Fix:** Add `upsertDeadLetter('audit_trail_orphaned', ...)` + `escalateUncertainDlFailure` in the timeout branch.

### `[x]` R3-FG-28 (M) — Killswitch `Promise.race` doesn't `AbortSignal` the HCS submit
**Closes:** P2-006 + P5-KS-001 + P5-KS-002. The HCS write keeps running in background after timeout fires; can emit anchor AFTER orphan is written → duplicate anchor + orphan for one engagement.
**Fix:** Pass `AbortSignal` into `recordControlEvent`. Or SET-NX an idempotency claim before the race so duplicate emissions are no-ops.

### `[x]` R3-FG-29 (M) — Reconcile cron operator-lock TTL 300s shorter than worst-case mirror walk
**Closes:** P2-010. 50 DLs × 8s mirror timeout = 400s; lock TTLs out at 300s → concurrent reconcile.
**Fix:** Heartbeat `PEXPIRE` every 30s, OR bound mirror walk via parallelism + per-batch budget.

### `[x]` R3-FG-30 (M) — `registerUser` doesn't flush before returning + sibling Lambda's `getUserByMemo` hits stale cache
**Closes:** P2-009. First deposit lands in `unmatched_memo` DL on a sibling Lambda.
**Fix:** `await store.flush()` before return; force `refreshUserIndex` at top of pollOnce.

### `[x]` R3-FG-31 (M) — TxId regex inconsistency between modules
**Closes:** P4-006. `userOps.ts:101` accepts `0.0.X-T-N` and `0.0.X@T.N`; `force-release/route.ts:111` and `parseTxIdTimestamp` only accept `@`. Replay succeeds with dash, force-release rejects later.
**Fix:** Normalize to canonical `@` form at userOps boundary, OR pick one form everywhere.

### `[x]` R3-FG-32 (M) — `replayDeposit` collapses 5+ skip reasons into "already_processed"
**Closes:** P4-004. Operator sees "already_processed" for tx-not-success, no-memo, no-user-match, validation-failed — false success signal.
**Fix:** Discriminated union return from `processTransaction`; propagate specific reason through replayDeposit + route response.

### `[x]` R3-FG-33 (M) — User deregistration with open `play_uncertain` → permanent wedge
**Closes:** P5-PU-002. Reservations gone with user, DL row stuck (F15 refuses force-release, manual reconstruction fails because user undefined).
**Fix:** Block deregister if any unresolved `play_uncertain` for userId, OR have manual reconstruction tooling write `audit_trail_orphaned` when user gone.

### `[ ]` R3-FG-34 (M) — Refund `failed:<txid>` claim has no documented reverse path → permanent lockout
**Closes:** P5-RC-001 + P5-RU-002. R2-FG-11 refuses to overwrite, but no admin endpoint to legitimately advance from `failed:<txid>` back to clear. Mirror reclassification (rare) leaves the on-chain refund invisible to the audit trail.
**Fix:** Add `POST /api/admin/refund-claim/:id/clear-failed` requiring operator tier + reason + HCS-20 `refund_claim_cleared` control event.

### `[x]` R3-FG-35 (M) — `recoverStuckPrizesForUser` snapshot of `affectedSessions` is stale
**Closes:** P5-PT-001. Concurrent play creates a NEW prize_transfer_failed DL between snapshot and contract tx; recovery resolves only the snapshot's DLs while `transferAllPrizes` empties ALL pending → phantom unresolved DLs.
**Fix:** Re-read DL list AFTER contract tx; resolve all `prize_transfer_failed` for user with timestamp ≤ contractTxTimestamp. OR hold per-user lock through the entire recovery (verify it spans the contract call).

### `[x]` R3-FG-36 (M) — Aborted session pool count mismatch only WARNS, should be `corrupt`
**Closes:** P5-SR-002. `closed_success` branch promotes pool-count mismatch to `corrupt`; `closed_aborted` branch only logs warning. Topic-only auditor sees clean abort despite count mismatch.
**Fix:** Match the closed_success behavior — promote count/merkle mismatch in aborted to `corrupt`.

### `[x]` R3-FG-37 (M) — `migrate-schema` operator-lock leaks on early throw
**Closes:** P7-002. `acquireOperatorLock(..., 600)` is followed by `await Promise.all([refreshUserIndex(), refreshOperator()])` — outside the inner try/finally. Refresh failure leaves lock held for 10 min.
**Fix:** Wrap the entire post-acquire block in try/finally (or use a `withOperatorLock` helper).

### `[ ]` R3-FG-38 (M) — Rate-limit fires BEFORE auth → unauthenticated DoS exhausts admin's IP bucket
**Closes:** P7-003. Admin from a NAT'd corporate IP gets 429'd because an attacker on the same NAT exhausted the IP-keyed limit.
**Fix:** Run `requireTier` first; rate-limit by `auth.accountId` for tiered routes.

### `[x]` R3-FG-39 (M) — Killswitch route has no rate limit + no idempotency
**Closes:** P7-004. Compromised admin token (or buggy script) can flood HCS topic with thousands of enabled/disabled events.
**Fix:** Add `checkRateLimit({action: 'admin-killswitch', limit: 5/60s, identity: auth.accountId})`. Skip HCS write if `enabled === current` (idempotent flip).

### `[x]` R3-FG-40 (M) — Force-release operator-tier unreachable from web admin UI
**Closes:** P7-006. If only `ADMIN_ACCOUNTS` is set (common testnet topology), the dashboard's "Force Release" button is dead (403). Killswitch precedent already downgraded to admin tier.
**Fix:** Either downgrade to `admin` tier matching killswitch, OR document `OPERATOR_ACCOUNTS` requirement in mainnet checklist + hide the UI button for non-operator sessions.

---

## Phase R3-4 — Medium (deployment / availability / blind-spot; ~10 items)

### `[x]` R3-FG-41 (M) — `/api/admin/refund` missing Idempotency-Key header
**Closes:** P7-009. Asymmetric with `/api/admin/withdraw-fees` which mandates it.
**Fix:** Match withdraw-fees: require `Idempotency-Key`, wrap `processRefund` in `withIdempotency`.

### `[x]` R3-FG-42 (M) — `/api/admin/monitoring` mirror walk has no fetch timeout
**Closes:** P7-010. Slowloris mirror response can hang Lambda for full 60s budget.
**Fix:** `signal: AbortSignal.timeout(8000)` per-fetch + outer 20s race.

### `[x]` R3-FG-43 (M) — `AUTH_PAGE_ORIGIN` testnet fallback on misconfigured mainnet → cross-network signature replay
**Closes:** P10-AUTH-002 + P10-PROD-001. `getAudience()` defaults to testnet origin. Mainnet deploy without env set accepts captured testnet signatures.
**Fix:** In production, require `AUTH_PAGE_ORIGIN` non-empty + starts-with-https + matches HEDERA_NETWORK; fail boot otherwise. Add to `assertProductionRedis`.

### `[x]` R3-FG-44 (M) — `/api/auth/refresh` silently demotes locked sessions to TTL'd
**Closes:** P10-AUTH-001. `refreshSession` calls `destroySession + createSession`; `createSession` always sets 7-day TTL even if source was `locked: true`.
**Fix:** Detect `session.locked`, re-call `lockSession(newToken)` after creation; OR refuse refresh on locked sessions (409).

### `[ ]` R3-FG-45 (M) — Frontend session tokens in `localStorage`; no CSP header
**Closes:** P10-FE-001. Third-party CDN (Google Fonts) compromise reads every session token (including locked-permanent ones).
**Fix:** Move to `httpOnly + secure + samesite=lax` cookie set by `/api/auth/verify`. Add strict CSP header.

### `[x]` R3-FG-46 (M) — HCS-20 v2 `play_pool_result` size cap throws on multi-byte symbols → session marked `corrupt`
**Closes:** P10-HCS-001. Successful on-chain play with NFT prize having Japanese / accented symbol blows past 1024-byte budget; submit throws → session aborted/corrupt by reader.
**Fix:** Pre-flight size check; emit fallback minimal pool message (drop strategyMeta, truncate sym, page large `ser` lists across `play_pool_result_part_N` messages).

### `[x]` R3-FG-47 (M) — MCP client singleton + retry leaks transports
**Closes:** P10-MCP-001. Failed first call leaves a transport handle reference that may pin Lambda warm slot to broken transport.
**Fix:** `try { await mcpClient?.close(); } catch {}` before re-nulling.

### `[x]` R3-FG-48 (M) — Escalation not idempotent → operator alert fatigue
**Closes:** P10-ESC-001. Every reconcile pass on a stuck DL re-fires the page (no dedup key). 24+ identical pages per day for the same incident.
**Fix:** Track "last escalated for this uncertainTxId" in Redis with 6h TTL; skip if key exists.

### `[ ]` R3-FG-49 (M) — Reader-level F18 dedup gap (only verify-audit dedups)
**Closes:** P9-007. `hcs20-reader.ts::parseV1Burn` preserves withdrawTxId but doesn't dedup. Dashboard audit page double-counts duplicate burns.
**Fix:** Move dedup logic from verify-audit into the reader's pass-2 reducer; expose deduped event stream + duplicates-detected stat.

### `[x]` R3-FG-50 (M) — Phantom-mint check toothless without `--agent`
**Closes:** P9-008. Agent flag is OPTIONAL; without it, the recipient check is skipped → cross-check passes for any incoming positive transfer of right amount to ANY account.
**Fix:** Refuse to run cross-check unless `--agent` provided, OR auto-resolve agent from a topic-embedded operator metadata anchor.

### `[ ]` R3-FG-51 (M) — `recordRake` schema lacks `originalDepositTxId` (R2-FG-22 per-deposit gap)
**Closes:** P9-009. R2-FG-22 doc requested per-deposit cross-check; impossible without schema field. Per-user sum-bound is a weaker substitute.
**Fix:** Add `originalDepositTxId` to rake message body (small wire change); implement per-deposit map.

### `[ ]` R3-FG-52 (M) — F24 claim not keyed by `withdrawTxId` (verifier DEL clobbers concurrent in-band acquire)
**Closes:** P5-OF-001. Subset of R3-FG-2 but specifically for the F24 path where the value sentinel is a fixed string.
**Fix:** (Same as R3-FG-2) — use `withdrawTxId` as claim VALUE, compare-and-delete via `RELEASE_SCRIPT`.

### `[x]` R3-FG-53 (M) — R2-FG-25 disable path silently degrades on anchor timeout
**Closes:** P5-KS-002. Same shape as R3-FG-27 but for the disable side; no DL written.
**Fix:** Same as R3-FG-27 — orphan + escalation on timeout.

### `[x]` R3-FG-54 (M) — `bumpUserLockContentionAttempts` local-only fallback misses cross-Lambda contention by design
**Closes:** P6-006. Redis INCR fallback to local entry counter — each Lambda only counts its own observations. Page threshold (6) never crossed; runaway play wedges verifier indefinitely.
**Fix:** On INCR failure, escalate eagerly OR maintain per-Lambda counter that pages at MAX/2.

---

## Phase R3-5 — Low (~30 items, polish + hardening)

### `[ ]` R3-FG-55 (L) — Force-release `successTriagedAt` clearance has no audit / no guard
**Closes:** P6-003. Documented escape hatch — operator with Redis REST creds can clear, force-release, release reservations, user re-plays same money.
**Fix:** Dedicated `clear-triage` admin endpoint with explicit reason + HCS-20 anchor.

### `[ ]` R3-FG-56 (L) — Test tightenings (10 mediums from P8)
P8-003/004/005/008/009/010/011/012/014/015 — assertion gaps that don't catch the regression they claim to. Each gets a tightening; bundled here for backlog grooming.

### `[ ]` R3-FG-57 (L) — `processWithdrawal` default `'hbar'` masks missing token data
**Closes:** P4-008. Drop the default; require explicit token.

### `[ ]` R3-FG-58 (L) — `bumpVerificationAttempts` spreads stale entry top-level
**Closes:** P2-011. Same shape as R3-FG-10; concurrent force-release-resolve gets reverted by malformed-attempt bump.

### `[ ]` R3-FG-59 (L) — Deposit-spam rate cap key reads env at runtime, splits across env mutations
**Closes:** P2-008. Use `KEY_PREFIX.dlRate` const instead.

### `[ ]` R3-FG-60 (L) — A2A allows `auth_token` in params bypassing Bearer header
**Closes:** P7-007. Strip `auth_token` from params before merging.

### `[ ]` R3-FG-61 (L) — `/api/auth/lock` accepts `sessionToken` body without Bearer proof
**Closes:** P7-008. Require Bearer matching the body's session.

### `[ ]` R3-FG-62 (L) — User EOA fallback can leak across users in misconfig
**Closes:** P7-011. Skip EOA fallback when accountId matches Hedera ID format.

### `[ ]` R3-FG-63 (L) — Cron rate-limit identity 'cron' shared with admin reconcile route
**Closes:** P7-012. Bucket by source IP; admin reconcile has its own bucket.

### `[ ]` R3-FG-64 (L) — Unknown-token DL spam path bypasses R2-FG-28 rate cap
**Closes:** P9-010. Apply `shouldRateLimitDlForUser` when memo resolves to a known user on the unknown-token path too.

### `[ ]` R3-FG-65 (L) — HOL registers MCP only — A2A clients invisible
**Closes:** P10-HOL-001. Send `communicationProtocol: 'BOTH'` or two registrations.

### `[ ]` R3-FG-66 (L) — Discovery cache 600s for fee tiers — slow to update on incident
**Closes:** P10-HOL-002. Drop to 30s for fee/limit fields.

### `[ ]` R3-FG-67 (L) — Token registry NaN propagation from string decimals
**Closes:** P10-TOK-002. Validate `Number.isInteger(parsed) && >= 0` before caching.

### `[ ]` R3-FG-68 (L) — `registerToken` doesn't validate token-id format
**Closes:** P10-TOK-003. Validate `^0\.0\.\d+$`; refuse boot if invalid.

### `[ ]` R3-FG-69 (L) — MCP API key has no rotation path
**Closes:** P10-MCP-002. Read env on each `callTool`; rebuild transport on change.

### `[ ]` R3-FG-70 (L) — `truncateError` can split UTF-8 mid-byte
**Closes:** P10-HCS-002. Codepoint-safe truncator.

### `[ ]` R3-FG-71 (L) — agentSeq seed-restart skip indistinguishable from missing-message gap
**Closes:** P5-AS-002. Emit `agent_seq_seed` control event on skip; reader suppresses gap warning across that range.

### `[ ]` R3-FG-72 (L) — strategy_change ordering audit attribution drift
**Closes:** P2-012. Observation only; documented.

### `[ ]` R3-FG-73 (L) — Force-release transient-mirror-error visibility gap
**Closes:** P4-010. Add `bumpForceReleaseTransientAttempts` counter or document explicitly.

### `[ ]` R3-FG-74 (L) — `processWithdrawal` 1e9 cap bypassable via direct domain call
**Closes:** P4-011. Move validation into `MultiUserAgent.processWithdrawal`'s entry guard.

### `[ ]` R3-FG-75 (L) — In_flight session boundary flap
**Closes:** P5-SR-001. Stable "as-of" timestamp at top of reader run + hysteresis margin.

### `[ ]` R3-FG-76 (L) — Replay tooling can't tell which writer's params to honor for orphans
**Closes:** P5-AT-002. Document "prefer most recent by timestamp".

### `[ ]` R3-FG-77 (L) — `validateProgressOrdering` doesn't validate ISO-8601 timestamp format
**Closes:** P6-007. Reject (return `{}` + escalate) if marker value isn't a plausible timestamp.

### `[ ]` R3-FG-78 (L) — Concurrent self-heal back-fills DIFFERENT timestamps from race
**Closes:** P6-008. Acquire verify-lock BEFORE back-fill stamp.

### `[ ]` R3-FG-79 (L) — Cron webhook fire-and-forget no AbortSignal
**Closes:** P10-CRON-002. Add 5s timeout for parity with escalation.

### `[ ]` R3-FG-80 (L) — `LAZYLOTTO_MCP_URL` not validated at boot
**Closes:** P10-PROD-002. Add to boot-fail asserts.

### `[ ]` R3-FG-81 (L) — `mcpUrl` not cleared on disconnect (frontend)
**Closes:** P10-FE-002. Add to `clearSession` cleared-keys list.

### `[ ]` R3-FG-82 (L) — `.agent-config.json` written without restrictive permissions
**Closes:** P10-HOL-003. `mode: 0o600`.

---

## Deferred (12 items — out of round-3 scope, file for follow-up)

- **D-1**: HCS-20 wire-schema additions (rake `originalDepositTxId`, agent_seq_seed control event) require dApp coordination
- **D-2**: Move session tokens off localStorage end-to-end (frontend rewrite)
- **D-3**: Strict CSP header (touches every page, must allow Wallet Connect SDK origins)
- **D-4**: Reconcile parallelism + heartbeat refactor
- **D-5**: Per-deposit rake reversal accounting (depends on D-1)
- **D-6**: HOL dual-protocol registration scheme (depends on broker support)
- **D-7**: Killswitch idempotency claim layer
- **D-8**: Reader-level F18 dedup migration (changes consumer contract for dashboard)
- **D-9**: `agentSeqSeedFailed` Redis migration
- **D-10**: Force-release tier downgrade to admin (operational decision required)
- **D-11**: `play_pool_result` chunking for oversize messages (HCS-20 spec change)
- **D-12**: Token registry retry-with-backoff (TTL'd negative cache vs throw — design choice)

---

## Plan-of-record decisions for the implementation phase

1. **R3-1 commit** bundles the four critical items. R3-FG-1 + R3-FG-3 + R3-FG-2 are interlocking (entry lifecycle + lock fence + self-heal); R3-FG-4 is independent but same severity.
2. **R3-2 commit** bundles the 18 high items. Roughly: (a) refund verifier symmetry + missing escalation calls, (b) verifier SUCCESS atomicity, (c) idempotency-key namespace, (d) MCP / triage / handle-refund parity, (e) test-quality tightenings (R3-FG-21 covers four tests).
3. **R3-3 + R3-4 commits** split the 27 mediums into two phases by domain (refund/state-machine vs deployment/availability).
4. **R3-5 commit** the 28 lows. Many are 1-3 line changes that can batch.
5. **Deferred** items get filed as GitHub issues at end of round.

## Open questions for the user
1. **Approve all 82 fix-now items** or prune any?
2. **Phase grouping** — R3-1/2/3/4/5 above, or different?
3. **R3-FG-3 self-heal direction** — back-fill safer-mode (require `historyWrittenAt + auditWrittenAt`), OR rip out self-heal entirely and go back to F4's escalate-on-incoherent-markers? The latter is safer but reverts a Round-2 fix.
4. **R3-FG-40 / D-10 force-release tier** — downgrade to admin (matches killswitch precedent), or require operator + document?
5. **Test-runner discipline** — should we adopt a CI guard that REJECTS any new fix without a regression test that fails on revert? The R2-FG-0 pattern is now a third-time repeating issue.
