# Deferred Audit Findings — Archive

**Created:** 2026-05-10 (Phase-9 Cluster A)
**Reason:** Phase-9 dissection (`docs/audit-cycle-dissection-2026-05-10.md`) struck `coverageStrategy:'documentation-only'` from the audit-coverage manifest schema. Six R9 findings whose fixes shipped without behavioral tests were dropped from the manifest and archived here.

This file is **not** scanned by the audit-coverage gate. It exists for historical traceability so a reviewer can see what was deferred and why.

---

## Why dropped, not promoted?

Each entry below has a real production fix at the named site. None has a per-finding behavioral test that would lock the fix against regression. Two paths were available:

1. **Promote with a placeholder test** — author a thin test that asserts the fix is "in place." Per the dissection doc §2 triage, this would be testing an *error* (local site-shape) not a *bug* (user-visible invariant). The cycle taught us that signal-existence tests are the wild-goose-chase engine.

2. **Drop and archive** — keep the manifest a true register of "fixes locked by behavioral tests." Operational closures (env wiring, runbook deltas) live in their natural runbook docs (`docs/mainnet-deploy-checklist.md`, `docs/incident-playbook.md`). Type-only fixes are validated by `tsc`, not by per-finding tests.

This file documents path 2.

---

## R9-FG-1 — `heldByToken` accumulator not subtracted in per-token derivation
**Originally:** R9 critical. Phase-7 Cluster B closed the named site at `src/scripts/verify-audit.ts` per-token derivation loop.
**Why deferred:** No per-finding test was authored. Phase-9 Cluster B authors a single conservation-invariant test (`r11-conservation-invariant.behavioral.test.ts`) that asserts the user balance reconstruction obeys conservation invariant 3 across a synthetic topic with `play_uncertain_success_pending_triage` events. That test subsumes R9-FG-1 and R9-FG-2 collectively.
**Where to find evidence the fix is in place:** `src/scripts/verify-audit.ts:1389-1400` (per-token loop subtracts held + flushOrphan).

## R9-FG-2 — `depositCreditFlushOrphanedByToken` accumulator not subtracted
**Originally:** R9 critical. Companion to R9-FG-1; same fix block.
**Why deferred:** Same as R9-FG-1. Subsumed by Phase-9 Cluster B conservation-invariant test.
**Where to find evidence:** `src/scripts/verify-audit.ts:1392-1402`.

## R9-FG-3 — `HCS20_SOFT_VALIDATE` env never set in production
**Originally:** R9 critical. Phase-7 Cluster A wired the env into cron + verify-audit module-load and added a boot warning.
**Why deferred:** This is a deployment-level closure, not a code-level fix. The runbook in `docs/mainnet-deploy-checklist.md` is the authoritative tracking artifact. R10-FG-5 separately tracks the env-pollution downside (a warm Lambda's mutation of `process.env` leaks into other handlers); that work is **out-of-scope for Phase-9** per the dissection doc §7.
**Where to find evidence:** `app/api/cron/reconcile/route.ts:55`, `src/scripts/verify-audit.ts:52`, `src/custodial/hcs20-reader.ts:maybeFireBootWarning`, `docs/mainnet-deploy-checklist.md:125`.

## R9-FG-4 — `reconcileOrphans` defined but never invoked
**Originally:** R9 critical. Phase-7 Cluster A imported and invoked the reconciler from the cron route.
**Why deferred:** Wiring-side closure. The cron route's existing test surface is integration-only and not unit-testable without a synthetic Redis harness. R10-FG-6 separately flags the broader observability cluster (page debounce, namespace ratios, runbook entries); that work is **out-of-scope for Phase-9**.
**Where to find evidence:** `app/api/cron/reconcile/route.ts` (imports + invokes `reconcileOrphans`).

## R9-FG-8 — `RedisLike.scan` cursor type
**Originally:** R9 high. Phase-7 Cluster G changed the cursor signature to `string | number`.
**Why deferred:** This is a TypeScript-only fix; `tsc` validates the type. The orphan reconciler tests (`src/lib/orphanReconciler.test.ts`) exercise both string and number cursors as a side effect of their existing assertions. No per-finding test is owed.

## R9-FG-13 — `RefundDuplicateError` discriminants thrown away at HTTP/MCP boundary
**Originally:** R9 high. Phase-7 Cluster F shipped `mapErrorToResponse` and wired the refund admin route through it. MCP/A2A surface still throws raw.
**Why deferred:** Partial migration; R10-FG-8 carries the work forward. R10-FG-8 is **out-of-scope for Phase-9** per the dissection doc §7 (admin UX, not balance correctness).
**Where to find evidence:** `app/api/_lib/errors.ts` (the helper), `app/api/admin/refund/route.ts` (consumer).

---

## Restoration policy

If R12 (or a future audit) surfaces any of these as a load-bearing user-visible failure with a concrete reproduction, the entry returns to `audit-coverage.json` with `coverageStrategy:'individual'` and a behavioral test that asserts the user-visible invariant. Otherwise these stay archived.

The archived JSON shape for these entries is preserved at `docs/audit-archive-deferred.json` for grep-friendly access.
