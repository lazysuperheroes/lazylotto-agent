# Security Remediation Plan

**Source audit:** `custodial-security-audit` workflow (`.claude/workflows/custodial-security-audit.js`) — an off-chain adversarial review of the custodial agent (multi-tenant fund accounting, auth/tier isolation, cross-Lambda concurrency, HCS-20 ledger integrity, x402 payments, security notifications).
**Audit run:** 2026-07-04 — 138 agents, 42 raw findings → 11 confirmed / 10 contested / 21 refuted by the 3-verifier gauntlet.
**Independent re-verification:** 2026-07-04 — all 19 reported findings re-checked against current code. **None fully refuted.** F1–F4 verified by hand; F5–F19 verified by four skeptical review passes. Two narrowed (F10, F19).

> ⚠️ These findings were derived by reading source, not by exploiting a live deployment. Before treating any as closed, land the fix **with a regression test** and confirm against the three pre-push gates (`npm test`, `npm run typecheck`, `npm run build:web`). F1 additionally depends on the trusted LazyLotto contract's `transferPendingPrizes(owner, MaxUint256)` semantics — re-validate against the live contract.

**How to use this doc:** each finding has a checkbox. Tick it only when the fix has shipped *and* a regression test locks it in. Workstreams are ordered by priority; findings inside a workstream touch adjacent code and should ship as one PR.

---

## Status at a glance

| # | Sev | Finding | Verdict | Reachable today? | Workstream |
|---|-----|---------|---------|------------------|------------|
| F1 | **High** | Cross-tenant prize sweep (`transferPendingPrizes(user, MaxUint256)`) | CONFIRMED (hand-verified) | **Yes — any user, no precondition** | B |
| F2 | **High** | Refund cross-Lambda lost-update (no `refreshUser` under lock) | CONFIRMED (hand-verified) | Yes — refund racing a play | A |
| F3 | **High** | Refund debits GROSS not NET → over-debit + false surplus | CONFIRMED (hand-verified) | Yes — user w/ same-token balance | A |
| F4 | **High** | x402 trusts client-echoed `payload.accepted` | CONFIRMED (hand-verified) | Only if `X402_ENABLED` (off by default) | E |
| F5 | Med | Serverless auth fails open to operator tier | CONFIRMED | Only non-Vercel host, `NODE_ENV≠production`, no auth cfg | C/E |
| F6 | Med | Rate-limit identity bypass (fake Bearer) | CONFIRMED | **Yes — unconditionally, incl. prod** | C |
| F7 | Med-High | No tier de-escalation; permanent locked sessions | CONFIRMED | Yes — no foreign-account revoke surface | C |
| F8 | **High** | agentSeq re-seed under-count → sequence reuse | CONFIRMED | On any Redis counter loss (DR event) | D |
| F9 | Med | `operator_withdraw_fees` arbitrary recipient | CONFIRMED | Admin cred + `OPERATOR_WITHDRAW_ADDRESS` unset | E |
| F10 | Low-Med | Prod guard keyed on `NODE_ENV` only | PARTIAL (narrowed) | Only when creds *also* absent — overlaps F5 | E |
| F11 | Low | x402 slippage floor declared, never implemented | CONFIRMED | Only if x402 enabled | E |
| F12 | Med | Prize-slim desyncs close `poolsRoot` → false `corrupt` | CONFIRMED | Prize-heavy pools (>~13 prizes) | D |
| F13 | Med-High | Empty `HCS20_TOPIC_ID` silently drops all audit writes | CONFIRMED (docstring promises a throw that never happens) | Topic-env misconfig | D/E |
| F14 | Low | check-deposits rate limit not identity-bound | CONFIRMED | Yes (bounded) | E |
| F15 | Low-Med | Refund rake reversal lacks `Math.max(0)` | CONFIRMED | Admin refund after fee sweep | A |
| F16 | Med | No reconcile dead-man's-switch | PARTIAL (external monitor documented, not minimum-viable) | Unset `CRON_SECRET`/paused cron | E |
| F17 | Med-High | Escalation claims dedup key before webhook delivery | CONFIRMED | Transient webhook failure | E |
| F18 | Low | `maxUserBalance` cap cross-Lambda TOCTOU | CONFIRMED (soft-limit only) | Concurrent deposits | E |
| F19 | Low | Eager pending-ledger drain fail-open | PARTIAL (trigger `processRefund` refuted; only verifier path queues) | Very narrow, self-healing | E |

**Recommended sequence:** P0 (A + B + F6) → P1 (C + D) → P2 (E, with F4+F11 as the hard gate before x402 is ever enabled).

---

## 🔴 Workstream A — Refund correctness (P0, one PR) — ✅ SHIPPED (branch `security/refund-correctness`, 2026-07-04)

All three live in `src/hedera/refund.ts` within ~15 lines of each other; fixed together with a conservation test. **Corner case found in implementation:** the fix also required `src/scripts/verify-audit.ts` — the DR reconstruction carried the *same* over-debit (`deposited - rake - refunded(gross)`), so it now adds back `totalRakeReversed` to stay consistent with the corrected Redis ledger (otherwise the Redis-vs-topic crosscheck would fire false discrepancies on every refunded user). Gates: 778/778 tests, typecheck clean, `build:web` green. Note: the *in-flight* `processRefund` happy path isn't unit-drivable (the fake client can't produce a successful on-chain receipt — pre-existing tech debt), so the conservation tests drive the symmetric verifier path; the in-flight net-debit is covered by typecheck + symmetry.

**Third-copy correction (found during Phase 2, 2026-07-04):** the admin force-release handler `app/api/admin/uncertain-tx/[id]/force-release/handlers.ts` is a THIRD copy of the refund ledger logic and carried the same F3 (gross debit) + F15 (unclamped reversal, no `totalRakeCollected`) bugs — now fixed to match the other two sites (net debit, `Math.max(0)`, `totalRakeCollected` reversal). Three pre-existing `test:web` failures in that route's tests (unrelated to any of this — the fixtures lacked `sender`/`hederaAccountId`, so the R4-FG-11 audit-anchor guard returned 400; proven pre-existing by stashing all my changes and re-running on the clean base) were repaired in passing. All four gates green: `npm test` 780, `typecheck`, `test:web` 143, `build:web`. **Lesson:** `test:web` (vitest, app/) is a de-facto FOURTH gate beyond CLAUDE.md's documented three — run it when touching `app/` or shared refund/ledger code.

- [x] **F2 — Refund cross-Lambda lost update.** *(shipped: `refreshUser?.`/`refreshOperator?.` under the lock, in-flight + verifier)*
  **Evidence:** `processRefund` acquires the outer lock at `refund.ts:206` but never `refreshUser`. `getUser` (`refund.ts:234`, `:900`) is a pure in-process cache read (`RedisStore.ts:510-512`); `updateBalance` (`refund.ts:927`) write-throughs the *whole* cached user object (`RedisStore.ts:553-562`) without re-reading Redis. A warm-Lambda refund thus overwrites a concurrently-committed play settlement. `withUserLock` (`locks.ts:172`) and `creditDeposit` (`UserLedger.ts:116`) both `refreshUser` under the lock — this path is the outlier.
  **Fix:** add `await options.store.refreshUser(depositRecord.userId)` (and `refreshOperator()` before the rake reversal) immediately after the lock at `refund.ts:206`, before the F7 guard read — or route the guard-and-debit through `withUserLock` (refreshes + drains pending-ledger + flushes before release). Apply identically to the reconcile-verifier path (`refund.ts:1623`/`:1641`).
  **Test:** two-store-instance regression — a refund does not revert a concurrently-committed balance change.

- [x] **F3 — Refund debits GROSS instead of NET.** *(shipped: debit `depositRecord.netAmount` at the in-flight debit, verifier debit, and queued payload; verify-audit reconstruction adds back `totalRakeReversed`)*
  **Evidence:** at deposit, `creditDeposit` credits the user `available += netAmount` (`UserLedger.ts:134`) and the operator `balances += rakeAmount` (`UserLedger.ts:145`). On refund, the ledger debit is `available = max(0, available - humanRefundAmount)` (`refund.ts:930`) where `humanRefundAmount` = the on-chain deposit amount = **gross** (`refund.ts:599`/`:602`), *while* the operator rake is separately reversed (`refund.ts:946`). Net effect: internal liabilities drop by `net + 2·rake` for a `net + rake` on-chain outflow. Whenever the user holds same-token balance beyond this deposit's net, the extra `rake` is taken from their *other* funds; the direction is always a false surplus, so reconcile reads "solvent" and the tenant loss is invisible. (The single-deposit case is masked by the `max(0,…)` clamp.)
  **Fix:** debit `depositRecord.netAmount`, not `humanRefundAmount`, at `refund.ts:930`. Keep `humanRefundAmount` for the on-chain transfer + audit anchor only. Propagate `netAmount` to the verifier debit (`refund.ts:1650`), the `refund_uncertain` DL `details.humanAmount`, and the pending-ledger payload (`refund.ts:1699`).
  **Test:** for a user with `available > netAmount`, a refund reduces `available` by exactly `netAmount`, reverses exactly `rakeAmount` from the operator, and leaves `float == Σavailable + Σreserved + operator.balances`.

- [x] **F15 — Operator rake reversal lacks `Math.max(0)` floor.** *(shipped: `Math.max(0)` on both direct reversals + `totalRakeCollected` reversed for parity with the queued path)*
  **Evidence:** `refund.ts:946` (in-flight) and `refund.ts:1666` (verifier) compute `op.balances[token] - rakeAmount` with no lower bound; `pendingLedger.ts:330`/`:541` clamp the identical reversal. A refund after fees were withdrawn below a deposit's rake drives `operator.balances` negative.
  **Fix:** wrap both subtractions in `Math.max(0, …)`; reverse `totalRakeCollected` for parity; log/dead-letter when the clamp engages (it means rake was already withdrawn — a real operator debt).

---

## 🔴 Workstream B — Cross-tenant prize sweep (P0, architectural care) — ✅ SHIPPED (2026-07-04, Phase 3)

**Shipped:** `LottoAgent.transferAllPrizes` now REFUSES the sweep when `pendingPrizesCount > getCurrentWinCount()` (dropped the `> 0` gate that silenced the pure-theft case), returning a new `blocked` `PrizeTransferOutcome` variant (mirrored in `PrizeTransferOutcomeReport` + `mapPrizeTransferOutcome`). `MultiUserAgent` dead-letters it as the new `prize_transfer_blocked_contamination` kind (added to `IStore` DL union, escalation kinds, dead-letters triage rank) and pages via `escalateUncertainDlFailure` (F17, now reliable) if the DL write itself fails. `recoverStuckPrizesForUser` now resolves blocked-contamination DLs and logs a LOUD contamination warning when OTHER users have stranded prizes (defense-in-depth; not a hard refuse — the operator explicitly targets a user and can preview via dryRun). Regression tests: `src/agent/prize-sweep-guard.test.ts` (exported `isPrizeSweepContaminated` boundary, incl. the pure-theft case). All 4 gates green (npm test 784, typecheck, test:web 143, build:web).

**Residual (noted, not blocking):** (1) `pendingPrizesCount` is read from the mirror (~4s lag) — a stale-low read could momentarily let a contaminated sweep pass; the recovery-tool warning + reconcile cron are the backstop. (2) The recovery tool still can't SUBSET-transfer per user (contract is all-or-nothing MaxUint256) — contamination requires per-user operator judgement; a hard-refuse-with-force override is a possible future hardening. (3) The in-flight `transferAllPrizes` E2E (getUserState + contract mock) isn't unit-driven — same tech-debt class as processRefund in-flight; the decision boundary is covered by the extracted helper test.

- [x] **F1 — A play sweeps the shared wallet's entire pending-prize list to the current player.** *(SHIPPED — see Workstream B header above)*
  **Evidence:** in custodial mode all users share one agent wallet; won prizes accrue to its single flat pending list. `transferAllPrizes` (`LottoAgent.ts:814`) reads the shared wallet's total `pendingPrizesCount`, skips only when it is `0`, and calls `transferPendingPrizes(currentUserEOA, MaxUint256)` (`contracts.ts:195`) — reassigning **every** pending prize to whoever plays now. The only guard (`LottoAgent.ts:832-842`) is a non-blocking `console.warn` gated on `expectedFromThisSession > 0`, so it is silent exactly in the pure-theft case (attacker won 0). A prior user's stranded prize (a documented failure mode handled by `recoverStuckPrizesForUser`) is claimed by the next player.
  **Fix (refuse, don't shrink — a subset transfer is not possible via `MaxUint256`):** drop the `expectedFromThisSession > 0` gate; when `state.pendingPrizesCount > getCurrentWinCount()`, **do not transfer** — dead-letter (`prize_transfer_blocked_contamination`) + page the operator, leaving all prizes pending for recovery. Harden `recoverStuckPrizesForUser` (`MultiUserAgent.ts:2271`) to reconcile pending prizes against play history and assert ownership before sweeping.
  **Test:** a stranded prize from user A + a play by user B → transfer is blocked (not swept to B), DL written.
  **Note:** re-validate the `transferPendingPrizes(owner, MaxUint256)` semantics against the live LazyLotto contract before finalizing.

---

## 🟠 Workstream C — Auth hardening (P1)

- [x] **F6 — Rate-limit identity bypass on unauthenticated challenge/verify.** *(SHIPPED 2026-07-04, Phase 2: `ignoreBearer` option → IP-keyed `ipIdentity` (prefixed `ip:`) on the challenge + verify routes; cycling fake bearers can no longer fan out. Tests in `rateLimit.test.ts`.)*
  **Evidence:** `identityFor` returns `auth.slice(7,23)` (first 16 chars of the Bearer token) whenever any Authorization header is present, unvalidated (`rateLimit.ts:100-102`). `challenge/route.ts:28` and `verify/route.ts:27` are unauthenticated and pass no `identity` override, so an anonymous attacker cycling fake `Bearer sk_…N` gets a fresh bucket per token → unlimited attempts, defeating the mirror-node-DoS cap (10/5min) and the sig-guessing cap (5/5min).
  **Fix:** for pre-auth routes, key strictly on edge-set IP (ignore the Authorization header); prefix the identity (`ip:<xff>`) so it can't collide with a real token slice. Add an `ignoreBearer`/`preferIp` option to `checkRateLimit`. Update `rateLimit.test.ts` to assert IP bucketing on these routes.

- [x] **F7 — No tier de-escalation; locked sessions are permanent.** *(SHIPPED 2026-07-05, Workstream C: `resolveAuth` now re-resolves tier from env every request via `deEscalateTier` (extracted to SDK-free `src/auth/tiers.ts`), taking min(baked, current) — an offboarded operator drops to `user` immediately, even on a LOCKED session, without re-auth; never auto-escalates. New admin `POST /api/admin/revoke-sessions` force-kills all sessions for an account (leaked-token cutoff). Lock route now refuses admin/operator sessions (no permanent privileged credentials). Tests in `auth.test.ts`.)*
  **Evidence:** tier is baked at session creation (`verify.ts:170-176`) and returned verbatim by `resolveAuth` (`middleware.ts:44-53`) with no per-request re-resolution. `lockSession` sets `expiresAt=null` and re-SETs without TTL (`session.ts:98-103`) → a privileged credential with no expiry backstop. `revokeAllForAccount` fires only on the account's own re-auth (`verify.ts:173`); there is no admin endpoint to revoke another account's sessions. An offboarded operator's locked/leaked token keeps operator tier indefinitely.
  **Fix:** (1) in `resolveAuth`, re-resolve the tier from current env and take `min(stored, current)` so env removal de-escalates immediately (guard the synthetic `local`/`local-owner` accounts); (2) add an admin-tier `revoke-all-for-account` endpoint calling the existing `revokeAllForAccount(accountId)`; (3) forbid `lock` (no-TTL) for admin/operator sessions, or cap even locked privileged sessions with a max absolute lifetime.

- [x] **F5 — Serverless auth fails open to operator tier.** *(request-time half SHIPPED 2026-07-05, Workstream C: `requireAuthCheck` (app/api/_lib/mcp.ts) now REFUSES the no-auth-config operator fail-open whenever `MULTI_USER_ENABLED === 'true'`, independent of NODE_ENV — closes the unauthenticated-operator backdoor on hosted non-production deploys. The cold-start boot-assertion half still folds into Workstream E.)*
  **Evidence:** `requireAuthCheck` returns `{tier:'operator',accountId:'local'}` when no auth config is present (`mcp.ts:90-98`); the only backstop, `assertProductionRedis`, throws only when `NODE_ENV==='production'` (`redis.ts:266-267`). The CLI multi-user path hard-exits regardless of `NODE_ENV` (`server.ts:120-125`) — the serverless path has no equivalent. Reachable on a non-Vercel self-host with `NODE_ENV≠production` + no auth config.
  **Fix:** make the serverless bypass refuse operator tier when hosted/multi-user (gate it on an explicit `LOCAL_DEV`/`SINGLE_USER` flag, never inferred from config-absence on an HTTP surface), independent of `NODE_ENV`. Fold into the Workstream E boot assertion.

---

## 🟠 Workstream D — HCS-20 audit-trail integrity (P1)

The topic is the disaster-recovery source of truth; these three let it silently drift or self-condemn.

- [x] **F8 — agentSeq re-seed systematically under-counts → sequence reuse.** *(SHIPPED 2026-07-05, Workstream D: `initializeAgentSeq` now counts ANY message with a numeric `agentSeq` (dropped the `isFromUs` gate — the topic is single-writer, and only `play_session_open` carried an author, so the true max on the last pool/close was never seen). Raised `maxScan` 500→2000; refuses to seed `-1` when the scan hit its bound WITHOUT reaching the topic head (would reuse historical seqs → seed-failed path fires instead). Test in `AccountingService.test.ts`.)*
  **Evidence:** `initializeAgentSeq` reads `agentSeq` only on messages where `agent|from|performedBy === agentId` (`AccountingService.ts:742-751`). Only `play_session_open` carries an author field alongside `agentSeq` (`hcs20-schema.ts:193-194`); `play_pool_result`/`close`/`aborted` carry `agentSeq` but no author, so they are never counted — yet the max seq is always on a pool/close message. The scan recovers the open's seq (X); the next INCR returns X+1, an already-used seq → `agentSeqDuplicates` critical alert (`hcs20-reader.ts:1029-1047`). Worse: `maxScan=500` + early break (`:723`/`:758`) can leave the last open outside the window → seed `-1` → first INCR returns `0`. Trigger = any Redis counter loss (backup restore, LRU eviction, topic re-point, fresh deploy vs existing topic).
  **Fix:** the topic is single-writer, so drop the `isFromUs` gate for seq recovery — take max over any message with a numeric `agentSeq`, and break on the first one in desc order (it is the global max), which also immunizes against `maxScan`. Treat "scan completed on a non-empty topic but recovered nothing" as a seed **failure** (engage `agentSeqSeedFailed`) rather than seeding `-1`.

- [x] **F13 — Empty `HCS20_TOPIC_ID` silently drops every audit write.** *(SHIPPED 2026-07-05, Workstream D: `submitV2Message` now FAILS LOUD by default — throws on a missing topic instead of the silent no-op that contradicted its own docstring; callers' catch turns that into a visible `audit_trail_orphaned` dead-letter, not silent loss. The no-op is gated behind an explicit `HCS20_ACCOUNTING_OPTIONAL=true` opt-out (tests/dev). Test in `AccountingService.test.ts`. NOTE: the production boot-guard half (require `HCS20_TOPIC_ID` at cold-start) still folds into Workstream E.)*
  **Evidence:** `submitV2Message` (`AccountingService.ts:1265-1275`) and `submitMessage` (`:1302-1308`) `console.warn` and return when `topicId` is null — while `submitV2Message`'s own docstring (`:1253-1264`) explicitly claims it *throws* to distinguish "intentionally off" from "broken in production." `types.ts:258` turns an empty env into `null`; no boot guard requires the topic. Deposits/rake/plays/withdrawals mutate Redis while writing zero to the ledger; reconcile compares Redis vs on-chain **wallet** (not the topic), so the drift is invisible.
  **Fix:** restore the `throw` in `submitV2Message` when `topicId` is null; gate the intentional no-op behind an explicit `ACCOUNTING_DISABLED`/dev flag; add the production boot guard in Workstream E. (Exempt the `--deploy-accounting` bootstrap path.)

- [ ] **F12 — Prize-slim desyncs the close `poolsRoot` → legit sessions falsely marked `corrupt`.**
  **Evidence:** the writer computes `poolsRoot` over the **full** prize set (`MultiUserAgent.ts:1046-1059`), while each pool message is slimmed to top-10 prizes when >900 bytes (`AccountingService.ts:107-123`). The reader recomputes from the on-chain (slimmed) messages (`hcs20-reader.ts:1246-1299`); `canonicalizePrizesForHash` excludes `sym` but not dropped prizes (`hcs20-v2.ts:248-263`). So a prize-heavy pool (>~13 prizes) yields writer-root ≠ reader-root → `status='corrupt'` + under-reported `totalPrizeValue`, making the highest-value legit sessions indistinguishable from forged ones.
  **Fix:** compute the close `poolsRoot` over the **post-slim** prize sets — have `recordPlayPoolResult` return the actually-written prize array and feed those into `computePoolsRoot`. Ensure the reader distinguishes slim-truncation (expected) from a genuine mismatch.

---

## 🟡 Workstream E — Production boot-assertion, monitoring & x402 (P2; x402 sub-item is a hard gate)

- [ ] **Consolidated production boot guard** (closes the enforcement half of F5, F9, F13, F16, and F10).
  Extend `assertProductionRedis` to key on a **deploy-intent** signal (`VERCEL_ENV==='production'` / `HEDERA_NETWORK==='mainnet'` / explicit `REQUIRE_REDIS=1`) instead of `NODE_ENV`, and require in production: Upstash creds, `HCS20_TOPIC_ID` (F13), `OPERATOR_WITHDRAW_ADDRESS` (F9), `CRON_SECRET` (F16), and the operator/serverless auth config (F5).

- [ ] **F9 — `operator_withdraw_fees` arbitrary recipient.**
  **Evidence:** `requireOperator` only rejects `tier==='user'` (`operator.ts:36-40`), `to` is caller-controlled (`operator.ts:78`), and the recipient guard is a no-op when the env is unset: `if (allowedAddress && recipientAccountId !== allowedAddress)` (`MultiUserAgent.ts:1648-1654`). `withdraw-fees/route.ts:56-57` uses `envWithdrawAddr || body.to`; `userOps.ts:446-448` validates only the `0.0.X` format. No boot enforcement (only a CLI-only warn at `src/index.ts:173-179`).
  **Fix:** require `OPERATOR_WITHDRAW_ADDRESS` at boot (above) and reject any recipient that differs — the recipient must never be caller-controlled. Consider a `requireOperatorStrict` (reject anything below `operator`) for fund-moving tools, distinct from the admin-permitted `requireOperator` for read/ops tools (ties to F7).

- [ ] **F10 — Prod safety guard keyed solely on `NODE_ENV`.** *(narrowed — only bites when Upstash creds are also absent; overlaps F5)*
  **Evidence:** `getRedis` returns the real Upstash client whenever `url && token` are present, *before* the `NODE_ENV` check (`redis.ts:385-400`), so degradation to the in-memory Map requires creds to also be absent; `NODE_ENV` only decides whether cred-absence is fatal. `/api/health` already surfaces `redis:'memory'` when degraded (`health.ts:66`,`:99`).
  **Fix:** subsumed by the deploy-intent-signal change in the consolidated boot guard.

- [ ] **F16 — No dead-man's-switch for the reconcile cron.**
  **Evidence:** `isAuthorizedCron` fails closed (401) when `CRON_SECRET` is unset (`reconcile/helpers.ts:25-30`); boot requires the webhook but not the secret that drives it (`redis.ts:301-312`); no in-app `lastReconcileAt` watermark; `/api/health` does no solvency check (`health.ts:90-102`); the webhook fires only inside a successful run. An external monitor is documented (`docs/uptime-monitoring.md:119-129`) but is not in the minimum-viable checklist and is unenforced.
  **Fix:** add `CRON_SECRET` to the boot checks (above); write `lastReconcileAt` + `solvent` verdict to Redis on each successful reconcile and expose staleness in `/api/health` so the already-configured health monitor becomes a true dead-man's-switch.

- [x] **F17 — Escalation claims the dedup key before webhook delivery.** *(SHIPPED 2026-07-04, Phase 2 — pulled ahead of Workstream B: release the dedup claim on ANY delivery failure (network throw, timeout, OR non-2xx — added the `res.ok` check the finding required) so the next pass re-pages; only a durably-claimed key is released. Tests in `escalation.test.ts`.)*
  **Evidence:** `escalateUncertainDlFailure` claims a 6h `SET NX EX` dedup key (`escalation.ts:117-126`) then POSTs the webhook (`:190-196`); the catch only logs (`:197-206`) with no compensating `del`. A transient webhook failure on a one-shot critical page swallows it for 6h — during which a held reserve/claim can TTL-expire and double-spend.
  **Fix:** hoist `dedupKey` out of the claim `try` and `redis.del(dedupKey)` on POST failure so the next pass retries (lower-risk than claim-after-success, which re-opens the fail-open duplicate-page path the per-Lambda suppression Map already guards).

- [ ] **F4 — 🚫 x402 gate trusts client-echoed requirements.** *(hard gate: do NOT enable `X402_ENABLED` until fixed)*
  **Evidence:** `settleOrChallenge` sets `requirements = payload.accepted` (client echo) and passes it to `facilitator.verify`/`settle` and returns it as `paidRequirements` (`x402Gate.ts:62`,`:65`,`:73`,`:81`); the server-built `accepts` (`scheme.ts:64-107`) is used only to render the 402 and is never compared. A buyer submits `accepted.amount="1"` (or `payTo=self`) and gets a full-price rake holiday.
  **Fix:** after decoding, select the matching entry from the server's `accepts` by deep-match on `(scheme, network, asset, payTo)` and require `BigInt(payload.accepted.amount) >= BigInt(matchedServer.amount)`; assert `payload.x402Version === X402_VERSION` and network. Pass the **server-matched** `PaymentRequirements` into verify/settle — never the client echo.

- [ ] **F11 — 🚫 x402 slippage floor declared but never implemented.** *(hard gate with F4)*
  **Evidence:** `minAcceptedFraction` (default 0.97) is declared/loaded (`features.ts:62`,`:167`) and `scheme.ts:48-49` falsely comments that "the route applies the configured slippage tolerance on settlement," but it is read nowhere on the money path; `tinybarsToUsdCents` (`exchangeRate.ts:51`) is used only in its own test. The HBAR quote is locked once at request time (`scheme.ts:93`) with no settle-time floor.
  **Fix:** at settle, after matching the server requirement (F4), compute the paid amount's USD-cent value via `tinybarsToUsdCents` (HBAR) / base-unit math (USDC) and reject unless `>= priceUsdCents * minAcceptedFraction`. Correct the misleading `scheme.ts:49` comment.

- [ ] **F14 — check-deposits rate limit not identity-bound, runs before auth.**
  **Evidence:** `check-deposits/route.ts:40` calls `checkRateLimit` with no `identity` and before `requireTier` (`:44`), so it buckets on the 16-char Bearer prefix; a re-authenticated user gets a fresh 12/min bucket, and each admitted call runs an all-user mirror poll. Correct sibling: `replay-deposit/route.ts:42-53` binds `identity: auth.accountId`.
  **Fix:** move `checkRateLimit` after `requireTier` and pass `identity: auth.accountId`. Consider a short Redis-shared minimum interval on `pollDepositsOnce`.

- [ ] **F18 — `maxUserBalance` cap is a cross-Lambda TOCTOU.** *(soft-limit only — user's own funds, no cross-tenant movement, no double-credit)*
  **Decision (2026-07-04): FIX.** Cheap and idiomatic — it reuses the same check-and-mutate-in-the-updater pattern `reserve()` already uses, and it makes a policy the operator deliberately configured actually hold under concurrency. The racy outcome (own funds, invariant preserved) is borderline, but "the risk cap should hold" wins given the fix is a one-pattern application.
  **Evidence:** the cap is checked on a pre-lock cached snapshot (`DepositWatcher.ts:450`,`:521-523`); `creditDeposit` does no cap re-check under the lock. Two warm Lambdas processing two distinct-txId deposits for one user can both pass and both credit.
  **Fix:** re-check `available + grossAmount <= maxUserBalance` inside `creditDeposit`'s `updateBalance` callback after `refreshUser`; on breach, mirror the **existing** pre-lock behavior (release the tx claim and dead-letter — not a crash) so the failure mode is identical to today's, just race-safe.

- [ ] **F19 — Eager pending-ledger drain fail-open.** *(narrow — named trigger `processRefund` refuted; only the uncertain-refund verifier path can queue; self-healing)*
  **Decision (2026-07-04): ACCEPT the behavior; observability-only fix. Do NOT ship the fail-closed change.** `withUserLock` wraps every play and withdrawal, so failing closed on a transient `llen` blip is an availability regression across the hot path — a bad trade for a condition that needs a 4-way coincidence and self-heals on the next drain or the hourly reconcile. Fix the *silence*, not the fund path.
  **Evidence:** the eager drain in `withUserLock` is swallowed on error (`locks.ts:177-189`); `applyPendingLedgerForUser` treats a transient `llen` error as an empty queue (`pendingLedger.ts:197-198`). `processRefund` acquires the outer lock up front and **refuses** on contention rather than queuing (`refund.ts:206-213`) — only the uncertain-refund verifier queues (`refund.ts:1684-1704`), so the exploit's prerequisite state is rare and self-healing.
  **Fix (observability only):** stop collapsing the `llen`/`lrange` error into `0`/`[]` silently — retry the probe once or twice, and on persistent failure escalate/emit a metric (upgrade the `console.warn` at `locks.ts:184`) so a real occurrence is visible. Leave the fund-path behavior (proceed, heal on next drain) unchanged.

---

## Re-running the audit

After landing fixes, re-run the workflow to confirm closure and catch regressions:

```
# opt-in; ~dozens of agents, significant token spend
use a workflow: custodial-security-audit
```

The workflow lives at `.claude/workflows/custodial-security-audit.js` (local-only; `.claude/` is gitignored). It targets this repo by default.
