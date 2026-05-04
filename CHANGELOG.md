# Changelog

All notable changes to this project will be documented in this file.

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
