# Audit-Cycle Dissection — 2026-05-09

**Question.** Why does every audit phase introduce ~4 new criticals despite shipping closures for the prior round?

**Answer (one sentence).** Each phase is reviewed by tests that detect the *prior* round's archetype, not the *current* round's introduction archetype — so structural fixes land at the named site and a fresh archetype slips in next to them, undefended.

---

## 1. Trajectory

| Round | Total | Critical | Phase that preceded it | Introduction archetype that round surfaced |
|-------|-------|----------|------------------------|---------------------------------------------|
| R6    | 115   | 15       | R5-* fixes             | Sibling-class catch (`PostSubmitError` released the reserve where `ReceiptUncertainError` preserved it). |
| R8    | 32    | 5        | R7 / Phase-1..3        | Wire-only closure (data captured by reader/schema, never read by reducers). |
| R9    | 45    | 5        | Phase-6                | Wire-only closure, second wave (`heldByToken`/`flushOrphan` not subtracted; `HCS20_SOFT_VALIDATE` set nowhere; `reconcileOrphans` defined but unwired). |
| **R10** | **~50** | **4** | Phase-7                | **Comment-vs-code mismatch** — every introduction critical contradicts a comment placed *next to* the buggy code. |

R8 → R9 → R10 ≈ flat (32 → 45 → 50). The structural fix discipline closes the named archetype each round; bug-introduction rate is the convergence floor, not bug count.

---

## 2. Hypothesis

The hypothesis under test, reduced to falsifiable form:

> Every R10-FG critical (R10-FG-1..4) would have been caught by a small behavioral integration test asserting the invariant in plain prose. None of those tests exists today.

Operationally: author one test per finding *before* any fix. Run against current code. If all four fail, the hypothesis is verified.

---

## 3. Step-1 empirical result — CONFIRMED (4/4 fail)

Tests authored under `src/__tests__/r10-fg-{1..4}-behavioral.test.ts`, run against `testnet` HEAD `11034af`:

| Finding | Test outcome | Concrete failure |
|---------|--------------|------------------|
| R10-FG-1 SADD-after-flush race | **FAIL** | `applyPendingLedgerForUser` re-debits on partial-failure replay (got 80, expected 90). |
| R10-FG-2 user-status mutation  | **FAIL** | First call mutates `user.balances` from 100 → 90 on the live store reference. |
| R10-FG-3 parseRefund silent null | **FAIL** | Refund with empty `originalDepositTxId` produces 0 events, no categorized stat. |
| R10-FG-4 manifest placebo      | **FAIL** | 9 entries: R9-FG-{1,2,3,4,6,8,11,12,13} declare `coverageStrategy:'individual'` with `tests:[]`. |

Time to author each test, against current code: ~5–20 min. All four are well within the budget of a normal cluster-fix commit.

---

## 4. The structural gap

R4-0 added `revert-proof:` annotations on tests (proving each test names a finding it locks).
Phase-3 added `audit-coverage.json` (proving each shipped fix references locking tests).
Phase-6 closed the notes-substring exemption with an explicit `coverageStrategy` enum.

None of these enforces the inverse: **invariants asserted in code comments must have a corresponding behavioral test.**

R10-FG-1 is exactly this gap, in microcosm. The author wrote a 12-line comment at `pendingLedger.ts:296-308` explaining that SADD must precede flush, then coded SADD *after* flush. No test asserted the ordering. R10-FG-2 has the same shape: comment at `route.ts:137` says "we don't mutate the store-cached object"; line 154 mutates it. R10-FG-4 has the same shape: schema docstring says "may be empty for documentation-only entries"; the gate doesn't enforce that constraint, so 9 individual-strategy entries shipped vacuous.

---

## 5. Phase-8 process change

Two changes, ordered by leverage:

### 5a. Behavioral-test mandate per cluster (primary)

Every `severity: 'critical' | 'high'` manifest entry MUST declare at least one test under `tests: [...]` whose body exercises the failure mode end-to-end (i.e. a test that *does the thing the bug did* and asserts the corrected behavior). Documentation-only and structural-gate entries continue to bypass per-finding tests via `coverageStrategy`.

The R10-FG-4 gate test (now landing as part of Phase-8) catches placebo-by-elision. To extend coverage to the *quality* of the test (not just its existence), the manifest entry's locking test name must contain at least one of: `behavioral`, `integration`, `revert-proof`, or be paired with a `revertDrill`. (Soft form for now; tighten in R11+.)

### 5b. Comment → test → code lockstep (secondary)

When a fix's diff includes a code comment containing `must|MUST|NEVER|do NOT|don't`, the same diff MUST add a test referencing the same finding ID. Enforced by a pre-merge scan; failures point at the comment line and demand a paired test.

This is light — keyword-based, with an explicit `// invariant-untested: <reason>` waiver. Rationale: comments asserting invariants are the cheapest place to *write* an invariant and the most expensive place to *forget* one.

### Lockstep validation

Phase-8 closes R10-FG-1..4 under this discipline:

1. The four `r10-fg-*-behavioral.test.ts` files are authored *first*, FAILING (already done — Step 1).
2. The fix lands. Its diff is approved iff the corresponding test goes GREEN with no other test changes.
3. The test moves to a permanent home (the tests stay in `src/__tests__/` indefinitely; an entry in `audit-coverage.json` references each).

The cluster's commit message documents which test locks the fix.

---

## 6. Pre-mortem — what archetype is most likely to slip in next?

Each phase has invented its own introduction archetype. The series so far:

- R6 → sibling-class catch
- Phase-6 → wire-only closure
- Phase-7 → comment-vs-code mismatch

If Phase-8 holds the comment-vs-test-vs-code lockstep, the next archetype is unlikely to be in the *named* invariants. The next failure mode is most likely **invariants the author never wrote down** — assumptions encoded only in the function signature, the field shape, or downstream code:

- A type narrows further than the runtime data justifies (e.g. `string` field but writers occasionally emit `null` and readers crash on `JSON.parse(null)`).
- A function's return shape changes; callers never check the discriminated union exhaustively (e.g. new `kind: 'partial'` added; old switch branches default-skip it).
- A primitive's interface gains a method (`incrby`); some mock implementations don't add it; tests pass because nothing exercised those paths.

Pre-emptive defense: extend the Phase-3 manifest to require that any entry whose fix changed a *type or interface* lists at least one consumer-side regression test (`reverse-coverage`). Not in scope for Phase-8 — note for R11.

---

## 7. R11 success criterion

R11 lands `<15` findings, with `0` new criticals introduced by Phase-8. If R11 introduces ≥1 new critical, the dissection ratchet has not converged and Phase-9 must add a stricter gate (likely the reverse-coverage discipline above). If R11 lands `≥30`, stop and re-dissect.

The audit cycle's convergence is now measured in introduction *rate*, not finding *count*. Phase-8's job is to drive introduction rate to zero.
