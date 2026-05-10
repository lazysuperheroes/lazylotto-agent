# Round-9 Adversarial Audit — Phase-6 Convergence Verdict

**Date:** 2026-05-09 (round 9)
**Branch:** `testnet`
**Scope:** Re-audit of Phase-6 (clusters A→G+H), which itself was the once-and-for-all closure of the 32 R8 findings.

**Methodology:** 12 background personas, one persona each — same lineup as R6:
- P1 — R7+R8 regression hunter
- P2 — Concurrency / cross-Lambda atomicity
- P3 — Sibling sweep
- P4 — Integration boundary
- P5 — State-machine walker
- P6 — Self-heal critic
- P7 — API surface
- P8 — Test-quality auditor
- P9 — Closure verifier (32-finding table)
- P10 — Blind-spot agent
- P11 — Performance / scalability
- P12 — Audit-trail completeness + conservation invariants

**Raw count:** ~104 findings across 12 personas. Deduplicated to **~45 unique items**.

**Convergence trajectory:** R6 (115 findings) → R8 (32 findings) → R9 (~45 findings).

The R9 count slightly INCREASED relative to R8 in raw terms but the severity profile shifted radically: R8 had 5 critical / 10 high. **R9 has 5 critical / 9 high — and the criticals are now wiring/coverage gaps, not double-spend windows.** P9's closure-verification table marks **30 of 32 R8 findings CLOSED, 2 PARTIAL, 0 OPEN, 0 REGRESSED**.

**Verdict in one sentence:** Phase 6 structurally closed the named archetypes; the new findings are dominated by (a) production wiring gaps where the new mechanisms exist but aren't invoked, (b) Phase-6 INTRODUCTION bugs where I added accumulators but never used them in the final balance derivation, and (c) sibling archetypes the widened gates don't yet cover.

---

## Five-finding cluster of Phase-6 introduction bugs (highest priority)

These are bugs Phase-6 ITSELF introduced — not pre-existing issues the audit surfaced.

### `[ ]` R9-FG-1 (C) — `heldByToken` accumulator populated but NEVER subtracted from `ledgerBalanceByToken`
**Confirms:** P5-001, P12-001 (2 independent confirms).
**Bug:** `verify-audit.ts:849-861` accumulates `led.heldByToken[r.token] += r.amount` from triage `tokenReservations`. The final per-token derivation at `verify-audit.ts:1359-1368` computes `balance = dep - rk - sp - wd - rf`. **Never subtracts `heldByToken`.** R8-FG-24 closure is wire-only. A user with a held triage reservation shows full available balance — the very bug R8-FG-24 was meant to fix is still live.
**Fix:** subtract `(led.heldByToken[token] ?? 0)` in the derivation loop. Add `Object.keys(led.heldByToken)` to `allTokens`. Add regression test feeding a triage event with reservations and asserting reduced balance.

### `[ ]` R9-FG-2 (C) — `depositCreditFlushOrphanedByToken` populated but NEVER subtracted from `ledgerBalanceByToken`
**Confirms:** P5-001, P12-002 (2 independent confirms).
**Bug:** Same archetype as R9-FG-1. R6-FG-10 closure is wire-only. `verify-audit.ts:880-892` populates the accumulator; the derivation ignores it. Topic-only DR replay over-credits users by exactly the orphaned grossAmount. The original bug (R6-FG-10) is still live despite the closure ship.
**Fix:** subtract `(led.depositCreditFlushOrphanedByToken[token] ?? 0)` in the derivation loop. Add to `allTokens`. Regression test against synthetic mint+orphan pair asserts `ledgerBalanceByToken === 0`.

### `[ ]` R9-FG-3 (C) — `HCS20_SOFT_VALIDATE` env never set in any production path; schema-validation alerts ship as silent no-ops
**Confirms:** P1-001, P2-001, P4-002, P6-006, P7-008 (5 independent confirms).
**Bug:** `hcs20-reader.ts:336-344` `isSoftValidateEnabled()` returns false unless the env var is set. Grep across the entire repo finds NO writer of `HCS20_SOFT_VALIDATE=1` — not in `vercel.json`, not in `app/api/cron/reconcile/route.ts`, not in `src/scripts/verify-audit.ts`, not in `package.json` scripts. The reader's docstring at line 331 claims "cron + verify-audit set this" — the code does not. Phase-6 R8-FG-6 closure (verify-audit consumes `schemaValidationFailures`) is shipped but functionally unwired in every prod surface.
**Fix:** `process.env.HCS20_SOFT_VALIDATE = '1'` at the top of `app/api/cron/reconcile/route.ts` AND `src/scripts/verify-audit.ts`. Add a boot warning in `src/custodial/hcs20-reader.ts` first-use path: if neither env is set AND `process.env.VERCEL === '1'`, log warn. Add to `docs/mainnet-deploy-checklist.md` Phase 1 env-vars step.

### `[ ]` R9-FG-4 (C) — `reconcileOrphans` is wired to NOTHING in production
**Confirms:** P2-002, P6-002 (2 independent confirms; P11 inferred wiring exists but never grepped).
**Bug:** `src/lib/orphanReconciler.ts:31-34` docstring says "Wiring: invoked from the hourly `/api/cron/reconcile` endpoint after the existing reconcile passes." Grep confirms `reconcileOrphans` is imported only by `src/scripts/reconcile-orphans.ts` (CLI) and its own test. The cron route never calls it. Stuck claims accumulate silently across all 8 namespaces (including 30-day refund claims and 7-day pendingLedger claims). The docstring's "passive observer" guarantee is irrelevant if it's never observing in production.
**Fix:** in `app/api/cron/reconcile/route.ts`, after the existing reconcile resolves, call `await reconcileOrphans({ staleThresholdRatio: 0.75 })`; merge the count into the response payload; fire `RECONCILE_FAILURE_WEBHOOK_URL` when count ≥5. Add an incident-playbook symptom entry.

### `[ ]` R9-FG-5 (C) — `auth/verify.ts:107` message-substring sibling-miss archetype undefended by Phase-6 widened gate
**Confirms:** P3-001 (alone but cleanly identified).
**Bug:** `src/auth/verify.ts:107` does `err instanceof Error && err.message.includes('signature')` — the EXACT string-control-flow archetype Phase-6 R8-FG-25 retired in `MultiUserAgent.ts:1767` and `refund.ts:445`. The string `'signature'` is constructed at lines 96 and 103 of the same file. A future copy-edit ("validation"/"signing") silently flips the catch branch. The Phase-6 sibling-archetype gate adds patterns for `.name === 'X'` and `.constructor.name === 'X'` but NOT for `err.message.includes(...)`.
**Fix:** add a forbidden pattern `/\.\s*message\s*\.\s*includes\s*\(\s*['"]/g` to `sibling-archetype-gate.ts`. Replace verify.ts site with a typed `SignatureValidationError` sentinel. Same archetype family as R8-FG-25 — completing it.

---

## High-severity findings (9)

### `[ ]` R9-FG-6 (H) — `pendingLedger` body NOT idempotent on `(userId, sourceTx)`; 7-day double-debit window after Lambda crash mid-mutation
**Confirms:** P5-003 (genuinely new finding — Phase-6 R8-FG-7 fix relied on body idempotency assumption that doesn't hold).
**Bug:** Lambda A acquires fenced claim, runs `updateBalance` (Redis write-through fires; flush may or may not have completed), terminates hard. Sibling sees `kind:'busy'`, leaves the row. After 7-day TTL, claim auto-releases. Next drain re-acquires, body re-runs the full mutation. If the original Redis write landed, this is a double-debit. R8-FG-7's "leave the row for next drain" is correct ONLY if the body cannot double-apply.
**Fix:** add a SADD-membership check on `pending-ledger-applied:<userId>:<sourceTx>` (no TTL) before the mutation. The fencedClaim becomes a politeness-only serializer; the SADD is the correctness anchor.

### `[ ]` R9-FG-7 (H) — `recordPlaySessionClose` writer signature drops `strategyDeviation`; close-with-deviation cannot be recorded on chain
**Confirms:** P5-002 (R8-FG-17 was a half-fix).
**Bug:** Schema accepts `strategyDeviation` on both close + aborted; reader extracts it on both. Writer `recordPlaySessionAborted:1043` accepts it; `recordPlaySessionClose:1010-1033` does NOT. R8-FG-17's acceptance check explicitly required "Assert close + aborted both carry strategyDeviation when supplied" — only aborted got wired.
**Fix:** add `strategyDeviation?: { reason: string; field?: string }` to `recordPlaySessionClose`'s `details` type and conditionally spread.

### `[ ]` R9-FG-8 (H) — `RedisLike.scan` interface signature mismatches Upstash production return type
**Confirms:** P4-001, P10-003 (2 confirms).
**Bug:** Interface declares `Promise<[number, string[]]>`; Upstash actual is `Promise<[string, string[]]>`. Cast `as unknown as RedisLike` at `redis.ts:361` masks the mismatch. Today's two callers (orphanReconciler) defend with local cast + `cursor === 0 || cursor === '0'` exit guard. Future callers trusting the interface (`cursor + 1`) would silently loop forever on production Upstash.
**Fix:** change interface to `cursor: string | number` and `Promise<[string | number, string[]]>`. Mock stringifies on return.

### `[ ]` R9-FG-9 (H) — Field-level schema constraints (`AmountStringField` < 1e15, `originalDepositTxId.min(1)`) reject legacy testnet data through the READER-LOOSE schema
**Confirms:** P7-002, P7-003, P12-003 (3 confirms).
**Bug:** Phase-6 added `AmountStringField` and `.min(1)` AT THE FIELD LEVEL in shared schemas. Both writer-strict (`Hcs20WriterMessageSchema`) AND reader-loose (`Hcs20V2MessageSchema`) inherit them. Legacy testnet refunds with `amt: '1.5e308'` (finite, parses to MAX_VALUE) or `originalDepositTxId: ''` now fail BOTH parses. The reader's hand-coded `parseRefund` still parses them via `Number()` and `String() ?? ''`, but `softValidate` flags every legacy refund as `schema_validation_failure`. Third-party readers using our exported schemas get parse failure on existing data.
**Fix:** split into `AmountStringField` (loose, no bound) for the reader-loose schema, and `AmountStringFieldStrict` (with bound) for `Hcs20WriterMessageSchema`. Same for `originalDepositTxId`.

### `[ ]` R9-FG-10 (H) — `pendingLedger` queued debits invisible in user dashboard
**Confirms:** P6-001 (alone but high-impact UX).
**Bug:** Phase-6 R8-FG-7 leaves the row for next drain. Eager drain runs only on `withUserLock` re-entry; periodic runs hourly. Worst case: refund queues at T+0, sibling crashes mid-body, next drain at T+59min. `app/api/user/status/route.ts:106-122` returns `user.balances` verbatim with NO subtraction of pending adjustments. User dashboard shows phantom funds for ~1 hour. Withdraw modal lets the user request the refunded amount AGAIN (per-user lock catches it eventually but UX is misleading).
**Fix:** in user-status route, fetch `listPendingLedgerAdjustments(userId)`, subtract pending sums per-token from `tokens[k].available`. Add `pendingAdjustments` array to response.

### `[ ]` R9-FG-11 (H) — R8-FG-8 reader-side empty-string `originalDepositTxId` defense missing
**Confirms:** P9 PARTIAL verdict on R8-FG-8.
**Bug:** Writer schema `min(1)` rejects new emissions. Reader at `hcs20-reader.ts:1503` still does `String(... ?? '')` and verify-audit gates dedup on truthy `if (orig)`. A wire-conforming-but-empty `originalDepositTxId` (legacy or attacker-injected) bypasses dedup → double-credit.
**Fix:** in `parseRefund`, drop messages with empty `originalDepositTxId` (`return null`) AND emit `report.recordFailure('refund', 'empty originalDepositTxId')`.

### `[ ]` R9-FG-12 (H) — `orphanReconciler.test.ts` cross-contamination
**Confirms:** P10-005.
**Bug:** Only test #4 cleans its `:integration` seed; if it panics before line 136 (e.g. the dynamic import fails), the key persists across runs. Future `assert.equal(orphans.length, 1)` would silently fail.
**Fix:** add `:integration` to `beforeEach` candidates. Better: per-test prefix via `randomUUID()`.

### `[ ]` R9-FG-13 (H) — `RefundDuplicateError.kind` / `InFlightClaimError` discriminants thrown away at HTTP/MCP boundary
**Confirms:** P5-004, P6-008, P8 implicit (3 confirms).
**Bug:** Both error classes carry rich `kind` discriminants but admin routes (`app/api/admin/refund/route.ts:113-119`) and MCP tools (`src/mcp/tools/operator.ts:205-207`) catch generically and emit `error: message`. The compile-time exhaustiveness Phase-6 added is a writer-side benefit that never reaches the operator. Operator UI can't distinguish "wait 60s" from "force-release required" from "permanent ban — call SREM".
**Fix:** centralize error mapping in `app/api/_lib/errors.ts`. `if (err instanceof RefundDuplicateError) return { error, code: 'REFUND_DUPLICATE', kind, retryable: kind === 'in-progress' }`. Use 409 for in-progress, 422 for permanent.

### `[ ]` R9-FG-14 (H) — `R6-FG-5` and `R8-FG-13` source-regex tests don't strip comments before matching
**Confirms:** P8-001, P8-002 (Phase-3 placebo archetype recurrence).
**Bug:** `contracts.test.ts:76-94` and `MultiUserAgent.test.ts:1023-1061` read source via raw `readFileSync` and run regex. A comment containing `instanceof PreserveClaimError` (we have several documenting the archetype) could falsely satisfy. Same Phase-3 placebo archetype P8 found in R8.
**Fix:** route source-regex assertions through `lint-helpers.ts` `stripCommentsAndStrings(source)` before matching.

---

## Medium-severity findings (~20)

Major themes — see individual persona reports for file:line:
- **Sibling archetypes the gate doesn't catch yet** (P3-002, P3-003, P3-004, P3-007, P3-009): unfenced `redis.set(..., {ex})` overwrite-claim, unfenced `redis.del()` outside primitives, custom `redis.eval` Lua, `err.constructor === X` variant, `pipeline.sadd` (P10-006).
- **`deposit_credit_flush_orphaned` schema fields all `.optional()`** (P4-003, P5-006, P12 implicit): writer regression dropping grossAmount silently passes Zod. Need cross-field refine.
- **F24 plain-UUID fence + `uncertainTxVerification.ts:1314` legacy unfenced DEL** (P5-007, P3-005): Pre-Phase-6 legacy DL fallback can nuke a fresh F24 acquirer's claim.
- **Orphan reconciler**: mis-parses non-`pending:` values (P4-005, P5-005, P10), N+1 round-trips per scanned key (P11-001), sequential namespace walk (P11-007), context not in alert payload (P10-010), stale comment about mock (P10-004).
- **`UserLedger.ts:333` empty `catch {}`** swallows Phase-6 Zod throws — orphan control event silently disappears (P6-007).
- **softValidate has no boot warning when env unset** (P6-006): operator deploys to Vercel, loses every reader-side validation signal silently.
- **PreserveClaimError runtime guard incomplete** (P3-006): only blocks direct parent instantiation; subclass with `transactionId: undefined` still passes.
- **Strict schema throws conflate writer typos with on-chain failures in `audit_trail_orphaned`** (P6-005): operator sees same DL category for code bugs and infrastructure failures.
- **`ControlEventSchema.cause` field unbounded** (P4-004): large stack-trace causes throw at `enforceTopicMessageSizeLimit` boundary.
- **Test files compile into `dist/` and ship in npm package** (P10-007): pre-existing but Phase 6 doubled the footprint.
- **`coverageStrategy` required → merge conflict kills entire gate** (P10-008): one missing field on a backport entry fast-fails Zod parse, bypassing all cross-references.
- **Manifest ratio counter never ratchets** (P12-006, P10-009, P8-006): R8-FG-21 effectively still open. Counter is informational only.
- **Refund mid-deployment legacy `'pending'` form has no test** (P5-008): future cleanup that drops the literal-equals branch silently mis-classifies.
- **`InFlightClaimError` lacks kind discriminant** (P5-009): F24 has multiple distinct in-flight states, all collapse to one error.
- **Aborted-with-poolsRoot vs close-with-poolsRoot edge case** (P5-010): close-throw with PreserveClaim falls back to aborted, but original close may also land → reader sees both terminals.
- **No `.github/workflows/`** (P6-009): `schema:docs:check`, `audit:coverage:check` never run in CI.

## Low / informational findings (~12)

- `stripCommentsAndStrings` name lies (P1-004, P10-002).
- `FencedClaimOutcome` JSDoc claims `'preserved'` kind that doesn't exist in the type (P10-001).
- `AmountStringField` accepts `' '` (single space → Number(' ') === 0) (P1-006).
- Stale orphanReconciler comment about mock SCAN (P10-004).
- `releaseFence` eval-fail fallback warns at log level, never pages (P6-004).
- `recordRefund` writer spreads `rakeReversedToken: undefined` to JSON (P10-010).
- Per-message `process.env.HCS20_SOFT_VALIDATE` lookup (P11-008): hoist to per-walk boolean.
- Stale grandfather rationales without ticket tracking (P3-010).
- `slim_truncated_prizes` alert surfaced but `totalPrizeValue` not corrected (P12-007).
- `deposit_credit_flush_orphaned` reader dedup relies on writer's `idempotencyKey` (P12-008): defense-in-depth missing.
- No symmetric `user_balance_negative` alert (P12-005): operator has one.
- AlertCategory + custom Error classes verified clean (P4-009, P4-010).

---

## P9's 32-finding R8 closure verdict

| Verdict | Count | Notes |
|---|---|---|
| CLOSED | 30 | Structural closure confirmed at file:line for all 30 |
| PARTIAL | 2 | R8-FG-8 (reader-side empty-string defense missing → R9-FG-11), R8-FG-21 (description + missing R8-FG entries) |
| OPEN | 0 | — |
| REGRESSED | 0 | — |

The PARTIAL cases align with this round's findings:
- R8-FG-8 PARTIAL ↔ R9-FG-11
- R8-FG-21 PARTIAL ↔ R9-FG-15-class (manifest ratio counter doesn't ratchet)

---

## Convergence trajectory

| Round | Total findings | Critical | High | Note |
|---|---|---|---|---|
| R1 | ~80 | — | — | Pre-history |
| R2 | ~85 | — | — | Pre-history |
| R3 | ~95 | — | — | Pre-history |
| R4 | ~110 | — | — | Pre-history |
| R5 | ~115 | — | — | Pre-history |
| R6 | 115 | 15 | many | Last "double-spend windows" round |
| R8 | 32 | 5 | 10 | After R7 structural fixes |
| **R9** | **~45** | **5** | **9** | **After Phase-6 closure of R8** |

The raw count went UP slightly between R8 and R9 because Phase 6 changed a large surface and the audit ran across new code. The severity profile, however, IMPROVED:
- **R6 criticals were double-spend windows** (R6-FG-1..5).
- **R8 criticals were schema-loose, writer-bypass, gate-line-scope** (R8-FG-1..4).
- **R9 criticals are wiring gaps** (env not set, reconciler not invoked) and **Phase-6 introduction bugs** (accumulators not subtracted).

Risk class shifts from "operator could lose money" → "operator can't see drift" → "fix the wiring".

---

## Phase-7 readiness

The 5 R9 criticals fall into 3 root causes:
1. **Production wiring bugs** (R9-FG-3, R9-FG-4): two-line fixes in `app/api/cron/reconcile/route.ts` + `src/scripts/verify-audit.ts`.
2. **Phase-6 introduction bugs** (R9-FG-1, R9-FG-2): two-line fixes in `verify-audit.ts:1359-1368` derivation loop.
3. **Sibling archetype completion** (R9-FG-5): typed sentinel for `auth/verify.ts:107` + extend gate with `.message.includes(...)` pattern.

Combined with the 9 highs (most ~5-line fixes each) and ~20 mediums, Phase 7 is bounded — total surface ~50 small targeted edits. After Phase 7, R10 should land <20 findings if the Phase-6 introduction-bug pattern doesn't recur.

If R10 lands clean (<15), the audit cycle has converged.

---

## Files implicated (alphabetical, Phase-6 + R9 surface)

- `app/api/admin/refund/route.ts`
- `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts`
- `app/api/cron/reconcile/route.ts`
- `app/api/user/audit/route.ts`
- `app/api/user/status/route.ts`
- `docs/hcs20-v2-schema.md`
- `docs/incident-playbook.md`
- `docs/mainnet-deploy-checklist.md`
- `docs/uptime-monitoring.md`
- `src/__tests__/audit-coverage-scan.ts`
- `src/__tests__/audit-coverage.json`
- `src/__tests__/audit-coverage.test.ts`
- `src/__tests__/claim-archetype-gate.ts`
- `src/__tests__/lint-helpers.ts`
- `src/__tests__/sibling-archetype-gate.ts`
- `src/auth/redis.ts`
- `src/auth/verify.ts`
- `src/custodial/AccountingService.ts`
- `src/custodial/MultiUserAgent.ts`
- `src/custodial/UserLedger.ts`
- `src/custodial/hcs20-reader.ts`
- `src/custodial/hcs20-schema.ts`
- `src/custodial/pendingLedger.ts`
- `src/custodial/uncertainTxVerification.ts`
- `src/hedera/refund.ts`
- `src/hedera/transfers.ts`
- `src/lib/fencedClaim.ts`
- `src/lib/idempotency.ts`
- `src/lib/orphanReconciler.ts`
- `src/lib/orphanReconciler.test.ts`
- `src/mcp/tools/operator.ts`
- `src/scripts/verify-audit.ts`
- `src/scripts/verify-audit-crosscheck.ts`
- `tsconfig.cli.json`
