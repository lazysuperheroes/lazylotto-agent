# Round-6 Adversarial Audit — Findings + Triage

**Date:** 2026-05-10 (round 6)
**Branch:** `testnet`
**Scope:** Re-verify R5 closures (89 fixes across 5 commits 878857f..b56bfe6) + scrutinize R5's NEW code surface (`safeSubmit` + `PostSubmitError`, `slimPoolResult` helper, `refreshAndGuard`, `pendingLedgerClaim` SET-NX, `LEGACY_MERKLE_CUTOFF` env, `openSeq`, `strategyDeviation`, `prizesByToken` default `{}`, in-memory eval mock heartbeat support, heartbeat self-rescheduler + `.unref()`, counter resets on `markResolved`, ISO-8601 validation in `validateProgressOrdering`, refund verifier malformed-fields gate, fenced refund claim DEL with `pending:<uuid>`, exponential agentSeq backoff, `v2WrittenPools` pre-await increment).

**Methodology:** 12 background agents, one persona each:
1. P1 — R5 regression hunter
2. P2 — Concurrency / cross-Lambda atomicity
3. P3 — Double-X re-verify (sibling sweep)
4. P4 — Integration boundary
5. P5 — State-machine walker
6. P6 — Self-heal critic
7. P7 — API surface
8. P8 — Test-quality auditor (R2-FG-0 archetype, **fifth recurrence**)
9. P9 — Closure verifier (R1+R2+R3+R4+R5)
10. P10 — Blind-spot agent
11. P11 — Perf / scalability
12. P12 — Audit-trail completeness + conservation invariants

**Raw count:** ~372 findings across 12 personas. Deduplicated to ~115 unique items below.

The dominant theme this round: **R5's central refactor (`safeSubmit` + `PostSubmitError`) was wired only into refund.ts and the `transfers.ts` helpers. Every other on-chain submit site still tests `instanceof ReceiptUncertainError` only — and now treats `PostSubmitError` as a confirmed failure. R5-FG-3 was supposed to CLOSE a double-spend window; partial application leaves the system strictly less safe than pre-R5.**

The other dominant theme: **R5 added many writer-side bits (depositTxId on rake, rakeReversed/rakeReversedToken on refund, deposit_credit_flush_orphaned anchor, prize_recovery affectedSessions flip) but the consumer side lags. `parseRefund` doesn't read rakeReversed at all (operator-balance reconstruction permanently broken). The reader doesn't recognize deposit_credit_flush_orphaned. The default runbook doesn't pass `--store-snapshot`.**

Tertiary: **5th recurrence of the test-quality archetype. R5 shipped ~89 fixes; only 5 have direct revert-proof tests. The R4-0 baseline gate counts comments, not behavior. P8 found 109 findings.**

---

## Phase R6-1 — Critical (15 items)

### `[ ]` R6-FG-1 (C) — `MultiUserAgent.processWithdrawal` releases reserve on `PostSubmitError` (R5-FG-3 sibling miss)
**Closes:** P1-002, P3-001, P10-002.
**Bug:** `src/custodial/MultiUserAgent.ts:1414-1474`. After R5-FG-3, `safeSubmit` lifts ANY post-submit error to `PostSubmitError extends PreserveClaimError`. The withdraw catch tests `instanceof ReceiptUncertainError` ONLY. A `PostSubmitError` (signer disposed, V8 OOM, network reset between `tx.execute()` returning and `awaitReceipt` entering) falls through to "Confirmed pre-submit OR on-chain failure" branch (line 1471) — `releaseReserve(userId, amount, withdrawToken)` runs. The user's reserve is freed; on-chain transfer may have actually landed. A fresh-key retry with the released balance submits a SECOND on-chain transfer.
**Fix:** Change line 1415 to `if (transferError instanceof ReceiptUncertainError || transferError instanceof PostSubmitError)`. Persist a `withdrawal_uncertain` (or `withdrawal_post_submit_uncertain`) DL for both shapes.

### `[ ]` R6-FG-2 (C) — `MultiUserAgent.playForUser` releases reservations on `PostSubmitError` (R5-FG-3 sibling miss)
**Closes:** P1-001, P3-003.
**Bug:** `src/custodial/MultiUserAgent.ts:1142-1201`. Same archetype as R6-FG-1 in the play path. A `PostSubmitError` from inside the play loop escapes the `instanceof ReceiptUncertainError` check at line 1143, falls through to releaseReserve over every reservation. With on-chain submit possibly landed and entries possibly issued, a retry on fresh idempotency lets the user re-play with a healed balance → two plays' worth of buys, only one paid for.
**Fix:** Add `|| error instanceof PostSubmitError` at line 1143.

### `[ ]` R6-FG-3 (C) — `MultiUserAgent.operatorWithdrawFees` DELs the F24 per-token claim on `PostSubmitError` (R5-FG-3 sibling miss)
**Closes:** P1-003, P3-002.
**Bug:** `src/custodial/MultiUserAgent.ts:1786-1801`. Catch at line 1790-1801 releases the F24 per-token pending claim when `!(transferError instanceof ReceiptUncertainError)` — a `PostSubmitError` is treated as non-uncertain → claim RELEASED. Line 1802's check skips DL write for `PostSubmitError`. Net: claim released, operator-state un-debited, on-chain status unknown, NO dead-letter row. A fresh-key retry passes SET-NX (claim just DELed) and submits a SECOND withdrawal; if original landed → operator double-pay.
**Fix:** Both checks must include `|| transferError instanceof PostSubmitError`. Mirror refund.ts:653.

### `[ ]` R6-FG-4 (C) — `executeEncodedCall` and `executeIntent` skip `safeSubmit` entirely (R5-FG-3 sibling miss in contracts.ts)
**Closes:** P3-004, P5-011, P10-001-related.
**Bug:** `src/hedera/contracts.ts:94-102, 147-155`. R5-FG-3 promised "every helper that does `tx.execute()` MUST throw a PreserveClaim-flavored error if execute() returned." The two contracts.ts helpers — `executeIntent` and `executeEncodedCall` — still do raw `tx.execute(client) + awaitReceipt`. Any non-receipt-shape post-submit error from buy/roll/transferAllPrizes/staking ops escapes as a vanilla `Error` → `withIdempotency`'s catch DELs the claim → contract-call double-spend window. The very contract operations that gas-ladder retries (R4-FG-17) are the ones most exposed AND least protected.
**Fix:** Wrap the `tx.execute() + awaitReceipt` pair in `safeSubmit` for both helpers.

### `[ ]` R6-FG-5 (C) — `transferAllPrizesWithRetry` uses string-name comparison; `PostSubmitError` slips through retry ladder
**Closes:** P3-005.
**Bug:** `src/hedera/contracts.ts:291-309`. The retry-loop catch checks `err.constructor.name === 'ReceiptUncertainError' || message.includes('ReceiptUncertainError') || message.includes('receipt timeout')` — string matching, NOT `instanceof`. `PostSubmitError`'s constructor.name is `'PostSubmitError'`; its message starts with `Transaction X was submitted but a post-submit error occurred...`. Neither matches. The retry escalator continues to the next attempt, submitting a SECOND prize-transfer transaction; if the original landed, the contract's prize-loop counter was burned. Pre-fix bug R4-FG-17 was supposed to close — re-emerges via `PostSubmitError` once `safeSubmit` is wired upstream.
**Fix:** Use `err instanceof PreserveClaimError` (catches both subclasses) and rethrow as a `prize_transfer_uncertain`-flavored wrapped error. Stop relying on string sniffing.

### `[ ]` R6-FG-6 (C) — `slimPoolResult` (R5-FG-110) breaks Merkle parity for any pool with >10 prizes
**Closes:** P1-004, P4-007, P10-001.
**Bug:** `src/custodial/AccountingService.ts:80-122` (slim caps to top-10) but `src/custodial/MultiUserAgent.ts:1011-1024` (close `poolsRoot`) computes hash over the FULL prize set (`convertPrizeDetailsToV2(p.prizeDetails)`). The reader recomputes from the slimmed top-10 wire prizes. Roots disagree → reader marks session `corrupt`. Same archetype as R5-FG-1 (which fixed `sym` for the same reason); R5-FG-110 reintroduced the exact archetype with a different field. Schema doc `docs/hcs20-v2-schema.md` makes no mention of the cap.
**Fix:** Either (a) writer slims for the close-root computation (apply `slimPoolResult` before hashing), stamping `slim_truncated_prizes` in the close so the reader applies the cap before recomputing, OR (b) move cap behavior to a side-channel (`play_session_close_prizes_extended` follow-up message). Update schema doc.

### `[ ]` R6-FG-7 (C) — `parseRefund` does not propagate `rakeReversed` / `rakeReversedToken` → operator-rake-reversal accumulator permanently zero
**Closes:** P12-001.
**Bug:** `src/custodial/hcs20-reader.ts:126-136, 481, 1322-1342`; `src/scripts/verify-audit.ts:701-708`. R4-FG-58 / R5-FG-94 wrote `rakeReversed: String(...)` and `rakeReversedToken` onto on-chain `RefundMessage`. But `NormalizedRefundEvent` declares NEITHER field, and `parseRefund()` builds the normalized event without reading them. R5-FG-94's mismatch check (`evRakeReversed = ... ?? 0`) always evaluates `0`. Verify-audit's per-user/operator rake-reversal accumulator is permanently empty for ALL post-F9 refunds.
**Conservation break:** Invariant 4 — `operator_balance = totalRakeCollected - operatorWithdrawn - rakeReversed` — collapses to `totalRakeCollected - operatorWithdrawn` (rakeReversed always 0). Operator's reconstructed balance inflates indefinitely. R2-FG-22's "phantom_rake_reversal" check is dead code. R5-FG-94's duplicate-mismatch check is dead code.
**Fix:** Add `rakeReversed?: number; rakeReversedToken?: string` to `NormalizedRefundEvent`. Coerce `rakeReversed` via `Number(payload.rakeReversed)` with `Number.isFinite` guard.

### `[ ]` R6-FG-8 (C) — `RefundMessage` carries no `token` field for the refunded asset → all FT/LAZY refunds reconstruct as HBAR
**Closes:** P12-002.
**Bug:** `src/custodial/AccountingService.ts:1058-1077` (writer); `src/hedera/refund.ts:972-988` (caller); `src/custodial/hcs20-reader.ts:1322-1342` (reader). Every other balance-affecting v1 op (mint, transfer/rake, burn) was retrofitted with explicit `token` field. RefundMessage was missed. Caller `processRefund` knows the token (`refundToken`) and passes it ONLY as `rakeReversedToken`, never as the refund's own asset. `parseRefund` calls `resolveTokenField(msg.payload)` which falls through `payload.token` → `payload.tick === 'LLCRED'` → returns `'HBAR'`. Every LAZY-deposit refund, every FT-pool refund, lands in the user's `totalRefundedByToken['HBAR']`.
**Conservation break:** Invariant 3 — `ledger_balance(user) = deposits - rake - spent - withdrawals - refunded` — breaks per-token: deposit recorded under `LAZY`, refund subtracted under `HBAR`. Verify-audit shows phantom HBAR debit and phantom LAZY balance.
**Fix:** Extend `RefundMessage` with required `token: string`; have `recordRefund` accept `token` and stamp it. Document in schema spec.

### `[ ]` R6-FG-9 (C) — `recordControlEvent('deposit_credit_flush_orphaned')` drops `grossAmount` / `token` / `cause` (R5-FG-45 wire-incomplete)
**Closes:** P4-004, P12-003.
**Bug:** `src/custodial/AccountingService.ts:407-467`; caller at `UserLedger.ts:321-328`. The R5-FG-45 caller passes `{ uncertainTxId, userId, grossAmount, token, cause, idempotencyKey }`. But `recordControlEvent`'s typed event union excludes `'deposit_credit_flush_orphaned'`, AND its body assembler only spreads `uncertainTxId, kind, mirrorResult, userId, tokenReservations, idempotencyKey`. The topic message NEVER carries `grossAmount`, `token`, `cause`. A topic-only DR replay sees an orphan anchor with `userId` only — **insufficient to reconstruct the orphan amount**, the entire reason R5-FG-45 added the anchor.
**Conservation break:** DR replay over-credits the user by `grossAmount` because the orphan anchor alone says "this credit flush failed" without the amount. Operator must cross-reference Redis (the very thing that fails on Redis loss).
**Fix:** Extend the event union literal to include `'deposit_credit_flush_orphaned'`. Extend `details` type to include `grossAmount, token, cause`. Spread into the `submitMessage` payload. Add unit test asserting the topic message carries `grossAmount`.

### `[ ]` R6-FG-10 (C) — verify-audit doesn't surface `deposit_credit_flush_orphaned` events as alerts
**Closes:** P4-004, P12-004.
**Bug:** `src/scripts/verify-audit.ts:778-820`. Even with R6-FG-9 fixed, verify-audit's control-event switch handles only `force_release_override`, `force_release`, `play_uncertain_success_pending_triage`, `killswitch_enabled`, `killswitch_disabled`. `deposit_credit_flush_orphaned` falls through unhandled. Topic has the orphan record; documented DR tool gives a clean conservation report. R5-FG-45's closure is wire-only.
**Fix:** Add `case 'deposit_credit_flush_orphaned':` emitting a critical alert with `grossAmount, userId, uncertainTxId` so DR replay sees "deduct N from user X's reconstructed balance".

### `[ ]` R6-FG-11 (C) — `--store-snapshot` opt-in; documented runbook doesn't pass it → R5-FG-44 closure unreachable in practice
**Closes:** P6-001, P12-005.
**Bug:** `src/scripts/verify-audit.ts:1153-1186`; `docs/disaster-recovery.md:122-126`; `docs/incident-playbook.md:430-433`. R5-FG-44 added `--store-snapshot` to merge `audit_trail_orphaned` DLs into alerts. Default OFF. Both runbooks invoke `verify-audit.ts --topic $TOPIC` with NO `--store-snapshot`. `npm run read-accounting` doesn't pass it either. An operator following the documented incident-response sequence on a "healthy looking" topic gets `Conservation OK` while the agent has been silently dead-lettering 50 orphans/hour.
**Fix:** Either (a) update runbooks to pass `--store-snapshot` by default, OR (b) invert the flag — make it the default and add `--no-store-snapshot` for CI/synthetic-topic runs, OR (c) update `package.json` `read-accounting` script.

### `[ ]` R6-FG-12 (C) — `pendingLedger` mutation failure leaves claim held while next drain LREMs the row → silent ledger-debit loss
**Closes:** P1-009, P5-005, P5-006.
**Bug:** `src/custodial/pendingLedger.ts:213-298`. Both eager and periodic drain paths SET-NX the claim BEFORE the mutation try/catch. On mutation failure (refresh, updateBalance, updateOperator, OR flush throw) the catch logs and falls through; the claim stays held but the LIST entry is NOT LREM'd. Next drain: LRANGE has the row → SET-NX returns null (claim still held) → enters "sibling already claimed" branch which **best-effort LREMs the row** assuming sibling applied. Row gone forever; user's `available -= entry.amount` never applied. Operator's rake reversal also lost. Silent ledger corruption — no DL written.
**Fix:** Do NOT LREM in the `claimed === null` branch. Let the original claim-holder either complete on retry, or have its claim TTL out (which re-opens the entry). Alternatively: write `pending_ledger_orphaned` DL when a row's claim TTL'd out without LREM. Reorder the drain to flush BEFORE lrem (so LREM-success implies flush-success).

### `[ ]` R6-FG-13 (C) — `submitV2Message` has no post-submit safety net → R5-FG-22 invariant breaks under SDK post-submit throws
**Closes:** P1-005, P1-010, P5-011.
**Bug:** `src/custodial/AccountingService.ts:1142-1148`. `submitV2Message` calls `.execute(client)` raw — no `safeSubmit`, no receipt await, no post-submit error lift. Combined with R5-FG-22's increment-before-await, any post-submit throw from the SDK (network blip, internal-retry rejection in non-receipt shape) inside `recordPlayPoolResult` is treated as a pre-submit failure (decrement + abort with mismatched count). The aborted path's `abortedPoolsRoot` is computed over `slice(0, v2WrittenPools)` which is now one short — but the topic HAS the message → roots disagree → reader marks session `orphaned` (or `corrupt`).
**Conservation break:** Audit trail is load-bearing. A single SDK hiccup post-submit on any pool message corrupts the entire session's verifiable state. R5-FG-22's fix is built on the assumption that all errors classify cleanly into pre-submit vs post-submit (PreserveClaim). `submitV2Message` violates that.
**Fix:** Wrap `submitV2Message` in safeSubmit (or its no-receipt analogue) so post-`.execute()` throws lift to PreserveClaimError. Better: actually `awaitReceipt` for v2 messages so the writer state machine knows whether the message landed.

### `[ ]` R6-FG-14 (C) — `withIdempotency` plain-DEL fallback bypasses fence; nukes sibling Lambda's claim under prolonged eval failure
**Closes:** P1-007, P2-002, P5-003, P9-006.
**Bug:** `src/lib/idempotency.ts:166-213`. R5-FG-48 added a plain `redis.del(fullKey)` as fallback when `redis.eval(RELEASE_SCRIPT)` throws. The fence is bypassed on cleanup. Adversarial sequence: eval succeeded server-side, threw on response transport (Redis cluster failover, drop on response, mock incompatibility) → key already DEL'd → sibling Lambda B `SET-NX` acquires with `fence_B` → Lambda A's plain DEL nukes Lambda B's claim → Lambda C acquires `fence_C` → B and C both submit on-chain action. R5-FG-48 dismisses this as "microseconds" but Upstash REST eval can take seconds during cluster events.
**Fix:** Replace plain DEL with fenced compare-and-DEL via a different Redis client/connection (bypassing the failed eval channel), OR leave the claim alone and let the 24h TTL be the fallback. Pages already fire on the double-failure path; a stuck claim is the safer failure mode than nuking a sibling's claim.

### `[ ]` R6-FG-15 (C) — `LEGACY_MERKLE_CUTOFF` post-cutoff gate fails OPEN on missing/malformed timestamp → forge-by-strip-timestamp bypass
**Closes:** P1-008.
**Bug:** `src/custodial/hcs20-reader.ts:279-284`; `src/scripts/verify-audit.ts:1126-1131`. `isPostLegacyCutoff(undefined)` returns `false`. `isPostLegacyCutoff('garbage')` returns `false`. An attacker (or buggy writer) emits a forged close with `consensus_timestamp` field stripped or malformed → `closePostCutoff = false` → legacy-unbound Merkle fallback permitted → `usedLegacy=true` → `status='closed_success'` with only a buried warning. R5-FG-2 is bypassed for any forged message that omits the timestamp.
**Fix:** Missing/malformed timestamp on a close/aborted message that lacks a bound Merkle root MUST be treated as `corrupt` directly. OR `isPostLegacyCutoff` defaults to `true` (fail-closed) when parsing fails. The "no timestamp" case is impossible on a healthy mirror response — failing closed is correct.

---

## Phase R6-2 — High (~38 items)

### `[ ]` R6-FG-16 (H) — `force-release/handlers.ts` audit-anchor failures in withdrawal/operator-fee/refund handlers don't set `partialMutation` (R5-FG-17 sibling miss x3)
**Closes:** P3-015, P4-001, P4-003, P5-001, P5-019.
**Bug:** R5-FG-17 added `partialMutation` discriminator in `handlePlay`. `handleWithdrawal` (lines 370-409), `handleOperatorFee` (lines 657-682), `handleRefund` (lines 1129-1199) all catch `accounting.recordWithdrawal/recordOperatorWithdrawal/recordRefund` failures, write orphan rows, and return `{ ok: true }` despite the anchor never landing. Route resolves entry; topic missing the anchor; silent insolvency. None call `escalateUncertainDlFailure`. The refund handler's SUCCESS path additionally clobbers the refund claim (lines 1257-1263) and SADDs `refundedOriginals` (lines 1270-1314) unconditionally — even when audit anchor failed → permanent ban without anchor.
**Fix:** Each handler's audit-anchor catch must set `auditAnchorFailed = { phase: 'audit_anchor', cause }`, return `{ ok: true, action, partialMutation: auditAnchorFailed }`, AND call `escalateUncertainDlFailure({ kind: 'audit_trail_orphaned', ... })`. Mirror handlePlay's contract. For refund, gate the claim-overwrite + SADD on `progress.auditWrittenAt`.

### `[ ]` R6-FG-17 (H) — `isPreserveClaim` name fallback misses `PostSubmitError`
**Closes:** P1-006, P4-006.
**Bug:** `src/lib/idempotency.ts:54-62`. Cross-bundle drift fallback only checks `err.name === 'ReceiptUncertainError'`. R5-FG-3 added `PostSubmitError` (also sets `this.name = 'PostSubmitError'`) but didn't update the fallback. A bundling boundary that produces a duplicate `PreserveClaimError` class would fail `instanceof` AND wouldn't recognize `PostSubmitError` either → claim DELed → on-chain submit may have landed → retry executes a SECOND submit.
**Fix:** Update line 60: `if (err instanceof Error && (err.name === 'ReceiptUncertainError' || err.name === 'PostSubmitError')) return true;`. Add regression test mirroring the existing fake-name test.

### `[ ]` R6-FG-18 (H) — `MultiUserAgent.processWithdrawal` does NOT call `assertKillSwitchDisabled` → kill-switch bypass
**Closes:** P3-006.
**Bug:** `src/custodial/MultiUserAgent.ts:1334-1338`. `playForUser` (line 1510), `registerUser` (line 1363), `updateUserStrategy` (line 1417), `playForAllEligible` (line 1279) all call `assertKillSwitchDisabled()`. `processWithdrawal` does not. With kill switch engaged (operator emergency pause), users can still withdraw via `/api/user/withdraw` and `multi_user_withdraw`. CLAUDE.md contract is "kill switch is the single source of truth — invoke from the domain layer". Withdrawal is exactly the kind of write-path operation the gate should cover during a security incident.
**Fix:** Add `await assertKillSwitchDisabled();` as the first line of `processWithdrawal`. R5-FG-33's body sanitization is moot if the gate isn't reached.

### `[ ]` R6-FG-19 (H) — `KillSwitchError.reason` leaks via every MCP tool result (R5-FG-33 sibling miss across MCP/A2A surface)
**Closes:** P3-007, P3-024.
**Bug:** `src/mcp/tools/operator.ts:63, 105, 137, 171, 206, 244, 274` (and multi-user tools); `src/utils/format.ts:26-28`. Every MCP tool that catches a domain throw wraps with `errorResult(\`Failed: ${errorMsg(e)}\`)`. `errorMsg` returns `e.message` verbatim. `KillSwitchError` constructor at `killswitch.ts:46-53` bakes the operator's free-text reason into `message`. R5-FG-33 closed three Next.js routes by sanitizing; the MCP surface (and by transitivity A2A, since A2A re-issues as MCP `tools/call`) was missed entirely. Every authenticated MCP/A2A poller during a kill-switch engagement reads the operator's incident description verbatim.
**Fix:** Either (a) override `KillSwitchError` constructor to store `reason` in a private field with `message` as a fixed sanitized string (operator-tier code that needs the reason calls `getRawReason()` explicitly), OR (b) add `KillSwitchError`-aware sanitization to `errorMsg`. Option (a) is cleanest — eliminates the leak class entirely.

### `[ ]` R6-FG-20 (H) — Public agent card enumerates every `operator_*` skill name (R5-FG-92 partial)
**Closes:** P3-008, P7-004.
**Bug:** `src/a2a/agent-card.ts:223`; `app/.well-known/agent-card.json/route.ts`; `app/api/a2a/route.ts:41-48`. R5-FG-92 filtered the unknown-skill error message to `multi_user_*` because operator skill names are sensitive. But `buildAgentCard()` returns `[...MULTI_USER_SKILLS, ...OPERATOR_SKILLS]` unconditionally, and BOTH `GET /api/a2a` and `GET /.well-known/agent-card.json` serve it WITHOUT auth, with a 5-min public cache. The R5-FG-92 fix is theatre — every operator skill name is publicly enumerable via the discovery endpoint.
**Fix:** Either (a) `buildAgentCard()` accepts an optional `tier` parameter; default returns only `MULTI_USER_SKILLS`; operator skills surface only when fetched by an authenticated operator-tier session (vary on Authorization), OR (b) accept that operator skill names are public and remove the R5-FG-92 filter as inconsistent.

### `[ ]` R6-FG-21 (H) — `user/audit/route.ts` and 6 other user GETs rate-limit BEFORE auth without `identity:` (R5-FG-31 sibling miss)
**Closes:** P3-010, P7-002.
**Bug:** Seven user-tier read routes — `user/audit:309-317`, `user/check-deposits:35-44`, `user/dead-letters:26-33`, `user/enrich-nfts:34-42`, `user/history:36-43`, `user/prize-status:62-74`, `user/status:36-44` — call `checkRateLimit` first with no identity, falling through to `identityFor()`'s 16-char bearer-prefix bucket. Token rotation defeats the cap. R5-FG-31 fixed only the four write routes.
**Fix:** Move `requireTier` above `checkRateLimit` and pass `identity: auth.accountId` on all seven routes. Same pattern as R5-FG-31 fixes.

### `[ ]` R6-FG-22 (H) — MCP rate-limiter buckets by 16-char bearer-prefix (R5-FG-31 sibling miss on primary surface)
**Closes:** P7-003.
**Bug:** `app/api/mcp/route.ts:85-119`. `checkMcpRateLimit` keys on `auth.slice(7, 23)` for authenticated calls. Token rotation resets the bucket on each rotation, blowing past `MCP_RATE_LIMIT = 30/min`. R5 fixed user/admin routes; the MCP surface (the PRIMARY surface, exposing 23 tools including operator tools) was the sibling miss.
**Fix:** Resolve the bearer to `auth.accountId` first via `resolveAuth()` and bucket by accountId.

### `[ ]` R6-FG-23 (H) — `applyPendingLedgerForUser` eager apply path missing R5-FG-96 rake-drift cross-check
**Closes:** P1-011, P9-004.
**Bug:** `src/custodial/pendingLedger.ts:240-263` (eager) vs `:393-413` (periodic). R5-FG-96 added the deposit-record cross-check in periodic drain only. Eager apply (the hot path during in-band withdraw/play traffic) uses queued snapshot directly. An out-of-band hand-edit / data-migration drift is detected only periodically; eager silently uses stale data. The "operator silently kept the rake despite refund" bug R4-FG-13 closed re-emerges asymmetrically.
**Fix:** Lift the drift check into a shared helper called from both paths.

### `[ ]` R6-FG-24 (H) — Reader's `seenControlIdempotencyKeys` legacy tracker silently neutralizes R5-FG-95 tuple dedup
**Closes:** P9-001, P4-017.
**Bug:** `src/custodial/hcs20-reader.ts:567-585`. R5-FG-95's tuple set `seenControlEventKeys` is added alongside the legacy single-key tracker, not as replacement. Both are bumped on every accepted event AND BOTH gate the skip path (lines 574, 580). For two control events sharing the SAME idempotencyKey but DIFFERENT `event` kinds, the SECOND has `tupleKey2 = "kindB|idempK"` → not in `seenControlEventKeys` → passes the new gate. But the legacy gate at line 580 sees `seenControlIdempotencyKeys.has(idempK)` is true → skipped. R5-FG-95's stated invariant ("tuple keeps cross-kind events separate") is unreachable.
**Fix:** Drop the legacy single-key gate at lines 580-583. The tuple set is sufficient; back-compat with tests should be done by extending test mocks, not the production filter.

### `[ ]` R6-FG-25 (H) — Refund-anchor reader dedup permanently bypassed for events older than 60 days
**Closes:** P9-002.
**Bug:** `src/custodial/hcs20-reader.ts:506-520`. R5-FG-106's window gates `seenRefundTxIds.add()` AND `seenRefundedOriginals.add()` AND `seenRefundRakeReversed.set()` on `now - evTs <= REFUND_DEDUP_WINDOW_MS`. For events older than 60 days, NONE of the three trackers are populated, but the event is still `events.push(ev)`. A topic with two refund anchors both ≥60d old (same refundTxId OR same originalDepositTxId) emits BOTH events, double-counting `rakeReversed` in any audit reconstruction over pre-60d history. R4-FG-58's invariant is weakened to a soft "recent-only" property without a doc note.
**Fix:** Track `seenRefundedOriginals` UNCONDITIONALLY (no window) — it's a Set of strings, memory bounded by topic size. The 60d window should apply to `seenRefundTxIds` only.

### `[ ]` R6-FG-26 (H) — Reader skips Merkle validation on aborted-with-poolsRoot when open is missing `agent` (R5-FG-50 sibling miss)
**Closes:** P10-008.
**Bug:** `src/custodial/hcs20-reader.ts:1043-1126`. R5-FG-50 closed the close-side gap (open missing `agent` → corrupt). The same archetype exists for ABORTED: line 1055 conditions `else if (bucket.aborted.poolsRoot && agent)` — when `agent` is missing, falls through. Line 1106's `!bucket.aborted.poolsRoot` check fails (poolsRoot IS present) → line 1124 sets `status = 'closed_aborted'` WITHOUT VALIDATING THE ROOT. An attacker with operator-key access can forge an aborted message with a poolsRoot for any pool set — if the open lacks `agent`, the abort sails through unverified.
**Fix:** Mirror R5-FG-50: when `agent` is missing on the open AND the abort claims poolsRoot, push a `cannot_verify_root_binding_open_missing` warning and promote to `corrupt`.

### `[ ]` R6-FG-27 (H) — `recover-stuck-prizes.ts` script ignores R5-FG-65/66 `receiptUncertain` flag → recovery double-submits
**Closes:** P4-009, P6-003.
**Bug:** `src/scripts/recover-stuck-prizes.ts:230-252`. R5-FG-65/66 stamps `receiptUncertain` and `lastSubmittedTxId` onto `prize_transfer_failed` DL so a recovery script can mirror-check before re-submitting. But the standalone `recover-stuck-prizes.ts` does NOT read the DL — it reads only `agentState.pendingPrizes` from the dApp MCP and immediately calls `transferAllPrizesWithRetry`. If the original tx was receipt-uncertain (may have landed), the recovery submits a SECOND `transferPendingPrizes` blind. Two `prize_recovery` HCS messages emit, both claiming success on the same prize set. R5-FG-65/66 added the data fields but didn't wire them into the consumer.
**Fix:** Recovery script must (1) load existing `prize_transfer_failed` DL row(s) for the user, (2) if any has `receiptUncertain:true`, mirror-query `lastSubmittedTxId` first, (3) only proceed with new submit if mirror confirms the prior tx FAILED. Otherwise short-circuit to "audit-only" mode (record `prize_recovery` referencing the prior txId without a new contract call).

### `[ ]` R6-FG-28 (H) — `recover-stuck-prizes.ts` doesn't pass `affectedSessions` → reader's R5-FG-46 flip is dead code for CLI path
**Closes:** P6-004, P12-009.
**Bug:** `src/scripts/recover-stuck-prizes.ts:278-288`. R5-FG-46's reader post-process flips `prizeTransfer.status: 'failed' → 'recovered'` based on `prize_recovery.affectedSessions`. The MCP path (`MultiUserAgent.recoverStuckPrizes`) computes `affectedSessions` from DLs and passes it. But the standalone CLI script does NOT — it omits `affectedSessions` from the `recordPrizeRecovery` call. Operator follows Symptom 1 of the playbook (which references CLI), recovery succeeds, but `verify-audit` and audit page still show affected sessions as `prizeTransfer.status='failed'` forever.
**Fix:** CLI script needs to load DLs (via `createStore`/`refreshDeadLetters`), compute `affectedSessions`, and pass them through. Reuse MCP path's logic or extract a shared helper.

### `[ ]` R6-FG-29 (H) — Reader's R5-FG-46 unconditional flip masks partial recovery
**Closes:** P6-005.
**Bug:** `src/custodial/hcs20-reader.ts:773-786`. When `prize_recovery` references `affectedSessions:['A','B','C']`, reader unconditionally flips ALL of A, B, C from `failed` → `recovered` without validating that recovery's `prizesByToken` actually covers each session's expected prizes. A recovery that succeeded for session A's HBAR prize but failed for session B's NFT (NFT already transferred, contract reverted on second pass) gets the same green stamp on B. Auditor sees three "recovered" sessions when only one was fixed.
**Fix:** Add per-session prize-count/value reconciliation in the flip. If `prizesByToken` doesn't cover a session's expected prizes, mark as `partially_recovered` (new state) with a warning instead of `recovered`.

### `[ ]` R6-FG-30 (H) — `prize_recovery` against `succeeded` / `skipped` session is silently ignored
**Closes:** P10-010, P12-007.
**Bug:** `src/custodial/hcs20-reader.ts:778-784`. The flip-to-recovered logic only fires when `sess.prizeTransfer.status === 'failed'`. If an operator runs `recover-stuck-prizes` against a session whose original status was `succeeded` (LottoAgent's R4-FG-17 wrap-after-receipt-uncertain that actually landed) or `skipped`, the reader silently no-ops. Should be a critical alert: either (a) operator ran a redundant recovery (and likely double-paid prizes), or (b) original status was forged.
**Fix:** Loosen condition: `if (sess.prizeTransfer.status === 'failed' || sess.prizeTransfer.status === 'succeeded')`, with different warning messages. Surface as critical alert.

### `[ ]` R6-FG-31 (H) — `prize_session_close` `lastError` not truncated → close exceeds 1024-byte cap, falls to abort which DROPS prizeTransfer entirely
**Closes:** P10-006.
**Bug:** `src/custodial/MultiUserAgent.ts:144-148` (`mapPrizeTransferOutcome` puts raw `outcome.error`); `AccountingService.ts:983` (close passes through unmodified). Schema doc claims 200-char truncation but the writer DOESN'T call `truncateError`. When close exceeds 1024 bytes, `enforceTopicMessageSizeLimit` throws → `recordPlaySessionClose` rejects → catch fires → `recordPlaySessionAborted` written instead. Aborted has NO `prizeTransfer` field. Audit trail loses the actual outcome of `transferPendingPrizes`. User sees `closed_aborted` and thinks the play was aborted, when in fact the play succeeded but prize-transfer outcome was stripped.
**Fix:** In `mapPrizeTransferOutcome`, wrap `outcome.error` with `truncateError(outcome.error, 200)`. Add unit test with 5KB error message asserting close stays <1024 bytes.

### `[ ]` R6-FG-32 (H) — 24h CORS preflight cache breaks rolling deploys for new `Idempotency-Key` requirement
**Closes:** P10-004.
**Bug:** `app/api/_lib/cors.ts:125,151` + every route's `Access-Control-Max-Age: 86400`. R5-FG-36 added `Idempotency-Key` to Allow-Headers. Browsers cache preflight 24h. After deploy, any browser that received the OLD preflight within previous 24h continues using the cached preflight; new client code sending `Idempotency-Key` triggers CORS failure with no preflight re-fetch. Symptom: dashboard withdraw button silently fails for some users for ~24h. R5-FG-36's "OPTIONS regression test" doesn't catch this (tests don't model browser cache state).
**Fix:** Bump deploy with `Access-Control-Max-Age: 0` for affected routes for one cycle, then restore. OR dashboard always includes Idempotency-Key (even on routes not requiring it) so preflight signature is stable. Document in `docs/mainnet-deploy-checklist.md`.

### `[ ]` R6-FG-33 (H) — Cron `clientIp` regex leaves stray `]` for IPv6-without-port; bucket forks per malformed shape
**Closes:** P7-006, P10-005.
**Bug:** `app/api/cron/reconcile/route.ts:117-120`. Regex chain handles `[::1]:5000` (correctly yields `::1`) but on `[2001:db8::1]` (no port — produced by some load balancers and `x-real-ip` from upstream proxies) yields `2001:db8::1]`. Stray-`]` IPv6 vs clean form bucket separately. Worse: empty XFF + empty x-real-ip → ALL anonymous calls land in `cron-unknown-ip` (single bucket for the entire planet of unauthenticated cron probers — leaked CRON_SECRET amplification primitive).
**Fix:** Use `net.isIP` or `URL.canParse('http://' + raw)` to canonicalize. For the unknown-IP fallback, fail closed (refuse with 401 if both XFF and x-real-ip absent in production).

### `[ ]` R6-FG-34 (H) — Reader v1 mint/rake dedup is silent (no sanity-check) — forge attempts hidden
**Closes:** P6-010, P12-013.
**Bug:** `src/custodial/hcs20-reader.ts:644-650, 663-670`. R5-FG-24 added `seenDepositTxIds` and `seenRakeKeys`; both bump `stats.skippedMessages++` on duplicate detection — same as benign legacy duplicate. R5-FG-94 set the precedent of sanity-checking duplicate rakeReversed for forge detection — but mint/rake paths got NO equivalent. A forge attempt re-issuing `deposit:<existingTxId>` with a DIFFERENT amount (e.g. 1000 vs original 100) is silently dropped.
**Fix:** Stamp the duplicate's `amount`/`token` against the kept event; if mismatch, bump `stats.unknownMessages++` AND add critical alert in verify-audit.

### `[ ]` R6-FG-35 (H) — Force-release route's resolve-write doesn't reset counters (R5-FG-76 sibling miss x3)
**Closes:** P3-011, P3-012.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:577-583`; `src/hedera/refund.ts:1422-1428, 1990-2002`. R5-FG-76 patched `markResolved` to clear counters. Force-release route + `verifyUncertainRefunds` FAILED + SUCCESS resolves bypass `markResolved` — they spread `...latestEntry, resolvedAt, resolvedBy, resolutionTxId` directly. If a verifier loop bumped counters before force-release, the resolved entry retains the stale counter. Operator clearing `resolvedAt` to re-run sees R5-FG-76's whole point ("a future re-run starts fresh") broken.
**Fix:** Spread `details: { ...latestEntry.details, userLockContentionAttempts: 0, verificationAttempts: 0 }` into the three resolve writes.

### `[ ]` R6-FG-36 (H) — `MultiUserAgent.recoverStuckPrizesForUser` resolves DLs from a stale snapshot (R5-FG-8 sibling miss)
**Closes:** P3-013.
**Bug:** `src/custodial/MultiUserAgent.ts:2311-2339`. Line 2311 calls `refreshDeadLetters`, line 2313 captures snapshot, line 2321 enters loop with `upsertDeadLetter({ ...entry, resolvedAt, ... })` spreading the snapshot. A force-release writing a top-level field on one of those entries between line 2313 and line 2323 has its mutation REVERTED. R5-FG-8 fixed exactly this archetype at 7+ sites; prize-recovery's resolve loop was overlooked.
**Fix:** Inside the loop, call `refreshDeadLetters`; find fresh entry; skip if `resolvedAt`; spread `...fresh`.

### `[ ]` R6-FG-37 (H) — `queuePendingLedgerAdjustment` is non-idempotent → `rpush` on retry creates duplicate queue rows; queue grows monotonically
**Closes:** P3-014.
**Bug:** `src/custodial/pendingLedger.ts:76-81`. R5-FG-4 added per-(userId, sourceTx) SET-NX claim on apply side. Writer side is plain `redis.rpush(LIST_KEY, JSON.stringify(entry))`. Two reconcile passes that both queue the SAME refund (force-release retried after 504, Lambda warmup races) push TWO identical rows. Reader's R5-FG-4 claim catches the second apply (skips mutation) but `lrem` only removes ONE matching row per call → leftover orphan rows that perpetually skip and never LREM. **Queue grows monotonically with every duplicate queue write.** Eventually `LRANGE 0 -1` exceeds Upstash's 4MB body cap.
**Fix:** SET-NX `(userId, sourceTx)` BEFORE `rpush`. If claim exists, skip push (a row is already queued or applied). Plus add MAX_RECORDS trim to pendingLedger.

### `[ ]` R6-FG-38 (H) — Force-release progress reads accept any value type (R5-FG-91 sibling miss)
**Closes:** P3-016.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts:280-285, 511-514, 899-902`; `src/hedera/refund.ts:1535, 1539`. R5-FG-91 added ISO-8601 validation to `validateProgressOrdering`. The progress READS at the top of each handler do NO type validation. A malformed entry with `settledAt: true` (boolean) makes `!progress.settledAt` evaluate `false`, skipping `settleSpend`. Resolve-write fires with no debit. F15 successTriagedAt gate at handlers.ts:746 permits empty string → wedge.
**Fix:** Validate every progress field with `Number.isFinite(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v)` on read. Treat invalid as absent. F15 gate requires non-empty ISO-8601.

### `[ ]` R6-FG-39 (H) — Refund verifier `bumpVerificationAttempts` not called when malformed-fields gate (R5-FG-60) fires
**Closes:** P5-002.
**Bug:** `src/hedera/refund.ts:1456-1512`. R5-FG-60 says "bump verificationAttempts and surface as still_uncertain so an operator gets paged via R3-FG-77 / R5-FG-91 ordering check"; actual code only writes one orphan + one escalation. No `bumpVerificationAttempts(store, entry)` call. R3-FG-48 cause-class dedup (6h TTL) suppresses subsequent passes. Threshold-based escalate-after-N-attempts mechanism never fires.
**Fix:** Insert `await bumpVerificationAttempts(store, entry)` immediately before the `escalateUncertainDlFailure` call.

### `[ ]` R6-FG-40 (H) — `idempotency_release_failed` (R5-FG-48) escalation has no DL row, no playbook entry, requires log-line parsing
**Closes:** P5-004, P6-006.
**Bug:** `src/lib/idempotency.ts:200-212`. The page text is "wedged at fullKey=`lla:testnet:idem:<scope>:<key>`" — operator must parse log lines to extract key. Escalation does NOT write a DL row (unlike every other R5-introduced kind), so `verify-audit --store-snapshot` won't surface it. NO Symptom in playbook. Recovery requires `redis-cli DEL <fullKey>` AND knowing to read page text closely.
**Fix:** Have `idempotency_release_failed` ALSO write `audit_trail_orphaned` DL with `details.idempotencyKey = fullKey, sourceKind: 'idempotency_release_failed'` so it surfaces in `--store-snapshot`. Add Symptom to playbook with explicit `redis-cli DEL` command.

### `[ ]` R6-FG-41 (H) — `escalation_throw_after_sadd_failure` secondary orphan has no consumer; sits in DL forever
**Closes:** P6-007.
**Bug:** `src/hedera/refund.ts:1901-1937`. R5-FG-64 retries escalation once after 30s; on second failure writes secondary orphan tagged `phase:'escalation_throw_after_sadd_failure'`. But: (1) `verifyUncertainRefunds` doesn't process `audit_trail_orphaned` kind, (2) reconcile cron doesn't loop over orphans, (3) `verify-audit --store-snapshot` only ALERTS, doesn't replay. Orphan sits forever. The page never went out (that's why secondary was written). Operator has NO automated signal.
**Fix:** Add reconcile-cron step that loops `audit_trail_orphaned` rows tagged `escalation_throw_after_sadd_failure`, retries the escalation, resolves on success.

### `[ ]` R6-FG-42 (H) — `unknown_token_promoted` writes only `logger.error`; no escalation, no DL filter, no batch-replay tool (R5-FG-79 deferred without mitigation)
**Closes:** P6-008.
**Bug:** `src/custodial/DepositWatcher.ts:336-345`. When 10 polls of unknown-token deposit fail, watcher promotes to hard DL with `autoRetry:false` and `logger.error`. NO `escalateUncertainDlFailure`, NO admin-UI badge, NO batch-replay tool. Operator must tail Vercel logs, extract each txId, manually call `/api/admin/replay-deposit` per txId. Under load (attacker spams 100 unknown-token deposits) legitimate cases hide in noise.
**Fix:** At minimum, log structured "manual replay needed" line per promotion that admin UI can grep, AND list the txId in `/api/admin/dead-letters?kind=deposit_failed&promotedAt=*` response. Better: paged escalation + `/api/admin/replay-promoted` batch tool.

### `[ ]` R6-FG-43 (H) — `MultiUserAgent.submitV2Message` no post-submit safety net combined with R5-FG-22 increment-before-await
**Closes:** Same as R6-FG-13 (duplicate consolidated).

### `[ ]` R6-FG-44 (H) — `bumpVerificationAttempts` and `bumpUserLockContentionAttempts` race against `markResolved`'s counter reset (TOCTOU)
**Closes:** P9-005.
**Bug:** `src/custodial/uncertainTxVerification.ts:639-643, 668-674`; bump sites at `:355-410, :459-505`. `markResolved` constructs `cleanedProgress` with counters=0 and refresh-then-spreads. The bumpers refresh-then-spread the incremented counter. NO Lua-script gating — both perform read-modify-write on same `details` field independently. Sequence: (1) Resolver B writes counter=0 + resolvedAt; (2) Bumper A reads stale snapshot (counter=4, no resolvedAt), increments (5), writes counter=5. Bumper's `if (base.resolvedAt) return` only checks the FRESH refresh; if resolve write lands AFTER bumper's refresh but BEFORE bumper's upsert, bumper clobbers the resolve.
**Fix:** Wrap per-entry mutations in Lua compare-and-swap on `details.<field>`, OR hold `lockUser:<userId>` (or per-DL fence) across both bump and resolve.

### `[ ]` R6-FG-45 (H) — `KILLSWITCH_TTL_SEC = 24h` will silently expire engagements; auto-disabled state has no operator-paged signal
**Closes:** P9-011.
**Bug:** `src/lib/killswitch.ts:232-236`. R5-FG-7 added 24h TTL to fix R4-FG-47's "permanent flag" bug. But auto-expiry means: operator engages 9am Monday with `reason: "RPC compromise — investigating"`. At 9am Tuesday Redis flag TTLs out. **No HCS anchor written for auto-disable.** Agent silently resumes accepting plays. No webhook fire. Operator returning Wednesday sees plays succeeding and assumes resolved — but no human disabled the switch. Topic-only auditor sees `killswitch_enabled` Monday with no companion `killswitch_disabled`.
**Fix:** When `enableKillSwitch` runs, schedule a `killswitch_auto_expired` HCS control event via reconcile job that polls `getKillSwitchState()` every 30 minutes and writes auto-disable anchor (and pages operator) when state flips enabled→disabled without `disableKillSwitch` call.

### `[ ]` R6-FG-46 (H) — Pre-submit refund SADD failure path's audit-orphan + escalation can deadlock if Redis is down
**Closes:** P9-013.
**Bug:** `src/hedera/refund.ts:578-622`. SADD failed because Redis is unreachable. Next attempts: (a) `options.store.upsertDeadLetter(...)` performs Redis write — also fails. (b) `escalateUncertainDlFailure(...)` uses Redis for cross-Lambda dedup — also throws. Both swallowed. Throw at line 618 fires; route returns 5xx. **Operator gets NEITHER orphan row NOR page — only 5xx.** Once Redis recovers, next refund retry succeeds, refund fires, prior failed attempts have NO audit footprint.
**Fix:** Add in-memory ring buffer for "orphan-events-pending-flush" in `RedisStore`; on every poll cycle, attempt to flush. Redis recovery automatically replays buffered orphans.

### `[ ]` R6-FG-47 (H) — Pending-ledger 7-day TTL allows replay when LREM persistently fails
**Closes:** P10-009.
**Bug:** `src/custodial/pendingLedger.ts:212-224, 348-358`. R5-FG-4's claim is `(userId, sourceTx)` SET-NX with 7d TTL. Every LREM is `.catch(() => 0)` — silent swallow. If the network blip following SET-NX also takes out the LREM, row stays in `LIST_KEY` for 7d+. When `applyPendingLedgerForUser` runs at T=7d+1s: claim TTL expired, SET-NX wins, row still there → mutation reapplies. A 7-day-delayed reconcile from operator running stale code (or sustained Redis outage that swallowed both SET-NX-success-path LREM and subsequent retries) can resurrect a 7-day-old refund and re-debit the user.
**Fix:** Either (a) extend claim TTL to a horizon longer than any plausible reconcile delay (e.g., 90d), OR (b) make LREM error a HARD failure that retries with backoff before claim-release, OR (c) DEL the claim only after successful LREM, so the claim itself becomes the dedup primitive even past 7d.

### `[ ]` R6-FG-48 (H) — `seenControlIdempotencyKeys` Sets grow unbounded for the lifetime of a single reader pass
**Closes:** P9-007.
**Bug:** `src/custodial/hcs20-reader.ts:344, 374`. R5-FG-106 added 60-day window to refund dedup but did NOT apply same to `seenControlIdempotencyKeys` / `seenControlEventKeys`. On a topic with millions of control events (force-release, override anchors, killswitch_enabled events), Sets grow without bound per reader invocation. Reader is invoked per `/api/admin/audit` and `/api/user/audit` request — repeated cold-loads on a 5-year-old topic can OOM.
**Fix:** Apply the same windowed-dedup pattern to control events.

### `[ ]` R6-FG-49 (H) — DepositWatcher refresh interval is no-op on serverless (R5-FG-41 effectively no-op on Vercel)
**Closes:** P11-002, P11-024.
**Bug:** `src/custodial/DepositWatcher.ts:225-238`. R5-FG-41 introduced `REFRESH_USERS_EVERY_N_POLLS=10` to throttle refresh. The check is `pollCount === 1 || pollCount % 10 === 0`. On Vercel, `pollDepositsOnce()` is invoked on demand from `/api/cron/reconcile` and balance-dependent operations — watcher instance isn't long-lived. Each Lambda invocation creates a fresh watcher with `pollCount: 0`, increments to 1 in first call, and triggers `refreshUserIndex()` **every single time**. The "every Nth poll" optimization only applies to the long-running CLI watcher. Net effect on production: identical to pre-R5-FG-41 (refresh on every poll) plus false sense of throttling.
**Fix:** Track `lastRefreshAt` in Redis (TTL-based throttle that survives cold starts): `SET lla:watcher:lastRefresh:<agent> NX EX 600` — refresh only if SETNX wins.

### `[ ]` R6-FG-50 (H) — verify-audit cross-check exceeds mirror node 100 req/s soft cap (R5-FG-105 throttle at wrong layer)
**Closes:** P11-001.
**Bug:** `src/scripts/verify-audit.ts:925-938`. R5-FG-105 set `BATCH_SIZE=25, BATCH_THROTTLE_MS=50`. The 50ms throttle is applied **between chunks of 500**, not between the 25-wide `Promise.all` batches inside `warmMany`. With mirror p50 ~100ms per fetch, `warmMany(500, 25)` issues 500 requests in `~500/25 × 100ms = 2s`, then sleeps 50ms — sustained throughput **~244 req/s**, well above mirror node 100 req/s soft cap. When topic has 5K+ cross-check txIds, verifier hits 429s mid-run. R5-FG-101's per-chunk error-suppression silently swallows failures as `unverified` warnings → audit appears clean while half the mints/burns weren't verified.
**Fix:** Move throttle inside `warmMany` between the 25-wide batches: `await sleep(50)` between every `Promise.all` of 25. Or drop `BATCH_SIZE` to 8. Alternative: rate-limit by token-bucket (100 req/s = one token per 10ms).

### `[ ]` R6-FG-51 (H) — `refreshUserIndex` pipelined GET unbounded → 4MB Upstash request body cap break at ~10K users
**Closes:** P11-009.
**Bug:** `src/custodial/RedisStore.ts:423-445`. `refreshUserIndex` does `SMEMBERS users:all` then `pipeline.get(k('users', id))` for every user. Upstash REST pipeline body is single JSON request. At 5000 users × ~600B per record = 3MB → near 4MB cap. At 10K users → exceeds cap and fails. R5-FG-41's miss (R6-FG-49 above) compounds this.
**Fix:** Page the pipeline. Read users in chunks of 500. For warm Lambdas, only refresh users with stale TTL — track per-user `lla:store:userIndex:lastSeen:<userId>` with EX, only re-fetch keys that are stale or new.

### `[ ]` R6-FG-52 (H) — User audit MAX_PAGES=1000 → 100K message ceiling exhausts Lambda heap
**Closes:** P11-018.
**Bug:** `app/api/user/audit/route.ts:365-401`. `MAX_PAGES=1000 × 100 messages/page = 100K messages`. R5-FG-39 deduplicated decode pass (good), but `allMessages: TopicMessage[]` and `decodedAll: {seq,timestamp,payload}[]` both live simultaneously through entire filter loop. At 100K messages × ~500B base64 + ~500B decoded payload + ~500B parsed object = ~150MB heap before second loop runs. Vercel 1GB Lambda OOMs at ~2-3 concurrent requests.
**Fix:** Stream per-page. Decode + filter + accumulate inline as each page returns; never hold `allMessages` and `decodedAll` simultaneously. Eliminates the 150MB intermediate.

### `[ ]` R6-FG-53 (H) — `initializeAgentSeq` retry ladder blocks first v2 write 5+ seconds during mirror-degraded cold start
**Closes:** P11-021.
**Bug:** `src/custodial/AccountingService.ts:603-666`. R5-FG-13 added exponential backoff on seed-failed flag TTL, but in-process retry ladder is still `[200, 1000, 3000]`ms = ~4.2s of synchronous waits when mirror is fully down. First user trying to play during a mirror outage waits 5+s before play even starts, then likely sees `AGENT_SEQ_SEED_FAILED`. Each warm Lambda's first-play repeats this — N warm Lambdas × 4.2s mirror calls during outage that operator was hoping to ride out.
**Fix:** Don't retry-with-sleep. If first attempt fails, immediately mark seed-failed (Redis flag with TTL backoff already in place) and fail fast. Sibling Lambdas read flag and skip scan. When mirror recovers, flag TTLs out and exactly one Lambda re-seeds.

### `[ ]` R6-FG-54 (H) — `recordControlEvent('force_release')` `idempotencyKey` uses `entry.timestamp` → operator retry collisions silently dropped
**Closes:** P4-010, P9-010.
**Bug:** `app/api/admin/uncertain-tx/[id]/force-release/route.ts:426-433`. Fence is `force-release:${id}:${fenceTs}` where `fenceTs = new Date(entry.timestamp).getTime()`. `entry.timestamp` is the DL's creation time, NOT force-release operation time. If operator force-releases, route fails after audit anchor lands but before resolve (R5-FG-19 leaves entry unresolved), then RETRIES later with new operator session — second retry computes SAME fence (entry.timestamp didn't change). R5-FG-20's reader-side dedup silently drops the second legitimate force-release anchor as duplicate. Reason field of second attempt silently lost from topic.
**Fix:** Use a more resilient key: include `auth.accountId` so two distinct operators force-releasing same id produce distinct keys. Replace `getTime()` with finite-guard.

### `[ ]` R6-FG-55 (H) — `LEGACY_MERKLE_CUTOFF_TIMESTAMP` is operator-controlled env, not documented in schema spec → external auditors disagree silently
**Closes:** P12-010.
**Bug:** `docs/hcs20-v2-schema.md:537-555` mentions the env but presents the cutoff as the agent's choice. External auditor running verify-audit with their own env will produce different reconstructions than operator's. Worse: an attacker with operator-key access could move the cutoff forward to keep accepting forged legacy roots. The cutoff is a security boundary AND a per-agent env — incompatible.
**Fix:** Bake the cutoff into the wire — write a one-time topic anchor at R4-FG-23 deploy time (e.g. `op:'control', event:'merkle_binding_cutover_announced', cutoff:'2026-05-08T00:00:00Z'`). Reader reads cutover from topic, not env. Document that readers MUST find it on-chain.

---

## Phase R6-3 — Medium (~32 items)

### `[ ]` R6-FG-56 (M) — `R2-FG-12 stampProgress refresh-then-merge` test rewrites assertion to hide its own original invariant (R5-FG-76 broke the test's purpose)
**Closes:** P8-001.
**Fix:** Add a SEPARATE intermediate-stamp test that asserts `verificationAttempts` is preserved at the stampProgress moment (stub settleSpend to throw before reaching markResolved).

### `[ ]` R6-FG-57 (M) — `R5-FG-49 cancel immediately halts further heartbeat ticks` test does not exercise the zombie-callback race
**Closes:** P8-002, P9-015.
**Fix:** Extend mock to support `pause()`/`resume()` over `eval`; queue ticks during pause; assert that on resume only ONE tick fires.

### `[ ]` R6-FG-58 (M) — `R3-FG-58 bumpVerificationAttempts refresh-then-spread` test passes pre-fix
**Closes:** P8-003.
**Fix:** Arrange a stale snapshot by capturing `entry` BEFORE the sibling write — pass into a private `bumpVerificationAttempts` (export for testing).

### `[ ]` R6-FG-59 (M) — Schema doc lies about `prizeTransfer.status='recovered'` being writer-emitted
**Closes:** P10-003.
**Fix:** Tighten wire-format type to `succeeded | skipped | failed`. Move `recovered` to reader-side `NormalizedSession.prizeTransfer.status` only. Update schema doc.

### `[ ]` R6-FG-60 (M) — Schema doc step 3 doesn't explicitly state `sym` excluded from canonical Merkle hash
**Closes:** P12-017.
**Fix:** Rewrite step 3 normatively: "For each NFT entry, retain ONLY `tk` and `ser`; discard `sym` and any other display metadata."

### `[ ]` R6-FG-61 (M) — Schema doc doesn't specify `bv:1` line construction byte-for-byte
**Closes:** P12-018.
**Fix:** Doc must specify: separator is U+007C, newline is U+000A LF, all strings UTF-8, no normalization. Add reference vector with hex bytes.

### `[ ]` R6-FG-62 (M) — Schema doc omits R5-FG-110 prize-count cap
**Closes:** P10-007.
**Fix:** Once R6-FG-6 resolved (writer slims before hashing), document slim transform with byte-exact pseudocode in schema doc, including sort tiebreaker and order of operations.

### `[ ]` R6-FG-63 (M) — Reader doesn't enforce "each play_session_open has at most ONE terminal" — close + aborted both present silently keeps close
**Closes:** P10-015, P12-024.
**Fix:** When both close and aborted are present, mark `corrupt` with warning `dual_terminal_present`. Surfaced as critical alert.

### `[ ]` R6-FG-64 (M) — Reader doesn't enforce "each deposit has at most ONE rake event" — two rakes for one deposit pass silently when one has no depositTxId
**Closes:** P12-025.
**Fix:** Track per-user rake events without depositTxId in separate set. Cross-check at end-of-walk: legacy-rakes vs legacy-deposits-without-attribution mismatch surfaces warning.

### `[ ]` R6-FG-65 (M) — Refund pairing not checked: every refund must reference a `mint` on topic
**Closes:** P12-020.
**Fix:** Mirror R5-FG-14: after walking events, iterate refunds and confirm each `originalDepositTxId` is in `depositTxIdsByUser`. Orphan refunds → critical: refund_without_deposit.

### `[ ]` R6-FG-66 (M) — Rake event with `depositTxId` pointing to refunded deposit not flagged as anomalous
**Closes:** P12-011.
**Fix:** verify-audit cross-check: for every (user, depositTxId) rake event, check if there's a refund event with `originalDepositTxId === depositTxId`. If yes AND `rakeReversed === 0`, flag as `unreversed_rake_on_refunded_deposit`.

### `[ ]` R6-FG-67 (M) — Rake event whose `depositTxId` points to a deposit OUTSIDE the topic-walk window appears as "rake without deposit" → false positive critical alerts
**Closes:** P12-012.
**Fix:** When `partial === true`, downgrade `rake_without_deposit` to warning. OR walk deposits-first in two passes.

### `[ ]` R6-FG-68 (M) — verify-audit `--store-snapshot` requires `--agent` but uses placeholder fallback `'0.0.0'`
**Closes:** P6-014, P12-021.
**Fix:** Refuse `--store-snapshot` without `--agent`. Don't silently fall back.

### `[ ]` R6-FG-69 (M) — `relatedTxId` (R5-FG-69) lives only on escalation webhook payload; no topic anchor
**Closes:** P12-022.
**Fix:** Mirror R6-FG-9 fix — write a control event on each anchor failure with `relatedTxId` body field.

### `[ ]` R6-FG-70 (M) — `idempotency_release_failed` (R5-FG-48) escalation has no topic anchor → wedged claim invisible to topic-only auditor
**Closes:** P12-023.
**Fix:** When `idempotency_release_failed` escalates, ALSO write a control event with operation kind + on-chain txId + idempotency-key fingerprint.

### `[ ]` R6-FG-71 (M) — `validateProgressOrdering` accepts ISO-valid but logically wrong timestamps (1970, 9999)
**Closes:** P10-017, P12-019.
**Fix:** Bound check: `parsed >= AGENT_DEPLOY_DATE_MS && parsed <= now + 5*60*1000`.

### `[ ]` R6-FG-72 (M) — A2A `wrapAsTask` discriminator only handles `flush_failed_paged`; other paged statuses leak as 'completed'
**Closes:** P4-012.
**Fix:** Make discriminator extensible. `PAGED_STATUSES = new Set(['flush_failed_paged', ...])`. Add generic status-message.

### `[ ]` R6-FG-73 (M) — Reader's `parseV1Transfer` defaults ALL transfers to `type: 'rake'` — auditing legacy non-rake transfers as rake
**Closes:** P4-013.
**Fix:** If `memo` is not `'rake'` and doesn't start with `'rake:'`, return `null` (skip) or surface as generic `transfer` event.

### `[ ]` R6-FG-74 (M) — Reader extracts depositTxId from body OR memo with no consistency check
**Closes:** P4-014.
**Fix:** In `parseV1Transfer`, if BOTH `bodyDepositTxId` and `memoDepositTxId` are present and differ, log critical anomaly.

### `[ ]` R6-FG-75 (M) — `pendingLedger` drain is fully sequential
**Closes:** P11-007.
**Fix:** Process drain in parallel chunks. 16 lanes by `userId % 16`. Per-entry ops stay sequential within a lane.

### `[ ]` R6-FG-76 (M) — admin/audit chunked Promise.all blocks on slowest member
**Closes:** P11-003.
**Fix:** Replace with worker-pool: `const workers = Array(16).fill(0).map(async () => { while ((u = queue.shift())) await refresh(u); })`. Slow user blocks only one slot.

### `[ ]` R6-FG-77 (M) — `idempotency_release_failed` escalation kind has no force-release UI handler
**Closes:** P10-011.
**Fix:** Add generic "unblock-claim" handler for `idempotency_release_failed` (DEL the wedged claim key after operator confirms on-chain status). For audit-trail-orphaned variants, document recovery path.

### `[ ]` R6-FG-78 (M) — `recordPlaySessionAborted` doesn't carry `prizeTransfer` outcome → user sees `closed_aborted` with no prize-delivery info
**Closes:** P10-012.
**Fix:** Pass `transferOutcome` into `recordPlaySessionAborted` and persist as `prizeTransferOnAbort`. Update reader + `prizeTransferLabel` to surface for aborted sessions.

### `[ ]` R6-FG-79 (M) — `prizesByToken: {}` empty-object default indistinguishable from absent (R5-FG-89 no-op)
**Closes:** P10-013, P12-028.
**Fix:** Reader checks `msg.payload.prizesByToken !== undefined` (not truthy). Add explicit warning when recovery has prizes but breakdown is empty. Update schema doc to require field for new emissions.

### `[ ]` R6-FG-80 (M) — Pipe-delimited `(eventKind, idempotencyKey)` tuple key has no escaping; future writer with pipes silently collapses
**Closes:** P10-014, P10-028.
**Fix:** Use unambiguous separator (`\x00`) or JSON-encode tuple. Centralize a `composeTupleKey(...parts)` helper.

### `[ ]` R6-FG-81 (M) — `unref?.()` silent no-op when `setTimeout` returns number primitive (jsdom / fake timers)
**Closes:** P10-016.
**Fix:** Detect at startup whether `setTimeout` returns Node-style Timeout. Warn loudly if not. Or feature-detect: `if (typeof timerHandle === 'object' && typeof timerHandle.unref === 'function') ...`.

### `[ ]` R6-FG-82 (M) — Truncated UTF-8 fingerprint hashes operate on slice'd UTF-16, can produce mid-surrogate-pair input
**Closes:** P10-019.
**Fix:** Truncate by codepoint count: `Array.from(rawCauseMsg).slice(0, 256).join('')`. Or use `truncateError(rawCauseMsg, 256)` (already exists).

### `[ ]` R6-FG-83 (M) — `pendingLedger` malformed rows not LREM'd → indefinite re-walk + counter inflation
**Closes:** P5-014.
**Fix:** In malformed branches, LREM the row, write `audit_trail_orphaned`, escalate.

### `[ ]` R6-FG-84 (M) — `pendingLedger` user-not-found silently drops debit
**Closes:** P5-015.
**Fix:** Do NOT LREM. Write `audit_trail_orphaned`, escalate. Operator decides.

### `[ ]` R6-FG-85 (M) — `tryClaimTransaction` rolls back ordering: local `delete` first, then `srem` → cluster-wide claim re-fires while local cache says claimed
**Closes:** P2-008, P2-011.
**Fix:** `srem` first then local delete. Mirror `tryClaimTransaction` pattern.

### `[ ]` R6-FG-86 (M) — `agentSeq` seed-failure counter has unbounded growth on EXPIRE failure
**Closes:** P1-014, P5-009.
**Fix:** Atomic Lua: `set seedFailKey NX EX → if won, INCR + EXPIRE`. Or `redis.set(seedFailCountKey, String(failCount), { ex: 86400 })` instead of separate INCR + EXPIRE.

### `[ ]` R6-FG-87 (M) — `pendingLedger` 7-day TTL is shorter than legitimate replay windows AND doesn't match the LIST retention
**Closes:** P1-015, P2-016, P10-009.
**Fix:** See R6-FG-47 for the deeper fix.

### `[ ]` R6-FG-88 (M) — `seedAgentSeq` SETNX doesn't bump existing counter to higher mirror-derived baseline
**Closes:** P2-003, P2-012.
**Fix:** Lua-CAS: `if not exists, set to value; else if current < value, set to value; else no-op`.

### `[ ]` R6-FG-89 (M) — `enableKillSwitch` SET-NX-EX gates engagement BUT not anchor-write retry
**Closes:** P2-013.
**Fix:** When `disableKillSwitch` runs and discovers flag was already TTL'd, emit synthetic `killswitch_ttl_expired` audit anchor. Or remove TTL entirely (revert R5-FG-7) but separately fix R4-FG-47 by writing `killswitch_re_engaged` on no-op path.

### `[ ]` R6-FG-90 (M) — `RedisStore.depositsByUser`/`playsByUser` lazy build races concurrent recordDeposit/rotateRecords
**Closes:** P2-007.
**Fix:** Build the index synchronously inside `recordDeposit`. Or snapshot `this.deposits.length` at lazy-build entry. Document concurrency expectation.

### `[ ]` R6-FG-91 (M) — Eager pendingLedger drain skips R5-FG-96 rake-amount reconciliation
**Closes:** Same as R6-FG-23 (consolidated).

### `[ ]` R6-FG-92 (M) — Reader emits session events keyed by `firstSeq`, not `openSeq` (R5-FG-58 sibling miss in event-emission)
**Closes:** P3-026.
**Fix:** Reader emits session events with `sequence: bucket.open?.sequence ?? session.firstSeq`.

### `[ ]` R6-FG-93 (M) — Reader v1-fallback session has no `openSeq`; verify-audit's strategy cross-check falls back to `firstSeq`
**Closes:** P3-017.
**Fix:** Set `openSeq: v1.sequence` in v1 fallback to make consumer contract uniform.

### `[ ]` R6-FG-94 (M) — `relatedTxId` field set to SAME txId on both deposit/rake escalations — provides zero pairing information
**Closes:** P3-018.
**Fix:** Drop `relatedTxId` for these sites and add `pairKind` field; OR consolidate into single composite escalation kind `deposit_rake_anchor_pair_failed`.

### `[ ]` R6-FG-95 (M) — Cumulative escalation site `relatedTxId` audit (refund processRefund post-success cascade, force-release route, prize_recovery)
**Closes:** P3-019, P3-020, P3-022, P3-023.
**Fix:** Audit each escalation site for paired-failure context; add `relatedTxId` where the pair link is meaningful.

### `[ ]` R6-FG-96 (M) — `slimPoolResult` unconditional stringify on hot path
**Closes:** P11-005.
**Fix:** Cheap-check heuristic: if `msg.prizes.length <= 3 && !msg.strategyMeta`, skip size check entirely.

### `[ ]` R6-FG-97 (M) — `slimPoolResult` re-stringifies up to 4x per slim pool
**Closes:** P11-006.
**Fix:** Track `currentBytes` incrementally. After step 1 drops `strategyMeta`, subtract size delta. Single full stringify at start, deltas thereafter.

### `[ ]` R6-FG-98 (M) — Reader's `prize_recovery` flip relies on `affectedSessions` populated; CLI omission silent failure
**Closes:** P6-015.
**Fix:** When `prize_recovery` lacks `affectedSessions`, emit warning `prize_recovery_orphan_no_sessions: txId=<contractTxId>`.

### `[ ]` R6-FG-99 (M) — `force_release_refund_sadd` orphan recovery is "manually SADD"; conflicts with Symptom 22 logic
**Closes:** P6-016.
**Fix:** Symptom 24 row for `force_release_refund_sadd` should redirect to Symptom 22's verifier-path SADD instructions.

### `[ ]` R6-FG-100 (M) — `recordRakeReversed` mismatch is value-only; reader doesn't compare `rakeReversedToken` between duplicates
**Closes:** P12-016.
**Fix:** Tuple-compare `(rakeReversed, rakeReversedToken)`. Surface mismatch types distinctly.

### `[ ]` R6-FG-101 (M) — admin/audit unbounded session truncation silent for operator
**Closes:** P11-004.
**Fix:** Stamp response payload with `{ truncated: true, totalUsers, enrichedUsers }`.

### `[ ]` R6-FG-102 (M) — pendingLedger drain skips entries by `userId` filter without removing from list (O(total queue length) per user lock acquire)
**Closes:** P11-008.
**Fix:** Keep per-user queue keyed by `lla:store:pendingLedger:user:<userId>`. Eager path does `LRANGE userKey 0 -1`.

### `[ ]` R6-FG-103 (M) — `RedisStore` per-user lazy index rebuild O(N) on every rotation
**Closes:** P11-010.
**Fix:** Incremental update on rotation. Walk dropped N to decrement per-user Map.

### `[ ]` R6-FG-104 (M) — Sequential mint+burn cross-check loop after warmMany
**Closes:** P11-023.
**Fix:** Pre-warm `decimalsCache` from unique tokens with `Promise.all` (concurrency=10) before sequential loop.

### `[ ]` R6-FG-105 (M) — admin/audit + user/audit duplicate parse pass on prize_recovery sessions
**Closes:** P11-025.
**Fix:** Build `prizeRecoveryEvents` during phase 1; iterate that array directly.

### `[ ]` R6-FG-106 (M) — Reader's `usedLegacy` Merkle path is the ONLY warning surface; not elevated to status-level for non-CLI consumers
**Closes:** P9-003.
**Fix:** Surface `legacyMerkleBinding: true` at top level of `NormalizedSession`. Apply cutover-aware critical promotion at reader level, not just verify-audit.

### `[ ]` R6-FG-107 (M) — `bumpUserLockContentionAttempts` fallback escalation runs `escalateUncertainDlFailure({kind: entry.kind ?? 'withdrawal_uncertain'})` despite R5-FG-75's tighter check ABOVE it
**Closes:** P9-014.
**Fix:** Apply same `if (entry.kind === ...)` guard to fallback at lines 491-504.

### `[ ]` R6-FG-108 (M) — `r5-fg-3` integration test for safeSubmit-using-callers (processWithdrawal, processRefund, transferAllPrizesWithRetry)
**Closes:** P8-057 partial.
**Fix:** Add integration test that stubs `tx.execute()` to return then throw before receipt; assert claim survives via withIdempotency.

### `[ ]` R6-FG-109 (M) — User audit refreshPlaysForUser inside hot endpoint with no cache
**Closes:** P11-019.
**Fix:** Add 30s in-Lambda TTL cache keyed on `userId`. Skip refresh if recently refreshed.

### `[ ]` R6-FG-110 (M) — User audit `involvesAccount` regex-allocated per message
**Closes:** P11-026.
**Fix:** Hoist regex construction outside filter loop. Pre-compile once per request.

### `[ ]` R6-FG-111 (M) — Force-release route's verify-lock release happens BEFORE the audit anchor + resolve write outside lock for `withdraw-fees`
**Closes:** P4-015.
**Fix:** Move `withdraw-fees` lock acquire/release to wrap entire route flow including resolve-write, OR gate any in-band `operatorWithdrawFees` on a check of unresolved DLs.

### `[ ]` R6-FG-112 (M) — admin/replay-deposit 207 with paged warning (R5-FG-54) leaks Redis health
**Closes:** P7-014, P7-026.
**Fix:** Generic message in HTTP body. Persist phase/cause to orphan row only.

### `[ ]` R6-FG-113 (M) — Force-release `partialMutation` 503 leaks specific failure phase + cause to admin tier
**Closes:** P7-013.
**Fix:** Return generic "operation incomplete, retry after operator review" 503. Persist phase/cause to orphan row only.

### `[ ]` R6-FG-114 (M) — A2A unauthenticated rate-limit shares a single `a2a` bucket
**Closes:** P7-009.
**Fix:** Force unauthenticated path to bucket by IP, or refuse unauthenticated POST entirely.

### `[ ]` R6-FG-115 (M) — Killswitch GET admin-tier strip is asymmetric — operator MCP path returns full state
**Closes:** P7-010.
**Fix:** Centralize redaction in `getKillSwitchState()` itself with a `tier` argument.

---

## Phase R6-4 — Low (~30 items)

(Brief, in flat list. See agent reports for full detail.)

- **R6-FG-116** (L): `KillSwitchError` not handled in `user/withdraw` (defense-in-depth) [P7-011, P3-009]
- **R6-FG-117** (L): admin/dead-letters query filter validation [P7-012]
- **R6-FG-118** (L): auth/challenge + auth/verify rate-limit by accountId [P7-015]
- **R6-FG-119** (L): `/api/public/stats` unrate-limited; can be cache-busted [P7-016]
- **R6-FG-120** (L): `/api/health` unrate-limited; version field is timing channel [P7-017]
- **R6-FG-121** (L): `auth/lock` rate-limit pre-auth without identity binding [P7-018]
- **R6-FG-122** (L): cron CORS wildcard origin [P7-019]
- **R6-FG-123** (L): `identityFor` 'unknown' magic string overlap [P7-020]
- **R6-FG-124** (L): `isOriginAllowed` exported but unused (dead code) [P7-021]
- **R6-FG-125** (L): admin DL `SEVERITY_RANK` table hardcoded; new kinds default to 0 [P7-022]
- **R6-FG-126** (L): A2A wrapAsTask leaks "Local state mutated; Redis flush failed" verbatim [P7-023]
- **R6-FG-127** (L): `auth/refresh` accepts sessionToken from body, not header (rate-limit ineffective) [P7-025]
- **R6-FG-128** (L): `RedisStore.releaseTransactionClaim` ordering inconsistency [P2-008]
- **R6-FG-129** (L): `processedTxIds` cache hit short-circuits without Redis cross-check [P2-015]
- **R6-FG-130** (L): `recordRedisFailure` per-Lambda breaker (not cluster-wide) [P2-019]
- **R6-FG-131** (L): `localEscalationLog` GC iteration style fragile [P2-020]
- **R6-FG-132** (L): `RedisStore.fire` flush snapshot vs concurrent fire race [P2-021]
- **R6-FG-133** (L): `withUserLock` releases lock on flush throw [P2-022]
- **R6-FG-134** (L): Reader skips `slim_truncated_prizes` flag → auditor can't tell prizes were silently dropped [P12-027]
- **R6-FG-135** (L): `prize_recovery` event emits no `agentSeq` → out-of-order vs session reconstruction non-deterministic [P12-030]
- **R6-FG-136** (L): verify-audit `partial` flag doesn't propagate to JSON output envelope [P12-029]
- **R6-FG-137** (L): `parseRefund` reads `amt` as Number with no decimals awareness [P12-014]
- **R6-FG-138** (L): R5-FG-94 anomaly counter buries critical signal in generic `unknownMessages++` [P12-015]
- **R6-FG-139** (L): `details.attempts === 0` omitted by truthy spread [P10-022]
- **R6-FG-140** (L): CLI MCP server `Allow-Headers` doesn't include `Idempotency-Key` [P10-023]
- **R6-FG-141** (L): `PACKAGE_VERSION ?? ...` doesn't fall through on empty string [P10-018, P10-024]
- **R6-FG-142** (L): `.gitattributes eol=lf` doesn't catch IDE-saved CRLF mid-deploy [P10-025]
- **R6-FG-143** (L): `attempts` semantics inconsistent between succeeded/failed paths [P10-027]
- **R6-FG-144** (L): `expiresAt` computed at issue, doesn't reconcile with Redis TTL [P10-029]
- **R6-FG-145** (L): In-memory mock eval covers exactly two scripts; future scripts silently throw [P10-030]
- **R6-FG-146** (L): `agentSeqInitPromises.delete + await initializeAgentSeq` allows brief redundant mirror scans [P9-016, P2-018]
- **R6-FG-147** (L): `KILL_KEY` SET-NX claims JSON-serialized state value; operator hand-edit collides [P9-017]
- **R6-FG-148** (L): Refund's success-path post-success SADD is unconditional duplicate of pre-submit [P9-018]
- **R6-FG-149** (L): Force-release `successTriagedAt` stamp uses `refreshAndGuard` but route's resolve uses different fallback [P9-019]
- **R6-FG-150** (L): `recoveryLockHeartbeat.cancel()` + `process.exit` interaction; in-flight Lua eval may extend after cancel [P9-020, P5-007, P5-008]

---

## R6-FG-51-style: Test discipline (sixth recurrence pending)

R5-FG-51 acknowledged 8 R4 fixes need tests; R5 shipped 3 (R4-FG-66 partial, R5-FG-49 shallow, R5-FG-48 solid). P8 audited the R5 surface and found:

- **5 R5 fixes** with revert-proof tests (R5-FG-2, R5-FG-3 ×3 sub-tests, R5-FG-9, R5-FG-25 partial 2/10, R5-FG-48, R5-FG-49 shallow)
- **~85 R5 fixes** with NO direct revert-proof test
- **3 tests actively HIDE the original invariant** (R6-FG-56/57/58)
- **R4-0 baseline gate counts comments, not behavior** — shipped fixes can be completely untested without tripping the gate

The audit doc's open question 5 ("revert-proof drill" CI step) remains unanswered. P8-106..P8-109 propose:
- Maintain `audit-coverage.json` keyed by `{ R<N>-FG-<id>: testFile|null }`; CI fails if any audit doc finding lacks test pointer.
- "Revert-proof drill" CI job: greps for `revert-proof:` comments, randomly picks one, sed-deletes the named function/value in production code, runs tests, asserts test fails, restores.

This is the SIXTH recurrence of R2-FG-0 archetype. Without a CI guard that exercises the discipline directly (not just counts annotations), the recurrence will continue.

---

## Plan-of-record decisions for the implementation phase

1. **R6-1 commit** bundles the 15 critical items. Themes:
   - **`PostSubmitError` sibling sweep** (R6-FG-1 / 2 / 3 / 4 / 5) — the safest fix (single regex replace + integration test) closes 3 critical double-spend windows
   - **Merkle parity for slim path** (R6-FG-6) — writer must hash the same prizes it sends
   - **Refund event schema** (R6-FG-7 / 8) — `rakeReversed`/`rakeReversedToken`/`token` fields wire through reader
   - **Topic-only DR completeness** (R6-FG-9 / 10 / 11) — `deposit_credit_flush_orphaned` actually carries the amount and surfaces in alerts; `--store-snapshot` becomes the runbook default
   - **pendingLedger ledger-debit loss** (R6-FG-12) — claim-held-but-row-LREMd silent corruption
   - **submitV2Message safety net** (R6-FG-13) — completes R5-FG-22's invariant
   - **withIdempotency fallback DEL** (R6-FG-14) — drop the unfenced fallback, accept stuck-claim as the safer failure mode
   - **LEGACY_MERKLE_CUTOFF fail-closed** (R6-FG-15) — close the strip-timestamp bypass

2. **R6-2 commit** the ~38 high items. Major themes:
   - **handlers.ts ↔ verifier parity sweep round 2** (R6-FG-16 / 35 / 36)
   - **Authentication sanitization** (R6-FG-17 / 18 / 19 / 20)
   - **API surface R5-FG-31 sibling sweep** (R6-FG-21 / 22)
   - **Reader dedup & invariants** (R6-FG-24 / 25 / 26 / 34 / 48)
   - **prize_recovery semantics** (R6-FG-27 / 28 / 29 / 30)
   - **Self-heal closures** (R6-FG-40 / 41 / 42)
   - **Concurrency races** (R6-FG-44 / 45 / 46 / 47)
   - **Perf cliffs** (R6-FG-49 / 50 / 51 / 52 / 53)

3. **R6-3 commit** the ~32 medium items split across 2 phases by domain.

4. **R6-4 commit** the ~30 low items.

## Open questions for the user

1. **All ~150 items in scope**, or any to prune? R6 found more issues than R5 (~115 unique vs ~95). Significant finding: R5's central refactor (`safeSubmit` + `PostSubmitError`) is partially applied, leaving multiple critical double-spend windows. This needs to ship before mainnet.

2. **R5-FG-3 PostSubmitError sweep priority**: ship R6-FG-1..5 immediately as a hotfix on top of the R5 commits, OR roll into a unified R6-1 commit? They're the most load-bearing fix (Critical × 5).

3. **Schema doc shipped without Merkle binding cutover anchor on chain (R6-FG-55)**: ship a one-time anchor at deploy time AND require external auditors to read it from topic, OR keep env-driven cutoff and document it as a known limitation? The env approach allows operator-key compromise to bypass the binding.

4. **R6-FG-51 test discipline (sixth recurrence)**: ship the "revert-proof drill" CI job NOW, OR keep accepting partial test coverage with each round's pre-mortem of the previous round's gaps? Six rounds of partial coverage suggests the static-analysis approach isn't enough — CI must actively verify the discipline.

5. **Conservation invariant 4 currently unprovable** because `parseRefund` doesn't read `rakeReversed` (R6-FG-7). External audits will fail. Hotfix or wait?
