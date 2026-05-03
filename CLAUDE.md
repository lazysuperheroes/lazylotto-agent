# CLAUDE.md — LazyLotto Agent

## Project Overview

Autonomous AI agent that plays the LazyLotto lottery on Hedera. Three deployment modes:
- **Single-user local**: Agent plays with its own funded wallet on behalf of one owner
- **Multi-user local**: Operator runs CLI managing multiple users' deposits, plays, and withdrawals
- **Multi-user hosted** (primary): Deployed to Vercel, users connect via MCP or web dashboard

## Deployment URLs

- **Testnet agent**: https://testnet-agent.lazysuperheroes.com
- **Testnet dApp MCP**: https://testnet-dapp.lazysuperheroes.com/api/mcp
- **Mainnet dApp MCP**: https://dapp.lazysuperheroes.com/api/mcp

## Architecture

- **Reads**: Via MCP client connected to LazyLotto dApp endpoint (pool data, EV, user state)
- **Writes**: Direct Hedera SDK contract calls (agent signs all transactions)
- **Wallet**: Agent holds its own Hedera account with private key in env
- **Strategy**: Versioned JSON files define play behavior, budget, and risk tolerance
- **Accounting**: HCS-20 v2 immutable on-chain ledger with per-pool play_session_open/play_pool_result/play_session_close sequence. Self-sufficient — external auditors can reconstruct from the topic alone. v1 batch messages still parse via the reader's dual-shape fallback for legacy testnet sessions. See `docs/hcs20-v2-schema.md` for the wire spec.
- **Auth**: Hedera signature challenge-response, session tokens in Upstash Redis (or in-memory fallback)
- **Agent surfaces**: TWO protocols, ONE codepath.
  - **MCP server** at `/api/mcp` (and stdio for Claude Desktop) — JSON-RPC 2.0 with `WebStandardStreamableHTTPServerTransport`. Primary surface; all tool handlers live here.
  - **A2A server** at `POST /api/a2a` (JSON-RPC 2.0 `message/send` only — synchronous) and `GET /.well-known/agent-card.json` for discovery. The A2A route is a thin adapter that re-issues each skill call as a `tools/call` against the local MCP endpoint, so parity is by construction. Skills map 1:1 to MCP tool names. Streaming + persisted tasks deliberately out of scope (Phase 1).
- **HTTP Transport**: Dual mode — stdio for Claude Desktop, HTTP/serverless for Vercel
- **Frontend**: Next.js 16 app with WalletConnect auth page, user dashboard, admin dashboard, audit page with SessionCard aggregation
- **Persistence**: RedisStore (Vercel/production) or PersistentStore (local dev, JSON files)
- **Discovery**: HOL HCS-11 profile + `/api/discover` (human/operator-facing) + `/.well-known/agent-card.json` (A2A spec)
- **Monitoring**: Hourly reconcile cron at `/api/cron/reconcile` (CRON_SECRET auth, optional webhook on insolvency); external uptime monitor on `/api/health`. See `docs/uptime-monitoring.md`.

## Tech Stack

- Runtime: Node.js 20+ (TypeScript, ESM)
- Hedera SDK: @hashgraph/sdk (wallet, signing, contract calls, transfers)
- MCP: @modelcontextprotocol/sdk (client for dApp reads, server for agent control)
- A2A: @a2a-js/sdk (Agent Card builder, type definitions). Wire format is plain JSON-RPC 2.0 — we don't run the SDK's server runtime, we adapt to our existing MCP handlers via `src/a2a/adapter.ts`.
- Contract ABIs: @lazysuperheroes/lazy-lotto (NPM package)
- HOL: @hashgraphonline/standards-sdk (HCS-10/11/20, registry, discovery)
- Scheduler: node-cron (periodic play sessions)
- Config: dotenv + versioned JSON strategy files + Zod validation
- Next.js 16 (App Router, React 19, Tailwind v4)
- @hashgraph/hedera-wallet-connect (WalletConnect v2 for Hedera wallets)
- @upstash/redis (session storage, serverless-compatible)
- @hashgraph/proto (SignatureMap protobuf decode for wallet signatures)

## Key Directories

- src/agent/       — Core agent logic (LottoAgent, StrategyEngine, BudgetManager, AuditReport, ReportGenerator)
- src/custodial/   — Multi-user layer: UserLedger, DepositWatcher, MultiUserAgent (per-token reservation/settlement), AccountingService (v1+v2 writers), NegotiationHandler, GasTracker, PersistentStore, RedisStore, **hcs20-v2.ts** (schema types + helpers), **hcs20-reader.ts** (state-machine reader with dual v1+v2 dispatcher)
- src/hedera/      — Hedera SDK wrappers (wallet, contracts, mirror node, tokens, delegates, refund with retry ladder)
- src/mcp/         — MCP client (dApp reads) and MCP server (23 tools: 7 multi-user, 6 single-user, 7 operator incl. operator_recover_stuck_prizes; plus `multi_user_set_strategy`)
- src/a2a/         — A2A protocol layer: `agent-card.ts` (skill registry mirroring MCP tools), `adapter.ts` (A2A → MCP translation, no new business logic), `dispatcher.ts` (JSON-RPC 2.0 method routing). Tests under `__tests__/`.
- src/hol/         — HOL registry integration (HCS-11 profile, UAID)
- src/auth/        — Challenge-response authentication, session management, Redis client
- src/cli/         — Interactive setup wizard, `check-protocols.ts` (MCP/A2A parity smoke test)
- src/config/      — Strategy schema (Zod) and defaults, PRIZE_TRANSFER_RETRY gas ladder
- src/scripts/     — Operator CLI tools: recover-stuck-prizes, verify-audit (standalone), audit-deposit-discrepancy, test-v2-reader
- strategies/      — Versioned JSON strategy files
- docs/            — Operational + user-facing material; bootstrap design lives under `docs/archive/`
- docs/blog/       — Engineering blog posts (architecture, security, product perspectives)
- app/             — Next.js frontend (auth, dashboards, API routes, MCP endpoint, A2A endpoint)
- app/api/a2a/     — A2A JSON-RPC dispatcher (POST) + Agent Card (GET)
- app/.well-known/agent-card.json/ — Standard A2A discovery path
- app/api/_lib/    — Serverless singletons (store, hedera client, deposits, locks, MCP context)
- app/api/cron/    — Vercel Cron endpoints (reconcile)
- public/          — Static assets (favicon, robots.txt)

## Auth System

- Challenge-response: server generates nonce, user signs with Hedera wallet, server verifies signature
- Four tiers: public (register, onboard), user (play, withdraw, status), admin (refund, dead-letters), operator (fees, reconcile, health)
- Per-user ownership: user tier can only access their own data (enforced in MCP tools and A2A adapter)
- Operator tools require admin/operator tier (user tier denied)
- Session tokens: sk_ prefixed, sha256-hashed in Redis, 7-day expiry, lockable (permanent)
- Auto-revoke on re-auth
- Rate limiting: auth endpoints (10/5min challenge, 5/5min verify), MCP endpoint (30/min per identity), A2A endpoint (30/min per identity)

## HTTP Transport

- CLI mode: `--mcp-server --http --port 3001` (persistent process, full state)
- Serverless mode: Next.js API route at /api/mcp (stateless, WebStandardStreamableHTTPServerTransport)
- CLI endpoints: /mcp, /auth/*, /health, /discover
- Serverless endpoints: /api/mcp, /api/a2a, /.well-known/agent-card.json, /api/auth/*, /api/user/*, /api/admin/*, /api/discover, /api/health, /api/cron/reconcile

## A2A Protocol Layer

- Endpoint: `POST /api/a2a` (JSON-RPC 2.0); supported method is `message/send`. `message/stream` returns `UnsupportedOperationError (-32003)`. `tasks/get`/`tasks/cancel` return `TaskNotFoundError`/`TaskNotCancelableError` (we are stateless — tasks complete synchronously and are returned inline).
- Agent Card served at both `GET /.well-known/agent-card.json` (standard) and `GET /api/a2a` (alias). Cached 5 min. Network-aware: testnet vs mainnet `url` field.
- Auth: Bearer token (same `sk_*` session token used by MCP). The route extracts the token from `Authorization: Bearer ...` and threads it as `auth_token` into the underlying MCP tool call so existing tier enforcement is reused unchanged.
- Implementation: `app/api/a2a/route.ts` calls the local `/api/mcp` endpoint over HTTP for each skill invocation. This guarantees parity by construction — the request path is identical to any other MCP client. Tested by `src/cli/check-protocols.ts` (run with `npm run check-protocols`).
- Skills are registered in `src/a2a/agent-card.ts` and map 1:1 to MCP tool names by `id`. Every MCP tool surfaced to clients MUST have a corresponding A2A skill entry — the parity smoke test (`npm run check-protocols`) verifies this on every release.

## Next.js Frontend

- app/ directory with App Router
- Pages: /auth (WalletConnect sign-in), /dashboard (user), /admin (operator), /audit (on-chain trail)
- API routes: /api/auth/*, /api/user/*, /api/admin/*, /api/mcp, /api/discover
- LSH branding: dark mode, Unbounded/Heebo fonts, LAZY Gold accents
- Dual tsconfig: tsconfig.json (Next.js), tsconfig.cli.json (CLI)

## Serverless Architecture (Vercel)

- MCP endpoint: stateless, new McpServer per request, cached agent context singleton
- Persistence: RedisStore (Upstash) with write-through cache, flushed before response
- Deposits: detected on-demand via pollOnce() before balance-dependent operations (no cron)
- Concurrency: Redis distributed locks (INCR + TTL) for play/withdraw per user
- Hedera client: cached per warm Lambda, created from env vars (works fine server-side)
- Store injection: MultiUserAgent.initialize({ store, client }) avoids double-instantiation
- Webpack externals (server-side only):
  - @modelcontextprotocol/sdk — minification breaks StreamableHTTPClientTransport
    (mangles class/method names the SDK uses at runtime, causes "b is not a function").
    Must remain un-bundled so Node.js loads it from node_modules directly.
  - Note: @hashgraphonline/standards-sdk was previously externalized for a file-type
    ESM issue, fixed upstream in v0.1.174 — no longer needed.
- Dual MCP role: the serverless function acts as MCP server (receiving tool calls)
  AND MCP client (connecting to dApp for pool reads). Both transports run in one Lambda.
- Strategy files: inlined in src/config/loader.ts for serverless (strategies/*.json
  not available on Vercel filesystem). CLI reads from disk, falls back to inline.

## Hedera-Specific Rules

1. $LAZY token uses 1 decimal place (10 base units = 1 LAZY)
2. Token approvals: $LAZY -> LazyGasStation, all others -> LazyLottoStorage
3. Roll operations need 1.5x gas multiplier
4. Mirror node has ~4s propagation delay after transactions
5. Always associate tokens before receiving them
6. Agent wallet should be a dedicated account with limited funding
7. Prize transfer uses transferPendingPrizes (in-memory reassignment, not token transfer)
8. `transferPendingPrizes` gas scales with prize count: 500K base + 225K per prize (first try), escalating to 300K then 400K per prize on retries. Capped at 14M. Defined in `PRIZE_TRANSFER_RETRY` in src/config/defaults.ts. The retry ladder is handled by `transferAllPrizesWithRetry` in src/hedera/contracts.ts and used by both the in-flight play path and `operator_recover_stuck_prizes`.

## Multi-User Security Rules

1. **Per-token reservation + settlement**: `MultiUserAgent.playForUser` builds a `Map<token, reservedAmount>` over the intersection of the user's positive-balance tokens with the strategy's budgeted tokens, reserves each independently, and settles each from `report.poolResults[].feeTokenId` after the play. NEVER settle `report.totalSpent` (a meaningless cross-token sum) against a single "primary token". The critical regression test `'HBAR-only user only has HBAR in the reservation set'` locks this behavior in.
2. **Defense-in-depth on unexpected token spend**: If the play loop tries to spend a token that wasn't in the user's reservation set, throw immediately. The catch block releases every outstanding reservation. Bleeding operator funds is unacceptable.
3. **Pool filter restriction**: before building the user-specific LottoAgent, override `poolFilter.feeToken` based on the user's reserved-token set. `FeeTokenFilterSchema` supports an array form (`['HBAR','LAZY']`) for mixed-balance users — don't fall back to `'any'`.
4. Sequential play per user: never interleave User A's play with User B's
5. Per-user mutex: in-memory (CLI) + Redis distributed lock (serverless) for play and withdraw
6. Orphaned reserve recovery: on startup, release any stuck reserved amounts
7. Idempotent deposits: track processed transaction IDs to prevent double-crediting
8. Rake on deposits, not wins: users claim their own prizes from the dApp
9. **Prize transfer outcome is real**: `LottoAgent.safeTransferPrizes` returns a `PrizeTransferOutcome` discriminated union (`skipped | succeeded | failed`) and the session record's `prizesTransferred` reflects the actual result, NOT a hardcoded `true`. Failed transfers dead-letter as `kind: 'prize_transfer_failed'` with full retry log.
10. Refund ledger adjustment: `processRefund` deducts from user balance when memo matches a deposit AND writes a `refund` op to HCS-20 via `AccountingService.recordRefund`
11. Registration dedup: `getUserByAccountId` check prevents accidental double-registration
12. **HCS-20 v2 audit trail is load-bearing**: every play session writes open + N pool_results + close (or aborted). `AccountingService.submitV2Message` hard-fails on >1024 byte messages. `agentSeq` is a monotonic per-agent counter recovered at startup via mirror node scan.

## Local Development Without Redis

- Auth sessions: in-memory Map fallback (src/auth/redis.ts) — sessions lost on restart
- Store: PersistentStore (JSON files in .custodial-data/) — works fully offline
- Distributed locks: no-op in CLI mode (in-memory mutex is sufficient for single-process)
- Deposits: DepositWatcher background polling (CLI) or on-demand (serverless)
- Rate limits: per-process in-memory counters via the same Redis fallback. Production
  (Upstash configured) shares counters across all warm Lambdas via Redis INCR — the
  documented limit is the actual cluster-wide cap. Deploying to Vercel without Upstash
  silently degrades rate limiting to per-Lambda; the boot warning from src/auth/redis.ts
  is your only signal — don't ignore it.
- All three modes work locally without Redis; Redis is only required for production/Vercel

## Commands

```
npm run dev              — Single play session (tsx)
npm run dev:mcp          — MCP server (tsx)
npm run dev:scheduled    — Scheduled mode (tsx)
npm run dev:audit        — Configuration audit (tsx)
npm run dev:web          — Next.js dev server
npm run dev:http         — HTTP transport MCP server
npm run dev:multi-http   — Multi-user HTTP MCP server
npm run setup            — First-time wallet setup
npm run status           — Check wallet balances
npm run audit            — Configuration audit
npm run wizard           — Interactive .env setup
npm test                 — Run test suite (380 tests)
npm run build            — Compile + shebang injection
npm run build:web        — Next.js production build
npm run smoke-test       — Auth flow smoke test
npm run read-accounting  — HCS-20 audit trail reader
npm run check-protocols  — Smoke-test MCP + A2A endpoints + Agent Card on a deployed URL
```

Multi-user mode:
```
lazylotto-agent --multi-user                      — Start custodial agent
lazylotto-agent --multi-user --deploy-accounting  — Deploy HCS-20 topic
lazylotto-agent --multi-user --mcp-server         — MCP server with multi-user tools
```

Operator scripts (src/scripts/):
```
npx tsx src/scripts/recover-stuck-prizes.ts <userAccountId> [--execute] [--reason "..."]
   — Emergency recovery for prizes stranded in agent wallet due to
     failed transferPendingPrizes. Default dry-run; pass --execute
     to actually transfer. Records to HCS-20 audit trail.

npx tsx src/scripts/verify-audit.ts --topic <id> [--user <accountId>] [--json]
   — Standalone audit verifier. Reconstructs per-user ledger from
     the HCS-20 topic alone, no Redis dependency. Safe to run
     against production (read only).

npx tsx src/scripts/audit-deposit-discrepancy.ts
   — Forensic walk comparing live store totalDeposited against
     on-chain mint sums. Used to track down "ghost deposit"
     discrepancies. Falls back to on-chain-only mode if Redis
     creds aren't in .env.

npx tsx src/scripts/test-v2-reader.ts
   — Developer diagnostic: pulls the live HCS-20 topic and runs
     it through parseAuditTopic, prints stats + session breakdown.
     Useful for spot-checking after schema or reader changes.
```

## Documentation

`docs/` contains operational + user-facing material only. Bootstrap design docs
and shipped PRDs live under `docs/archive/` (do not link to them from current
docs). The dApp's MCP endpoint is documented in the separate LazyLotto dApp
repo, not here.

**Repo root:**
- `README.md` — engineering / operator entrypoint (architecture, security, MCP + A2A surfaces, CLI, env vars)
- `PLAYERS.md` — friendly normie-facing guide for end users
- `FEATURES.md` — feature breakdown by audience (Players / Developers / Operators)
- `CHANGELOG.md` — release history

**Operational (load-bearing for running production):**
- `docs/hcs20-v2-schema.md` — external-auditor wire spec for the audit trail
- `docs/mainnet-deploy-checklist.md` — phase-by-phase mainnet deploy runbook
- `docs/mainnet-hol-registration.md` — one-time mainnet HOL registration
- `docs/incident-playbook.md` — 2am-page symptom → action runbook
- `docs/disaster-recovery.md` — Redis-loss recovery via HCS-20 trail
- `docs/uptime-monitoring.md` — `/api/health` + reconcile cron wiring
- `docs/testnet-uat.md` — pre-release UAT checklist against testnet-agent

**User / operator facing:**
- `docs/getting-started.md` — three-modes setup runbook
- `docs/MULTI_USER.md` — custodial-mode operator + user reference
- `docs/testnet-user-guide.md` — end-user dashboard + Claude walkthrough
- `docs/hol-discovery-guide.md` — 3-layer HOL discovery model with curl examples
- `docs/LSH-Branding-Reference.md` — frontend design tokens + branding rules

**Engineering blog (`docs/blog/`):**
- `lazy-wins.md` — product perspective on why this exists
- `trust-by-design.md` — security perspective for skeptical Web3 audiences
- `architecture-deep-dive.md` — engineering perspective on the build

**Archive (`docs/archive/`):** see `docs/archive/README.md`.
