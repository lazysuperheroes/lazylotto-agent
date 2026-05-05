# Changelog

All notable changes to this project will be documented in this file.

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
