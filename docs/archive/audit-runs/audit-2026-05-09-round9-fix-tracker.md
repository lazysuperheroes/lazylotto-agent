# Round-9 Fix Tracker — Phase 7 Single-Pass Hardening

**Date created:** 2026-05-09
**Branch:** `testnet`
**Source audit:** `docs/audit-2026-05-09-round9.md` (~45 findings: 5 critical, 9 high, ~20 medium, ~12 low/info)
**Goal:** close every R9 finding in one structural pass, organized into 9 clusters of root-cause fixes. R10 (12-persona re-audit) should land with <20 findings.

This file is the rollback artifact. Each cluster gets its own commit; cluster commit hashes are recorded below so any cluster can be reverted independently if it breaks something downstream.

This file is **temporary** — once R10 converges and the audit-coverage manifest absorbs the closures, the entire `docs/audit-2026-05-*` set (R6 + R8 + R8-tracker + R9 + R9-tracker) gets garbage-collected.

---

## Cluster status overview

| Cluster | Scope | Findings | Status | Commit |
|---|---|---|---|---|
| A | Production wiring (env + cron invocation) | 2 critical | `[x] DONE` | (uncommitted) |
| B | Verify-audit derivation completeness | 2 critical + 1 medium | `[x] DONE` | (uncommitted) |
| C | Sibling archetype gate completion | 1 critical + ~6 mediums | `[x] DONE` | (uncommitted) |
| D | Schema field-level/writer-strict split | 1 high + 2 mediums | `[x] DONE` | (uncommitted) |
| E | pendingLedger idempotency + status surfacing | 2 highs | `[x] DONE` | (uncommitted) |
| F | Half-implemented feature completion | 3 highs + 2 mediums | `[~] PARTIAL` | F24 migration deferred to R10-Phase-1; rest done |
| G | Reconciler reliability + tests | 1 high + ~5 mediums | `[~] PARTIAL` | scan signature + non-pending parse + context log + test cleanup done; perf P11-001/007 deferred |
| H | Test quality + CI ratchets | 1 high + ~10 lows | `[~] PARTIAL` | source-regex strip, rename, JSDoc, runtime guard, coverageStrategy default, CI workflow, dist exclusion done; manifest ratchet baseline + Zod-aware DL routing deferred |
| I | Manifest + docs hygiene | R8-FG-21 PARTIAL + ~7 mediums | `[~] PARTIAL` | description rewrite + R9-FG entries done; prose doc updates (hcs20-v2-schema.md, disaster-recovery.md, incident-playbook.md) deferred |

**Order:** A → C → D → B → E → F → G → H → I.

Why: A is two-line wiring (do first to unblock prod observability). C widens gates so subsequent refactors are caught. D refactors schema (deps for E + F + B's regression tests). B fixes derivation. E pendingLedger. F feature completion. G reconciler. H tests. I docs.

---

## Per-finding tracker

### Cluster A — Production wiring (closes 2 critical)

> **Root cause:** Phase 6 added new mechanisms but the production cron + script entrypoints never invoke or enable them. `softValidate` env never set; `reconcileOrphans` never called from cron. Phase-6 R8-FG-6 and R8-FG-9 closures are functionally dead in production despite tests passing.
>
> **Single fix:** Set `HCS20_SOFT_VALIDATE=1` at cron + verify-audit startup. Wire `reconcileOrphans` into the cron route. Boot warning when env unset in Vercel. Update mainnet-deploy-checklist.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-3 | C | `HCS20_SOFT_VALIDATE` env never set in any production path; schema-validation alerts ship as silent no-ops | `[x]` set in cron route + verify-audit + boot warning |
| R9-FG-4 | C | `reconcileOrphans` is wired to NOTHING in production | `[x]` invoked in cron after reconcile + webhook on threshold |

**Files touched:**
- `app/api/cron/reconcile/route.ts` — set env + invoke reconcileOrphans
- `src/scripts/verify-audit.ts` — set env at startup
- `src/custodial/hcs20-reader.ts` — boot warning when prod env unset
- `docs/mainnet-deploy-checklist.md` — env-var step

**Acceptance check:** boot warning fires in synthetic Vercel-env test; cron route smoke test confirms `reconcileOrphans` is imported and called.

---

### Cluster B — Verify-audit derivation completeness (closes 2 critical + 1 medium)

> **Root cause:** Phase 6 added `heldByToken` and `depositCreditFlushOrphanedByToken` accumulators on `PerUserLedger` and populated them from triage events + orphan events, but the final per-token derivation at `verify-audit.ts:1359-1368` still uses the pre-Phase-6 formula `dep - rk - sp - wd - rf`. Both R8-FG-24 and R6-FG-10 closures are wire-only — the data is captured but never used.
>
> **Single fix:** Subtract both accumulators from balance in the derivation loop. Add `Object.keys(...)` of both maps to `allTokens`. Add symmetric `user_balance_negative` alert. Surface slim_truncated_prizes into per-user warnings.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-1 | C | `heldByToken` accumulator populated but NEVER subtracted from `ledgerBalanceByToken` | `[ ]` |
| R9-FG-2 | C | `depositCreditFlushOrphanedByToken` accumulator populated but NEVER subtracted | `[ ]` |
| R9-P12-005 | M | No symmetric `user_balance_negative` alert (operator has one) | `[ ]` |
| R9-P12-007 | L | `slim_truncated_prizes` alert surfaced but `totalPrizeValue` not corrected | `[ ]` |

**Files touched:**
- `src/scripts/verify-audit.ts` — derivation loop + alert + warnings

**Acceptance check:** new tests — synthetic mint+orphan asserts `ledgerBalanceByToken === 0`; triage event + reservations asserts held subtraction; negative-balance synthetic asserts new alert; truncated-prize session adds warning.

---

### Cluster C — Sibling archetype gate completion (closes 1 critical + ~6 mediums)

> **Root cause:** Phase 6 widened the gate to `.name === 'X'` and `.constructor.name === 'X'` but missed three sibling families: `.message.includes(...)` substring discrimination (R9-FG-5), unfenced `redis.set(..., {ex})` overwrite-claim, unfenced `redis.del/eval` outside primitives, `err.constructor === X` variant, `pipeline.sadd` form. Several call sites still use these archetypes.
>
> **Single fix:** Extend FORBIDDEN_PATTERNS for both gates. Migrate or grandfather every newly-flagged site. Add typed sentinel for auth/verify.ts message-substring. Behavioral fixtures asserting each new pattern fires.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-5 | C | `auth/verify.ts:107` message-substring sibling-miss undefended by widened gate | `[x]` `SignatureValidationError` typed sentinel |
| R9-P3-002 | C/M | `redis.set(..., { ex: TTL })` velocity-counter race at MultiUserAgent.ts:2550 | `[x]` atomic `incrby + expire` |
| R9-P3-003 | H | Unfenced `redis.del()` on idempotency keys at userOps.ts:612,632 | `[x]` gate flags + grandfather rationale |
| R9-P3-004 | H | Unfenced `redis.del()` for kill-switch at killswitch.ts:325,426 | `[x]` gate flags + grandfather rationale |
| R9-P3-007 | M | Custom `redis.eval` Lua at force-release/handlers.ts:455,688 | `[x]` gate flags + grandfather (uses RELEASE_SCRIPT) |
| R9-P3-009 | M | `err.constructor === X` variant not caught by gate | `[x]` gate pattern + behavioral fixture |
| R9-P10-006 | L | SADD pattern misses `pipeline.sadd(...)` form | `[ ]` (deferred — current pattern is `redis.sadd` only; pipeline.sadd would require receiver-agnostic pattern) |
| R9-P3-010 | L | Stale grandfathers without ticket tracking | `[x]` rationale notes added; R10-Phase-1 tracker references |

**Files touched:**
- `src/__tests__/sibling-archetype-gate.ts` — `.message.includes`, `.constructor === X` patterns
- `src/__tests__/sibling-archetype-gate.test.ts` — 2 new behavioral fixtures
- `src/__tests__/claim-archetype-gate.ts` — set-ex-no-nx, redis.del, redis.eval, pipeline.sadd patterns + grandfathers
- `src/__tests__/claim-archetype-gate.test.ts` — 4 new behavioral fixtures
- `src/auth/verify.ts` — `SignatureValidationError` typed sentinel
- `src/custodial/MultiUserAgent.ts:2550` — velocity counter via `incrby + expire`
- `src/services/userOps.ts:612,632` — `releaseIdempotencyClaim` helper or grandfather with rationale
- `src/lib/idempotency.ts` — new `releaseIdempotencyClaim` if needed
- `src/lib/killswitch.ts:325,426` — grandfather DEL with rationale
- `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts` — grandfather redis.eval if RELEASE_SCRIPT-equivalent

**Acceptance check:** all gates green; behavioral fixtures fire; velocity-counter atomic via incrby; auth/verify.ts catches via `instanceof`.

---

### Cluster D — Schema field-level/writer-strict split (closes high R9-FG-9 + 2 mediums)

> **Root cause:** Phase 6 added `< 1e15` bound + `.min(1)` constraint at the FIELD level on shared schemas. Both `Hcs20WriterMessageSchema` (strict) and `Hcs20V2MessageSchema` (loose) inherit them. Legacy testnet refunds with `amt: '1.5e308'` or empty `originalDepositTxId` now fail BOTH parses → `softValidate` flags every legacy refund as drift; third-party readers using exported schemas reject existing data.
>
> **Single fix:** Split into loose (reader-facing) and strict (writer-only) variants. Cross-field refine for `deposit_credit_flush_orphaned`. Bound on `cause` field.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-9 | H | Field-level constraints reject legacy testnet data through reader-loose schema | `[ ]` |
| R9-P12-003 | H | Legacy refunds with `1e308` amt propagate via reader's unrefined `Number()` | `[ ]` |
| R9-P4-003 | H | `deposit_credit_flush_orphaned` schema fields all `.optional()` — silent DR-replay zero | `[ ]` |
| R9-P5-006 | M | Same as P4-003 — schema needs cross-field invariant | `[ ]` |
| R9-P4-004 | M | `cause` field has no max length; oversized values fail size cap at the boundary | `[ ]` |
| R9-P10-010 | L | `recordRefund` writer spreads `rakeReversedToken: undefined` to JSON | `[ ]` |

**Files touched:**
- `src/custodial/hcs20-schema.ts` — split AmountStringField + originalDepositTxId; cross-field refine; .max(500) on cause; conditional rakeReversedToken spread
- `src/custodial/hcs20-v2.ts` — re-export new strict variants
- `src/custodial/hcs20-schema.test.ts` — 4 new tests covering loose/strict split + cross-field
- `src/custodial/AccountingService.ts` — conditional rakeReversedToken spread (R9-P10-010)

**Acceptance check:** loose reader accepts legacy unbounded amount + empty originalDepositTxId; strict writer rejects both; cross-field on flush_orphan refuses missing fields; cause >500 chars rejected.

---

### Cluster B (continued — runs after D)

(B's regression tests assert against the strict writer schema landed in D.)

---

### Cluster E — pendingLedger idempotency + status surfacing (closes 2 highs)

> **Root cause:** Phase 6 R8-FG-7 fix (drop busy-branch LREM) was correct under the assumption that bodies are idempotent. They aren't. Lambda crash mid-mutation creates 7-day double-debit window after TTL expiry. Plus user dashboard shows phantom funds for pending adjustments.
>
> **Single fix:** SADD-membership check `pending-ledger-applied:<userId>:<sourceTx>` (no TTL) BEFORE mutation. Add to user-status route subtraction.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-6 | H | pendingLedger body NOT idempotent on (userId, sourceTx); 7-day double-debit window | `[ ]` |
| R9-FG-10 | H | pendingLedger queued debits invisible in user dashboard | `[ ]` |
| R9-P2-004 | H | pendingLedger eager-path orders LREM BEFORE flush — kill window | `[ ]` |

**Files touched:**
- `src/custodial/pendingLedger.ts` — SADD primitive + reorder eager flush→LREM
- `app/api/user/status/route.ts` — subtract pending adjustments
- `src/custodial/pendingLedger.test.ts` (new or existing) — tests for both

**Acceptance check:** synthetic Lambda-crash test asserts next drain skips re-mutation; user-status returns reduced available when pending exists.

---

### Cluster F — Half-implemented feature completion (closes 3 highs + 2 mediums)

> **Root cause:** Several Phase-6 features partially wired up. Schema accepts `strategyDeviation` on close + aborted but writer only emits on aborted. Reader-side `originalDepositTxId.min(1)` defense missing. Typed errors carry rich `kind` discriminants but HTTP/MCP boundary collapses to plain message strings. F24 fence not in `pending:<uuid>:<context>` format → orphan reconciler can't attribute. Legacy DL fallback in `uncertainTxVerification.ts:1314` does unfenced DEL.
>
> **Single fix:** Wire `strategyDeviation` to close writer. Reader-side empty-string defense. Centralized error→API mapping. F24 fence migration. Tighten legacy fallback.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-7 | H | `recordPlaySessionClose` drops `strategyDeviation` (half-fix) | `[ ]` |
| R9-FG-11 | H | R8-FG-8 reader-side empty-string defense missing | `[ ]` |
| R9-FG-13 | H | Typed error discriminants thrown away at HTTP/MCP boundary | `[ ]` |
| R9-P5-007 | M | F24 fence format diverges from fencedClaim primitive | `[ ]` |
| R9-P3-005 | M | Stale grandfather rationale: handlers.ts SADD covers DEL+EVAL too | `[ ]` |
| R9-P5-009 | L | `InFlightClaimError` lacks kind discriminant | `[ ]` |

**Files touched:**
- `src/custodial/AccountingService.ts` — `recordPlaySessionClose` accepts strategyDeviation
- `src/custodial/hcs20-reader.ts` — `parseRefund` empty-string defense
- `app/api/_lib/errors.ts` (NEW) — `mapErrorToResponse` for RefundDuplicateError + InFlightClaimError
- `app/api/admin/refund/route.ts` — use new mapping
- `src/mcp/tools/operator.ts` — use new mapping
- `src/custodial/MultiUserAgent.ts` — F24 fence format + InFlightClaimError.kind discriminant
- `src/custodial/uncertainTxVerification.ts:1314` — tighten legacy fallback

**Acceptance check:** close-with-deviation round-trips through schema; empty-string refund returns null with stat; admin refund returns 409/422 by RefundDuplicateError.kind; orphan reconciler attributes F24 claims.

---

### Cluster G — Reconciler reliability + reconciler tests (closes high R9-FG-12 + ~5 mediums)

> **Root cause:** Reconciler has multiple correctness + perf gaps: `RedisLike.scan` interface signature mismatches Upstash; non-pending values mis-parsed for grandfathered SET-NX sites; N+1 round-trips per scanned key; sequential namespace walk; context not in alert payload; stale comment about mock; `.test.ts` cross-contamination.
>
> **Single fix:** Fix interface signature, conditional pending: parse, pipeline batching, parallel namespace walks with budget, context in alert, fix stale comment, fix test cleanup.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-8 | H | `RedisLike.scan` signature mismatches Upstash production return type | `[ ]` |
| R9-FG-12 | H | `orphanReconciler.test.ts` cross-contamination | `[ ]` |
| R9-P11-001 | H | Orphan reconciler N+1 round-trips per scanned key | `[ ]` |
| R9-P11-007 | M | Orphan reconciler sequential namespace walk; no budget | `[ ]` |
| R9-P5-005 | M | Orphan reconciler mis-parses non-pending values | `[ ]` |
| R9-P10-005 | M | Same as R9-FG-12 (test cross-contamination) | `[ ]` |
| R9-P10-004 | L | Stale comment about mock SCAN | `[ ]` |
| R9-P10-010 | L | `OrphanedClaim.context` parsed but not in alert payload | `[ ]` |

**Files touched:**
- `src/auth/redis.ts` — RedisLike.scan signature
- `src/lib/orphanReconciler.ts` — conditional pending: parse, pipeline batching, Promise.all, context in alert, comment update
- `src/lib/orphanReconciler.test.ts` — fix cross-contamination
- `src/scripts/reconcile-orphans.ts` — print context in CLI summary

**Acceptance check:** reconciler runs in <60s on 1k-key topic; killswitch JSON value doesn't fire false-positive orphans; test runs are deterministic across multiple invocations.

---

### Cluster H — Test quality + CI ratchets (closes high R9-FG-14 + ~10 lows)

> **Root cause:** Several test-quality gaps: source-regex tests don't strip comments → placebo recurrence; misnamed helper; unfounded JSDoc; runtime guard incomplete; no CI workflow; test files in npm dist; manifest ratio doesn't ratchet; etc.
>
> **Single fix:** Route source-regex through `stripComments`. Rename helper. Fix JSDoc. Strengthen runtime guard. Add CI workflow. Exclude tests from dist. Ratchet manifest ratio.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R9-FG-14 | H | Source-regex tests don't strip comments before matching (placebo) | `[ ]` |
| R9-P1-004 | M | `stripCommentsAndStrings` is misnamed; doesn't strip strings | `[ ]` |
| R9-P10-001 | M | `FencedClaimOutcome` JSDoc claims `'preserved'` kind that doesn't exist | `[ ]` |
| R9-P3-006 | M | `PreserveClaimError` runtime guard incomplete (subclass with undefined transactionId) | `[ ]` |
| R9-P10-008 | M | `coverageStrategy` required → merge conflict kills entire gate | `[ ]` |
| R9-P10-009 | M | Manifest ratio counter never ratchets (R8-FG-21 PARTIAL) | `[ ]` |
| R9-P12-006 | M | Same as R9-P10-009 | `[ ]` |
| R9-P6-009 | L | No `.github/workflows/` — gates never run in CI | `[ ]` |
| R9-P10-007 | M | Phase-6 test files compile into `dist/` and ship in npm package | `[ ]` |
| R9-P1-006 | L | `AmountStringField` accepts `' '` (single space → 0) | `[ ]` |
| R9-P6-005 | M | Strict schema throws conflate writer typos with on-chain failures in `audit_trail_orphaned` | `[ ]` |
| R9-P6-007 | M | `UserLedger.ts:333` empty `catch {}` swallows new Zod throws | `[ ]` |
| R9-P11-008 | L | Per-message `process.env.HCS20_SOFT_VALIDATE` lookup | `[ ]` |
| R9-P10-002 | M | Same as R9-P1-004 | `[ ]` |
| R9-P12-008 | L | `deposit_credit_flush_orphaned` reader dedup defense-in-depth missing | `[ ]` |
| R9-P5-008 | M | Refund mid-deployment legacy `'pending'` form has no test | `[ ]` |
| R9-P5-010 | L | Aborted-with-poolsRoot vs close-with-poolsRoot edge case | `[ ]` |
| R9-P6-004 | M | `releaseFence` eval-fail fallback warns at log level, never pages | `[ ]` |

**Files touched:**
- `src/__tests__/lint-helpers.ts` — rename + strip
- `src/hedera/contracts.test.ts` — strip comments before regex
- `src/custodial/MultiUserAgent.test.ts` — strip comments before regex
- `src/lib/fencedClaim.ts` — JSDoc fix
- `src/hedera/transfers.ts` — strengthen runtime guard
- `src/__tests__/audit-coverage-scan.ts` — coverageStrategy default
- `src/__tests__/audit-coverage.test.ts` — ratchet via baseline
- `src/__tests__/audit-coverage-baseline.json` (NEW) — sidecar
- `.github/workflows/ci.yml` (NEW) — gate trio
- `tsconfig.cli.json` — exclude tests
- `src/custodial/hcs20-schema.ts` — AmountStringField rejects whitespace
- `src/hedera/refund.ts` — Zod-aware catch
- `src/custodial/UserLedger.ts:333` — explicit logger.error + DL on Zod throw
- `src/custodial/hcs20-reader.ts` — hoist softValidate per-walk
- `src/custodial/hcs20-reader.ts` — extra dedup defense for orphan events
- `src/hedera/refund.test.ts` — legacy 'pending' form test
- `src/lib/fencedClaim.ts` — escalation on N eval failures (operator-tunable)

**Acceptance check:** all named tests pass; CI workflow runs gates on every PR; `dist/` doesn't contain `*.test.*`; manifest ratio doesn't regress.

---

### Cluster I — Manifest + docs hygiene (closes R8-FG-21 PARTIAL + ~7 mediums)

> **Root cause:** Manifest description still claims "every shipped audit-finding fix" but covers ~9 of 115+ R6 + 32 R8 findings. No R8-FG-* or R9-FG-* entries. Several doc surfaces lag Phase-6 + Phase-7 changes.
>
> **Single fix:** Honest description rewrite. Add R8-FG-* + R9-FG-* manifest entries (criticals + highs at minimum). Update prose docs.

| ID | Sev | Finding | Status |
|---|---|---|---|
| R8-FG-21 | M | Manifest description false-claims; no R8-FG-* entries | `[ ]` |
| R9-P7-001 | H | Hand-written `docs/hcs20-v2-schema.md` examples don't show Phase-6 fields | `[ ]` |
| R9-P7-002 | C* | `AmountStringField` legacy reader rejection (overlaps Cluster D) | `[x]` (in D) |
| R9-P7-003 | H | `originalDepositTxId.min(1)` retroactively breaks (overlaps Cluster D) | `[x]` (in D) |
| R9-P7-004 | M | A2A Agent Card has no skill input/output schemas | `[ ]` |
| R9-P7-005 | M | wireSchema in REST audit responses doesn't surface schemaValidationFailures | `[ ]` |
| R9-P7-006 | M | `truncatedPrizesDropped` undocumented in schema doc | `[ ]` |
| R9-P7-007 | M | Verify-audit alerts JSON output has no documented schema | `[ ]` |
| R9-P7-008 | M | `/api/health` doesn't surface Phase-6 schema-drift signals | `[ ]` |
| R9-P7-009 | M | `parseRefund` doesn't enforce writer's < 1e15 (overlaps D) | `[x]` (in D) |
| R9-P7-010 | L | Agent Card description silent on Phase-6 capabilities | `[ ]` |

**Files touched:**
- `src/__tests__/audit-coverage.json` — description + new entries (R8-FG-* + R9-FG-*)
- `docs/hcs20-v2-schema.md` — prose update + autogen regen
- `docs/disaster-recovery.md` — alert categories section
- `docs/incident-playbook.md` — orphan reconciler symptom
- `docs/uptime-monitoring.md` — schema-drift monitor
- `app/api/health/route.ts` — schema_health field (optional, low priority)
- `app/api/admin/audit/route.ts` + `app/api/user/audit/route.ts` — extend wireSchema with schema-failure counts
- `src/a2a/agent-card.ts` — capabilities.extensions + protocolVersion bump

**Acceptance check:** `npm run schema:docs:check` passes after regen; manifest ratio counter non-regressing on R8-FG-* + R9-FG-* coverage.

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
| H | — | — | — | — |
| I | — | — | — | — |

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

## R10 readiness criteria

Before invoking the 12-persona R10 audit, all of the following must be green:

- [ ] All 45 R9-FG-* checkboxes flipped to `[x]`.
- [ ] `npm test` passes (target: ≥750 tests).
- [ ] `npm run audit:coverage:check` passes with `coverageStrategy` default + ratchet.
- [ ] `npm run schema:docs:check` passes (regenerated after Cluster D + I).
- [ ] `npm run audit:revert-drill -- --all` runs ≥4 drills, all pass.
- [ ] `npm run reconcile:orphans` runs cleanly with new RedisLike.scan signature.
- [ ] Both archetype gates flag deliberate plants for `.message.includes(...)`, `redis.del`, `redis.eval`, `pipeline.sadd`.
- [ ] `HCS20_SOFT_VALIDATE=1` set in cron route + verify-audit script.
- [ ] Cron route imports + invokes `reconcileOrphans`.
- [ ] Verify-audit derivation subtracts `heldByToken` + `depositCreditFlushOrphanedByToken`; `user_balance_negative` alert exists.
- [ ] Schema has separate strict/loose variants; reader-loose accepts legacy unbounded amounts.
- [ ] pendingLedger SADD-membership prevents double-debit on Lambda crash mid-mutation.
- [ ] `app/api/_lib/errors.ts` maps RefundDuplicateError + InFlightClaimError to coded responses.
- [ ] `.github/workflows/ci.yml` runs the gate trio.
- [ ] Test files no longer in `dist/`.

Once all check, fire R10 with the same 12-persona prompt set as R9.
