# CLAUDE.md — LazyLotto Autonomous Agent

## Project Overview

Autonomous AI agent that plays the LazyLotto lottery on Hedera with its own funded wallet.
The agent evaluates pools, buys entries, rolls for prizes, claims winnings, and manages
its budget — all without human intervention.

## Architecture

- **Reads**: Via MCP client connected to the LazyLotto dApp endpoint (https://lazylotto.app/api/mcp)
- **Writes**: Direct Hedera SDK contract calls (no dependency on dApp for transactions)
- **Wallet**: Agent holds its own Hedera account with private key in .env
- **Strategy**: Configurable JSON files define play behavior, budget, and risk tolerance

## Tech Stack

- Runtime: Node.js 20+ (TypeScript, ESM)
- Hedera SDK: @hashgraph/sdk (for wallet, signing, contract calls)
- MCP Client: @modelcontextprotocol/sdk (for querying LazyLotto dApp)
- Contract ABIs: @lazysuperheroes/lazy-lotto (NPM package)
- HOL: @hashgraphonline/standards-sdk (for registry and discovery)
- Scheduler: node-cron (for periodic play sessions)
- Config: dotenv + JSON strategy files

## Key Directories

- src/agent/       — Core agent logic (LottoAgent, StrategyEngine, BudgetManager)
- src/hedera/      — Hedera SDK wrappers (wallet, contracts, mirror node, tokens)
- src/mcp/         — MCP client (reads) and MCP server (agent control)
- src/config/      — Strategy types and defaults
- strategies/      — JSON strategy files (conservative, balanced, aggressive)

## Hedera-Specific Rules

1. $LAZY token uses 1 decimal place (10 base units = 1 LAZY)
2. Token approvals: $LAZY → LazyGasStation, all others → LazyLottoStorage
3. Roll operations need 1.5x gas multiplier
4. Mirror node has ~4s propagation delay after transactions
5. Always associate tokens before receiving them
6. Agent wallet should be a dedicated account with limited funding — NEVER the treasury

## Commands

npm run start            — Run agent (single session)
npm run start:scheduled  — Run agent on cron schedule
npm run setup            — First-time wallet setup (associations, approvals)
npm run status           — Check agent wallet balance and state
npm test                 — Run test suite