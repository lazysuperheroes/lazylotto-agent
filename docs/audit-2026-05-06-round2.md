# 2026-05-06 Audit — Round 2 Fix Tracking

**Branch:** `testnet` · **Round-1 baseline:** `27afc82` (Phase 5 complete, all 27 round-1 fixes closed)

Recovery doc for the second multi-persona adversarial audit. Round 1
shipped 27 fixes; round 2 found that 4 of those fixes (F7/F8/F9/F11)
have **decorative tests** that don't actually exercise the production
code, plus introduced 4 critical findings + ~25 high findings + an
attack chain that defeats the DR promise.

## Round-2 vs round-1
- Round 1: F1–F27 (27 fixes, 5 phases). Tracker: `docs/audit-2026-05-06-fixes.md`.
- Round 2: R2-FG-0 through R2-FG-55 (45 deduped fix groups; 30 fix-now, 15 defer). This file.

## Status legend
- `[ ]` pending
- `[~]` in progress
- `[x]` done (implemented + test green)
- `[-]` deferred (to follow-up branch)
- `[!]` blocked / needs decision

## Severity legend
- **C** critical · **H** high · **M** medium · **L** low

## Plan-of-record decisions
- All 30 fix-now items in scope (R2-FG-0 through R2-FG-30).
- Phase order R2-0 → R2-1 → R2-2 → R2-3 → R2-4 → R2-5. One commit per phase.
- R2-0 is a verification prerequisite — confirm Phase-2 fixes (F7/F8/F9/F11)
  actually work in production code by replacing the 5 decorative tests
  with real integration tests. If a test reveals an underlying fix is
  regressed, treat it as a new round-2 finding (option (b)) rather than
  re-opening the round-1 tracker.
- R2-FG-3 + R2-FG-4 (phantom mint/burn cross-checks) must include a
  parallel-fetch + per-tx cache layer in `verify-audit.ts` so cross-check
  cost scales sub-linearly on large topics.
- Tests-first per item. Each fix gets a regression test that fails on
  `27afc82`, then the fix that makes it pass.

---

## Phase R2-0 — Verification prerequisite (1 item)

### `[ ]` R2-FG-0 (Prereq) — Replace decorative Phase-2 tests with real integration tests
**Closes (P6):** 5 cheat tests (F11, F4-Infinity, F7, F8, F9) + 4 weak tests
(F4-non-finite, operator-fee FAILED no-op, F12 play SUCCESS, play FAILED).

**Why prereq:** P6 found that the F7/F8/F9/F11 tests don't actually drive
`processRefund` / `verifyUncertainRefunds`. Reverting any of those fixes
would not fail any test. The fixes may be correct, but we have zero
regression coverage. Build real coverage first; if any newly-rigorous test
fails on current code, the underlying fix is regressed and goes into the
fix-now stream as a new round-2 item.

**Test scope:**
- F11: drive `processRefund` with a store fake where `isDepositCredited` returns true but `getDepositByTxId` returns undefined. Assert throw before any on-chain call.
- F7: drive `processRefund` with `available + reserved < netAmount`. Assert "partially or fully consumed".
- F8: memo-collision integration test — `getDepositByTxId` returns user `bob`, `getUserByMemo(memo)` returns user `alice`. Assert refund debits `bob`.
- F9: refund SUCCESS path with `rakeAmount=5`. Assert operator balance debited by 5 AND `recordRefund` called with `rakeReversed=5`.
- F4-Infinity: plant a SUCCESS mirror response so the bug WOULD trigger settleSpend(Infinity) without F4. Assert reserve stays finite + verificationAttempts increments.
- Tighten 4 weak tests with stronger assertions per P6 recommendations.

**Acceptance:** Either (a) all new tests pass on `27afc82`, confirming
the fixes work — proceed to R2-1, OR (b) some test fails on `27afc82`,
file as new round-2 fix-now items, fix in this phase.

---

## Phase R2-1 — Critical (4 items, close the chain attack)

### `[ ]` R2-FG-1 (C) — Force-release handlers acquire `lockUser:<userId>`
**Closes:** C2-1 = X-01, X-02, X-03, X-04 (P4) + P1, P2 R-05, P3 B-11. The dominant round-2 finding.

**Bug:** F12's force-release handlers (`handlers.ts`) mutate per-user
state — `settleSpend`, `updateBalance(totalWithdrawn += amount)`,
`recordWithdrawal`, refund debit, rake reversal, play_uncertain
reservation release — without acquiring `lockUser:<userId>`. F23 added
the lock to the verifier path; F12 created a parallel mutation path
that didn't inherit the invariant.

**Files:**
- `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts` — wrap mutation blocks in `acquireUserLock` / `releaseUserLock` with same backoff pattern as `tryAcquireUserLockForVerify`.
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts` — release verifier-lock on `ok=false` paths (currently leaks until 60s TTL on 503/409/400).

**Test:** `'force-release withdrawal SUCCESS contends with concurrent in-band withdraw via per-user lock'` — start in-band withdraw holding `lockUser:U`, fire force-release, assert handler returns 409 (or waits) instead of double-mutating. Same for refund + play FAILED branches.

---

### `[ ]` R2-FG-2 (C) — Refund claim semantics: permanent SADD set
**Closes:** C2-2 = S-04 + B-17 + S-03.

**Bug:** F10's `failed:<refundTxId>` claim has 30-day TTL. After expiry,
a retry of `processRefund(originalTxId)` passes SET-NX-EX → second
on-chain transfer. No recovery once duplicate lands. Plus B-17:
force-release SUCCESS overwrites a `failed:` marker without warning.
S-03: arbitrary string in claim slot is interpreted as "already refunded"
which leaks confusing operator messages.

**Files:**
- `src/auth/redis.ts` — add `KEY_PREFIX.refundedOriginals` (no TTL).
- `src/hedera/refund.ts:processRefund` — gate on BOTH the SET-NX-EX claim AND the SADD set.
- After confirmed-success path, `redis.sadd(KEY_PREFIX.refundedOriginals, originalTxId)`.
- Force-release SUCCESS overwrite: refuse if existing claim starts with `failed:`; require explicit operator clear.
- Validate claim value against allowlist (`pending` / `failed:<txid>` / `<txid>`); arbitrary strings → "unexpected state, investigate".

**Test:** `'second processRefund call after claim TTL expiry rejects via permanent refunded-originals set'`.

---

### `[ ]` R2-FG-3 (C) — Phantom-mint cross-check tightening
**Closes:** C2-3 = TR-02 + TR-08.

**Bug:** F21's check is `tx.result === 'SUCCESS'` only. Doesn't verify
transfer direction (incoming to agent vs outgoing), recipient, or
amount. Operator with topic submit key can mint phantom credits
referencing any historical SUCCESS tx — even an outflow from agent.

**Files:**
- `src/scripts/verify-audit.ts:483-538` — extend cross-check:
  - For HBAR mints: `tx.transfers` contains `{ account: agentAccountId, amount: > 0 }` matching `mint.amt × 10^8`.
  - For HTS mints: `tx.token_transfers` contains matching `{ account, token_id, amount }`.
  - Temporal sanity: `tx.consensus_timestamp ∈ [message_ts - 5min, message_ts + 60s]`.
  - Mismatch → critical alerts (`phantom_mint_amount_mismatch`, `phantom_mint_wrong_recipient`, `phantom_mint_outflow`, `phantom_mint_temporal`).

**Plus parallel-fetch + cache layer** (per user direction): batch mirror lookups in groups of 10 with `Promise.all`; per-txId cache so repeat-cross-checks within a single audit run hit memory not network.

**Test:** `'verify-audit flags phantom mint with wrong recipient/amount/direction/temporal'`.

---

### `[ ]` R2-FG-4 (C) — Phantom-burn cross-check (extend F21 to burns)
**Closes:** C2-4 = TR-03.

**Bug:** F21's commit said "same check for ... withdraw burns once F18
lands" — never implemented. Any `withdrawal` / `operator_withdrawal`
burn can claim any real on-chain `withdrawTxId` with no validation.
Compromised operator can debit any user any amount.

**Files:**
- `src/scripts/verify-audit.ts` — for every `withdrawal` and `operator_withdrawal` event with `withdrawTxId`, fetch the on-chain tx and assert SUCCESS + outgoing transfer FROM agent matching amount + recipient claim.
- Pre-F18 burns (no `withdrawTxId`) cannot be cross-checked — emit warning per occurrence.
- Reuse the parallel-fetch + cache layer from R2-FG-3.

**Test:** `'verify-audit flags burn referencing tx where transfer direction was incoming, not outgoing'`.

---

## Phase R2-2 — High (force-release / verifier symmetry; 7 items)

### `[ ]` R2-FG-5 (H) — F14 verifier path stamp-before-mutate
**Closes:** G-02 (P1) + R-06.

**Bug:** F14's stamp-before-mutate ordering landed in `handlers.ts` but
NOT in the verifier (`uncertainTxVerification.ts:verifyUncertainOperatorFeeWithdrawals`
SUCCESS branch still does `updateOperator → stampProgress`). Lambda
freeze between mutate and stamp → next pass debits again.

**Files:** `src/custodial/uncertainTxVerification.ts:verifyUncertainOperatorFeeWithdrawals` — swap order to stamp-before-mutate; mirror the orphan write on mutation failure.

**Test:** `'verifyUncertainOperatorFeeWithdrawals SUCCESS: stamp written before store.updateOperator'`.

---

### `[ ]` R2-FG-6 (H) — F25/F26 Lua case-mismatch
**Closes:** R-01 + R-02 (partial overlap with B-03).

**Bug:** Both `releaseVerifyLock` (`uncertainTxVerification.ts:204-232`)
and `releaseRefundLock` (`refund.ts:797-814`) use uppercase Lua `GET`/`DEL`
while `src/auth/redis.ts:428` in-memory eval predicate is `script.includes('get') && script.includes('del')` (lowercase). Result: lock release is a silent no-op in CLI / dev / test mode. The race-fallback GET-then-DEL is also racy (between get and del, another acquire can succeed; we'd nuke their lock).

**Files:**
- `src/lib/locks.ts` — export `RELEASE_SCRIPT` (already lowercase).
- `src/custodial/uncertainTxVerification.ts` — import + use `RELEASE_SCRIPT`.
- `src/hedera/refund.ts` — same.
- Remove the GET-then-DEL fallback. If `eval` is unavailable, log critical and rely on TTL only.

**Test:** `'releaseVerifyLock against in-memory store actually deletes the key on fence match'`.

---

### `[ ]` R2-FG-7 (H) — `handlePlay` SUCCESS emits F16 anchor
**Closes:** R-05 + G-03 (P1) + P6 follow-up.

**Bug:** Verifier path writes `recordControlEvent('play_uncertain_success_pending_triage')` before escalating + resolving (F16). Force-release `handlePlay` SUCCESS only stamps `successTriagedAt` locally — no on-chain anchor. The handler comment even says "F16 in Phase 4 will add the matching HCS-20 manual-triage anchor" — never added. Topic-only auditor sees the user's pre-play balance with operator wallet short.

**Files:** `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:handlePlay` SUCCESS branch — add `ctx.accounting.recordControlEvent('play_uncertain_success_pending_triage', { by, uncertainTxId, userId, tokenReservations })`. Wrap with audit-orphan dead-letter on failure.

**Test:** `'force-release play_uncertain SUCCESS writes play_uncertain_success_pending_triage control event'`.

---

### `[ ]` R2-FG-8 (M) — Audit-orphan rows include `phase` field
**Closes:** R-07 + G-05 (P2).

**Bug:** `handleWithdrawal` / `handleOperatorFee` audit-orphan rows omit
the `phase` field that the F14 path sets (`debit_failed_after_stamp`,
`audit_failed`). Manual replay tooling can't distinguish phases.

**Files:** `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts` — every audit-orphan write carries `phase: 'audit_failed' | 'debit_failed_after_stamp' | 'mutation_failed' | …`.

**Test:** Per-handler test asserting `phase` field on orphan details.

---

### `[ ]` R2-FG-9 (M) — Force-release re-reads entry post-lock
**Closes:** B-11.

**Bug:** Route reads `entry` at line 200, acquires lock at line 247.
Between read and lock-acquire, a concurrent verifier (whose F26 release
landed) could have stamped progress markers + resolved. Handler operates
on stale snapshot.

**Files:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts` — after lock acquisition, re-read entry via `store.refreshDeadLetters` + `store.getDeadLetters` and use the fresh snapshot.

**Test:** `'force-release uses fresh entry snapshot post-lock-acquisition'`.

---

### `[ ]` R2-FG-10 (M) — `handleRefund` validates `agentAccountId` upfront
**Closes:** B-12 + R-15.

**Bug:** SUCCESS path silently skips audit if `details.agentAccountId`
missing, returns 200 with action message claiming "wrote audit anchor"
that didn't actually happen. R-15: when no deposit record exists, the
audit anchor is written with `from === to === agentAccountId` —
meaningless audit.

**Files:** `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:handleRefund` — validation block requires `agentAccountId` (return 400 if missing). On no-depositRecord, refuse SUCCESS (return 400 — operator must reconstruct depositRecord first).

**Test:** `'handleRefund SUCCESS without agentAccountId returns 400, not silent skip'`.

---

### `[ ]` R2-FG-11 (M) — F12 SUCCESS detects prior `failed:` claim
**Closes:** X-12 + B-17.

**Bug:** Force-release SUCCESS overwrites the verifier's `failed:<txId>`
claim without warning, destroying the on-chain-failed evidence.

**Files:** `handlers.ts:handleRefund` SUCCESS — before overwriting `details.claimKey`, GET its value. If `startsWith('failed:')`, log critical inconsistency, write `audit_trail_orphaned`, return 409 demanding explicit operator override.

**Test:** `'force-release refund SUCCESS refuses to overwrite a failed: claim without explicit clear'`.

---

## Phase R2-3 — High (concurrency / state; 7 items)

### `[ ]` R2-FG-12 (H) — `stampProgress` refresh-before-merge
**Closes:** X-05.

**Bug:** F1 stamp reads stale `entry.details` (snapshot from loop entry).
Concurrent writers (e.g., F4's `bumpVerificationAttempts`) write to the
SAME row; their fields are silently overwritten on the next stamp.

**Files:** `src/custodial/uncertainTxVerification.ts:stampProgress` — fetch fresh entry from store before merging progress accumulator.

**Test:** `'concurrent bumpVerificationAttempts during stampProgress merge: neither write loses fields'`.

---

### `[ ]` R2-FG-13 (H) — `validateProgressOrdering` self-heals
**Closes:** S-01.

**Bug:** A crash mid-flight where intermediate stamp failed (e.g.
`settled` set, `totalWithdrawn` UNSET, `history` set) is permanently
rejected by `validateProgressOrdering`. Entry wedges; no auto-recovery.

**Files:** `src/custodial/uncertainTxVerification.ts:validateProgressOrdering` — when a later marker is set after an unset earlier one, infer the earlier step actually ran (the later marker proves it) and back-fill the timestamp; OR allow the verifier to proceed and re-attempt the missing step idempotently.

**Test:** `'verifier self-heals when an intermediate progress stamp failed but later stamps succeeded'`.

---

### `[ ]` R2-FG-14 (H) — F23 user-lock contention escalation
**Closes:** B-01 + S-07 + R-03 partial.

**Bug:** Sustained user-lock contention (legit long play, or user
spamming plays) wedges the verifier indefinitely with no telemetry —
"still_uncertain" looks identical to mirror-flake. Operator never sees
a paged escalation.

**Files:** `src/custodial/uncertainTxVerification.ts` — track per-entry `userLockContentionAttempts` counter (Redis INCR, separate from malformed-attempts). Page after N (e.g., 6) consecutive defers via `escalateUncertainDlFailure`.

**Test:** `'verifier escalates after N consecutive user-lock contention defers'`.

---

### `[ ]` R2-FG-15 (M) — Verifier user-lock uses different key prefix
**Closes:** R-03.

**Bug:** F23 uses the same `lockUser:<userId>` key as `processRefund`
and in-band withdraw. Long in-band ops force the verifier to defer
silently. Round-2 finding observation: separate the verifier's lock
namespace so contention is observable.

**Files:** `src/lib/locks.ts` — add `acquireUserLockForVerifier(userId)` using `KEY_PREFIX.lockUser + 'verify:'` namespace. Or document that contention is expected and rely on R2-FG-14 escalation.

**Decision required:** namespace separation OR escalation only? Recommend: keep same key (correctness — verifier MUST serialize against in-band) + R2-FG-14 escalation (observability).

**Test:** `'verifier shares lock with in-band; R2-FG-14 covers visibility'`.

---

### `[ ]` R2-FG-16 (M) — F24 per-token claim released by verifier
**Closes:** S-05 + R-14.

**Bug:** Verifier resolves `operator_fee_withdraw_uncertain` but doesn't
release the F24 `withdraw-pending:<token>` claim. Operator can't retry
that token's fee withdrawal for up to 30 min after the verifier already
resolved.

**Files:** `src/custodial/uncertainTxVerification.ts:verifyUncertainOperatorFeeWithdrawals` — after `markResolved`, DEL `KEY_PREFIX.lockOperator + 'withdraw-pending:' + tokenKey`. Same in `force-release/handlers.ts:handleOperatorFee`.

**Test:** `'operator-fee verifier releases F24 in-flight claim on resolution'`.

---

### `[ ]` R2-FG-17 (H) — Audit-orphan synthetic-id collision
**Closes:** S-02.

**Bug:** Multiple writers (in-band, verifier, force-release) use the
SAME synthetic id `audit-orphan:<txId>`. `upsertDeadLetter` is REPLACE,
so later writes destroy earlier orphan history.

**Files:** every audit-orphan write site — salt by writer phase:
- in-band: `audit-orphan:in-band:<txId>`
- verifier: `audit-orphan:verifier:<txId>`
- force-release: `audit-orphan:force-release:<txId>` (already has this prefix actually; verify others use distinct prefixes)
- creditDeposit: `audit-orphan:credit:<txId>` (R2-FG-31)

**Test:** `'multiple audit failures for the same source tx do not collide on transactionId'`.

---

### `[ ]` R2-FG-18 (H) — agentSeq duplicate detection
**Closes:** S-08 + TR-09.

**Bug:** Reader uses `Set<number>` for agentSeq — silently collapses
duplicates. Two messages with same seq from same agent → corruption
that goes undetected.

**Files:**
- `src/custodial/hcs20-reader.ts` — change `seenAgentSeqByAgent: Map<string, Set<number>>` to `Map<string, Map<number, sessionIds[]>>`. Emit `stats.agentSeqDuplicates: [{agent, seq, sessions}]` in pass 2.
- `src/scripts/verify-audit.ts` — surface as critical alert.
- Add buffer at seed time: `seedAgentSeq(highestSeq + 10)` to absorb mirror-scan eventual-consistency window.

**Test:** `'reader detects agentSeq duplicates as critical'` + `'agentSeq seed leaves buffer to absorb mirror lag'`.

---

## Phase R2-4 — High (data-integrity / refund correctness; 6 items)

### `[ ]` R2-FG-19 (H) — F7 unspent guard tightening + per-deposit accounting
**Closes:** P1 G-01 (F7 caveat).

**Bug:** Guard uses `available + reserved >= netAmount`. A deposit fully
reserved by an active play passes the guard; the play settles → operator
pays for both. Plus the guard runs WITHOUT the user lock so concurrent
state can drift between check and submit.

**Files:** `src/hedera/refund.ts:processRefund` — change guard to `available >= netAmount` (excluding reserved). Acquire user lock around the guard so concurrent ops can't move balance between check and submit.

**Test:** `'processRefund refuses when deposit is reserved against an active play'`.

---

### `[ ]` R2-FG-20 (H) — F18 dedup hardening
**Closes:** R-10 + TR-14 + B-07 (partial).

**Bugs:**
- Empty-string `withdrawTxId` bypasses dedup at writer + reader.
- `seenWithdrawTxIds` Set shared between user/operator burns; collision suppresses legitimate event.

**Files:**
- `src/custodial/AccountingService.ts:recordWithdrawal/recordOperatorWithdrawal` — throw if `withdrawTxId === ''`.
- `src/scripts/verify-audit.ts` — namespace dedup: `seenWithdrawTxIdsByKind: Map<'user'|'operator', Set<string>>`. Cross-kind collision → critical alert.

**Test:** `'recordWithdrawal throws on empty withdrawTxId'` + `'reader does not collapse user + operator burns sharing withdrawTxId'`.

---

### `[ ]` R2-FG-21 (M) — F18 mixed-version transition
**Closes:** TR-05.

**Bug:** Pre-F18 burn (no `withdrawTxId`) + post-F18 burn (with) for the
same on-chain withdrawal both count. User `totalWithdrawn = 2N`.

**Files:** `src/scripts/verify-audit.ts` — for legacy burns (no withdrawTxId), build heuristic dedup key `(user, token, amount, ±10min ts window)`. If a post-F18 burn matches, suppress as duplicate; emit warning.

**Test:** `'reader collapses pre-F18 + post-F18 burn for the same on-chain withdrawal via heuristic'`.

---

### `[ ]` R2-FG-22 (H) — `rakeReversed` cross-check against rake history
**Closes:** TR-04.

**Bug:** Refund's `rakeReversed` field applied without cross-check.
Operator can write `rakeReversed: 999` for a deposit with 0 rake →
operator-balance ledger goes arbitrarily negative.

**Files:** `src/scripts/verify-audit.ts` — pre-pass builds `rakeByDepositTxId: Map<txId, totalRake>`. Refund reducer asserts `rakeReversed ≤ rakeByDepositTxId.get(originalDepositTxId) ?? 0`. Mismatch → critical `phantom_rake_reversal` alert.

**Test:** `'verify-audit flags refund.rakeReversed exceeding accumulated rake'`.

---

### `[ ]` R2-FG-23 (H) — Operator-balance-negative alert
**Closes:** TR-01 + TR-11.

**Bug:** `verify-audit.ts` prints negative operator balances as JSON
numbers but raises NO alert. Conservation violations slip past.

**Files:** `src/scripts/verify-audit.ts` — after operator-state derivation, emit critical `operator_balance_negative` alert for any token where `balances[tk] < 0`.

**Test:** `'verify-audit alerts on negative operator balance from F9 rake-reversal-after-withdraw'`.

---

### `[ ]` R2-FG-24 (M) — F11 deposit-record on-chain cross-check
**Closes:** B-15.

**Bug:** F11's gate trusts `DepositRecord` blindly. Anyone with Redis
write can plant a fake record; refund honors it.

**Files:** `src/hedera/refund.ts:processRefund` — after `getDepositByTxId`, fetch `mirror/transactions/<txId>`, verify SUCCESS + transfer to agent matching `DepositRecord.netAmount + rakeAmount`. Reuse the cache from R2-FG-3.

**Test:** `'processRefund refuses tx whose mirror record does not show transfer to agent matching DepositRecord'`.

---

## Phase R2-5 — High (process / availability; 6 items)

### `[ ]` R2-FG-25 (H) — Killswitch HCS submit timeout
**Closes:** X-06 + R-12 + B-09.

**Bug:** `enableKillSwitch` awaits `recordControlEvent` with no timeout.
HCS topic submit can hang for minutes during congestion — exactly when
the operator wants to engage the killswitch. Plus B-09: anchor success
+ Redis flip failure → topic shows paused, agent isn't.

**Files:** `src/lib/killswitch.ts` — wrap `accounting.recordControlEvent` in `Promise.race` with 5s timeout. On timeout, log critical + write `audit_trail_orphaned` + flip Redis anyway. Add explicit error propagation if Redis flip fails after anchor success (don't swallow).

**Test:** `'enableKillSwitch with stalled HCS submit flips Redis within 5s'`.

---

### `[ ]` R2-FG-26 (H) — DepositWatcher unknown-token watermark hold
**Closes:** G-01 (P7).

**Bug:** Unknown-token deposits dead-letter, but the watermark advances
past them. The next poll cycle won't see them. Comment promises auto-retry
on next poll; code contradicts.

**Files:** `src/custodial/DepositWatcher.ts:pollOnce` — when `extractCredit` throws unknown-token, do NOT update `lastTimestamp` for that tx (skip the watermark advance for that iteration). OR stamp the dead-letter as `auto_retry: true` and add a sweep that re-processes once the registry warms.

**Test:** `'unknown-token deposit does NOT advance watermark past the tx'`.

---

### `[ ]` R2-FG-27 (H) — CLI / MCP recover-stuck-prizes lock unification
**Closes:** G-07.

**Bug:** CLI uses `acquireUserLock('recover-cli:0.0.X', 300)`; MCP uses
`acquireUserLock(internalUserId, …)`. Different keys → concurrent runs
both proceed → cross-user prize contamination possible.

**Files:** `src/scripts/recover-stuck-prizes.ts` — resolve `internalUserId` via `store.getUserByAccountId(userAccountId)` before lock acquisition. Use the same key the MCP path uses.

**Test:** `'CLI recover-stuck-prizes uses same lock key as MCP recover_stuck_prizes'`.

---

### `[ ]` R2-FG-28 (H) — DepositWatcher per-user dead-letter rate cap
**Closes:** G-16.

**Bug:** Anyone can deposit to the agent with `memo: ll-VVVV` to credit
victim V (or to push V over `maxUserBalance` and force dead-letters).
Memo format is publicly observable.

**Files:** `src/custodial/DepositWatcher.ts` — per-user dead-letter rate cap (e.g., 5 dead-letters per user per hour via Redis INCR). Above cap, drop the deposit silently OR write a single aggregate "deposit-spam-detected" row instead of N rows.

**Test:** `'deposit-spam to a single user via memo is rate-limited at the dead-letter layer'`.

---

### `[ ]` R2-FG-29 (H) — `playForUser` settle-then-throw orphan
**Closes:** G-11 + G-12.

**Bug:** `playForUser` settle loop runs BEFORE v2 audit sequence. If
settle partially completes then throws (token registry race, NaN
amount), the spend already landed locally with no on-chain marker.
F17's audit-orphan only covers the v2-write block.

**Files:** `src/custodial/MultiUserAgent.ts:playForUser` — wrap settle→v2 in try/catch that emits `audit_trail_orphaned` with partial-spend state on any throw. Stamp `auditOrphan: true` flag on the `PlaySessionResult` so dashboard renders warning.

**Test:** `'playForUser throw between settle and v2 emits audit_trail_orphaned with partial spend'`.

---

### `[ ]` R2-FG-30 (M) — `creditDeposit` flush failure escalation
**Closes:** G-17.

**Bug:** Step 7's `flush()` happens before user-lock release. If flush
throws (Redis blip), local state mutated but Redis didn't get the
balance update. Lock released → next acquirer reads stale (un-credited)
state. User missing funds.

**Files:** `src/custodial/UserLedger.ts:creditDeposit` — on flush failure post-`recorded`, retry once. If still fails, escalate via `escalateUncertainDlFailure` (extend the union to accept `'deposit_credit_flush_failed'`). Operator surfaces silent loss.

**Test:** `'creditDeposit flush failure escalates instead of silently dropping balance write'`.

---

## Deferred (Phase R2-6 — follow-up branch; 25 items)

### Medium-priority defer

| ID | Title | Source |
|---|---|---|
| `[-]` R2-FG-31 | `creditDeposit` rake percent clamp + audit-orphan on HCS-20 fail | G-03, G-04 (P7) |
| `[-]` R2-FG-32 | F22 boot guard scope (separate webhook check from `assertProductionRedis`) | B-10 |
| `[-]` R2-FG-33 | Reconcile detects topic-vs-Redis killswitch divergence | B-09, S-06, S-09 |
| `[-]` R2-FG-34 | F27 clamp future timestamps + reject `0.0.0@0.0` | R-11, B-04 |
| `[-]` R2-FG-35 | `applyPendingLedgerForUser` flush before LREM | G-09 |
| `[-]` R2-FG-36 | `revokeAllForAccount` atomic via Lua | G-10 |
| `[-]` R2-FG-37 | `transferAllPrizesWithRetry` refresh prize count between retries | G-06 |
| `[-]` R2-FG-38 | Reconciliation solvency math accounts for held `play_uncertain` reservations | G-13 |
| `[-]` R2-FG-39 | Refund verifier user-lock spans intermediate stamp | X-08 |
| `[-]` R2-FG-40 | Operator-fee FAILED branch checks `operatorDebitedAt` before no-op | R-13 |
| `[-]` R2-FG-41 | `play_uncertain_success_pending_triage` reduces held reservations in replay | TR-07 |
| `[-]` R2-FG-42 | `pendingLedger` JSON encoding consistency for LREM | G-08 |

### Low-priority defer

| ID | Title | Source |
|---|---|---|
| `[-]` R2-FG-43 | F2 `isRefundClaimKey` rejects bare prefix | B-06 |
| `[-]` R2-FG-44 | `isValidDetailAmount` strict `> 0` (reject zero) | R-09 |
| `[-]` R2-FG-45 | F4 ordering check rejects non-string markers | B-18 |
| `[-]` R2-FG-46 | F22 webhook reachability probe at boot | B-19 |
| `[-]` R2-FG-47 | F5 unsupported-kind early-reject before rate-limit | B-20 |
| `[-]` R2-FG-48 | Reader rejects unknown burn memo (no default-to-withdrawal) | TR-15 |
| `[-]` R2-FG-49 | Control-event malformed `tokenReservations` warn-on-drop | TR-13 |
| `[-]` R2-FG-50 | Killswitch periods rendered in `verify-audit.ts` output | TR-06 |
| `[-]` R2-FG-51 | Audit-orphan retry sweep | S-10 |
| `[-]` R2-FG-52 | Strategy hash anchor (overlaps round-1 D2) | adjacent |
| `[-]` R2-FG-53 | `recoverStuckPrizesForUser` gas tracking (round-1 D5) | G-05 |
| `[-]` R2-FG-54 | DepositWatcher cross-Lambda single-flight | G-19 |
| `[-]` R2-FG-55 | `pendingLedger` per-user keys (O(1) drain) | G-18 |

## Update procedure

When starting an item: change `[ ]` → `[~]`, add date.
When done: change `[~]` → `[x]`, add date + commit SHA.
When deferring: change to `[-]` with reason.

## Round-2 takeaways

1. **F12 force-release rewrite created parallel mutation paths** that didn't inherit F23 (locking), F16 (anchor), F14 (ordering), F17 (orphan). Single phase (R2-1 + R2-2) closes ~12 findings via consolidating these.
2. **DR promise was severely degraded** by phantom-mint/burn cross-check gaps. R2-FG-3 + R2-FG-4 + parallel-fetch + cache restore it.
3. **Phase-2 fixes had decorative tests** (P6). R2-0 verifies the fixes actually work before round 2 builds further.
4. **F25/F26 silently no-op in CLI/test** (R-01) — entire test suite has been giving false greens on lock-release behavior. R2-FG-6 fixes by importing the existing lowercase `RELEASE_SCRIPT`.
