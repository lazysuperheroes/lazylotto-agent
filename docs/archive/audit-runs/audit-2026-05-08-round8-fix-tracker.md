# Round-8 Fix Tracker — Phase 6 Single-Pass Hardening

**Date created:** 2026-05-08
**Branch:** `testnet`
**Source audit:** `docs/audit-2026-05-08-round8.md` (32 findings: 5 critical, 10 high, 12 medium, 5 low/info)
**Goal:** close every R8 finding in one structural pass, organized into 7 clusters of root-cause fixes. R9 (12-persona re-audit) should land with <15 findings.

This file is the rollback artifact. Each cluster gets its own commit; cluster commit hashes are recorded below so any cluster can be reverted independently if it breaks something downstream.

This file is **temporary** — once R9 converges and the audit-coverage manifest absorbs the closures, the entire `docs/audit-2026-05-*` set (R6 + R8 + R8-fix-tracker) gets garbage-collected.

---

## Cluster status overview

| Cluster | Scope | Findings | Status | Commit |
|---|---|---|---|---|
| A | Strict schema layer | 7 + downstream R8-FG-10 | `[x] DONE` | (uncommitted) |
| B | Gate widening | 5 | `[x] DONE` | (uncommitted) |
| C | Reader & consumer enforcement | 6 + R6-FG-10 | `[x] DONE` | (uncommitted) |
| D | Test quality + coverage ratchet | 10 | `[x] DONE` | (uncommitted) |
| E | Half-implemented features | 4 | `[x] DONE` | (uncommitted) |
| F | Orphan reconciler activation | 1 | `[x] DONE` | (uncommitted) |
| G | Coverage manifest ratchet | 1 + audit-coverage hygiene | `[x] DONE` | (rolled into D) |
| H | `isPreserveClaim` name fallback | 1 (rolled into B) | `[x] DONE` | (uncommitted, in B) |

**Order of operations:** A → B (incl. H) → C → D → E → F → G. Cluster A is the dependency root for several others (D's R6-FG-8 placebo fix, C's verify-audit additions). B is independent but should land early so subsequent clusters can't introduce regressions invisible to the gates.

---

## Per-finding tracker

### Cluster A — Strict schema layer

> **Root cause:** Zod's default mode strips unknown writer keys silently. The `*StrictSchema` variant promised in `hcs20-schema.ts` header was never built. `recordPrizeRecovery`/`recordControlEvent` bypass `submitV2Message`. Cross-field invariants (rakeReversed pairing, originalDepositTxId.min(1), amount bounds) are unenforced.
>
> **Single fix:** Build `Hcs20WriterMessageSchema` (strict variant of `Hcs20V2MessageSchema`) used only by `validateV2Message`. Add `ControlEventSchema` covering all writer fields incl. R6-FG-9 (`grossAmount`/`token`/`cause` for `deposit_credit_flush_orphaned`). Route control + prize_recovery through `submitV2Message`. Add cross-field refines.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-1 | C | `validateV2Message` silently strips unknown writer fields | `[x]` strict union |
| R8-FG-2 | C | `recordPrizeRecovery` + `recordControlEvent` bypass schema | `[x]` route through submitV2Message |
| R8-FG-8 | H | Empty-string `originalDepositTxId` slips dedup at reader+verify-audit | `[x]` `.min(1)` |
| R8-FG-22 | M | Refund `amt` schema is unbounded `string`; overflow → NaN balances | `[x]` AmountStringField refine |
| R8-FG-23 | M | `idempotencyKey` field in control events has no schema validation | `[x]` ControlEventSchema strict |
| R8-FG-31 | L | Doc generator collapses `oneOf` to literal `"discriminated union"` | `[x]` recurse |
| R8-FG-10 | H | R6-FG-8 schema test is a placebo (downstream of R8-FG-1) | `[x]` behavioral assertion |

**Files touched:**
- `src/custodial/hcs20-schema.ts` — strict variant, `ControlEventSchema`, cross-field refines
- `src/custodial/AccountingService.ts` — `recordControlEvent`/`recordPrizeRecovery` route through `submitV2Message`
- `src/custodial/UserLedger.ts` — pass grossAmount/token/cause to `recordControlEvent`
- `src/custodial/hcs20-schema.test.ts` — replace placebo with behavioral assertion (`assert.equal(parsed.token, 'LAZY')`)
- `src/scripts/generate-schema-docs.ts` — recurse into `oneOf`
- `docs/hcs20-v2-schema.md` — regenerated

**Acceptance check:** `npm test` green; `npm run schema:docs:check` passes; spike tests of typo'd payloads (`rakeRevsered`) throw inside `validateV2Message`; an `originalDepositTxId: ''` payload throws.

---

### Cluster B — Gate widening (incl. Cluster H)

> **Root cause:** Both lint gates use line-by-line scanning. Multi-line `redis.set(...)` calls bypass. The gates' vocabulary is too narrow (only `instanceof X`, only `redis.set`). `isPreserveClaim`'s name fallback at `idempotency.ts:60` is the same archetype inside the helper meant to defend against it.
>
> **Single fix:** Refactor both gates to a shared whole-file scanner with file-wide block-comment pre-strip. Add patterns for `err.name === '<subclass>'`, `err.constructor.name === '<subclass>'`, `redis.sadd`, `redis.zadd`, `redis.incr`. Confirm both walk `app/`. Migrate or grandfather every newly-flagged site. Two-line `isPreserveClaim` fallback fix.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-3 | C | Claim-archetype gate misses multi-line SET-NX (7 sites bypass) | `[x]` whole-file scan + grandfathered |
| R8-FG-4 | C | `isPreserveClaim` name fallback drops `PostSubmitError` (R6-FG-17) | `[x]` two-line fix + gate covers archetype |
| R8-FG-27 | M | Verify Phase-1 gate scans `app/` | `[x]` shared scanProductionRoots |
| R8-FG-28 | L | SADD/ZADD/INCR claim archetypes unguarded | `[x]` SADD/ZADD patterns + grandfathers |
| R8-FG-29 | L | Per-line block-comment strip false-positives | `[x]` file-wide stripCommentsAndStrings |

**Files touched:**
- `src/__tests__/sibling-archetype-gate.ts` — whole-file scan, name-string patterns, file-wide comment strip, scan app/
- `src/__tests__/claim-archetype-gate.ts` — whole-file scan, SADD/ZADD/INCR patterns, file-wide comment strip
- `src/lib/idempotency.ts` — name fallback covers PostSubmitError
- Migration of newly-flagged sites — likely:
  - `src/lib/killswitch.ts` — adopt fencedClaim or grandfather
  - `src/lib/escalation.ts` — adopt fencedClaim or grandfather
  - `src/hedera/refund.ts` (two sites) — adopt fencedClaim or grandfather
  - `src/custodial/MultiUserAgent.ts` (F24 claim) — adopt fencedClaim or grandfather
  - `src/custodial/RedisStore.ts` (agentSeq seed) — grandfather (canonical primitive)
  - `app/api/admin/uncertain-tx/[id]/force-release/route.ts` — adopt operator-lock or grandfather
- New test fixture verifying the gate flags a deliberate plant in `app/`

**Acceptance check:** Both gates flag the deliberate-plant fixtures (one per pattern). The 7 currently-bypassed sites either route through approved primitives or are explicitly listed in `ALLOWED_PATHS` with rationale notes.

---

### Cluster C — Reader & consumer enforcement

> **Root cause:** Phase 2 made the reader observe schema violations but no consumer ever escalates them. Reader never reads several writer-emitted fields (slim_truncated_prizes). Verify-audit doesn't reduce held reservations or consume `deposit_credit_flush_orphaned`.
>
> **Single fix:** verify-audit consumes `schemaValidationFailures` + new control-event kinds + tokenReservations. Reader env-gates softValidate (perf), records unknown-op under sentinel, reads slim_truncated_prizes.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-5 | C | `rakeReversed` without `rakeReversedToken` silently drops in verify-audit | `[x]` schema cross-field + verify-audit fallback to event.token |
| R8-FG-6 | H | verify-audit doesn't consume `schemaValidationFailures` | `[x]` consumer added; per-entry critical alert |
| R8-FG-15 | H | `softValidate` Zod safeParse perf regression on long walks | `[x]` env-gated `HCS20_SOFT_VALIDATE` |
| R8-FG-16 | M | `slim_truncated_prizes` writer-emitted but reader never reads | `[x]` reader sums + warning + alert category |
| R8-FG-18 | M | `softValidate` silently skips unknown ops; no flag in stats | `[x]` `<unknown>` sentinel |
| R8-FG-24 | M | `tokenReservations` on triage events not reduced from user balance | `[x]` heldByToken accumulator |
| (bonus) R6-FG-10 | C | verify-audit doesn't switch on `deposit_credit_flush_orphaned` | `[x]` switch case + grossAmount reduction |

**Files touched:**
- `src/scripts/verify-audit.ts` — schemaValidationFailures consumer; deposit_credit_flush_orphaned switch; tokenReservations reduction; rakeReversed token fallback
- `src/custodial/hcs20-reader.ts` — env-gated softValidate; unknown-op sentinel; slim_truncated_prizes consumption + NormalizedSession field; parse new control event fields
- `src/custodial/hcs20-v2.ts` — `NormalizedSession.truncatedPrizesDropped?: number`
- New verify-audit tests for each consumer addition

**Acceptance check:** Synthetic topic with one schema-failed message produces a critical alert from verify-audit. Synthetic topic with `slim_truncated_prizes:5` produces a warning. Topic with `tokenReservations:[{token:'HBAR',amount:50}]` reconstructs balance with 50 HBAR held.

---

### Cluster D — Test quality + coverage ratchet

> **Root cause:** Bidirectional invariant has substring escape hatch. Locking tests are tautologies/placebos. The manifest covers ~9 of 115 R6 findings without any ratchet that flags un-tracked closures. Several drill patches only exercise one assertion of multi-assertion tests.
>
> **Single fix:** Replace notes-substring exemption with explicit `coverageStrategy` enum field. Author behavioral tests for the catches. Author missing eval-fail and callsite drills. Add uniqueness enforcement, runtime guards, manifest-vs-doc ratchet.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-10 | H | R6-FG-8 schema test placebo (covered in A; entry confirmed here) | `[x]` (in A) |
| R8-FG-11 | H | R6-FG-5 locking test is a tautology (`typeof === 'function'`) | `[x]` behavioral source-regex |
| R8-FG-12 | H | `notes`-substring exemption silently bypasses ~4 of 11 entries | `[x]` `coverageStrategy` enum |
| R8-FG-13 | H | Sibling-archetype gate detects pattern reintroduction, not behavior | `[x]` MultiUserAgent source-regex (3 catches) |
| R8-FG-14 | H | `releaseFence` eval→DEL fallback untested (R5-FG-48 archetype) | `[x]` eval-throwing redis double |
| R8-FG-19 | M | R6-FG-12 manifest entry locks the wrong test | `[x]` secondary lock + structural-gate strategy |
| R8-FG-20 | M | R6-FG-4 drill validates only import; ≥2 callsite assertion unexercised | `[x]` callsite drill + `await safeSubmit(` regex |
| R8-FG-21 | M | Manifest under-claims R6 by ~93% | `[x]` ratio counter + coverageStrategy field |
| R8-FG-30 | L | `findTestLine` substring match doesn't enforce uniqueness | `[x]` throws on multi-match |
| R8-FG-32 | L | `PreserveClaimError` abstract class lacks runtime instantiation guard | `[x]` `new.target === abstract` constructor guard |

**Files touched:**
- `src/__tests__/audit-coverage-scan.ts` — `coverageStrategy: 'individual' | 'structural-gate' | 'documentation-only'`; `findTestLine` uniqueness
- `src/__tests__/audit-coverage.test.ts` — replace notes-substring with coverageStrategy enum check; add manifest-vs-doc ratio counter
- `src/__tests__/audit-coverage.json` — coverageStrategy on existing entries; new entries for R8-FG-* closures + R6-FG-9/10
- `src/__tests__/revert-drills/R6-FG-4-callsite.patch` — NEW: removes one safeSubmit() invocation, leaves import
- `src/hedera/contracts.test.ts` — replace R6-FG-5 typeof tautology with behavioral injection test
- `src/custodial/MultiUserAgent.ts` or new test file — three behavioral injection tests for the broadened catches
- `src/lib/fencedClaim.test.ts` — eval-fail fallback test (inject eval-throwing redis double)
- `src/hedera/transfers.ts` — runtime constructor guard on `PreserveClaimError`

**Acceptance check:** Every manifest entry has `coverageStrategy` field; gate refuses entries without it. Drill `--all` runs ≥4 drills. Behavioral tests inject `PostSubmitError` at all three MultiUserAgent catches and assert reservations preserved. The ratio counter reports manifest-vs-doc coverage as a stat.

---

### Cluster E — Half-implemented features

> **Root cause:** Several Phase-2/Phase-4 features are partially wired up — pendingLedger busy-branch LREMs the row before we know the sibling completed; `recordPlaySessionAborted` ignores the schema's `strategyDeviation`; `fencedClaim`'s documented `context` parameter never reaches Redis; multiple message-substring control-flow patterns wait for the next sibling miss.
>
> **Single fix:** Drop pendingLedger busy-LREM. Wire `strategyDeviation` through the writer. Encode `context` into fence value. Replace string-control-flow with typed sentinel errors.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-7 | H | pendingLedger busy-branch LREM reopens R6-FG-12 archetype | `[x]` LREM removed; row preserved for next drain |
| R8-FG-17 | M | `recordPlaySessionAborted` writer drops `strategyDeviation` | `[x]` parameter accepted + spread |
| R8-FG-25 | M | String-control-flow archetype seeds in MultiUserAgent + refund.ts | `[x]` `InFlightClaimError` + `RefundDuplicateError` |
| R8-FG-26 | M | `fencedClaim` documented `context` parameter never written to Redis | `[x]` encoded into fence; reconciler parses suffix |

**Files touched:**
- `src/custodial/pendingLedger.ts` — drop LREM from busy branches in both `applyPendingLedgerForUser` and `drainPendingLedgerAdjustments`
- `src/custodial/AccountingService.ts` — `recordPlaySessionAborted` accepts and emits `strategyDeviation`
- `src/lib/fencedClaim.ts` — fence value becomes `pending:<uuid>:<context>` when context provided; `releaseFence` compare-and-DEL still works (full-string match); `OrphanedClaim.context` parsed from suffix
- `src/custodial/MultiUserAgent.ts` — `InFlightClaimError extends Error { readonly __claimInFlight = true }`; replace `message.includes('already in flight')` discrimination
- `src/hedera/refund.ts` — `RefundDuplicateError extends Error { readonly kind: 'in-progress' | 'completed' | 'failed-onchain' | 'refunded-originals' | 'unknown' }`; replace 5-way message-substring discrimination

**Acceptance check:** Synthetic test: kill Lambda mid-fenced-body, assert next drain re-acquires and processes the row (R8-FG-7). Assert close + aborted both carry `strategyDeviation` when supplied. Assert `fencedClaim('test', fn, { context: 'X' })` stores `pending:<uuid>:X` in Redis. Assert `instanceof InFlightClaimError` discriminates correctly.

---

### Cluster F — Orphan reconciler activation

> **Root cause:** Reconciler probes for `redis.scan`; the in-memory `RedisLike` mock has no scan method; reconciler always returns `[]` in dev/test. `EXPECTED_TTL_SEC` registers only 5 of 9+ namespaces. `pending:` value-filter excludes legitimate non-fenced claims. No test file.
>
> **Single fix:** Add `scan` to RedisLike + mock. Register every fenced-claim namespace. Drop the pending-prefix filter. Ship a test.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-9 | H | Orphan reconciler dead code in dev/test; missing scan + namespaces | `[x]` `scan` on RedisLike + mock + 4 new tests + `refunded`/`escalated`/`killswitch` registered |

**Files touched:**
- `src/auth/redis.ts` — `scan(cursor, { match, count }): Promise<[cursor, keys[]]>` on `RedisLike`; in-memory mock implementation (linear pass; cursor = index)
- `src/lib/orphanReconciler.ts` — register `refunded`, `escalated`, `killswitch`, F24 operator pending, agentSeq seed in `EXPECTED_TTL_SEC`; drop `pending:` value-filter; per-namespace shape predicates
- `src/lib/orphanReconciler.test.ts` — NEW: seeds keys across multiple namespaces, asserts staleness math + per-namespace ratio logic

**Acceptance check:** `npm run reconcile:orphans` against a seeded mock returns the correct count of stale claims across all 9+ namespaces. Test file passes.

---

### Cluster G — Coverage manifest ratchet

> **Root cause:** Manifest description claims "every shipped audit-finding fix" but lists 9 entries for 115+ R6 findings. No ratchet flags un-tracked closed findings; the gate enforces "every entry has a real test" but not "every shipped fix has an entry".
>
> **Single fix:** Add a counter-test that walks `docs/audit-*-round*.md`, extracts every `R\d-FG-\d+` ID, computes coverage ratio against manifest entries, and reports as a stat (or gates on selected severity tiers). Document the manifest's coverage policy explicitly. Add manifest entries for every R8-FG-* finding closed in Phase 6.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-21 | M | Manifest under-claims R6 by ~93% | `[ ]` |

**Files touched:**
- `src/__tests__/audit-coverage.test.ts` — manifest-vs-doc coverage ratio counter (new `it` block)
- `src/__tests__/audit-coverage.json` — description rewritten to honest coverage policy; new entries for every R8-FG-* finding closed in Phase 6
- `docs/audit-2026-05-08-round8.md` — annotation noting which findings have audit-coverage entries after Phase 6

**Acceptance check:** Counter reports `coverage: N tracked / M total findings` per round. Gate doesn't fail on under-coverage by default but emits a warning so reviewers see the ratio.

---

## Deferred R6 critical findings — out of Phase 6 scope

P9 closure verifier flagged eight R6 critical findings the original R7 plan never addressed. R6-FG-10 is folded into Cluster C; the rest are documented here for the operator's awareness and may be picked up in Phase 7+ if the operator chooses to harden them.

| ID | Severity | Notes |
|---|---|---|
| R6-FG-6 | C | Merkle parity for >10-prize pools — readers mark `corrupt` |
| R6-FG-9 | C | Wire fields for `deposit_credit_flush_orphaned` (folded into Cluster A) |
| R6-FG-10 | C | verify-audit consumer for `deposit_credit_flush_orphaned` (folded into Cluster C) |
| R6-FG-11 | C | Runbook flags `--store-snapshot` opt-in; documented runs miss orphans |
| R6-FG-13 | C | `submitV2Message` raw `.execute()`; needs `safeSubmit` wrapper |
| R6-FG-14 | C | Idempotency plain-DEL fallback bypasses fence under transport-throw race |
| R6-FG-15 | C | `isPostLegacyCutoff(undefined)` returns false → strip-timestamp bypass |
| R6-FG-17 | C | `isPreserveClaim` name fallback (closed by Cluster B / R8-FG-4) |

R6-FG-18..22 (auth/rate-limit) — also unaddressed; operator-decision territory.

---

## Per-cluster commit log

(filled in as work progresses)

| Cluster | Commit SHA | Date | Tests after | Notes |
|---|---|---|---|---|
| A | — | — | — | — |
| B | — | — | — | — |
| C | — | — | — | — |
| D | — | — | — | — |
| E | — | — | — | — |
| F | — | — | — | — |
| G | — | — | — | — |

---

## Rollback procedure

Each cluster lands as a single commit. If a cluster causes a regression downstream:

```
# Identify the cluster's commit SHA from the table above.
git revert <SHA>
# Re-run the test suite + R4-0 gate.
npm test
```

The tracker doc itself is not under any auto-revert — it documents the work; the work is the code.

---

## R9 readiness criteria

Before invoking the 12-persona R9 audit, all of the following must be green:

- [ ] All 32 R8-FG-* checkboxes flipped to `[x]`.
- [ ] `npm test` passes (target: ≥720 tests).
- [ ] `npm run audit:coverage:check` passes with `coverageStrategy` enforcement.
- [ ] `npm run audit:revert-drill -- --all` runs ≥4 drills, all pass.
- [ ] `npm run reconcile:orphans` runs cleanly with the new RedisLike scan.
- [ ] Both archetype gates flag deliberate-plant test fixtures.
- [ ] R4-0 revert-proof gate passes (with new behavioral test annotations).

Once all check, fire the R9 audit (same 6+ persona prompt set as R8 but with one additional `R8 closure verifier` to confirm no Phase-6 fix accidentally broke a previously closed R6 finding).
