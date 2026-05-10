# Audit-Cycle Dissection — 2026-05-10 (Phase-9 frame)

**Question.** Why does each round produce 30-50 findings while only 5-10 of them are bugs a user would ever notice?

**Answer (one sentence).** The audit framework counts "things to fix" without distinguishing user-visible failure modes from quality complaints, observability gaps, and process-discipline gaps — and twelve adversarial agents will always find 30-50 things, so we mistake the framework's bias for the codebase's bug rate.

**Phase-9 thesis.** Stop. Triage. Fix the load-bearing items. Ship.

---

## 1. Trajectory and the diminishing-returns question

| Round | Total | Critical | Phase before | Phase output |
|-------|-------|----------|--------------|--------------|
| R6 | 115 | 15 | R5 | R6→R7 structural fixes |
| R8 | 32 | 5 | R7/Phase-1..3 | Phase-6 closures |
| R9 | 45 | 5 | Phase-6 | Phase-7 closures |
| R10 | ~50 | 4 | Phase-7 | Phase-8 closures |
| R11 | ~38 | 3 deduped | Phase-8 | Phase-9 (this) |

R11 is the **first round whose total dropped** since R8. Phase-8's process change (behavioral-test mandate at §5a of the prior dissection) closed the comment-vs-code introduction archetype. Net of carry-forward bugs Phase-8 didn't address, R11's *new* bugs introduced by Phase-8 are 1 by P9's strict count.

So the audit cycle IS converging on bug-introduction rate. Why does it feel like a wild goose chase?

**Because we've been counting findings, not bugs.** R11's ~38 unique findings include:

- Counter-declared-but-no-consumer (real bug — over-credits user balance)
- Manifest entry shipped with `coverageStrategy:'documentation-only'` (process complaint — no user notices)
- Test mocks duplicated across files (quality complaint)
- `vercel.json` cron schedule not validated against `maxDuration` (observability gap)
- Sibling-archetype gate doesn't catch `.message.startsWith` (pattern hardening — no live exploit path Phase-8 broke)
- Comment-vs-code mismatch about which env triggers a warning (cosmetic)
- `responseBalances` indirection is "16 lines of comment for 12 lines of code" (style)

Treating these as a homogeneous set of "findings to close" is the engine of the wild goose chase. The audit framework's adversarial bias toward "always find more" mistakes "more findings" for "more bugs". They're not the same.

## 2. Triage: bug vs error vs quality vs process

Define four categories. Each finding, at audit time, gets exactly one:

**Bug** (load-bearing). A user, an operator, or an external auditor can construct a sequence of actions that produces incorrect state — phantom funds, double-debit, double-credit, lockout, balance-reconstruction-divergence, security bypass, or DoS. The state is wrong, not just the path leading to it.

**Error** (local-shape). A specific function, type, or call site is locally wrong but produces no user-visible incorrect state. Example: a mock with the wrong return type that happens to satisfy the same test expectations as a correct mock; a comment that contradicts code where the code is right and the comment is stale; a test that asserts a signal instead of an invariant where the invariant holds anyway.

**Quality** (could be cleaner). The code works correctly. It could be simpler, less duplicated, more cohesive, less commented, or follow conventions more uniformly. No incorrect state.

**Process** (could be enforced). A discipline or invariant is asserted in prose (commit messages, comments, dissection docs, manifest fields) but isn't enforced by code. Future regressions could re-introduce the named archetype. Today, the named archetype isn't recurring; the gate would be precautionary.

The four categories require different remedies:

- **Bugs** must be fixed. They're the load-bearing reason the audit cycle exists.
- **Errors** should be fixed when cheap; deferred when costly. They tend to predict bugs.
- **Quality** can be addressed in dedicated cleanup rounds, not under audit-pressure.
- **Process** ships a gate only when the named archetype is *actively* recurring. Otherwise the gate is dead code and the audit cycle is increasing its own surface.

## 3. Empirical triage of R11

### R11 deduped criticals

| ID | Category | Reasoning |
|---|---|---|
| R11-FG-1 (counter wire-only) | **Bug** | verify-audit reconstructs OVER-CREDITED user balance on topics with empty-`originalDepositTxId` refunds. Conservation invariant violated. |
| R11-FG-2 (`documentation-only` loophole) | **Process** | The audit critiques the audit. No user notices. Worth fixing lightly to stop the cycle from re-finding it. |
| R11-FG-3 (dashboard merge-back) | **Bug** | After every play/withdraw/deposit-check, the dashboard shows phantom funds again. User can attempt withdraw of refunded amount, hitting per-user-lock rejection. |

### R11 introduction highs

| ID | Category | Reasoning |
|---|---|---|
| R11-FG-4 (SADD+withUserLock interaction) | **Bug** | Narrow but real: SADD throw + subsequent in-band `fn()` + post-body `flush()` commits debit without applied-set anchor. Next drain re-applies → double-debit. |
| R11-FG-5 (parseRefund 5-way nulls) | **Bug** | Sibling of R11-FG-1. 4 null-return reasons fall through to `skippedMessages++` and the same over-credit signature applies. |
| R11-FG-6 (Section 5b lockstep gate) | **Process** | Strike. Ship the gate only if the next round shows comment-vs-code regression. Phase-8's evidence is the opposite: comment-vs-code introduction stopped. |

### R10 carry-forward highs

| ID | Category | Reasoning |
|---|---|---|
| R10-FG-5 (env pollution) | **Error** | Observability impact, not balance correctness. softValidate's per-message Zod cost in user paths. Strike for Phase-9; revisit if R12 finds it. |
| R10-FG-6 (orphan reconciler observability) | **Quality** | 8-confirm in R10. Genuine, but operational not balance. Defer to a dedicated observability pass. |
| R10-FG-7 (status-code monitoring) | **Process** | Runbook gap. Strike. |
| R10-FG-8 (`mapErrorToResponse` partial) | **Quality** | Admin UX. Refund admin route uses it; MCP/A2A surface still throws raw. Operationally tolerable. Strike. |
| R10-FG-9 (aggregate ledgerBalance formula) | **Bug** | External auditors / JSON consumers see drifted numbers. Per-token correct; aggregate stale. Conservation invariant adjacent. |
| R10-FG-10 (strategyDeviation no caller) | **Error** | Cosmetic wire field. The R5-FG-59 alert can never fire. Strike for Phase-9; the alert was never load-bearing. |
| R10-FG-11 (LRANGE on hot path) | **Bug** | Quantified in P11-001. User-facing latency at scale. Genuine perf bug. |
| R10-FG-12 (velocity DoS) | **Bug** | Compromised session can 24h-lock-out a victim's withdraw. Real attack. |
| R10-FG-13 (`.message.startsWith`) | **Process** | Pattern hardening. Sibling-archetype gate covers `.includes`; family is open. No live exploit path Phase-8 broke. Strike. |
| R10-FG-14 (SignatureValidationError completion) | **Bug** | The most security-critical throw in the auth path is plain `Error`. Half-migrated code is worse than unmigrated. |
| R10-FG-16 (heldByToken on recovery) | **Bug** | Post-recovery balance reconstruction produces false-positive `user_balance_negative` critical alert. Operational confusion. |

### Aggregate

- **R11 bugs:** 4 (R11-FG-1, R11-FG-3, R11-FG-4, R11-FG-5)
- **R10 carry-forward bugs:** 5 (R10-FG-9, R10-FG-11, R10-FG-12, R10-FG-14, R10-FG-16)
- **Total load-bearing:** 9
- **Process / errors / quality (struck or out-of-scope):** ~29
- **R10 mediums + lows:** ~25 — all categorized quality or process; struck en masse

The 9 load-bearing items are what Phase-9 ships. The other 29 are documented as out-of-scope with category labels visible in the audit-coverage manifest.

## 4. Why the cycle ran 6 rounds

Three contributing factors:

**(a) Adversarial agents never converge to zero findings.** Each round, 12 personas with different lenses each find 5-10 things. Even on a perfectly correct codebase, persona "carmack" will find lines that could be shorter; persona "frontend" will find UX assumptions; persona "qa" will find test coverage gaps. The lower bound is bounded by the number of personas × persona-specific concerns, not by the codebase quality.

**(b) Each round's "closures" introduce new code that's audited next round.** Phase-7 added the audit-coverage manifest. R8 found bugs in the manifest. Phase-8 added the placebo gate. R11 found the documentation-only loophole. **Audit machinery audits itself.** The fix is to keep audit machinery minimal and avoid shipping new gates whose failure mode is "the gate has a bug".

**(c) The bug-vs-error distinction wasn't named until R10's dissection got close to it (the Phase-8 introduction archetype "comment-vs-code mismatch" is half-error, half-bug).** Without the distinction, every persona's finding gets the same severity treatment, and a 30-finding round looks the same as a 30-bug round.

**The corollary:** the audit cycle could have stopped at R8 (32 findings) if we'd triaged. Most of R8's findings were errors and quality, not bugs. The pressure to "close all the criticals" drove Phase-6/7/8/9 because we treated every C as a bug; in retrospect some were errors that didn't manifest under realistic load.

## 5. Phase-9 process change

One rule: **bugs only.** Phase-9 closes the 9 load-bearing items. No process gates ship. No new abstractions added except where the load-bearing fix requires them (`Readonly<UserAccount>`, monthly-shard scheme).

Phase-9's behavioral tests follow a stricter pattern than Phase-8's: every test MUST assert the user-visible invariant the bug broke, not the implementation detail of the fix. Concretely:

- Cluster B's test asserts: "given synthetic topic with 5 malformed refunds, verify-audit's reconstructed user balance equals expected-balance computed from conservation invariant 3." It does NOT assert "stats.refundsDroppedEmptyOriginal > 0".
- Cluster C's test asserts: "after `setStatus({...prev, balances})` from `/api/user/play`, the dashboard's displayed `available` still reflects pending-debit subtraction." It does NOT assert "the route returns responseBalances variable".
- Cluster D's test asserts: "no sequence of `withUserLock` invocations with mid-flight SADD failures results in a balance that violates conservation invariant 3 across two consecutive Lambda restarts." It does NOT assert "SADD precedes flush in callLog".

The behavioral-test discipline is enforced by the dissection's review criterion at the cluster commit, not by a gate. **Phase-9 ships no gates.** This is intentional — adding gates is what makes audit machinery audit itself.

## 6. Phase-9 cluster plan

### Cluster A — Manifest hygiene (R11-FG-2 light fix)

**Scope.** Strike `documentation-only` from `coverageStrategy` enum. Promote R9-FG-6, R9-FG-11, R9-FG-12 to `'individual'` with their existing tests linked. Re-categorize the remaining 6 entries (R9-FG-1, 2, 3, 4, 8, 13) to `'structural-gate'` where appropriate or merge into the new Phase-9 cluster's manifest entries where the closure subsumes them.

**Why.** Stops the next audit from re-finding the placebo loophole. Doesn't ship a new gate. Closes a process item cheaply because it's there.

**Test.** Existing `audit-coverage.test.ts` placebo gate continues to pass post-change (with `documentation-only` removed, the gate's branch becomes dead code; remove that branch too).

**Estimate.** ~100 LOC.

### Cluster B — Conservation invariant (R11-FG-1, R11-FG-5, R10-FG-9, R10-FG-16)

**Scope.**
- Wire `refundsDroppedEmptyOriginal` into verify-audit's alert array (mirror `schemaValidationFailures` pattern at `verify-audit.ts:1296-1304`).
- Discriminate `parseRefund`'s 5 null-return reasons (return tagged `null | { reason: ... }`); dispatcher categorizes per-reason.
- Fix aggregate `ledgerBalance` formula at `verify-audit.ts:1377` to subtract held + flushOrphan.
- Decrement `heldByToken` on `prize_recovery` / `force_release` / `force_release_override` events (`verify-audit.ts:830-922`).
- Convert `r10-fg-3-behavioral.test.ts` from signal-existence to balance-conservation invariant. New test fixture: synthetic 20-message topic with all five malformed-refund branches + a valid refund + a `prize_recovery` after `play_uncertain_success_pending_triage`. Assert reconstructed balance per user matches expected.

**Bug invariant locked.** Conservation invariant 3 holds across topics containing all five parseRefund-failure modes, the held → recovered transition, and the aggregate-formula path.

**Estimate.** ~250 LOC.

### Cluster C — Store-cache contract (R11-FG-3, R10-FG-2 architectural)

**Scope.**
- `Readonly<UserAccount>` return type on `IStore.getUser`, `getUserByAccountId`, `getUserByMemo` across `IStore`, `RedisStore`, `PersistentStore`.
- Cluster-fix balance-bearing routes: `/api/user/check-deposits`, `/api/user/play`, `/api/user/withdraw`. Each returns response balances pre-subtracted with pending adjustments (or via a shared helper `composeUserResponse(user)`).
- Frontend invariant test in `app/__tests__/dashboard-invariant.test.tsx`: after `setStatus({...prev, balances: <raw>})` from any of the 4 routes, the displayed `available` still equals `total - pending`.
- Decision-at-cluster-time fallback: if `Readonly` migration produces >30 type errors, downgrade to `Object.freeze` at the cache boundary (in `RedisStore.set` and `PersistentStore.set` write paths) + the route-level fix. Smaller surface, equivalent guarantee, documented in commit body.

**Bug invariant locked.** Dashboard never shows phantom funds after any sequence of route invocations on a warm Lambda.

**Estimate.** ~400 LOC if Readonly migration; ~200 LOC if frozen-cache fallback.

### Cluster D — Pending-ledger fully-idempotent (R11-FG-4, R10-FG-1 tightened)

**Scope.**
- Move `store.updateBalance` AFTER `redis.sadd(...)` in both eager and periodic paths of `pendingLedger.ts`. A SADD throw aborts before any in-memory mutation; the dirty-cache hazard at locks.ts:181-191 vanishes.
- Re-author `r10-fg-1-behavioral.test.ts`'s second test to wrap the drain inside a synthesized `withUserLock` simulator that runs `fn()` after the drain. Assert: SADD-throw → in-memory cache stays at original value → `fn()` reads correct balance → post-body flush commits correct value.
- Monthly-shard scheme for `pendingLedgerAppliedSet`: `pendingLedgerAppliedSet:YYYYMM`; SISMEMBER fans out across last 3 shards on read; SADD writes to current month only. Bounded growth without losing the "applied forever" semantic.

**Bug invariant locked.** No sequence of withUserLock invocations with mid-flight SADD failures violates conservation invariant 3 across two consecutive Lambda restarts.

**Estimate.** ~150 LOC.

### Cluster E — Security & DoS sweep (R10-FG-11, R10-FG-12, R10-FG-14)

**Scope.**
- Shard pendingLedger queue per-user: `pending:adjustments:<userId>` as a LIST. Drain reads only the user's shard. The hot-path LRANGE collapses from O(global) to O(user's pending count). Migration: read-from-both-(legacy-global-list, per-user-shard) writes-to-per-user-shard during cutover; reconcile cron drains legacy list opportunistically until empty.
- INCRBY then DECRBY rollback in `MultiUserAgent.applyWithdrawalVelocityCap` over-cap branch. Compromised session can no longer 24h-lock the victim.
- Complete SignatureValidationError typed-sentinel migration at `src/auth/verify.ts:87`, `:94`, `:154`. Replace plain `throw new Error(...)` with the sentinel class.

**Bug invariants locked.**
- `/api/user/status` LRANGE cost is O(user's own pending entries), not O(cluster-wide).
- Velocity counter rollback: a sequence of N over-cap `withdraw` attempts leaves the counter at the same value as 0 attempts.
- Every signature-failure throw at `auth/verify.ts` is `instanceof SignatureValidationError`.

**Estimate.** ~300 LOC.

## 7. Out-of-scope (struck from Phase-9, justified)

- **R11-FG-6** (Section 5b lockstep gate). Process. Phase-8 closed the comment-vs-code archetype; the gate would be precautionary. Ship only if R12 finds the archetype recurring.
- **R10-FG-5** (env pollution). Error. Observability impact only. Revisit if R12 finds it.
- **R10-FG-6** (orphan reconciler observability cluster). Quality. 8-confirm but operational, not balance.
- **R10-FG-7** (status-code monitoring). Process. Runbook gap.
- **R10-FG-8** (mapErrorToResponse partial). Quality. Admin UX.
- **R10-FG-10** (strategyDeviation no caller). Error. Cosmetic.
- **R10-FG-13** (`.message.startsWith`). Process. Pattern hardening.
- **All R10 mediums and lows** (~25 items). Quality, process, or error. None load-bearing.
- **All R11 mediums and lows** (~17 items). Same.

If R12 surfaces any of these as load-bearing through a concrete user-visible failure, they get pulled into a Phase-10 with the same triage discipline. Otherwise they stay struck.

## 8. R12 success criterion = ship and GC

**Pass condition (ship):** R12 lands at:
- 0 deduped critical findings
- ≤5 deduped high findings
- 0 closure-with-caveat verdicts on any Phase-9 closure
- All deduped findings categorize as quality, process, or error (not bug)

**On pass:**
- Move `docs/audit-2026-04-*` through `docs/audit-2026-05-*` to `docs/archive/audit-runs/`.
- Move `docs/audit-r11-personas/` into the archive.
- `docs/audit-cycle-dissection-2026-05-09.md` and this doc stay at `docs/` root as the canonical record of the cycle.
- Set `audit-coverage.json` into "maintenance mode" — manifest entries for active load-bearing fixes only; existing entries grandfathered. The placebo gate stays.
- Note in `CLAUDE.md`: "Audit cycle closed at Phase-9 (2026-05-10). Future audits run on demand against specific subsystems, not as 12-persona codebase sweeps."

**Fail condition (re-dissect):** R12 finds:
- ≥1 deduped critical OR
- ≥1 closure-with-caveat on a Phase-9 closure OR
- ≥6 deduped highs that triage as bug

**On fail:** the audit cycle has a structural floor we haven't found. The remedy is architectural, not procedural. Concrete next move: extract `IStore` + cross-Lambda primitives + `parseAuditTopic` reducer into separately-conformance-tested packages (the suggestion in Phase-8 dissection §6's pre-mortem). Phase-10 frame is "boundaries and contracts," not "more closures."

## 9. The honest meta-point

The wild-goose-chase suspicion is correct: **we ran six rounds, half of which fixed errors and quality complaints disguised as criticals.** Each round's findings were honest at finding-time, but the framework's adversarial bias consistently presented errors as bugs. A reader who only reads the audit docs (and not the closure diffs) over-estimates how much was wrong with the codebase.

The codebase is not in great shape, but it's not in 50-criticals shape either. It's in **9-load-bearing-bugs and 25-quality-or-error-improvements** shape. Phase-9 fixes the 9. The 25 are catalogued and grandfathered. R12 confirms.

If R12 confirms, the audit cycle's failure mode was: it didn't have a triage primitive. Now it does. Future audits use the triage primitive at finding-time and produce ~5-10 bug findings instead of ~50 mixed findings.

If R12 doesn't confirm, the codebase has a structural issue the audit lens can't see. The remedy is architecture, not more rounds.

Either way, this is the last round. Let R12 decide which direction.
