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
- **Accounting**: HCS-20 immutable on-chain ledger (multi-user mode)
- **Auth**: Hedera signature challenge-response, session tokens in Upstash Redis (or in-memory fallback)
- **HTTP Transport**: Dual mode — stdio for Claude Desktop, HTTP/serverless for Vercel
- **Frontend**: Next.js 16 app with WalletConnect auth page, user dashboard, admin dashboard
- **Persistence**: RedisStore (Vercel/production) or PersistentStore (local dev, JSON files)
- **Discovery**: HOL HCS-11 profile + /api/discover endpoint

## Tech Stack

- Runtime: Node.js 20+ (TypeScript, ESM)
- Hedera SDK: @hashgraph/sdk (wallet, signing, contract calls, transfers)
- MCP: @modelcontextprotocol/sdk (client for dApp reads, server for agent control)
- Contract ABIs: @lazysuperheroes/lazy-lotto (NPM package)
- HOL: @hashgraphonline/standards-sdk (HCS-10/11/20, registry, discovery)
- Scheduler: node-cron (periodic play sessions)
- Config: dotenv + versioned JSON strategy files + Zod validation
- Next.js 16 (App Router, React 19, Tailwind v4)
- @hashgraph/hedera-wallet-connect (WalletConnect v2 for Hedera wallets)
- @upstash/redis (session storage, serverless-compatible)
- @hashgraph/proto (SignatureMap protobuf decode for wallet signatures)

## Key Directories

- src/agent/       — Core agent logic (LottoAgent, StrategyEngine, BudgetManager, AuditReport)
- src/custodial/   — Multi-user layer (UserLedger, DepositWatcher, MultiUserAgent, AccountingService, NegotiationHandler, GasTracker, PersistentStore, RedisStore)
- src/hedera/      — Hedera SDK wrappers (wallet, contracts, mirror node, tokens, delegates, refund)
- src/mcp/         — MCP client (dApp reads) and MCP server (22 agent control tools)
- src/hol/         — HOL registry integration (HCS-11 profile, UAID)
- src/auth/        — Challenge-response authentication, session management, Redis client
- src/cli/         — Interactive setup wizard
- src/config/      — Strategy schema (Zod) and defaults
- strategies/      — Versioned JSON strategy files
- docs/            — Getting started guide, multi-user guide, MCP reference
- app/             — Next.js frontend (auth, dashboards, API routes, MCP endpoint)
- app/api/_lib/    — Serverless singletons (store, hedera client, deposits, locks, MCP context)
- public/          — Static assets (favicon, robots.txt)

## Auth System

- Challenge-response: server generates nonce, user signs with Hedera wallet, server verifies signature
- Four tiers: public (register, onboard), user (play, withdraw, status), admin (refund, dead-letters), operator (fees, reconcile, health)
- Per-user ownership: user tier can only access their own data (enforced in MCP tools)
- Operator tools require admin/operator tier (user tier denied)
- Session tokens: sk_ prefixed, sha256-hashed in Redis, 7-day expiry, lockable (permanent)
- Auto-revoke on re-auth
- Rate limiting: auth endpoints (10/5min challenge, 5/5min verify), MCP endpoint (30/min per identity)

## HTTP Transport

- CLI mode: `--mcp-server --http --port 3001` (persistent process, full state)
- Serverless mode: Next.js API route at /api/mcp (stateless, WebStandardStreamableHTTPServerTransport)
- CLI endpoints: /mcp, /auth/*, /health, /discover
- Serverless endpoints: /api/mcp, /api/auth/*, /api/user/*, /api/admin/*, /api/discover

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
- Webpack: @hashgraphonline/standards-sdk externalized (ESM-only file-type dep)

## Hedera-Specific Rules

1. $LAZY token uses 1 decimal place (10 base units = 1 LAZY)
2. Token approvals: $LAZY -> LazyGasStation, all others -> LazyLottoStorage
3. Roll operations need 1.5x gas multiplier
4. Mirror node has ~4s propagation delay after transactions
5. Always associate tokens before receiving them
6. Agent wallet should be a dedicated account with limited funding
7. Prize transfer uses transferPendingPrizes (in-memory reassignment, not token transfer)

## Multi-User Security Rules

1. Reserve-before-spend: always move funds from available -> reserved before playing
2. Sequential play per user: never interleave User A's play with User B's
3. Per-user mutex: in-memory (CLI) + Redis distributed lock (serverless) for play and withdraw
4. Orphaned reserve recovery: on startup, release any stuck reserved amounts
5. Idempotent deposits: track processed transaction IDs to prevent double-crediting
6. Rake on deposits, not wins: users claim their own prizes from the dApp
7. Refund ledger adjustment: processRefund deducts from user balance when memo matches a deposit
8. Registration dedup: getUserByAccountId check prevents accidental double-registration

## Local Development Without Redis

- Auth sessions: in-memory Map fallback (src/auth/redis.ts) — sessions lost on restart
- Store: PersistentStore (JSON files in .custodial-data/) — works fully offline
- Distributed locks: no-op in CLI mode (in-memory mutex is sufficient for single-process)
- Deposits: DepositWatcher background polling (CLI) or on-demand (serverless)
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
npm test                 — Run test suite (356 tests)
npm run build            — Compile + shebang injection
npm run build:web        — Next.js production build
npm run smoke-test       — Auth flow smoke test
npm run read-accounting  — HCS-20 audit trail reader
```

Multi-user mode:
```
lazylotto-agent --multi-user                      — Start custodial agent
lazylotto-agent --multi-user --deploy-accounting  — Deploy HCS-20 topic
lazylotto-agent --multi-user --mcp-server         — MCP server with multi-user tools
```
