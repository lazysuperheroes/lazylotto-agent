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

## Tech Stack

- Runtime: Node.js 20+ (TypeScript, ESM)
- Hedera SDK: @hashgraph/sdk (wallet, signing, contract calls, transfers)
- MCP: @modelcontextprotocol/sdk (client for dApp reads, server for agent control)
- Contract ABIs: @lazysuperheroes/lazy-lotto (NPM package)
- HOL: @hashgraphonline/standards-sdk (HCS-10/11/20, registry, discovery)
- Scheduler: node-cron (periodic play sessions)
- Config: dotenv + versioned JSON strategy files + Zod validation

## Key Directories

- src/agent/       — Core agent logic (LottoAgent, StrategyEngine, BudgetManager, AuditReport)
- src/custodial/   — Multi-user layer (UserLedger, DepositWatcher, MultiUserAgent, AccountingService, NegotiationHandler, GasTracker, PersistentStore)
- src/hedera/      — Hedera SDK wrappers (wallet, contracts, mirror node, tokens, delegates)
- src/mcp/         — MCP client (dApp reads) and MCP server (19 agent control tools)
- src/hol/         — HOL registry integration (HCS-11 profile, UAID)
- src/cli/         — Interactive setup wizard
- src/config/      — Strategy schema (Zod) and defaults
- strategies/      — Versioned JSON strategy files
- docs/            — Multi-user guide, MCP integration design, MCP server reference

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
npm run setup            — First-time wallet setup
npm run status           — Check wallet balances
npm run audit            — Configuration audit
npm run wizard           — Interactive .env setup
npm test                 — Run test suite (69 tests)
npm run build            — Compile + shebang injection
```

Multi-user mode:
```
lazylotto-agent --multi-user                      — Start custodial agent
lazylotto-agent --multi-user --deploy-accounting  — Deploy HCS-20 topic
lazylotto-agent --multi-user --mcp-server         — MCP server with multi-user tools
```
