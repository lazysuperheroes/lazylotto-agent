# Round-8 Adversarial Audit — R7 Convergence Tracker

**Date:** 2026-05-08 (round 8)
**Branch:** `testnet`
**Scope:** Re-audit of R7 (phases 0-4) which itself was the once-and-for-all
structural fix for the recurring R1..R6 archetypes.

**Methodology:** 6 background personas, one persona each:
- P1 — Regression hunter on R7 phases 0-4
- P3 — Sibling sweep on the R7 structural gates
- P8 — Test-quality auditor (placebo + bidirectional invariant)
- P9 — Closure verifier (R6-FG-1..15 status)
- P10 — Blind-spot agent (everything outside the named lanes)
- P12 — Audit-trail completeness + conservation invariants

**Raw count:** 77 findings across 6 personas. Deduplicated to **~32 unique
items** below.

**Convergence verdict:**
The R7 thesis ("structural fixes prevent recurrence by construction") holds
**in shape but not in implementation**. Three of the four new gates have
genuine coverage holes that the audit found within hours:

1. **Phase-2 schema validation is loose, not strict** — Zod's default mode
   strips unknown writer keys silently rather than rejecting. `validateV2Message`
   gives operators false confidence: a typo like `rakeRevsered` passes
   validation, gets stripped, never reaches the topic, and the conservation
   invariant silently breaks. The schema file's own header comment promises a
   `*StrictSchema` variant that was never shipped. **3 independent confirms**
   (P12-001, P8-001, P1-002).

2. **Phase-2 writer gate has a backdoor** — `submitV2Message`'s private
   payload union omits `PrizeRecoveryMessage`, so `recordPrizeRecovery` falls
   through to the legacy `submitMessage` (no schema validation). The same
   applies to `recordControlEvent`. Any field drift in those op types ships
   to the topic unvalidated. **3 independent confirms** (P12-002, P3-002,
   P1-003).

3. **Phase-4 claim-archetype gate misses multi-line `redis.set(...)` calls**
   — the lint scans line-by-line, but every production SET-NX is multi-line.
   Seven uncaught hand-rolled claim sites in production code today
   (`refund.ts:382`, `refund.ts:1249`, `MultiUserAgent.ts:1752`,
   `escalation.ts:117`, `killswitch.ts:233`, `RedisStore.ts:858`,
   `app/.../force-release/route.ts:283`). The audit-coverage manifest
   advertises that the gate locks "every hand-rolled SET-NX" — false today.
   **3 independent confirms** (P3-003/004, P1-001, P10-002).

4. **Phase-1 sibling-archetype gate has a name-string sibling miss INSIDE
   the function it was supposed to protect** — `isPreserveClaim`'s
   cross-bundle fallback at `idempotency.ts:60` checks
   `err.name === 'ReceiptUncertainError'` but never `'PostSubmitError'`.
   The exact R5-FG-3 archetype lives in the helper meant to defend against
   it. R6-FG-17 in the round-6 doc flagged this; commits R6-0 and R6-1
   shipped without addressing it. **3 independent confirms** (P3-001,
   P9-sibling-miss, P10-003).

The pattern this round: **fixes were applied at the named site, sibling sites
in the SAME archetype were missed, the structural gate that's supposed to
catch the archetype is itself too narrow to see them**. This is the same
pattern that R7 was designed to break.

**However:** R6-FG-1..5 (Phase 0 hotfix), R6-FG-7, R6-FG-8 (Phase 2 fixes)
are **all closed at the named call sites**. P9 confirms each independently.
The fences themselves are correct; the gates AROUND them have the holes.

---

## Critical (5)

### `[ ]` R8-FG-1 (C) — Phase-2 `validateV2Message` silently strips unknown writer fields instead of rejecting
**Closes:** P12-001, P8-001, P1-002 (convergent).
**Bug:** `src/custodial/AccountingService.ts:1160` calls
`Hcs20V2MessageSchema.parse(payload)`. Zod's `discriminatedUnion` defaults to
strip-unknown-keys. A writer typo (`rakeRevsered: '14'` instead of
`rakeReversed`) reaches `submitV2Message`, the validator strips the unknown
field silently, the byte-cap and `JSON.stringify` operate on the stripped
payload, and the topic-side reader sees no field. Operator-balance reconstruction
runs short by exactly the un-emitted reversal — the EXACT R6-FG-7 archetype
the phase was built to prevent. The schema file header at
`src/custodial/hcs20-schema.ts:21-26` admits "Strictness is reserved for the
writer variant exported as `*StrictSchema`" — `Grep '*StrictSchema'` returns
zero matches. The promised variant was never shipped.
**Fix:** Either (a) build a strict variant by mapping the discriminated-union
options through `.strict()` and use it in `validateV2Message`, or (b) compare
`Object.keys(payload).every(k => k in schema.shape)` before calling parse.
This is the load-bearing claim of Phase 2; today it gives false confidence.

### `[ ]` R8-FG-2 (C) — `recordPrizeRecovery` + `recordControlEvent` bypass `validateV2Message` entirely
**Closes:** P12-002, P3-002, P1-003 (convergent).
**Bug:** `src/custodial/AccountingService.ts:1134-1141` — `submitV2Message`'s
private signature union omits `PrizeRecoveryMessage`. `recordPrizeRecovery`
at line 511 dispatches via the legacy `submitMessage` (no schema validation).
Same for `recordControlEvent` at line 451 (op="control" carrying R3-FG-22
`idempotencyKey` body-level dedup nonces — load-bearing for force-release
sibling dedup). Any drift between writer field set and `PrizeRecoverySchema`
or `ControlEventSchema` ships to the topic unvalidated. R6-FG-9 (the
`deposit_credit_flush_orphaned` field-drop) is a documented instance the
round-6 audit already called out; even after R7 it remains un-gated.
**Fix:** Add `PrizeRecoveryMessage | ControlEventMessage` to the
`submitV2Message` union. Migrate both record methods to call
`submitV2Message`. Add `ControlEventSchema` field for `event:'deposit_credit_flush_orphaned'`
plus the missing `grossAmount`/`token`/`cause` fields (closes R6-FG-9 at the
same time).

### `[ ]` R8-FG-3 (C) — Phase-4 claim-archetype gate scans line-by-line; seven multi-line SET-NX sites bypass
**Closes:** P3-003, P3-004, P3-010, P3-011, P3-014, P1-001, P10-002 (convergent).
**Bug:** `src/__tests__/claim-archetype-gate.ts:117-144` — the scanner reads
the file line by line and runs the regex on each. The regex
`/redis\s*\.\s*set\s*\([^)]*\b(nx|NX)\s*:\s*true/g` requires the entire call
on one line. Every production SET-NX call in this codebase is multi-line.
**Live bypasses:**
- `src/hedera/refund.ts:382-386` (refund per-tx claim)
- `src/hedera/refund.ts:1249-1252` (verifier per-tx claim)
- `src/custodial/MultiUserAgent.ts:1752-1756` (F24 operator per-token claim)
- `src/lib/escalation.ts:117-122` (escalation dedup)
- `src/lib/killswitch.ts:233-236` (kill-switch state)
- `src/custodial/RedisStore.ts:858` (agentSeq seed)
- `app/api/admin/uncertain-tx/[id]/force-release/route.ts:283` (verifier lock)

The gate test passes with **zero violations** while the codebase has seven
uncaught archetypes outside `ALLOWED_PATHS`. Adding a new SET-NX silently
merges. The gate was sold as "one-way ratchet for new code"; today it ratchets
nothing because its detection is broken.
**Fix:** Switch to whole-file scan: read each file's text once, normalize
whitespace via `text.replace(/\s+/g, ' ')` before regex, OR use a TS AST
walker (`ts-morph`) to find call expressions on a Redis-typed receiver. Then
either migrate the seven sites to `fencedClaim`/operator-locks or grandfather
each in `ALLOWED_PATHS` with documented exemption notes.

### `[ ]` R8-FG-4 (C) — `isPreserveClaim` name-fallback drops `PostSubmitError` (R6-FG-17 unfixed)
**Closes:** P3-001, P9-sibling-miss, P10-003 (convergent).
**Bug:** `src/lib/idempotency.ts:60` —
`if (err instanceof Error && err.name === 'ReceiptUncertainError') return true;`.
Single string equality, never updated when R5-FG-3 added `PostSubmitError`
as a sibling. This is the cross-bundle defense-in-depth fallback (the case
where module-identity drift breaks `instanceof PreserveClaimError`); under
exactly that failure mode, a `PostSubmitError`'s `name === 'PostSubmitError'`
fails the check, returns `false`, and the catch path DELs the idempotency
claim → retry submits a SECOND on-chain action → potential double-spend.
The sibling-archetype gate doesn't catch this because the file uses
`err.name === ...`, not `instanceof`. R6-FG-17 in the round-6 audit doc
flagged this; the R6-0 hotfix shipped without addressing it.
**Fix:** Two lines:
`if (err instanceof Error && (err.name === 'ReceiptUncertainError' || err.name === 'PostSubmitError')) return true;`.
Better: extend the sibling-archetype-gate's `FORBIDDEN_PATTERNS` with
`\.name\s*===\s*['"](?:ReceiptUncertainError|PostSubmitError)['"]` and
`\.constructor\.name\s*===\s*['"](?:ReceiptUncertainError|PostSubmitError)['"]`.

### `[ ]` R8-FG-5 (C) — `rakeReversed` without `rakeReversedToken` silently drops operator-balance reversal
**Closes:** P12-008.
**Bug:** `src/custodial/hcs20-reader.ts:1428-1431` — `parseRefund` only sets
`rakeReversedToken` when explicitly present. `RefundSchema` marks it
`.optional()` (`hcs20-schema.ts:248`). A wire-conforming refund with
`rakeReversed: '5'` and no `rakeReversedToken` emits `NormalizedRefundEvent`
with a number but no token. `verify-audit.ts:701-708` then requires
`reversedToken` truthy before crediting the reversal, so the reversal silently
drops from operator balance reconstruction. User-side `totalRefunded`
(line 698) still increments. Net: operator balance reads HIGHER than reality
(the rake was never accounting-reversed), conservation invariant 4 violated
on a fully wire-conforming message. R6-FG-7 closure was supposed to make
the field round-trip; it does, but the dependent token field is unenforced.
**Fix:** Either (a) make `rakeReversedToken` required when `rakeReversed` is
present via `.refine` cross-field check, OR (b) verify-audit falls back to
`event.token` (the refund's underlying token) when `rakeReversedToken` is
missing. Add a regression test feeding a refund with rakeReversed but no
rakeReversedToken and asserting operator balance updates.

---

## High (10)

### `[ ]` R8-FG-6 (H) — Reader's `softValidate` only OBSERVES; verify-audit doesn't consume `schemaValidationFailures`
**Closes:** P12-003.
**Bug:** `hcs20-reader.ts:285-289` — soft-validate is "Pure observation —
does NOT short-circuit the existing dispatch." Schema-violating messages flow
through legacy parsers and verify-audit's reducers without ever raising an
alert. `verify-audit.ts` does not read `result.stats.schemaValidationFailures`
— `Grep schemaValidationFailures verify-audit.ts` returns zero matches. The
clean-conservation summary masks reader-side schema failures.
**Fix:** verify-audit consumes `result.stats.schemaValidationFailures` and
emits a `critical` alert per entry. Promote the soft-validate signal into
the operator's runbook.

### `[ ]` R8-FG-7 (H) — pendingLedger `busy`-branch LREM reopens R6-FG-12 archetype
**Closes:** P9-partial.
**Bug:** `src/custodial/pendingLedger.ts:295-305` and `:464-471`. When Lambda
B sees `kind:'busy'` (because Lambda A is still mid-fenced-body), B's
"best-effort LREM" removes the LIST row. If Lambda A subsequently throws
non-preserve, `fencedClaim` releases the claim but the in-body LREM never
ran. The next drain pass sees no row → user's debit silently lost. The exact
R6-FG-12 archetype, in a slightly different shape, reopened by my Phase-4
migration. The comment "fence guarantees the sibling completed" is wrong —
release-on-throw is precisely the case where the row is NOT removed by the
sibling.
**Fix:** Drop LREM from the busy branch; let the next drain naturally
re-process. OR: have the busy-branch wait briefly for the sibling and re-poll
the claim before LREMing.

### `[ ]` R8-FG-8 (H) — Empty-string `originalDepositTxId` slips refund dedup at reader AND verify-audit
**Closes:** P12-012.
**Bug:** `RefundSchema.originalDepositTxId` is `z.string()` with no `.min(1)`
(`hcs20-schema.ts:236`). Reader at `hcs20-reader.ts:577-595` and verify-audit
at `verify-audit.ts:689-695` both gate on truthy values; empty string is
falsy. Two refund anchors with `originalDepositTxId: ''` BOTH count — both
`totalRefunded` and `totalRakeReversed` accumulate twice.
**Fix:** Schema `originalDepositTxId: z.string().min(1)`. Empty string is a
wire-level integrity failure; reject on both writer (R8-FG-1 fix) and reader.

### `[ ]` R8-FG-9 (H) — Orphan reconciler is dead code in dev/test; missing scan + missing namespaces
**Closes:** P10-004, P1-004 (convergent).
**Bug:** `src/lib/orphanReconciler.ts:103-134` probes
`(redis as unknown as { scan?: ... }).scan` and silently `break`s the loop
when scan is undefined. The `RedisLike` interface (`src/auth/redis.ts:97-144`)
does NOT declare `scan` — the in-memory mock has no implementation.
`findOrphanedClaims()` always returns `[]` in dev, in tests, and on any
deployment that falls back to memory mode. **Plus**: `EXPECTED_TTL_SEC`
registers only 5 prefixes (idempotency, lockUser, lockOperator,
pendingLedgerClaim, verifying). Misses `refunded` (refund.ts), `escalated`
(escalation.ts), `killswitch` (killswitch.ts), F24 operator per-token claim.
The `pending:` value-filter excludes legitimate non-fenced claims. **Plus**:
no test file (`Glob: **/orphanReconciler.test.ts → no files found`).
**Fix:** Declare `scan` on `RedisLike`; add an in-memory mock implementation
(O(N) iteration is fine for dev). Register every fenced-claim namespace in
`EXPECTED_TTL_SEC`. Drop the `pending:` filter in favor of per-prefix shape
predicates. Ship `src/lib/orphanReconciler.test.ts` exercising stale-detection
math.

### `[ ]` R8-FG-10 (H) — R6-FG-8 schema test is a placebo (zod strips unknown keys)
**Closes:** P8-001.
**Bug:** `src/custodial/hcs20-schema.test.ts:242` — `R6-FG-8: accepts the new
explicit 'token' field` asserts `RefundSchema.parse({...valid, token: 'LAZY'})`
doesn't throw. But because of R8-FG-1 (schema not strict), the parse passes
EITHER way: with the field declared OR with it removed (silently stripped as
unknown). The minimal revert "delete `token: HederaIdField.optional()` from
RefundSchema" still passes the test. The audit-coverage manifest's claim
"removing token from RefundSchema fails this test" is false.
**Fix:** Test must `assert.equal(parsed.token, 'LAZY')` or use a strict
schema variant (after R8-FG-1 ships). Either fix flips the test to
behavioral.

### `[ ]` R8-FG-11 (H) — R6-FG-5 locking test is a tautology (`typeof === 'function'`)
**Closes:** P8-002.
**Bug:** `src/hedera/contracts.test.ts:70` — locked test for R6-FG-5 in the
audit-coverage manifest is `assert.equal(typeof transferAllPrizesWithRetry,
'function')`. Any exported function passes; the test exercises no behavior.
A regression that flips the retry catch from `instanceof PreserveClaimError`
to `instanceof ReceiptUncertainError` (sibling miss back) passes both this
test AND the inheritance test (which only checks the parent-child relation).
**Fix:** Replace with a behavioral test that injects a `PostSubmitError` into
`transferAllPrizesWithRetry` and asserts the retry preserves the claim
(rethrows without escalating).

### `[ ]` R8-FG-12 (H) — Audit-coverage `notes`-substring exemption silently bypasses ~4 of 11 entries
**Closes:** P8-003, P10-013, P1-010 (convergent).
**Bug:** `src/__tests__/audit-coverage.test.ts:124-138` — exemption matches
substrings `'structural'`, `'Locked by'`, `'locked by'`, `'archetype'`. R6-FG-1,
R6-FG-2, R6-FG-3, R6-Phase-1, R6-Phase-4 all match by accident of vocabulary.
For these, the bidirectional invariant ("every locking test names the finding
ID") is silently bypassed — the locking test for four findings is the same
sibling-archetype-gate block, whose annotation names none of R6-FG-1/2/3.
The "bidirectional invariant" Phase-3 was sold on is mostly aspirational.
**Fix:** Replace the substring escape-hatch with an explicit
`coverageStrategy: 'individual' | 'structural-gate' | 'documentation-only'`
field on `FindingEntrySchema`. Opt-in instead of accidental keyword-match.

### `[ ]` R8-FG-13 (H) — Sibling-archetype gate detects pattern re-introduction, not behavioral revert
**Closes:** P8-004.
**Bug:** A regression that flips `MultiUserAgent.ts:1144` from
`if (error instanceof PreserveClaimError)` to `if (false)` (or replaces the
catch with `releaseReservations(...); throw error`) reopens R6-FG-2 without
introducing any forbidden `instanceof ReceiptUncertainError` token. The
sibling-archetype gate only detects PATTERN reintroduction; behavioral
reverts pass.
**Fix:** Add behavioral tests that inject a `PostSubmitError` into each of
the three `MultiUserAgent` catch paths and assert reservations are NOT
released (or, in the operator-fees path, the F24 claim is NOT DELed).

### `[ ]` R8-FG-14 (H) — `releaseFence` eval→DEL fallback is untested (R5-FG-48 archetype)
**Closes:** P8-007.
**Bug:** `fencedClaim.test.ts:131` exercises eval-success path only (mock
supports eval). The catch block at `fencedClaim.ts:177-208` (eval→DEL
fallback that R5-FG-48 was added to handle) is never exercised. A regression
that deletes the fallback still passes the test.
**Fix:** Author a test injecting an eval-throwing redis double; assert
`releaseFence` falls through to plain DEL.

### `[ ]` R8-FG-15 (H) — Reader `softValidate` runs Zod safeParse on every message — perf regression on long walks
**Closes:** P10-005.
**Bug:** `hcs20-reader.ts:490` — soft-validate runs inside the per-message
loop. Zod safeParse is ~5-50µs per call. For a 10k-message topic walk
(testnet has been writing v2 for weeks), this adds ~50-500ms per audit-page
render. `/api/user/audit` and `/api/admin/audit` invoke this synchronously
per request. No memoization despite ~13 literal op values.
**Fix:** Either (a) gate via `HCS20_SOFT_VALIDATE` env (cron + CLI only,
not hot user paths), (b) memoize per-op LRU on stable JSON hash, or (c)
sample first N per op type per request. Add a perf regression test asserting
≥10k-message walks complete under 500ms.

---

## Medium (12)

### `[ ]` R8-FG-16 (M) — `slim_truncated_prizes` writer-emitted but reader never reads it
**Closes:** P12-006.
**Bug:** Writer stamps `slim_truncated_prizes:N` (`AccountingService.ts:117`).
Schema permits it (`hcs20-schema.ts:140-142`). Reader's `reconstructSession`
NEVER reads the field — `Grep slim_truncated_prizes hcs20-reader.ts` returns
zero matches. `NormalizedSession` has no `truncatedPrizesDropped` count.
Verify-audit blind to silent prize loss. The dropped prizes happened on chain
(transferPendingPrizes); the topic claims a smaller `totalPrizeValueByToken`.
**Fix:** Reader sums `pool.slim_truncated_prizes` into a session-level count
and emits a `prize_count_truncated:N` warning; verify-audit promotes to
`warning`.

### `[ ]` R8-FG-17 (M) — `recordPlaySessionAborted` writer never accepts `strategyDeviation` (R5-FG-59 half-implemented)
**Closes:** P1-006.
**Bug:** `PlaySessionAbortedSchema` declares optional `strategyDeviation`
(`hcs20-schema.ts:175-179`). The inferred type includes it. But
`recordPlaySessionAborted` (`AccountingService.ts:998-1031`) parameter
object never accepts a `strategyDeviation` argument and never spreads it.
Schema docs the field; readers expecting it on aborted-with-deviation never
see it. R5-FG-59 was supposed to close this archetype on close + aborted;
shipped only on close.
**Fix:** Add `strategyDeviation?: { reason: string; field?: string }` to
the writer parameter; spread conditionally.

### `[ ]` R8-FG-18 (M) — `softValidate` silently skips unknown ops; no flag in stats
**Closes:** P1-005.
**Bug:** `hcs20-reader.ts:316` — `if (!(op in HCS20_SCHEMAS)) return;`. An
unknown `op` (writer bug, attacker injection, future v3) records nothing in
`schemaValidationFailures`. Phase-2's claim was "drift surfaces"; an unknown
op IS the drift case it should flag.
**Fix:** Record under sentinel like `op:'<unknown>'` so dashboards see the
count.

### `[ ]` R8-FG-19 (M) — R6-FG-12 manifest entry locks the wrong test
**Closes:** P8-006.
**Bug:** Manifest references `releases the claim on a non-preserve throw`
(`fencedClaim.test.ts:75`) as the locking test for R6-FG-12 (pendingLedger
bug). But that test exercises only the primitive's contract. A regression
that reverts pendingLedger.ts:226 back to hand-rolled `redis.set(key, '1',
{ nx: true, ex: ... })` + missing-DEL would NOT fail the locking test;
the primitive still works in isolation.
**Fix:** Add `claim-archetype-gate.test.ts` to R6-FG-12's `tests` array AS
A SECONDARY (after R8-FG-3 fix makes the gate actually catch the regression).

### `[ ]` R8-FG-20 (M) — R6-FG-4 drill validates only the import-line check; `safeSubmit(` count assertion unexercised
**Closes:** P8-005.
**Bug:** `R6-FG-4.patch` removes `safeSubmit` from the import line. The
test's TWO assertions (import regex + ≥2 call sites) — only the first fires.
A regression that drops one of the two `safeSubmit(` call sites without
touching the import passes the test.
**Fix:** Add a second drill patch (`R6-FG-4-callsite.patch`) that removes
ONLY one `safeSubmit(` invocation, leaving the import intact. List both
patches in the manifest.

### `[ ]` R8-FG-21 (M) — Audit-coverage manifest under-claims R6 by ~93%
**Closes:** P10-006.
**Bug:** Manifest description says "every shipped audit-finding fix"
(`audit-coverage.json:4`) but lists 9 entries for 115 R6 findings. CLAUDE.md
says R6-1a phase shipped FG-1, 5, 6, 7, 9, 10, 11, 12 — manifest only
explicitly covers FG-1..5, 7, 8, 12. The structural-gate entries cover some
findings by archetype but the count-vs-claim is ambiguous. The gate enforces
"every entry has a real test"; it does NOT enforce "every shipped fix has
an entry".
**Fix:** Either (a) rewrite the description as "structural gates + critical
fixes", or (b) add a counter-test that compares finding IDs in
`docs/audit-*-round*.md` against manifest entries and flags un-tracked
closed findings.

### `[ ]` R8-FG-22 (M) — Refund `amt` schema is `string`; no upper bound — overflow → NaN ledger balances
**Closes:** P12-004.
**Bug:** `RefundSchema.amt` is `z.string()` (`hcs20-schema.ts:223`). For
`amt: "1.7976931348623157e+308"` (Number.MAX_VALUE, finite), `parseRefund`
emits a Number that propagates through verify-audit's reducers, producing
`Infinity` → `NaN` per-token balances. Conservation invariant 3 produces
NaN silently if no separate alert exists.
**Fix:** Schema `amt: z.string().refine(s => { const n = Number(s); return
Number.isFinite(n) && n >= 0 && n < 1e15; }, 'unreasonable amount')`. Same
for `rakeReversed`.

### `[ ]` R8-FG-23 (M) — `recordControlEvent` `idempotencyKey` field is dedup-load-bearing yet has NO schema validation
**Closes:** P3-005.
**Bug:** `recordControlEvent` (`AccountingService.ts:451-468`) routes through
`submitMessage` (no Zod). `idempotencyKey` field name is a magic string; a
typo (`idempotency_key`, `idemKey`) emits a topic message that the reader's
dedup never matches. R3-FG-22 sibling dedup silently breaks.
**Fix:** Same as R8-FG-2 — route through `submitV2Message` with
`ControlEventSchema` typed.

### `[ ]` R8-FG-24 (M) — `tokenReservations` on control events validated by softValidate but NOT consumed by verify-audit
**Closes:** P12-015.
**Bug:** `play_uncertain_success_pending_triage` events carry
`tokenReservations: [{token, amount}]` so the held funds are visible on chain.
`verify-audit.ts:773-820` only formats the field into the alert message
string — never reduces user balance. User reads "available" higher than
agent has reserved.
**Fix:** verify-audit reduces per-user `ledgerBalanceByToken[token]` by sum
of held reservations for each pending-triage event.

### `[ ]` R8-FG-25 (M) — String-control-flow archetype seeds in MultiUserAgent.ts:1767, refund.ts:445
**Closes:** P3-006, P3-007.
**Bug:** `MultiUserAgent.ts:1767` — `claimErr.message.includes('already in
flight')` discriminates on a writer-constructed string from 7 lines earlier.
A future copy-edit ("withdrawal in progress on another Lambda") flips the
branch silently. `refund.ts:445-449` has 5 such substring discriminations
on internally-constructed strings. Same archetype seed as R5-FG-3 — string
as control flow.
**Fix:** Throw typed sentinels (`InFlightClaimError`,
`RefundDuplicateError extends Error { kind: 'in-progress' | 'completed' |
'failed-onchain' | 'refunded-originals' | 'unknown' }`). Catch on
`instanceof`. Adds compile-time exhaustiveness.

### `[ ]` R8-FG-26 (M) — `fencedClaim`'s documented `context` parameter is never written to Redis
**Closes:** P1-012.
**Bug:** `src/lib/fencedClaim.ts:73-79` documents `context` as "stamps the
claim with caller metadata so the orphan reconciler can attribute stuck
claims to a specific subsystem." Implementation never writes context — only
the `pending:<uuid>` fence is stored. `OrphanedClaim.kind` is computed from
key prefix, not context. The documented contract is unfulfilled.
**Fix:** Either (a) drop `context` from the API and the docstring, or (b)
encode it into the fence value (`pending:<uuid>:<context>`) so
compare-and-DEL still works (entire string must match for release).

### `[ ]` R8-FG-27 (M) — Phase-1 sibling-archetype gate may not scan `app/`
**Closes:** P1-007.
**Bug:** Need to verify the gate's tree-walker actually descends into `app/`.
Phase-4 claim-archetype gate explicitly walks both; Phase-1 should be
identical. Without the same scan, a regression in any Next.js route handler
re-introduces the archetype.
**Fix:** Add a regression test that drops `instanceof ReceiptUncertainError`
into a tmp `app/api/test-stub.ts` and asserts the gate flags it.

---

## Low / Informational (5)

### `[ ]` R8-FG-28 (L) — SADD/INCR claim archetypes unguarded
**Closes:** P10-001.
**Bug:** Claim-archetype gate forbids only `redis.set(*, *, { nx: true })`.
CLAUDE.md names three primitives — SADD-claim, SET-NX-lock, INCR-counter —
all of which can produce stuck-claim variants. Live SADD/INCR call sites
are not gated.
**Fix:** Extend `FORBIDDEN_PATTERNS` to include `redis\.sadd\(` (with allow
list for refund.ts existing producers + RedisStore.ts) and `redis\.zadd\(`.

### `[ ]` R8-FG-29 (L) — Sibling-archetype gate per-line comment strip false-positives on multi-line block comments
**Closes:** P10-010.
**Bug:** Per-line `replace(/\/\*[\s\S]*?\*\//g, '')` doesn't span lines. A
multi-line block comment opened on line N with `/*` and closed on N+5 with
`instanceof PostSubmitError` on line N+2 falsely fires. No production file
does this today, but a future docblock breaks CI.
**Fix:** Pre-process whole file: replace block comments with whitespace
preserving line numbers before line iteration.

### `[ ]` R8-FG-30 (L) — `findTestLine` substring match doesn't enforce uniqueness
**Closes:** P10-011.
**Bug:** `audit-coverage-scan.ts:108-121` — first-match semantics, but the
schema docstring promises "make it precise enough to match exactly one test
(the gate enforces uniqueness)". The gate only checks `line === null`. False
precision claim.
**Fix:** Either implement uniqueness (count matches; assert exactly 1) or
update the schema docstring to acknowledge first-match.

### `[ ]` R8-FG-31 (L) — Doc generator collapses `oneOf` to literal "discriminated union"
**Closes:** P10-008.
**Bug:** `generate-schema-docs.ts:104-106` returns the string
`'discriminated union'` for any `oneOf` field. No schema uses
`z.discriminatedUnion` at the top-level field today, but a future v3 message
variant would silently lose information.
**Fix:** Recurse into `oneOf` like `anyOf` does (line 99-102).

### `[ ]` R8-FG-32 (L) — `PreserveClaimError` abstract class lacks runtime instantiation guard
**Closes:** P10-014.
**Bug:** `transfers.ts:89-92` — abstract enforced at compile-time only.
`new (PreserveClaimError as any)()` instantiates the parent with
`transactionId: undefined`. No test asserts the runtime guard.
**Fix:** Add constructor guard `if (new.target === PreserveClaimError) throw
new TypeError('PreserveClaimError is abstract');`.

---

## Deferred R6 critical findings — never in R7 scope

P9 closure verifier flagged eight R6 critical findings the R7 plan never
addressed. These are NOT regressions from R7; they're carried over.

| ID | Severity | Subsystem | Risk |
|---|---|---|---|
| R6-FG-6 | C | Merkle | `slimPoolResult` cap=10 vs close `poolsRoot` over full set → readers mark >10-prize sessions `corrupt` |
| R6-FG-9 | C | Wire | `recordControlEvent` drops `grossAmount`/`token`/`cause` for `deposit_credit_flush_orphaned` |
| R6-FG-10 | C | Verifier | verify-audit doesn't switch on `deposit_credit_flush_orphaned` → no alert |
| R6-FG-11 | C | Runbook | `--store-snapshot` opt-in; runbooks don't pass it → operator sees clean conservation while DLs accumulate |
| R6-FG-13 | C | Wire | `submitV2Message` raw `.execute()` no `safeSubmit` → SDK post-submit throw corrupts `agentSeq` |
| R6-FG-14 | C | Idempotency | plain-DEL fallback bypasses fence under transport-throw race |
| R6-FG-15 | C | Reader | `isPostLegacyCutoff(undefined)` returns `false` → strip-timestamp bypass of R5-FG-2 |
| R6-FG-17 | C | Idempotency | `isPreserveClaim` name fallback (closed by R8-FG-4) |

Plus R6-FG-18..22 (auth/rate-limit) — also unaddressed.

---

## Positive findings (what IS solid)

P9 confirms each independently:
- **R6-FG-1, 2, 3 (CLOSED)**: `MultiUserAgent` catch broadening + structural
  gate. No sibling miss at any of three call sites.
- **R6-FG-4 (CLOSED)**: `executeIntent` + `executeEncodedCall` both wrapped
  in `safeSubmit`. Source-regex test catches imports + ≥2 call sites.
- **R6-FG-5 (CLOSED)**: retry catch uses `instanceof PreserveClaimError`,
  no string-name comparison. Inheritance test locks parent-child relation.
- **R6-FG-7 (CLOSED)**: parseRefund extracts both fields, type extended,
  verify-audit consumes. Round-trip test from contracts.test.ts exercises
  the wire path.
- **R6-FG-8 (CLOSED)**: schema + writer + both refund.ts call sites + reader
  prefer explicit `token`. (Test is a placebo per R8-FG-10, but the FIX
  itself is correct.)

P8 explicitly validates as ROBUST:
- `releases the claim on a non-preserve throw` (fencedClaim.test.ts:75) —
  drill verifiably fires.
- `PRESERVES the claim on PreserveClaimError (rethrows)` — behavioral.
- `rakeReversed is read from the wire payload` — round-trip integration.
- `throws when a required field is missing` — behavioral.
- `rejects an unknown op` — behavioral.

The fences themselves are correct. The gates around them have the holes.

---

## Triage summary

- **5 critical** (R8-FG-1..5): all are gate/validation coverage holes — the
  R7 thesis still works but its ENFORCEMENT layer is too narrow today.
- **10 high** (R8-FG-6..15): sibling misses, perf regressions, untested code
  paths, placebo tests.
- **12 medium** (R8-FG-16..27): smaller surface, mostly missing-consumer or
  half-implemented features.
- **5 low/informational** (R8-FG-28..32).

**Total: 32 unique findings**, vs the R6 round of 115.

The structural-fix thesis converged: down from 115 → 32 (~72% reduction)
between R6 and R8. The remaining 32 cluster into ~5 root causes (loose
schema, gate-line-scope, gate-namespace-scope, missing-bidirectional-test,
half-implemented-feature). That's the kind of failure mode the next phase
can close in one structural pass — not 32 individual point fixes.

If R9 is run after the 5 critical fixes ship, expect <15 findings.
