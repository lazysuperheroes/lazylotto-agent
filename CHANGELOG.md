# Changelog

All notable changes to this project will be documented in this file.

## [0.4.1] - 2026-07-05

> **Security hardening release.** An off-chain adversarial security audit of the
> custodial core — multi-tenant fund accounting, auth/tier isolation, cross-Lambda
> concurrency, HCS-20 ledger integrity, x402 payments, and operator alerting —
> surfaced 19 findings; all 19 were fixed, each locked by a regression test. A
> focused re-audit of the fix diff then caught 3 more (two of them introduced by
> the fixes themselves); those were fixed too, and a fix-verify pass confirmed
> closure. The commerce surfaces are untouched and remain flag-gated OFF. Full
> per-finding evidence + fixes: `docs/security-remediation.md`.

### Security

- **Refund correctness (F2 / F3 / F15 / F-R1).** Refunds now debit the NET amount
  the user was credited (not the gross on-chain amount — the previous behavior
  over-debited and manufactured a false operator surplus that hid insolvency from
  reconcile), refresh the user + operator balances UNDER the per-user lock before
  mutating (closing a cross-Lambda lost-update), and floor the operator rake
  reversal at 0 while also reversing `totalRakeCollected`. Applied across ALL
  THREE refund code paths (in-flight, uncertain-refund verifier, admin
  force-release) plus the standalone `verify-audit` reconstruction.
- **Cross-tenant isolation (F1 / F-R3).** The shared-wallet prize sweep
  (`transferPendingPrizes(owner, MaxUint256)`) now REFUSES when the agent wallet
  holds more pending prizes than the current session won — a prior tenant's
  stranded prizes can no longer be swept to the current player; a blocked sweep
  dead-letters for operator recovery. The guard is scoped to custodial
  (shared-wallet) mode, so single-user deployments still auto-forward the sole
  owner's own prizes.
- **Auth & tier isolation (F5 / F6 / F7).** Per-request tier de-escalation — an
  offboarded operator drops to `user` immediately, even on a locked session, and
  the tier can never auto-escalate; unauthenticated rate limits are keyed by IP so
  a forged `Bearer` can't reset the bucket; the serverless operator fail-open is
  refused in multi-user mode; new admin `POST /api/admin/revoke-sessions`.
- **Audit-trail integrity (F8 / F12 / F13 / F-R2).** agentSeq seeding counts
  author-less messages (closing a sequence-reuse bug), fails loud on a missing
  topic instead of silently dropping every audit write, and now skips the
  redundant cold-start mirror scan when the cluster counter is already seeded
  (closing a fail-closed play DoS the fail-loud change could otherwise trigger on
  a busy topic). The play-session close `poolsRoot` is versioned and computed over
  the post-slim prize set, so prize-heavy sessions no longer false-alarm as
  `corrupt` in the reader / DR reconstruction.
- **x402 payment gate (F4 / F11).** `settleOrChallenge` now validates the client
  payment against the SERVER's own requirements (scheme / network / asset / payTo
  + `x402Version`) and enforces the configured slippage floor before verify/settle
  — a spoofed or underpaid request is rejected instead of trusting the
  client-echoed amount. (Gate still behind `X402_ENABLED`.)
- **Alerting & monitoring (F16 / F17 / F19).** The operator-paging dedup claim is
  released on any webhook delivery failure (network / timeout / non-2xx) so a
  single transient blip can't suppress a critical page for 6h; the reconcile cron
  writes a freshness watermark surfaced at `/api/health` as a dead-man's-switch;
  the pending-ledger drain probe no longer silently collapses a transient error
  into "empty".
- **Deposit cap (F18).** `maxUserBalance` is re-checked under the credit lock on
  the fresh post-refresh balance, closing a cross-Lambda TOCTOU where two
  concurrent deposits could both pass a stale pre-lock check.
- **Production boot guard (F9 / F10).** A consolidated `isProductionDeploy()`
  keys the production assertions off more than `NODE_ENV`; a **mainnet** deploy
  now FAILS CLOSED if `HCS20_TOPIC_ID`, `OPERATOR_WITHDRAW_ADDRESS`, or
  `CRON_SECRET` are unset (testnet only warns).

### Added

- `IStore.peekAgentSeq` — read the HCS-20 agentSeq counter without incrementing
  (implemented by RedisStore + PersistentStore).
- `POST /api/admin/revoke-sessions` — admin force-revoke of all sessions for an
  account.
- `/api/health` gains a `reconcile: { lastRunAt, staleSeconds }` freshness block
  (surfaces the reconcile dead-man's-switch; not a solvency verdict — the endpoint
  is unauthenticated).
- `src/auth/tiers.ts` — SDK-free tier resolution + `deEscalateTier`.
- `MaxUserBalanceExceededError`.

### Notes

- ⚠️ **Mainnet deploys now require** `HCS20_TOPIC_ID`, `OPERATOR_WITHDRAW_ADDRESS`,
  and `CRON_SECRET`, or boot fails by design. Testnet warns only, so existing
  testnet deploys are unaffected.
- Shipped as 12 commits on `testnet` (`dc7c5a3..2f6bce9`). The re-audit found that
  two of the fixes (F8, F1) had introduced regressions of their own — the value of
  running an adversarial pass over a large security-critical diff, since a green
  test suite structurally can't catch that class.

## [0.4.0] - 2026-06-10

> **Hedera Commerce Agent release.** Two opt-in, flag-gated commerce surfaces
> on top of the existing audited custodial core. EVERYTHING DEFAULTS OFF;
> production runs untouched until a flag is flipped, and neither surface alters
> the audited HCS-20 settlement path.

### Added

- **AI chat** (`CHAT_ENABLED`): `/chat` + `/api/chat` backed by the **Hedera
  Agent Kit** used as a READ-ONLY tool router — read-only Hedera `*Query`
  plugins plus a custom plugin wrapping the audited MCP tools. The kit's
  MUTATING plugins are never loaded (structural guarantee, source-test locked).
  Scope-restricting system prompt + per-turn output/input/history/step caps +
  per-identity daily cap.
- **play-via-chat** (`CHAT_ALLOW_PLAY`, default off even when chat is on): the
  only mutating chat tool, two-step by construction (`multi_user_play` refuses
  unless `confirm === true`), routed through the audited MCP path. Withdrawals
  never exposed to chat.
- **x402-on-Hedera payment gate** (`X402_ENABLED` + `X402_PAY_TO`): `POST
  /api/premium/rake-holiday` sells a USD-priced "rake holiday" (USDC or live
  HBAR equivalent) → 0% deposit rake for N days. `402` → buyer-signed Hedera
  transfer → facilitator settle → grant. `x402Version: 2`, CAIP-2 `hedera:<net>`.
  WalletConnect picker (`RakeHolidayModal`) + `uat-x402.ts` reference payer.
- **Rake holiday mechanism**: single-seam `getEffectiveRakePercent` in the
  deposit path; grant in auth-Redis, idempotent per settlement tx. Optional
  flag-gated HCS-20 receipt anchor (`X402_RECORD_TO_HCS20`) via a non-balance-
  affecting `x402_rake_holiday_granted` control event. `/api/user/status`
  surfaces the effective rake so the dashboard + `/account` reflect an active
  holiday.
- **Commerce discovery**: `/api/discover` `commerce` block + `capabilities`
  flags, and the A2A Agent Card description names the capability, when x402 is
  active.
- **Dashboard UX**: first-run rake box + one-time rake explainer
  (`RakeTutorialModal`), audit-page type filter, sidebar session-change sync +
  conditional Chat link.
- **Tooling**: `npm run typecheck` gate over both tsconfigs; `docs/` (UAT
  runbook, x402 payment guide, AI Studio feedback, agentic-commerce blog post).

### Fixed

- `getRakeHoliday` guards the Upstash JSON double-parse (`typeof v === 'string'`)
  so an active holiday is reflected in the UI instead of silently showing the
  base rate.
- `tsconfig.cli.json` bumped `Node16` → `NodeNext`, fixing a latent CLI build
  break on the `package.json` import attribute.
- Two `idempotency.test.ts` fixtures now implement `PreserveClaimError`'s
  abstract `transactionId` (whole-program `tsc` was the only gate that caught it).

## [0.3.5] - 2026-05-10

> **Audit cycle closure release.** The 0.3.4 changelog ended with a three-agent
> security sweep that surfaced 15 fresh findings. That seeded a longer
> adversarial-audit cycle: 12-persona codebase sweeps repeated weekly,
> rounds R5 through R12 over four days (May 6 – May 10). The cycle ran
> seven full rounds; this release is what shipped from rounds R5-R12 and
> closes the cycle.
>
> **What this release contains, at a glance:**
> - 12 critical bug fixes across the multi-user / cross-Lambda surface
>   (concurrency races, double-debit windows, balance-conservation
>   violations, store-cache mutation hazards).
> - 4 architectural primitives that close entire archetype families at
>   compile time or via shared production helpers (`Readonly<UserAccount>`,
>   `Readonly<OperatorState>`, `composeBalanceResponse`, parseRefund
>   tagged-union).
> - The audit-coverage manifest + ratchet (`src/__tests__/audit-coverage.json`
>   plus the gates in `audit-coverage.test.ts` and `audit-coverage-scan.ts`)
>   as the live regression-detection contract going forward.
> - The full cycle history archived under `docs/archive/audit-runs/` for
>   traceability — finding IDs in code comments (e.g. `R10-FG-1`) reference
>   those documents.
>
> **Why we're comfortable shipping:** the closure pattern shifted from
> chasing-the-named-site (rounds R5-R8) to compile-time and architectural
> guarantees (Phase-9 + Phase-9.5). The four invariants in the §Architecture
> section below are enforced by the type system, by shared helpers all
> consumers must call, or by the audit-coverage gate's structural-fixture
> allowlist. Reverting any of them is a `tsc` error, a runtime test
> failure, or both. R12's verification audit found 5 deduped bugs against
> Phase-9 closures — all mechanical sibling-site misses, all closed in
> Phase-9.5 — and 0 new structural concerns.
>
> **Where we should have stopped:** R8 (32 findings) was probably the
> right exit point. We ran four more rounds (R9 → R12) in the wild-goose-
> chase pattern documented at
> `docs/archive/audit-runs/audit-cycle-dissection-2026-05-10.md` §1 — each
> round's closures introduced new code that the next round audited, and
> roughly half of each round's findings were quality complaints, observability
> gaps, or process discipline rather than user-visible bugs. The Phase-9
> dissection introduced a four-category triage primitive (`bug` vs `error`
> vs `quality` vs `process`) that, applied retroactively, would have
> compressed R6-R10 into ≤2 rounds total. Future audits should run on-demand
> against specific subsystems with the triage primitive at finding time —
> not as 12-persona codebase sweeps. CLAUDE.md's "Audit cycle status" section
> codifies this for future contributors.
>
> Testnet only — no users affected. Phase-9.5 hotfix verified clean before
> archive.

### Audit cycle summary

| Round | Phase | Verdict | Critical bugs closed |
|-------|-------|---------|---------------------|
| R5 | R5-1..4 | individual fixes (R5-FG-1..111) | 15 |
| R6 | R6-0/R6-1 | structural gate against PreserveClaim sibling-miss archetype | 5 |
| R7 (Phase 1-3) | bundled into Phase-8 | revert-proof annotations + audit-coverage manifest infrastructure | — |
| R8 (Phase 6) | bundled into Phase-8 | wire-only closures (heldByToken, depositCreditFlushOrphanedByToken, schemaValidationFailures consumers) | — |
| R9 (Phase 7) | bundled into Phase-8 | per-token reservation refinements; tagged-error sentinels | — |
| R10 (Phase 8) | clusters A-D | manifest placebo, parseRefund silent-null, user-status mutation, pendingLedger SADD-after-flush | 4 |
| R11 (Phase 9) | clusters A-E | conservation invariant + store-cache contract + pending-ledger idempotent + security/DoS sweep | 5 |
| R12 (Phase 9.5) | cluster F | force_release writer + playForUser saveUser revert + getOperator Readonly + parseRefund tagged-union + structural-gate loophole + archive doc rationale | 6 |

**Cumulative across the cycle:** 35 critical bug closures (deduped); ~120 high/medium closures (most quality-categorized in retrospect); two architectural migrations (Readonly cache contract + tagged-union parsers); one ratchet manifest gate-set that survives forward as the regression-lock.

### Fixed (CRITICAL — load-bearing user-visible bugs)

- **pendingLedger drain double-debit windows (R10-FG-1 + R11-FG-4 + R12-FG-2 family).** Three sequential closures of the same archetype: SADD anchor must precede balance mutation in both eager and periodic drain paths; mutation must occur AFTER anchor so a SADD throw aborts before any in-memory dirty state; `MultiUserAgent.playForUser`'s redundant second `saveUser(user)` was reverting the lastPlayedAt timestamp post-Phase-9 and is now removed. The order is now: SISMEMBER (skip if applied) → SADD anchor → updateBalance → updateOperator → flush → LREM. A flush throw leaves the anchor as a poison-pill (next drain takes the already-applied branch); a SADD throw aborts cleanly. Closes the multi-Lambda double-debit hazard at every entry point. Locked by `r10-fg-1-behavioral.test.ts` (3 tests including a withUserLock-faithful simulator across two pseudo-Lambdas).
- **Conservation invariant violation via parseRefund silent null-drop (R10-FG-3 + R11-FG-1 + R11-FG-5 + R12-FG-4 family).** parseRefund returned bare null on FIVE distinct payload-malformation reasons; the dispatcher only categorized empty-`originalDepositTxId` and let four sibling reasons fall into the catch-all `skippedMessages` counter. Verify-audit's reducer couldn't distinguish a dropped legitimate refund from any other skip — reconstructed user balances OVER-CREDITED by the dropped refund amount. Phase-8 added the first counter; Phase-9 wired the consumer into verify-audit's alert pipeline; Phase-9.5 made parseRefund return a discriminated `NormalizedRefundEvent | ParseRefundFailure` tagged union with an exhaustive switch + `never` exhaustiveness check. Future 6th reason becomes a TypeScript error, not a silent skip. Locked by `r10-fg-3-behavioral.test.ts`.
- **Store-cache mutation hazards via /api/user/status (R10-FG-2 + R11-FG-3 family).** The Phase-7 fix to subtract pending-ledger debits from the dashboard balance view mutated `user.balances` directly on a live store reference, leaking phantom-deficit state across requests on warm Lambdas. Phase-8 introduced a `responseBalances` local variable at the named route only; R11 found three sibling routes (/api/user/check-deposits, /api/user/play, /api/user/withdraw) returning raw user.balances and the dashboard merging those back, restoring the phantom-funds view R10-FG-2 was supposed to close. Phase-9 closed the architectural contract: `IStore.getUser*` returns `Readonly<UserAccount>` (compile-time guarantee), all four balance-bearing routes call the shared `composeBalanceResponse` helper, the behavioral test imports the helper directly so test/route divergence is structurally impossible. Phase-9.5 extended Readonly to `IStore.getOperator()` after R12 found the operator surface uncovered. Locked by `r10-fg-2-behavioral.test.ts` + the type system.
- **`force_release` writer dropped userId + tokenReservations; heldByToken decrement was dead code (R10-FG-16 + R12-FG-1).** Phase-9 Cluster B added a `verify-audit.ts` reducer-side decrement of `heldByToken` on `force_release` / `force_release_override` events, gated on `event.userId && event.tokenReservations`. R12 P5-001 surfaced that the only production writer (`app/api/admin/uncertain-tx/[id]/force-release/route.ts`) never passed those fields. The Phase-9 closure was decorative on production topics; every operator force-release of a triaged play would still trip the false-positive `user_balance_negative` alert R10-FG-16 was supposedly fixed for. Phase-9.5 threads `userId` and `tokenReservations` from the dead-letter entry's `details` into the writer (mirrors the play_uncertain_success_pending_triage writer at handlers.ts:807).
- **Velocity counter inflation 24h-DoS (R10-FG-12).** `MultiUserAgent.applyWithdrawalVelocityCap` did atomic INCRBY then checked the proposed value, but the over-cap branch did NOT roll back the increment. A compromised session retrying `withdraw(1500)` 10 times against a 1000 cap drove the counter to 15000; every legitimate withdraw for the next 24h returned 503. Pre-Phase-9 the inline comment accepted this as "intentionally lossy on the over-cap edge" — that framing missed the DoS attack vector against the victim user. Now does INCRBY(amount) then INCRBY(-amount) rollback on the over-cap branch; counter ends at the same value as if the increment had never run. Locked by `r10-fg-12-behavioral.test.ts`.
- **SignatureValidationError migration completion (R10-FG-14).** R9-FG-5 / Phase-7 Cluster C introduced a typed sentinel for signature failures but stopped halfway: three security-critical throws in `src/auth/verify.ts` (challenge expiry L87, account mismatch L94, signature failure L154 — the most security-sensitive throw in the auth path) were still plain `Error` and required substring matching downstream. Phase-9 Cluster E completed the migration; the R9-FG-5 archetype is now structurally retired across the auth surface.
- **Aggregate `ledgerBalance` formula stale vs per-token (R10-FG-9).** `verify-audit.ts:1377` aggregate formula omitted held + flushOrphan from the subtraction (per-token formula was correct; aggregate was stale). JSON consumers reading the top-level `ledgerBalance` saw drifted numbers vs the per-token sum. Now subtracts both; PerUserLedger.ledgerBalance docstring updated in lockstep.
- **pendingAdjustments hot-path LRANGE on every dashboard poll (R10-FG-11).** `/api/user/status` and `withUserLock` both called `redis.lrange(pendingLedgerList, 0, -1)` per request. With cluster-wide pending volume in the hundreds, LRANGE+JSON-parse cost dominated the dashboard hot path. LLEN short-circuit added at all three call sites: empty-queue case (the common case in production where pending entries live for at most a few hours) now returns after one cheap LLEN round-trip. Full per-user sharding deferred — current volume is far from any Redis cap; if R13 surfaces it as load-bearing, follow up.

### Architecture (load-bearing invariants enforced going forward)

These four are the new contracts. Future contributors who break them either hit a `tsc` error, a runtime test failure, or both. Documented in CLAUDE.md "Multi-User Security Rules" 14-17.

- **Store cache is read-only at the boundary.** `IStore.getUser*` returns `Readonly<UserAccount>`; `IStore.getOperator()` returns `Readonly<OperatorState>`; `IStore.getAllUsers()` returns `ReadonlyArray<Readonly<UserAccount>>`. Mutations route through `updateBalance(updater)`, `updateOperator(updater)`, or `saveUser(freshObject)` — never by direct property assignment on a returned reference.
- **pendingLedger drain anchors BEFORE mutation.** Order is load-bearing: SISMEMBER → SADD anchor → updateBalance → updateOperator → flush → LREM. The order is documented inline in `pendingLedger.ts` and asserted by `r10-fg-1-behavioral.test.ts`.
- **All balance-bearing routes call `composeBalanceResponse`.** `/api/user/status`, `/api/user/check-deposits`, `/api/user/play`, `/api/user/withdraw` MUST use the shared `app/api/_lib/composeBalances.ts` helper. The dashboard's merge-back paths assume the wire shape is uniform across routes; raw `user.balances` returns from any route reintroduce the phantom-funds view.
- **parseRefund returns a discriminated tagged union.** `NormalizedRefundEvent | ParseRefundFailure` where `ParseRefundFailure` carries a `reason` enum. The dispatcher uses an exhaustive switch with a `never` exhaustiveness check. Adding a new failure mode without a corresponding dispatcher case is a TypeScript compile error.

### Process / discipline (audit-coverage manifest infrastructure)

- **`src/__tests__/audit-coverage.json`** — the ratchet manifest, one entry per locked fix. Schema validated via Zod; entries require non-empty `tests` array (R12-FG-5 closure of the `structural-gate` loophole).
- **`audit-coverage.test.ts`** — gate suite enforcing: file-existence on linked tests, revert-proof annotation cross-reference (R4-0 discipline), placebo gate (R10-FG-4: `individual` strategy must have ≥1 test), structural-gate fixture allowlist (R12-FG-5: `structural-gate` entries must link a recognized structural fixture).
- **`revert-proof.test.ts`** — per-file undocumented-block ratchet against a baseline. Forces every new test to declare what regression it locks via `// revert-proof:` or `// smoke-only:` annotations.
- **`sibling-archetype-gate.ts`** — regex-based source scan blocking sibling-class catch (`PostSubmitError` masquerading as `ReceiptUncertainError` siblings) and string-control-flow patterns (`.message.includes`).
- **`claim-archetype-gate.ts`** — regex gate blocking hand-rolled `redis.set(..., { nx: true })` outside approved files (must use `fencedClaim` primitive).

### Documentation

- Audit cycle (rounds 2-12, all dissection docs, all 24 R11+R12 persona reports) archived under `docs/archive/audit-runs/`. Pointer + retrospective rationale at `docs/archive/README.md` "audit-runs/" section.
- CLAUDE.md gains "Audit cycle status (closed at Phase-9.5, 2026-05-10)" section + Multi-User Security Rules 14-17 codifying the load-bearing invariants.
- `docs/archive/audit-runs/audit-cycle-dissection-2026-05-10.md` is the canonical retrospective — read this before kicking off any future audit work.

### Tests

- 521 → 748 total node tests (+227 across the cycle). 4 R10/R11/R12 behavioral tests + the audit-coverage gate suite + sibling/claim archetype gate fixtures + per-cluster regression tests. All green at HEAD.

### Where we should have stopped (the honest retrospective)

For anyone reading this changelog 12 months from now wondering why the audit cycle ran seven rounds:

- **R5 → R8 closed the real bugs.** Phase-1 through Phase-3 of the cycle (revert-proof annotations, audit-coverage manifest, sibling-archetype gate) shipped the structural primitives that broke the obvious failure modes (PostSubmitError sibling-miss, hand-rolled SET-NX claims, mutation-disguised-as-mutation). At R8 the codebase was in 9-load-bearing-bugs shape.
- **R9 → R10 was wild-goose-chase territory.** Each round's closures shipped new code that the next round's adversarial agents found new "issues" in — most of which were quality complaints, observability gaps, or comment-vs-code mismatches in fresh diffs. The audit-machinery was auditing itself; we mistook the framework's bias toward "always find more" for the codebase's bug rate.
- **The Phase-9 dissection (round 11) named the meta-pattern.** A four-category triage (`bug` / `error` / `quality` / `process`) made the wild-goose-chase visible. Applied retroactively, ~70% of R6-R10 findings would have triaged as non-bug; the cycle should have stopped at R8 with deferral notes for the rest.
- **R11 + R12 were mechanically necessary because Phase-9 closures had sibling-site scope creep.** The architectural primitives (Readonly migrations, tagged-union parsers, shared response helpers) are worth their LOC; the cluster-fix scope-creep that needed Phase-9.5 to clean up was preventable with stricter `git grep` discipline at fix time.
- **What we'd tell future-us:** if a round's findings split heavily toward error/quality/process and only 2-3 items triage as bug, declare victory and ship. The next round will find another 30 things. They will not be more bugs. The codebase has a structural floor — reaching it requires architectural extraction (separately-conformance-tested IStore + cross-Lambda primitives + audit reducer packages), not more audit rounds.

The cycle is closed. Future audits run on-demand against specific subsystems, not as 12-persona sweeps. See CLAUDE.md "Audit cycle status" for the standing posture.

## [0.3.4] - 2026-05-05

> Three-agent post-0.3.3 security audit (security + analyzer + debt-hunter
> in parallel) surfaced 15 fresh exposures the cross-Lambda concurrency
> work missed. Two were silently broken in the 0.3.3 release itself
> (Upstash auto-decode trap on `idempotency.ts` + `killswitch.ts`),
> defeating the very fix we just shipped. All 15 are closed in this
> release. Testnet only — no users affected.

### Fixed (CRITICAL — silently broken in 0.3.3)
- **`withIdempotency` was returning `kind: 'in-flight'` instead of `'duplicate'`** because Upstash REST auto-decodes JSON values and `JSON.parse(<object>)` threw `SyntaxError`. Caught by inner catch, downgraded to in-flight. **Defeated the withdrawal-replay-protection contract this file was added for in 0.3.3.** Fix: `typeof raw === 'string' ? JSON.parse(raw) : raw` guard, matching the pattern used in 8 other call sites.
- **`getKillSwitchState` was dropping operator-set metadata** (`reason`, `enabledAt`, `enabledBy`) for the same reason. Engaged kill switches showed only the generic "agent temporarily closed" toast in the dashboard. Same one-line fix.

### Fixed (HIGH security)
- **Session token accepted via `?key=` query string.** Tokens in URLs leak via browser history, OS clipboard managers, screenshare, server access logs, Referer header. Locked-session tokens become permanent attacker control once the URL leaks anywhere. `src/auth/middleware.ts:extractToken` no longer reads the query param. The dashboard's "Copy Connection URL" surface is split into separate URL + token copy fields with explicit "use as Authorization Bearer" guidance. The Claude Desktop JSON config block (already used Bearer) is unchanged.
- **EOA-based register dedup leaked foreign user records.** Authenticated user-tier caller could submit a victim's accountId as `body.eoaAddress`; the downstream EOA-dedup returned the victim's full UserAccount (userId + depositMemo). `app/api/user/register/route.ts` now rejects any `eoaAddress` that doesn't match `auth.accountId` with 403.
- **Strategy update bypassed `withUserLock` — same lost-update class as `creditDeposit` pre-fix.** Strategy save wrote the FULL user object, silently overwriting concurrent deposit-credit updates from another Lambda. `app/api/user/strategy/route.ts` now wraps in `withUserLock`.
- **Play session could settle balances without on-chain audit trail.** When BOTH the v2 close write AND the abort marker fall-back failed, the session was settled locally with no HCS-20 marker. External auditors saw a phantom over-balance. Now dead-letters with new `kind: 'audit_trail_orphaned'` so the admin dashboard surfaces it for manual replay.
- **`HEDERA_NETWORK` silent fallback to `'testnet'` (pre-mainnet hazard).** Both `src/auth/redis.ts:NET` and `src/custodial/RedisStore.ts:NET` captured `process.env.HEDERA_NETWORK ?? 'testnet'` at module-load time as a frozen module constant. A mainnet deploy without the env would have silently read/written the testnet Redis namespace. `assertProductionRedis` now hard-fails with `PRODUCTION_NETWORK_REQUIRED` if `HEDERA_NETWORK ∉ {'mainnet','testnet'}` in production.

### Fixed (MEDIUM)
- **`X-RateLimit-Identity` response header leaked 16 chars of session token** on every MCP response — deterministic deanonymization to anyone capturing a response (proxies, browser devtools captured in support transcripts, edge-logged response headers). Header removed entirely. UAT diagnostics use Redis state directly.
- **Audit memo substring match exposed foreign HCS-20 entries.** `memo.includes(accountId)` matched short account ids against longer-suffix accounts (`0.0.12345` against `0.0.123456`). Replaced with word-boundary regex `(^|[^0-9.])<id>([^0-9]|$)`.
- **Withdraw amount validation accepted NaN / Infinity.** `typeof body.amount !== 'number' || body.amount <= 0` passed both. Reached the Hedera SDK and threw — reliable DoS that bypassed the velocity cap. Now `Number.isFinite + > 0 + < 1e9`.
- **Challenge message lacked domain binding (phishing pattern).** Signed text was identical across deployments — a malicious clone running this code could trick a user into signing a structurally-valid challenge. Now includes `Audience: ${AUTH_PAGE_ORIGIN}` so signed text differs per deployment.
- **`agentSeq` mirror-scan failure seeded at -1**, so the next INCR returned 0 — duplicating any existing agentSeq on a topic with months of valid data, marking the session as `corrupt` in the reader. Now retries 3 times with backoff (200ms/1s/3s); on terminal failure, agent is flagged seed-failed and `nextAgentSeq` throws `AGENT_SEQ_SEED_FAILED` so `playForUser` dead-letters via the new `audit_trail_orphaned` kind instead of writing a duplicate.
- **DepositWatcher dead-letters had no operator replay path.** New `POST /api/admin/replay-deposit` (admin-tier) fetches a tx from mirror node and re-runs it through `DepositWatcher.processTransaction`, bypassing the watermark. `creditDeposit`'s atomic SADD claim guarantees no double-credit even if the tx was already processed via a parallel path.
- **HCS message size cap missing in `NegotiationHandler.sendToUser`.** Notifications with long error strings could silently fail at the HCS layer. New `enforceTopicMessageSizeLimit()` helper in `hcs20-v2.ts` is now the single source of truth — used by `submitMessage`, `submitV2Message`, AND `sendToUser`.
- **`refund.ts` had no unit tests** despite being recently modified. New `src/hedera/refund.test.ts` covers the SET-NX-EX claim semantics, claim DEL on pre-transfer failure, post-transfer marker overwrite, and the `isDepositCredited` deposit-validation gate. Full processRefund integration test (with Hedera SDK + mirror-node mocks) is tracked as follow-up.

### Added
- `src/lib/idempotency.test.ts` — Upstash auto-decode regression tests with mock that mimics REST auto-decode behaviour.
- `src/lib/killswitch.test.ts` — same.
- `src/auth/challenge.ts:getAudience()` — sources `AUTH_PAGE_ORIGIN` for the audience-binding field.
- `IStore.DeadLetterEntry.kind` extended with `'audit_trail_orphaned'`.
- `MultiUserAgent.getDepositWatcher()` exposes the watcher for the admin replay route.
- `DepositWatcher.processTransaction` changed from `private` to `public`.

### Changed
- `extractToken` no longer accepts `?key=` query string; the dashboard `CompleteView` shows URL + token in separate copy fields; existing extractToken `?key=` test FLIPPED to assert it's IGNORED (regression marker).

### Tests
- 478 → 521 total node tests (+13 in 0.3.4 across idempotency, killswitch, refund, audience binding, HEDERA_NETWORK assertion). 118 vitest unchanged. All green.

## [0.3.3] - 2026-05-04

> Adversarial audit follow-up: the initial five fixes (dead-letter,
> refund TOCTOU, agentSeq, refund stale-cache, operator locks)
> closed the most visible exposures, but a deeper sweep found
> additional double-X surfaces that have all been folded into this
> release. The complete 0.3.3 fix set is below.

### Fixed
- **Play-route lock-vs-flush ordering — could cause double-spend on play.** The route released the user lock in its inner `try/finally` while `withStore`'s outer-finally ran `flush()` AFTER the inner returned. Order: release → outer-flush. The next acquirer could land between "release" and "outer-flush" with our writes still in `RedisStore.pending[]`. Combined with stale local cache on a different Lambda, two plays for the same user could lost-update on `user.balances`. Fixed by new `withUserLock(store, userId, fn)` helper that wraps acquire-refresh-drain-execute-flush-release. Same helper applied to play, withdraw, recovery (execute path), and the multi-user MCP tools.
- **Refund-then-X drift via pendingLedger drain timing — refund-then-withdraw double-spend window.** When `processRefund` couldn't acquire the user lock (because a play was in flight), it queued a debit to `pendingLedger`. Drain only ran on the hourly reconcile cron — leaving an up-to-1-hour window where the user could withdraw the refunded funds again. Fixed via new `applyPendingLedgerForUser` helper called inside `withUserLock` so refund-queued debits land before the lock holder reads `user.balances`.
- **`creditDeposit` had no per-user lock — lost-update with refund / play / withdraw.** Deposit watcher's `creditDeposit` mutated `user.balances` via `store.updateBalance` without holding the per-user lock. Refund / play / withdraw all DO hold the lock. Cross-Lambda: deposit watcher reads `{available: 100}` locally while another Lambda's lock-protected refund debits 50 → writes `{available: 50}` → releases lock. Deposit watcher then writes `{available: 200}` (its stale +100 mutation), obliterating the refund debit. Lost-update double-credit. Fixed by `creditDeposit` acquiring the same per-user lock with backoff [0, 50, 100, 200, 500, 1000, 2000, 3000]ms (~6.85s total); on failure releases the tx claim and throws → `DepositWatcher` dead-letters → next poll retries.
- **Withdrawal request-level idempotency missing — lost-response retry caused double-withdrawal.** Per-user lock prevented simultaneous withdrawals but not sequential retries. Client posts withdrawal, response packet drops (cold timeout, network blip), client retries same body, both calls execute. Fixed via new `Idempotency-Key` header support: `SET NX EX` claim on `idem:withdraw:{userId}:{key}` before the lock; duplicate retries get the cached result back (with `X-Idempotent-Replayed: true` response header) instead of executing a second on-chain transfer. Header is OPTIONAL for backwards compat.
- **Velocity cap failed OPEN on transient Redis errors — cap bypass surface.** `MultiUserAgent.checkWithdrawalVelocity` returned `cap` (full allowance) on a Redis throw. Single 50ms hiccup between the route's `assertRedisHealthy()` and the velocity check disabled the daily cap for that one withdrawal. Combined with a compromised session and rapid retries, attacker could blast through the cap on every Redis blip. Now throws `velocity_check_unavailable` on Redis error; route maps to 503 `redis_degraded`.
- **CLI `recover-stuck-prizes.ts` had no recovery lock.** Two operator CLI invocations on the same target account could double-execute the contract call (idempotent at chain level, but writes duplicate `prize_recovery` op to HCS-20 audit). Now holds `acquireUserLock(\`recover-cli:\${userAccountId}\`, 300)` across the contract call + audit write.
- **`app/api/admin/reconcile/route.ts` was the only mutating route not wrapped in `withStore`.** Bypassed the production-Redis preflight (F3) — a misconfigured production deploy could let reconcile run with the in-memory store fallback. Now wrapped, parity with every other admin route.
- **Operator-fee withdrawal stale-read.** `operatorWithdrawFees` acquired the operator lock but read `getOperator()` from local cache — could miss recent rake credits from another Lambda's deposit, causing under-withdrawal. Now `await store.refreshOperator()` inside the lock so the balance read is always current.
- **`RedisStore.load()` partial-failure cache poison guard.** `load()` cleared all caches and then ran 11 sequential Redis awaits. A mid-flight throw left the instance half-populated. Today's call path via `createStore()` discards the instance on rejection so the state isn't reachable, but defense-in-depth: wrap the body in try/catch with re-clear on failure so post-failure state is definitely empty.
- **Dashboard wires `Idempotency-Key` header on withdraw.** `app/dashboard/page.tsx:confirmWithdraw` now generates a fresh UUID per submit click. Closes the user-facing double-withdrawal exposure that the server-side `withIdempotency` primitive (above) was designed to fix.
- **Dead-letter resolution silently double-wrote rows.** `RecordDeadLetter` was an append, not the upsert the recovery path's comment claimed. Two operators (or one operator from two tabs) running `operator_recover_stuck_prizes` concurrently both passed the `!resolvedAt` filter against their independent local caches and both attempted recovery. Fixed by: (a) replacing `recordDeadLetter` with a genuine `upsertDeadLetter` keyed by `transactionId` (RedisStore: per-id key + LREM-then-RPUSH on the index list), (b) wrapping the recovery MCP tool's execute path in `acquireUserLock(userId, 300)` — the same per-user lock used by play and withdraw. See `docs/incident-playbook.md` Symptom 12.
- **Refund replay protection had a multi-second TOCTOU window.** Pre-fix pattern was GET-then-SET around the on-chain refund: `redis.get(refundLockKey)` → mirror-node lookup → on-chain transfer → `redis.set(refundLockKey, refundTxId)`. Two admin clicks landing on different Lambdas both read null and both executed the refund. Fixed by atomic `SET refundLockKey 'pending' NX EX 30d` BEFORE the transfer; overwrite with `refundTxId` on success; `DEL` on pre-transfer failure so retries are immediate (the pre-fix path also lacked release-on-failure, leaving a 30-day stuck marker on transient errors). See `docs/incident-playbook.md` Symptom 13.
- **Refund deposit-validation rejected legitimate refunds on cache-cold Lambdas.** `refund.ts:100` called `isTransactionProcessed` (local-cache) instead of consulting Redis. A Lambda whose cache was empty at startup would refuse to refund a recently-credited deposit until its cache hydrated. Now uses `await isDepositCredited` which falls back to Redis `SISMEMBER` and backfills the local cache on hit.
- **HCS-20 `agentSeq` was per-Lambda-process, not per-agent.** `AccountingService` held `agentSeq` as a private numeric field. Two warm Lambdas writing v2 messages for different users (per-user lock doesn't serialise across users) both called `nextAgentSeq()` from their independent counters and emitted duplicate sequence numbers. Schema doc + CLAUDE.md state "monotonic per-agent counter" — code now matches the spec via Redis `INCR` on `agentSeq:{accountId}`. Cold-start seeding via `SETNX` is idempotent across racing Lambdas. See `docs/incident-playbook.md` Symptom 14.
- **Operator-level admin operations had no operator lock.** Two concurrent `reconcile` runs (cron + admin click, or two admin clicks) walked the same state and could write conflicting outputs. `migrate-schema` was similarly unprotected. Both now wrap in `acquireOperatorLock` (5 min TTL for reconcile, 10 min for migrate-schema). The cron path skips silently with `{ skipped: true }` on lock contention so a benign race doesn't page an operator.

### Added
- **`src/lib/locks.ts:withUserLock(store, userId, fn)`** — higher-level helper around `acquireUserLock` that closes three exposures the raw acquire/release pair leaves open: stale local cache (await `refreshUser`), pending-ledger drift (await `applyPendingLedgerForUser`), lock release before flush completes (await `flush` before release).
- **`src/custodial/pendingLedger.ts:applyPendingLedgerForUser`** — single-user variant of the queue drain that assumes the caller already holds the lock. Used inside `withUserLock` so refund-queued debits apply on every lock acquire, not just on hourly cron.
- **`src/lib/idempotency.ts:withIdempotency(scope, key, fn)`** — request-level replay protection via `SET NX EX` claim. Wired into the withdraw route via the `Idempotency-Key` header.
- `IStore.isDepositCredited(txId)` — async, cross-Lambda hard check via Redis `SISMEMBER` on RedisStore. Replaces the unsafe `isTransactionProcessed` for correctness-critical reads. The sync method is retained as a soft cache for the deposit watcher's pre-loop short-circuit.
- `IStore.upsertDeadLetter(entry)` — async, genuine upsert by `transactionId`. Replaces `recordDeadLetter` (which was incorrectly named — it was an append).
- `IStore.seedAgentSeq(agentAccountId, value)` + `IStore.nextAgentSeq(agentAccountId)` — cross-Lambda monotonic counter via SETNX (seed) + INCR (claim) on RedisStore; in-memory Map on PersistentStore.
- `AccountingService` constructor accepts a `store` parameter and routes `agentSeq` through it. Without a store the service falls back to a per-process counter and logs a one-time warning so the unsafe path is visible.
- **`docs/concurrency-invariants.md`** — canonical doc explaining the bug class, the three primitives (SADD claim, SET NX EX, INCR), and a table of live invariants with their source files. Required reading before adding any new shared-state read to the custodial layer.
- **`src/custodial/concurrency-invariants.test.ts`** — single home for cross-Lambda concurrency regression tests. Each invariant in the doc has a test here. The pattern: shared mock Redis state, two store instances, `Promise.all([...])`, assert on outcome. Adding a new shared-state read requires a new test here.
- `docs/incident-playbook.md` Symptoms 12 (dead-letter double-resolution), 13 (refund double-execution / 30-day block), 14 (agentSeq duplicates) with cause / fix / diagnosis / reconciliation sections.
- CLAUDE.md Multi-User Security Rule #13 documenting the cross-Lambda dedup contract.

### Changed
- `recordDeadLetter` removed from the `IStore` interface and both implementations. Five callsites migrated to `await upsertDeadLetter`.
- `IStore.isTransactionProcessed` now explicitly documented as cache-only and unsafe for cross-Lambda dedup; only safe uses are the deposit watcher's pre-loop short-circuit and any path where a downstream atomic check catches the race.

### Tests
- 30 new tests across this release: 13 in `RedisStore.test.ts` + 6 in `PersistentStore.test.ts` (IStore primitive semantics), 11 in the new `concurrency-invariants.test.ts` (cross-Lambda invariants — deposit credit, agentSeq, refund replay, dead-letter upsert, withUserLock contract, creditDeposit lock guard, withdrawal idempotency). 478 → 508 total node tests, 118 vitest unchanged. All green.

## [0.3.2] - 2026-05-04

### Fixed
- **Cross-Lambda deposit-credit race (duplicate HCS-20 ops).** `RedisStore.isTransactionProcessed()` previously read only an in-process `Set`, so two warm Vercel Lambdas holding independent caches could each see "not processed" for the same on-chain deposit tx and both call `creditDeposit`, doubling the user's credited balance and writing two `deposit` + two `rake` ops to the HCS-20 audit topic. Observed on testnet 2026-05-04 against a fresh user where the dashboard's `check-deposits` background refresh raced with the play route's pre-play poll. Fix: `UserLedger.creditDeposit` now routes through a new `IStore.tryClaimTransaction(txId)` method backed by Redis `SADD` (atomic across all Lambdas) — the first caller wins, the rest short-circuit. The pre-fix `isTransactionProcessed` is kept for the deposit-watcher's pre-loop short-circuit and the refund flow's deposit-only validation, but is now documented as soft-cache-only and unsafe for cross-Lambda dedup. See `docs/incident-playbook.md` Symptom 11.

### Added
- `IStore.tryClaimTransaction(txId)` — atomic claim. `RedisStore` implements via `SADD` (returns true iff newly added across all instances); `PersistentStore` via the in-process `Set` (single-process, set IS the source of truth).
- `IStore.releaseTransactionClaim(txId)` — rollback path. Called from `creditDeposit`'s catch block when the credit fails BEFORE the deposit record is written, so a retry can pick up the same txId. After `recordDeposit` writes the row, the claim is intentionally NOT released (partial state is the lesser evil vs. a possible double-credit on retry).
- 10 new regression tests: `RedisStore.test.ts` (4 — single-instance claim, cross-Lambda race with shared mock Redis, local fast-path skip, release-and-reclaim), `PersistentStore.test.ts` (3 — claim, release, in-process race), `UserLedger.test.ts` (3 — concurrent same-txId, pre-record failure releases claim, post-record failure keeps claim).

## [0.3.1] - 2026-05-04

### Changed
- MCP client uses the dApp's canonical `lotto_*` tool names (Phase 1 of the v3 envelope). The seven read tools (`lotto_list_pools`, `lotto_get_pool`, `lotto_get_user_state`, `lotto_calculate_ev`, `lotto_get_system_info`, `lotto_check_prerequisites`, `lotto_roll`) and the buy-side split (`lotto_buy_entries` / `lotto_buy_and_roll` / `lotto_buy_and_redeem`) replace the legacy `lazylotto_*` names. The dApp's alias map keeps the old names working during the deprecation window; the agent now calls the new names directly so deprecation warnings stop firing on the dApp side.
- `buyEntries` is now a dispatch wrapper: callers still pass `action: 'buy' | 'buy_and_roll' | 'buy_and_redeem'`, internally routed to the matching dedicated tool. Public signature preserved so `LottoAgent` is unchanged.
- MCP client sends `X-MCP-Intent-Mode: autonomous`, opting into the dApp's autonomous intent mode so the dApp skips the Redis intent-record write and omits `executeUrl`. The agent never used `executeUrl` (we sign and submit via Hedera SDK), so this is a soft optimisation on the dApp side with no agent-side behaviour change.

### Added
- `IntentResponse` extended with five optional v3 envelope fields (`mcpSchemaVersion`, `domain`, `kind`, `intentMode`, `signature`) and exported `IntentDomain` / `IntentMode` types. Pure type additions — runtime ignores them. The HMAC `signature` is exposed for inspection only; we do not verify (the dApp's signing key is theirs, not ours).
- `BUY_TOOL_BY_ACTION` dispatch table exported from `src/mcp/client.ts` with a regression test in `src/mcp/client.test.ts` to lock the action → tool name mapping.

### Fixed
- `src/auth/auth.test.ts`: ten pre-existing `tsc --noEmit` errors caused by `next/types/global.d.ts` declaring `process.env.NODE_ENV` as `readonly`. The `assertProductionRedis` describe block now casts `process.env` once to a mutable `Record<string, string | undefined>`. Same runtime behaviour; full suite still 464 / 464 green.

### Documentation
- README and `docs/getting-started.md` note the dApp v3 envelope alignment, the canonical `lotto_*` tool family, and the `X-MCP-Intent-Mode: autonomous` header.

## [0.3.0] - 2026-05-03

### Added
- Wallet-bound operator tier via `OPERATOR_ACCOUNTS` env. Wallet signature is the only path to any privileged tier on hosted deployments.
- Canonical MCP tool-name list (`src/mcp/tool-names.ts`) shared by both MCP and A2A surfaces and the parity smoke test, preventing skill drift by construction.
- A2A skill entry for `multi_user_set_strategy`.
- Production-Redis preflight: `NODE_ENV=production` without Upstash credentials returns `PRODUCTION_REDIS_REQUIRED` 503 from every API route.
- Redis health circuit breaker (`src/lib/redisHealth.ts`): three failures in 60s opens; write-path routes return `redis_degraded` 503 until a successful Redis op closes the breaker. Reads continue throughout.
- `/api/health` exposes backend mode (`redis: 'upstash' | 'memory'`), kill-switch state, and version.
- Constant-time SHA-256 compare for `CRON_SECRET`.
- Slack/Discord mrkdwn escape on the reconcile failure webhook.
- HCS-20 v1 message size cap (1024 bytes), at parity with v2.
- Operator key-compromise runbook (`docs/incident-playbook.md` Symptom 8) with sub-30-min wall-clock target.
- `redis_degraded` 503 diagnostics (`docs/incident-playbook.md` Symptom 9).
- Engineering blog at `docs/blog/`: `lazy-wins.md`, `trust-by-design.md`, `architecture-deep-dive.md`.
- `PLAYERS.md` (player-friendly guide) and `FEATURES.md` (feature breakdown by audience).
- 41 new tests covering per-token reservation, lock-contract serialization, identity-keying spoof resistance, mrkdwn escape, circuit-breaker transitions, production-Redis preflight, and wallet-tier resolution.

### Changed
- `MCP_AUTH_TOKEN` scoped to single-user CLI / stdio deployments only; multi-user mode ignores it.
- All mutating API routes wrapped in `withStore` for uniform production-Redis preflight and error shape.
- `docs/` reorganized: bootstrap design and PRDs archived; redundant guides removed; the dApp-side `MCP_SERVER.md` reference moved to `docs/archive/MCP_SERVER_DAPP.md`.
- README, CLAUDE.md, and blog posts rewritten in present-tense design-statement voice for external readers.

### Security
- Withdrawal velocity-cap lock-scope invariant documented and tested in `src/lib/locks.test.ts`.
- Vercel edge-set `x-forwarded-for[0]` confirmed as the rate-limit identity source; body fields cannot enter the key.

### Documentation
- KMS-backed signing positioned as a single forward-looking enhancement with usage-driven triggers: monthly review and 50,000 HBAR AUM operator-wallet threshold.
- "Production guarantees" section in README: the hosted contract in three lines.
- Self-host call-outs added to README, PLAYERS.md, and the trust-by-design and lazy-wins blog posts.

### Tests
- 464 node-runner tests + 118 vitest tests = 582 total, all green.

## [0.1.0] - 2026-04-01

### Added
- Core 6-phase play loop: preflight, discover, evaluate, play, transfer, report
- Single-user mode with own funded Hedera wallet
- Multi-user custodial mode with deposit tracking, per-user balances, and rake fees
- MCP server with 19 tools for Claude Desktop integration
- MCP client with response mapping layer for LazyLotto dApp
- Interactive setup wizard (`--wizard`)
- Comprehensive audit report (`--audit`)
- Per-token budget management with USD cap support
- Reserve-before-spend pattern for financial safety
- HCS-20 on-chain accounting for multi-user mode
- HOL registry integration (HCS-11 agent profile)
- LazyDelegateRegistry queries for win rate boost
- Token alias system ("lazy" resolves to LAZY_TOKEN_ID from env)
- PersistentStore with atomic writes, dirty tracking, debounced flush
- Three built-in strategies: conservative, balanced, aggressive
- Dry-run mode, export-history, scheduled play via cron
- Strategy validation via Zod schema (v0.2)
- Price oracle (mirror node HBAR/USD + SaucerSwap token/HBAR)

### Security
- MCP auth token required for all fund-moving tools
- Auth enforced on all tools in multi-user mode
- Timing-safe token comparison to prevent side-channel attacks
- Transaction receipt status validation (revert detection)
- OWNER_EOA format validation at startup
- Strategy fallback requires --force for play modes
