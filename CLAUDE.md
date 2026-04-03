# CLAUDE.md — LazyLotto Agent

## Project Overview

Autonomous AI agent that plays the LazyLotto lottery on Hedera. Operates in two modes:
- **Single-user**: Agent plays with its own funded wallet on behalf of one owner
- **Multi-user (custodial)**: Agent accepts deposits from multiple users, plays on
  their behalf, routes prizes to their EOAs, charges a rake fee, with full HCS-20
  on-chain accounting

## Architecture

- **Reads**: Via MCP client connected to LazyLotto dApp endpoint
- **Writes**: Direct Hedera SDK contract calls (agent signs all transactions)
- **Wallet**: Agent holds its own Hedera account with private key in .env
- **Strategy**: Versioned JSON files define play behavior, budget, and risk tolerance
- **Accounting**: HCS-20 immutable on-chain ledger (multi-user mode)
- **Auth**: Hedera signature challenge-response, session tokens in Upstash Redis (or in-memory fallback)
- **HTTP Transport**: Dual mode — stdio for Claude Desktop, HTTP for Vercel/self-hosted
- **Frontend**: Next.js 16 app with WalletConnect auth page, user dashboard, admin dashboard

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
- src/custodial/   — Multi-user layer (UserLedger, DepositWatcher, MultiUserAgent, AccountingService, NegotiationHandler, GasTracker, PersistentStore)
- src/hedera/      — Hedera SDK wrappers (wallet, contracts, mirror node, tokens, delegates)
- src/mcp/         — MCP client (dApp reads) and MCP server (19 agent control tools)
- src/hol/         — HOL registry integration (HCS-11 profile, UAID)
- src/auth/        — Challenge-response authentication, session management
- src/cli/         — Interactive setup wizard
- src/config/      — Strategy schema (Zod) and defaults
- strategies/      — Versioned JSON strategy files
- docs/            — Multi-user guide, MCP integration design, MCP server reference
- app/             — Next.js frontend (auth page, dashboards, API routes)
- public/          — Static assets (favicon, robots.txt)

## Auth System

- Challenge-response: server generates nonce, user signs with Hedera wallet, server verifies signature
- Four tiers: public (register, onboard), user (play, withdraw, status), admin (refund, dead-letters), operator (fees, reconcile, health)
- Session tokens: sk_ prefixed, sha256-hashed in Redis, 7-day expiry, lockable (permanent)
- Auto-revoke on re-auth
- Rate limiting on auth endpoints

## HTTP Transport

- `--mcp-server --http --port 3001` for HTTP mode
- Endpoints: /mcp (MCP), /auth/* (challenge/verify/refresh/lock/revoke), /health
- CORS configured for auth page origin

## Next.js Frontend

- app/ directory with App Router
- Pages: /auth (WalletConnect sign-in), /dashboard (user), /admin (operator)
- API routes: /api/auth/*, /api/user/*, /api/admin/*
- LSH branding: dark mode, Unbounded/Heebo fonts, LAZY Gold accents
- Dual tsconfig: tsconfig.json (Next.js), tsconfig.cli.json (CLI)

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
3. Per-user mutex: covers both play and withdrawal operations
4. Orphaned reserve recovery: on startup, release any stuck reserved amounts
5. Idempotent deposits: track processed transaction IDs to prevent double-crediting
6. Rake on deposits, not wins: users claim their own prizes from the dApp

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
npm test                 — Run test suite (325+ tests)
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
