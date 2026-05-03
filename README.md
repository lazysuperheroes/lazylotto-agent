# LazyLotto Agent

Autonomous AI agent that plays the [LazyLotto](https://lazysuperheroes.com) lottery
on Hedera. The agent evaluates pools, buys entries, rolls for prizes, transfers
winnings, and manages its budget -- all without human intervention.

> **Three real deployment modes — pick what matches your trust model.**
> Use the hosted testnet/mainnet agent (zero setup), self-host the
> multi-user variant on your own subdomain (operator CLI or your own
> Vercel + Upstash), or run single-user on your laptop with your own
> Hedera wallet (Claude Desktop over stdio, no operator wallet in the
> loop). Same code base, three configs.

> **New here?** This README is the engineering / operator entrypoint. If you're
> a player who just wants to play the lottery without running anything, start
> with **[PLAYERS.md](PLAYERS.md)** — the friendly version. For a feature
> breakdown by audience, see **[FEATURES.md](FEATURES.md)**. The engineering
> blog under **[docs/blog/](docs/blog/)** has the why, the how, and the security
> story, written for three different audiences.

The agent operates in **three deployment modes**:

| Mode | Who runs it | Users | Persistence | Auth |
|------|-------------|-------|-------------|------|
| **Single-user** | You, on your machine | 1 (you) | In-memory | `MCP_AUTH_TOKEN` or none |
| **Multi-user local** | Operator, via CLI | Many | File or Redis | Hedera signature challenge |
| **Multi-user hosted** | Operator, on Vercel | Many | Upstash Redis | Hedera signature + WalletConnect |

---

## Architecture

### Single-User Mode

```
 Your Wallet (Owner)                 Agent Wallet
 +-----------------------+          +------------------------+
 | Holds LSH NFTs        |  delegate|  Funded with HBAR/LAZY |
 | Holds main funds      |--------->|  Plays lottery pools   |
 | Claims prizes on dApp |   NFTs  |  Transfers prizes back |
 +-----------------------+          +-------|----------------+
                                            |
                          +-----------------+----------------+
                          |                                  |
                    MCP (reads)                    Hedera SDK (writes)
                    LazyLotto dApp                 Contract calls
                    Pool data, EV                  Buy, Roll, Transfer
```

**Reads** happen via MCP (Model Context Protocol) connected to the LazyLotto dApp.
**Writes** happen via direct Hedera SDK contract calls signed by the agent wallet.

### Multi-User Hosted Mode

```
  Users                          Vercel (lazysuperheroes.com)
 +------------------+           +-------------------------------+
 | Browser/Wallet   |           | Next.js App                   |
 |   WalletConnect  |---------->|   /auth     WalletConnect     |
 |   sign challenge |           |   /dashboard  user view       |
 +------------------+           |   /admin      operator view   |
                                |   /api/mcp    MCP endpoint    |
 +------------------+           |   /api/discover  agent info   |
 | MCP Client       |---------->|                               |
 | (Claude, etc.)   |  auth +   +----------|--------------------+
 +------------------+  session             |
                                   +-------+--------+
  HOL Registry                     |                |
 +------------------+         Upstash Redis    Hedera SDK
 | HCS-11 Profile   |         sessions +       contract calls
 | UAID Discovery   |         ledger           buy, roll, transfer
 +------------------+              |
                              LazyLotto dApp
                              (MCP reads)
```

Users authenticate by signing a challenge with their Hedera wallet. The agent
plays on their behalf using a shared custodial wallet, with per-user accounting
tracked in an internal ledger (backed by Upstash Redis) and an immutable HCS-20
on-chain audit trail.

---

## Security Model

> **The agent wallet is a HOT WALLET. Its private key is stored in `.env` on disk
> (or in Vercel environment variables for hosted mode).**

### General Rules

1. **Use a DEDICATED Hedera account** for the agent. Never use your main wallet,
   treasury, or any account holding significant assets.

2. **Fund it minimally.** Load only enough HBAR and LAZY for a few play sessions.
   You can always top it up later.

3. **Never commit `.env`** to version control. The `.gitignore` already excludes it.

4. **Set `OWNER_EOA`** (single-user mode) to your main wallet. Prizes are
   transferred in-memory to this address -- you claim them from the LazyLotto dApp.
   The agent never needs your main wallet's private key.

5. **Use `--audit`** to verify your configuration before playing on mainnet.

6. **Keep NFTs in your owner wallet.** Delegate them to the agent for win rate
   bonuses -- don't transfer them. See [Delegation & Bonuses](#delegation--bonuses).

### Multi-User Authentication

The hosted and local multi-user modes use **Hedera signature challenge-response**
authentication. No shared secrets, no passwords.

**Flow:**
1. Client sends `POST /api/auth/challenge` with `{ accountId }`
2. Server returns a nonce message to sign
3. Client signs the message with their Hedera private key
4. Client sends `POST /api/auth/verify` with `{ challengeId, accountId, signatureMapBase64 }`
5. Server verifies the signature and returns a session token

**Session tokens:**
- Prefixed with `sk_` for easy identification
- SHA-256 hashed before storage in Redis (server never stores plaintext tokens)
- 7-day expiry, auto-revoked on re-authentication
- Lockable: operator can permanently lock a token (revocation-resistant)

**Authorization tiers:**

| Tier | Access | Who |
|------|--------|-----|
| **public** | Register, onboard, discovery | Anyone |
| **user** | Play, withdraw, status, deposit info | Authenticated users (own data only) |
| **admin** | Refund, dead-letter queue, all user views | Accounts in `ADMIN_ACCOUNTS` env |
| **operator** | Fee withdrawal, reconciliation, health | Accounts in `OPERATOR_ACCOUNTS` env |

**Per-user ownership enforcement:** User-tier sessions can only access their own
data. The server resolves the caller's identity from their session token and
rejects cross-user access attempts.

**Distributed locking:** Concurrent play and withdrawal operations for the same
user are prevented via per-user mutex locks (Redis-backed in hosted mode). This
ensures sequential execution even across multiple serverless function instances.

**Rate limiting:** The MCP and A2A endpoints each enforce 30 requests per
minute per authenticated identity. Auth endpoints have their own budgets
(10 challenge / 5 verify per 5 minutes per identity).

---

## Production Hardening

Operational features and explicit trade-offs for running the hosted agent.

### Production guarantees

The hosted agent's contract in three lines:

1. **Redis is required, not optional.** Production deploys
   (`NODE_ENV=production`) must have Upstash Redis configured. Missing
   credentials cause every API route to return a structured
   `PRODUCTION_REDIS_REQUIRED` 503 on the first request. Distributed
   locks, rate limits, kill-switch state, and velocity caps all live
   in Redis by design — there is no in-memory fallback in production.
2. **Layered safety on Redis.** Individual guards (kill switch,
   velocity cap, rate limiter, distributed locks) fail open on
   transient Redis errors so a 200ms upstream blip doesn't lock
   anyone out. A process-local circuit breaker tracks sustained
   failures and flips write-path routes (play, withdraw) to
   `redis_degraded` 503 when Redis is genuinely unhealthy. Reads
   continue throughout.
3. **Wallet-only privileged auth on hosted.** Operator and admin tiers
   are issued exclusively through Hedera signature challenge against
   `OPERATOR_ACCOUNTS` / `ADMIN_ACCOUNTS`. The `MCP_AUTH_TOKEN`
   shared-secret env var is scoped to single-user CLI / stdio
   deployments; multi-user mode ignores it. One trust model per
   deployment shape.

### Kill Switch

Emergency freeze for write-path operations. When engaged, the agent refuses
new plays and new registrations but continues to serve withdrawals,
deregistration, and reads. The intent is *"stop creating new financial
obligations while we figure out what's wrong"* — not *"lock users out of
their money."*

**How to use it:**
- Navigate to `/admin` (operator tier required).
- The banner at the top of the page shows the current state (engaged /
  disengaged) and a one-click toggle.
- Engaging prompts for a **reason**, which is persisted and shown to any
  user who hits a blocked endpoint.

**What it blocks:**
- `multi_user_play`, `agent_play` — no new lottery sessions
- `multi_user_register`, `POST /api/user/register` — no new user sign-ups

**What it leaves open:**
- Withdrawals and deregistration — users can always exit
- Balance / history / audit reads — users can always see their state
- Admin operations (refund, reconcile, health) — operators still have tools

Fails open: if Redis is unreachable when the flag is checked, the agent
allows the operation rather than halting. The kill switch is an override,
not a gate.

### Structured Logging

`src/lib/logger.ts` emits structured events to `process.stderr` in one of
two formats, selected automatically:

| Env | Format | Use |
|-----|--------|-----|
| `LOG_FORMAT=json` (or `NODE_ENV=production`) | One JSON object per line | Pipe into Logtail / Axiom / Datadog |
| Default in local dev | Pretty coloured text | Human-readable tail in your terminal |

`LOG_LEVEL` (`debug` \| `info` \| `warn` \| `error`) filters output.
`info` is the default.

**Safety invariant:** the logger writes ONLY to stderr. stdio MCP (Claude
Desktop) uses stdout as the JSON-RPC transport, so anything on stdout
corrupts the protocol. `src/index.ts` also redirects stray `console.log`
and `console.info` calls to stderr when running in `--mcp-server` mode
without `--http`, as a belt-and-braces guard.

Structured events currently emitted include `deposit_credited`,
`play_completed`, `withdrawal_processed`, `refund_ledger_adjusted`, and
`agent_started`/`agent_stopped`.

### Schema Versioning

Every persisted record is stamped with a `schemaVersion` field at write
time, sourced from the `CURRENT_SCHEMA_VERSION` constant in
`src/custodial/types.ts`. This costs nothing today but leaves a clean
migration path when the shape of any stored record changes.

- Current version: **1**
- Legacy records without a version are treated as v0 and passed through
  unchanged (the field is optional).
- When you change a record shape incompatibly: bump `CURRENT_SCHEMA_VERSION`,
  add a read-side upgrader keyed on the stamped version, and note the change
  in the version history comment at the top of `types.ts`.

Full migration tooling (bulk-rewrite scripts, `flashback`-style migration
runner) is intentionally deferred until the first real schema change —
cheapest to add in context rather than speculatively.

### Deferred Hardening

These items were deliberately skipped after weighing risk, cost, and
operational reality. Each has a clear trigger for when to revisit.

**KMS-backed signing** — The Hedera operator private key is stored in
Vercel environment variables rather than a KMS. For hosted deployments,
the key is set using Vercel's **Sensitive** env var mode, which hides the
value from the dashboard after it's written — only one team member (the
person who set it) ever sees the plaintext. With a two-person team, this
trust boundary is considered acceptable for testnet and early mainnet.

**Triggers to revisit (the explicit kill criteria for "deferred"):**

- **Monthly review** — first business day of each month, the operator
  re-evaluates whether KMS-backed signing should be moved up the
  priority list. Surfaced as a recurring calendar reminder so it
  doesn't fall off.
- **Hard trigger — 50,000 HBAR equivalent AUM.** When the agent
  wallet's assets-under-management exceed 50,000 HBAR (USD-converted at
  month-end mid-market), KMS-backed signing moves from "deferred" to
  "active scoping." The monthly reconcile report includes operator-wallet
  AUM with this threshold check, so the trigger fires on its own.
- Other unconditional triggers: team size grows past the original
  two-person circle, or a compliance requirement mandates hardware-
  backed signing.

The key-compromise runbook in `docs/incident-playbook.md` (Symptom 8)
documents the rotation procedure that bridges the gap between today's
trust boundary and a future KMS migration.

**Vercel Cron for deposit polling** — Deposits are detected on demand:
when a user calls `multi_user_deposit_info`, `multi_user_play`, or
`multi_user_play_history`, the route first runs a single mirror node
poll. If a user never interacts, their deposit sits in the agent wallet
and credits the moment they next check. This is a deliberate design
choice — no cron means no per-minute background cost, no timer drift,
and no idle-Lambda spin-up. **Revisit when:** users start complaining
that deposits take too long to appear, or push notifications are added
that need balance-change events.

**Full schema migration tooling** — Only the `schemaVersion` field is in
place today. The bulk-rewrite scripts, dry-run diff tooling, and
version-bump CLI are not. **Revisit when:** the first incompatible
record-shape change happens.

### HCS-20 v2 Audit Trail

The agent writes a structured sequence to an HCS-20 topic for every
play session: `play_session_open` → N × `play_pool_result` →
`play_session_close` (or `play_session_aborted` on partial-write
failure). Plus `mint` (deposits), `transfer` (rake), `burn`
(withdrawals), `refund`, `prize_recovery`, and `control` ops for
everything else.

The full wire spec is in `docs/hcs20-v2-schema.md`. It's designed so
an external auditor can reconstruct every user's ledger from the
topic alone, without needing the agent's Redis store. The reader
(`src/custodial/hcs20-reader.ts`) handles both v1 batch and v2
sequence shapes via an anti-corruption layer — legacy testnet
sessions parse correctly and surface as `closed_success` with a
"v1 legacy" warning.

Standalone CLI verifier at `src/scripts/verify-audit.ts`:

```bash
npx tsx src/scripts/verify-audit.ts --topic <topic-id> --user <accountId>
```

Produces per-user Deposited / Rake / Spent / Withdrawn / Refunded /
Balance totals with no dependency on the agent's state. This is the
artifact we'd hand to a regulator.

### Prize Transfer Reliability

Phase 5 of a play session reassigns pending prizes from the agent
wallet to the user's EOA via the contract's `transferPendingPrizes`
function. Gas scales with prize count, so the agent uses an
escalating-gas retry ladder (225K → 300K → 400K per prize, capped
at 14M) defined in `PRIZE_TRANSFER_RETRY` in
`src/config/defaults.ts`. The ladder retries on `INSUFFICIENT_GAS`
only — other errors propagate and get dead-lettered.

Failed transfers record a `prize_transfer_failed` dead letter with
the full retry log. The admin dashboard surfaces the count, and
the operator recovery tool (`operator_recover_stuck_prizes` MCP
tool, or the `src/scripts/recover-stuck-prizes.ts` CLI) pushes
stranded prizes through with the same ladder. Successful recoveries
write a `prize_recovery` op to the HCS-20 audit topic so the
intervention is visible to external auditors.

### Per-Token Play Correctness

The play loop reserves a budget **per token** (intersection of the
user's positive-balance tokens with the strategy's budgeted tokens),
runs the LottoAgent with a pool filter tightened to exactly those
tokens, and settles spend from `report.poolResults[].feeTokenId`
independently per token. Defense-in-depth: if the play loop ever
spends a token that wasn't in the reservation set, it throws and
the catch block releases every outstanding reservation.

This prevents a whole class of operator-fund-bleed bugs where a
HBAR-only user could trigger a LAZY pool play and have the LAZY
entry fee come out of the agent wallet (operator funds) while
being mis-billed in HBAR. The regression test
`'HBAR-only user only has HBAR in the reservation set'` in
`src/custodial/MultiUserAgent.test.ts` locks this behavior in.

### Reconcile Cron + Uptime Monitoring

`/api/cron/reconcile` is a `CRON_SECRET`-authenticated endpoint
that runs the same reconcile the admin dashboard does and returns
`200` on solvent / `503` on insolvent. Wired in `vercel.json` to
run hourly. Optionally fires a webhook on insolvency when
`RECONCILE_FAILURE_WEBHOOK_URL` is set.

Pair with an external uptime monitor (Better Stack, UptimeRobot,
Vercel Monitoring) pointed at `/api/health` for liveness. See
`docs/uptime-monitoring.md` for full wiring instructions.

### Operator Runbooks

- `docs/mainnet-deploy-checklist.md` — phase-by-phase mainnet
  deploy runbook with exhaustive env var list and verification
  steps
- `docs/mainnet-hol-registration.md` — one-time HOL registration
  walkthrough
- `docs/incident-playbook.md` — symptom → action runbook for the
  failure modes we've actually seen (stuck prizes, reconcile
  insolvency, dead letters, corrupt sessions, MCP HTML 500,
  operator-LAZY bleed)
- `docs/disaster-recovery.md` — Redis loss recovery procedure
  using the HCS-20 v2 trail as the backup

---

## Getting Started

### Single-User Mode

There are three ways to set up single-user mode. Pick the one that suits you.

#### Path A: Interactive Wizard (recommended for first-timers)

The wizard walks you through every step, creates your `.env` file, and
optionally runs `--setup` at the end.

```bash
# Install globally
npm install -g @lazysuperheroes/lazylotto-agent

# Run the wizard
lazylotto-agent --wizard
```

The wizard will ask for your agent account ID, private key, owner wallet,
network, strategy, and contract addresses. It validates each input and
writes the `.env` file for you.

#### Path B: Claude-Guided Setup (via MCP)

If the agent is already connected to Claude Desktop as an MCP server,
Claude can guide you through setup using the `agent_onboard` tool.

Claude will call `agent_onboard`, get a checklist of what's configured and
what's missing, then walk you through each step conversationally -- checking
balances, explaining delegation, and running the audit.

See [MCP Server](#mcp-server-claude-desktop-integration) for how to connect.

#### Path C: Manual Setup

```bash
npm install -g @lazysuperheroes/lazylotto-agent

# Copy the example env and edit it
cp .env.example .env
# Edit .env with your values (see Configuration section below)

# Associate tokens and set approvals
lazylotto-agent --setup

# Verify everything is correct
lazylotto-agent --audit

# Play a session
lazylotto-agent
```

### Multi-User and Hosted Setup

Multi-user mode (both local and hosted) requires additional configuration:
Upstash Redis credentials, rake fee settings, HCS-20 accounting topic, and
admin account IDs. See the dedicated guides:

- [Multi-User Guide](docs/MULTI_USER.md) -- full custodial mode documentation
- [Getting Started](docs/getting-started.md) -- three-modes setup runbook
- [Mainnet Deploy Checklist](docs/mainnet-deploy-checklist.md) -- production runbook
- [Testnet User Guide](docs/testnet-user-guide.md) -- the end-user dashboard + Claude flow

### Getting Testnet Tokens

To play on testnet you need HBAR and optionally LAZY tokens:

1. **Create a testnet account**: Visit [Hedera Portal](https://portal.hedera.com/) to create a testnet account and get your account ID + private key
2. **Get testnet HBAR**: Use the [Hedera Faucet](https://portal.hedera.com/faucet) to fund your testnet account with HBAR
3. **Get testnet LAZY**: The LazyLotto testnet uses LAZY token `0.0.8011209`. Contact the LazyLotto team or use the testnet faucet if available

Set `LAZY_TOKEN_ID` in your `.env` to match your network:
- **Testnet**: `LAZY_TOKEN_ID=0.0.8011209`
- **Mainnet**: `LAZY_TOKEN_ID=0.0.1311037`

The built-in strategies use `"lazy"` as a portable alias -- it automatically resolves to your configured `LAZY_TOKEN_ID`.

### npx (no install needed)

Every command also works with npx:

```bash
npx @lazysuperheroes/lazylotto-agent --wizard
npx @lazysuperheroes/lazylotto-agent --setup
npx @lazysuperheroes/lazylotto-agent --audit
npx @lazysuperheroes/lazylotto-agent
```

---

## Configuration

### Environment Variables

**Core (all modes):**

| Variable | Required | Description |
|----------|----------|-------------|
| `HEDERA_NETWORK` | Yes | `testnet` or `mainnet` |
| `HEDERA_ACCOUNT_ID` | Yes | Agent's Hedera account ID (`0.0.XXXXX`) |
| `HEDERA_PRIVATE_KEY` | Yes | Agent's private key (DER hex encoded) |
| `LAZYLOTTO_MCP_URL` | Yes | LazyLotto MCP endpoint |
| `LAZYLOTTO_MCP_API_KEY` | No | API key for MCP endpoint (if required) |
| `LAZYLOTTO_CONTRACT_ID` | No | LazyLotto contract (defaults from MCP) |
| `LAZYLOTTO_STORAGE_ID` | No | Storage contract address |
| `LAZY_GAS_STATION_ID` | No | GasStation contract address |
| `LAZY_TOKEN_ID` | No | LAZY token ID (defaults from MCP) |
| `OWNER_EOA` | Yes* | Your wallet address -- receives prizes (*single-user only) |
| `STRATEGY` | No | Strategy name or path (default: `balanced`) |
| `DELEGATE_REGISTRY_ID` | No | Delegate registry contract (for --audit) |
| `LSH_TOKEN_IDS` | No | Comma-separated LSH NFT token IDs (for --audit) |
| `HOL_API_KEY` | No | HOL registry API key |

**Multi-user mode:**

| Variable | Required | Description |
|----------|----------|-------------|
| `MULTI_USER_ENABLED` | Yes | Set to `true` to enable custodial mode |
| `RAKE_DEFAULT_PERCENT` | No | Default rake fee on deposits (default: 5%) |
| `RAKE_MIN_PERCENT` | No | Minimum negotiable rake (default: 2%) |
| `RAKE_MAX_PERCENT` | No | Maximum rake (default: 5%) |
| `DEPOSIT_POLL_INTERVAL_MS` | No | Deposit polling interval in ms (default: 10000) |
| `MAX_USER_BALANCE` | No | Maximum user balance (default: 10000) |
| `HCS20_TOPIC_ID` | No | HCS-20 accounting topic ID |
| `HCS20_TICK` | No | HCS-20 token tick symbol (default: LLCRED) |
| `MCP_AUTH_TOKEN` | No | Static auth token for single-user CLI / stdio MCP server. **Ignored in multi-user mode** (`MULTI_USER_ENABLED=true`) — hosted operators authenticate via wallet signature against `OPERATOR_ACCOUNTS`. |
| `OPERATOR_WITHDRAW_ADDRESS` | No | Restrict operator fee withdrawals to this address |

**Hosted deployment (Vercel):**

| Variable | Required | Description |
|----------|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL for sessions and persistence. **In `NODE_ENV=production`, missing Upstash credentials cause every API route to return 503 with `PRODUCTION_REDIS_REQUIRED`** — there is no silent fallback. |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token |
| `ADMIN_ACCOUNTS` | No | Comma-separated Hedera account IDs that get the `admin` tier (refunds, dead-letters, all-user views). |
| `OPERATOR_ACCOUNTS` | No | Comma-separated Hedera account IDs that get the `operator` tier (fees, reconcile, health, kill switch, fee withdrawal). Operator is a strict superset of admin. |

**Legacy aliases:** `KV_REST_API_URL` and `KV_REST_API_TOKEN` are accepted as
fallbacks for the Upstash variables.

### Strategy Files

Three built-in strategies ship in `strategies/`:

| Strategy | HBAR Budget | LAZY Budget | Entries/Pool | Risk |
|----------|------------|-------------|-------------|------|
| **conservative** | 25/session | 100/session | 3 | Low -- 10%+ win rate pools |
| **balanced** | 100/session | 500/session | 5 | Moderate -- all pools |
| **aggressive** | 500/session | 2000/session | 20 | Higher -- prize-rich + $100 USD cap |

Select via `STRATEGY=conservative` in `.env` or pass a path to a custom JSON file.

**Note:** The built-in strategy files use testnet token IDs (e.g., `0.0.8011209` for LAZY).
For mainnet deployment, update the `tokenBudgets` keys in your strategy files to match
mainnet token IDs, or set `LAZY_TOKEN_ID` in `.env` and use that value as the budget key.

### Custom Strategies

Create a JSON file matching this schema:

```json
{
  "name": "my-strategy",
  "version": "0.2",
  "description": "My custom strategy",
  "poolFilter": {
    "type": "all",
    "minWinRate": 5,
    "feeToken": "any",
    "minPrizeCount": 1
  },
  "budget": {
    "tokenBudgets": {
      "hbar": { "maxPerSession": 100, "maxPerPool": 50, "reserve": 10 },
      "lazy": { "maxPerSession": 500, "maxPerPool": 200, "reserve": 50 }
    },
    "maxEntriesPerPool": 10
  },
  "playStyle": {
    "action": "buy_and_roll",
    "entriesPerBatch": 3,
    "minExpectedValue": -10,
    "transferToOwner": true,
    "ownerAddress": "0.0.67890",
    "preferNftPrizes": false,
    "stopOnWins": 5
  },
  "schedule": {
    "enabled": false,
    "cron": "0 */6 * * *",
    "maxSessionsPerDay": 4
  }
}
```

Set `STRATEGY=./my-strategy.json` in `.env`.

---

## How the Agent Plays

Each session follows a 6-phase loop:

1. **Preflight** -- Verify wallet balance (HBAR + LAZY), check reserve threshold
2. **Discover** -- Query all pools via MCP, filter by strategy criteria
3. **Evaluate** -- Calculate expected value (EV) per pool including win rate boost
4. **Play** -- For each qualifying pool: check prerequisites, auto-fix (associate
   tokens, approve allowances), buy entries, roll
5. **Transfer** -- Move pending prizes to owner via `transferPendingPrizes`
6. **Report** -- Print session summary (pools played, wins, net P&L)

The agent is resilient: individual pool failures are caught and logged without
crashing the session. Prize transfer is always attempted even if play operations fail.

In multi-user mode, the same loop runs per-user with reserve-before-spend
accounting. The agent moves funds from `available` to `reserved` in the ledger
before playing, ensuring one user's session cannot spend another user's balance.

---

## MCP Server (Claude Desktop Integration)

The agent exposes an MCP server so Claude (or any MCP client) can control it.

### Claude Desktop Configuration

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "command": "lazylotto-agent",
      "args": ["--mcp-server"],
      "env": {
        "HEDERA_NETWORK": "testnet",
        "HEDERA_ACCOUNT_ID": "0.0.12345",
        "HEDERA_PRIVATE_KEY": "302e...",
        "LAZYLOTTO_MCP_URL": "https://testnet-dapp.lazysuperheroes.com/api/mcp",
        "OWNER_EOA": "0.0.67890",
        "STRATEGY": "balanced"
      }
    }
  }
}
```

Or if installed locally during development:

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "command": "node",
      "args": ["--import", "tsx", "src/index.ts", "--mcp-server"],
      "cwd": "/path/to/lazylotto-agent",
      "env": { "DOTENV_CONFIG_PATH": "/path/to/lazylotto-agent/.env" }
    }
  }
}
```

### Available MCP Tools

**Single-user tools:**

| Tool | Description |
|------|-------------|
| `agent_onboard` | Step-by-step onboarding checklist -- Claude uses this to guide you |
| `agent_play` | Run a lottery play session (requires `auth_token` when configured) |
| `agent_status` | Wallet balances, pending prizes, session history, cumulative stats |
| `agent_transfer_prizes` | Transfer all pending prizes to OWNER_EOA |
| `agent_set_strategy` | Switch strategy (built-in name or full JSON) |
| `agent_wallet_info` | Detailed wallet: tokens, NFTs, approvals, contracts |
| `agent_withdraw` | Withdraw HBAR or LAZY to owner (fund recovery) |
| `agent_stop` | Stop active session, transfer prizes, return summary |
| `agent_audit` | Full config audit with warnings and recommendations |

**Multi-user tools** (available when running with `--multi-user --mcp-server`):

| Tool | Auth Tier | Description |
|------|-----------|-------------|
| `multi_user_status` | admin/operator | List all registered users with balances and activity |
| `multi_user_register` | any | Register a new user, get deposit memo |
| `multi_user_deposit_info` | user+ | Get deposit instructions for a user |
| `multi_user_play` | user+ | Play for a specific user (userId required) |
| `multi_user_withdraw` | user+ | Process user withdrawal |
| `multi_user_deregister` | user+ | Deactivate user (withdraw-only after this) |
| `multi_user_play_history` | user+ | View play session results for a user |

**Operator tools** (require admin or operator tier):

| Tool | Description |
|------|-------------|
| `operator_balance` | Rake collected, gas spent, net profit |
| `operator_withdraw_fees` | Withdraw accumulated rake fees to a specified address |
| `operator_reconcile` | Compare on-chain wallet balances against internal ledger; reports per-token deltas and solvency status |
| `operator_dead_letters` | View deposits that could not be processed (unknown token, unknown memo, inactive user) |
| `operator_refund` | Refund a specific transaction back to the sender |
| `operator_health` | Uptime, deposit watcher status, error count, active users, pending reserves |

Tool parameter schemas are defined in `src/mcp/tools/*` (Zod). Inspect them with
`tools/list` against the live endpoint, or via the parity smoke test:

```bash
npm run check-protocols    # against testnet-agent.lazysuperheroes.com by default
npm run check-protocols -- http://localhost:3000   # against a local dev server
```

The dApp's MCP endpoint (which the agent consumes via `LAZYLOTTO_MCP_URL`) is
documented in the separate LazyLotto dApp repo, not here.

---

## A2A Protocol (Agent-to-Agent)

The same tools are also exposed via the **Agent-to-Agent (A2A)** protocol, so
non-MCP clients (or other agents) can drive the LazyLotto Agent without
speaking MCP. The A2A surface is a thin adapter on top of the MCP server: every
A2A skill maps 1:1 to an MCP tool, every skill invocation is routed through
the same handler, and parity is verified by `npm run check-protocols`.

### Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/.well-known/agent-card.json` | GET | A2A discovery — capabilities, skills, auth scheme, service URL. Cached 5 min. |
| `/api/a2a` | GET | Convenience alias for the Agent Card (same payload). |
| `/api/a2a` | POST | JSON-RPC 2.0 dispatcher. |

### Methods

`POST /api/a2a` accepts standard A2A JSON-RPC methods:

| Method | Status |
|--------|--------|
| `message/send` | **Supported.** Synchronous — the response includes a completed (or failed) `Task` with the result inline as a `DataPart` artifact. |
| `message/stream` | Returns `UnsupportedOperationError (-32003)`. Streaming is a Phase 2 item. |
| `tasks/get` | Returns `TaskNotFoundError (-32001)`. We are stateless — tasks are returned inline from `message/send` and not persisted. |
| `tasks/cancel` | Returns `TaskNotCancelableError (-32002)`. Tasks complete synchronously. |

### Auth

Same Bearer token as MCP. Pass `Authorization: Bearer sk_...` from
`/api/auth/verify`. The route extracts the token and threads it as
`auth_token` into the underlying MCP tool call, so all four authorization
tiers behave identically across both protocols.

### Example: invoke a skill

```bash
curl -X POST https://testnet-agent.lazysuperheroes.com/api/a2a \
  -H 'Authorization: Bearer sk_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "demo-1",
        "role": "user",
        "parts": [
          { "kind": "data", "data": { "skill": "multi_user_play", "params": {} } }
        ]
      }
    }
  }'
```

The response contains a `Task` with `status.state: "completed"` and an
`artifacts` array — the first artifact's `parts[0].data` is the JSON tool
result.

### Skills

Skills mirror the MCP tool catalog. The full list is served live at
`/.well-known/agent-card.json`. Skill `id` equals the MCP tool name —
e.g. `multi_user_play`, `operator_health`, `operator_recover_stuck_prizes`.
Use `npm run check-protocols` to confirm parity between the two surfaces
on any deployment.

---

## Web Dashboard

The agent includes a Next.js frontend for browser-based interaction.

### Pages

| Route | Purpose |
|-------|---------|
| `/auth` | WalletConnect sign-in. Users connect their Hedera wallet (HashPack, Blade, etc.) and sign a challenge to receive a session token. |
| `/dashboard` | User dashboard. Shows balance, deposit instructions, play history, and withdrawal controls. |
| `/admin` | Operator dashboard. All users overview, dead-letter queue, reconciliation, and health status. |
| `/audit` | On-chain audit trail. Browse HCS-20 accounting records with admin view and user filter. |

### Branding

The frontend uses Lazy Superheroes branding: dark mode with LAZY Gold accents,
Unbounded (headings) and Heebo (body) fonts, and IPFS-hosted LSH character
mascots from Gen 1 (Lazy Superheroes) and Gen 2 (Lazy Super Villains).

### Running Locally

```bash
npm run dev:web    # Starts Next.js dev server on port 3000
```

The web dashboard connects to the same MCP endpoint and auth system as the CLI.
For local development, run the HTTP MCP server in a separate terminal:

```bash
npm run dev:multi-http    # Multi-user HTTP MCP server
```

---

## Hosted Deployment (Vercel)

The agent is designed for serverless deployment on Vercel.

**Testnet instance:** https://testnet-agent.lazysuperheroes.com

### How It Works

- **Next.js App Router** serves the web dashboard and API routes
- **API routes** handle auth (`/api/auth/*`), MCP (`/api/mcp`), user operations (`/api/user/*`), admin operations (`/api/admin/*`), and discovery (`/api/discover`)
- **Upstash Redis** provides session storage and persistent user ledger (required -- no filesystem in serverless)
- **Stateless MCP endpoint** at `/api/mcp` accepts JSON requests with session token authentication

### Deposit Detection in Serverless Mode

In serverless mode there is no background polling process. Deposits are detected
**on-demand** -- when a user checks their balance, requests deposit info, or
triggers a play session, the agent queries the Hedera mirror node for new
incoming transfers. This is a deliberate design choice: no cron jobs or
long-lived processes are needed.

### Discovery Endpoint

`GET /api/discover` returns a public JSON payload describing the agent's
identity, network, auth flow, fee structure, accepted tokens, capabilities,
and endpoints. Think of it as the agent's `.well-known` configuration. This
powers HOL registry integration and programmatic agent discovery.

### Required Environment Variables (Vercel)

In addition to the core variables listed in [Configuration](#configuration),
hosted deployments require:

- `UPSTASH_REDIS_REST_URL` -- Upstash Redis REST endpoint
- `UPSTASH_REDIS_REST_TOKEN` -- Upstash Redis auth token
- `MULTI_USER_ENABLED=true`
- Admin/operator account IDs for authorization tier mapping

Set these in the Vercel project's Environment Variables settings.

### Build

```bash
npm run build:web    # Next.js production build
```

---

## Delegation & Bonuses

LazyLotto applies win rate bonuses based on:

1. **Delegated LSH NFTs** -- Lazy Superheroes NFTs whose bonus authority is
   delegated to the agent via the LazyDelegateRegistry.
2. **LAZY token balance** -- The agent's own LAZY holding can contribute to boost.

### How Delegation Works

The owner (you) calls `delegateNFT` on the LazyDelegateRegistry contract from
**your wallet** -- not the agent's. This grants the agent the win rate bonus
from your NFTs without transferring custody.

```
Owner wallet -> delegateNFT(agentAddress, lshTokenAddress, [serial1, serial2])
```

The agent's `calculateBoost()` automatically picks up delegated NFTs. You keep
full ownership and can revoke at any time via `revokeDelegateNFT`.

### Checking Delegation Status

```bash
lazylotto-agent --audit
```

The audit report shows:
- Current win rate boost (in basis points)
- NFT serials delegated to the agent
- Recommendations if no delegation is active

### Setting Up Delegation

1. Note your agent's account ID (shown in `--audit` output)
2. From your owner wallet, call the delegate registry:
   - Function: `delegateNFT(address _delegate, address _token, uint256[] _serials)`
   - `_delegate`: your agent's EVM address
   - `_token`: LSH NFT token's EVM address
   - `_serials`: array of NFT serial numbers to delegate
3. Run `lazylotto-agent --audit` to verify the delegation appears

---

## HOL Registry (Agent Discovery)

The agent can register itself in the [HOL Registry](https://hol.org) using
the HCS-11 standard. This makes it discoverable by other agents and services
on the Hashgraph Online network.

```bash
# First-time registration
lazylotto-agent --register

# Update profile if config changed
lazylotto-agent --register --force
```

Registration creates:
- An **HCS-11 agent profile** on Hedera (stored as an HCS topic)
- A **UAID** (Universal Agent ID) for discovery via the registry broker
- **HCS-10 inbound/outbound topics** for agent-to-agent communication

The agent registers as:
- **Type**: autonomous
- **Capabilities**: transaction analytics, workflow automation, market intelligence
- **Protocol**: HCS-10 (OpenConvAI)

Registration state is saved to `.agent-config.json` (gitignored). The `--audit`
command shows registration status. Set `HOL_API_KEY` in `.env` if the registry
broker requires authentication.

---

## CLI Commands

```
lazylotto-agent                  Single play session
lazylotto-agent --wizard         Interactive setup wizard (creates .env)
lazylotto-agent --setup          Token associations and approvals
lazylotto-agent --register       Register agent with HOL registry (HCS-11)
lazylotto-agent --register --force   Update existing HOL registration
lazylotto-agent --status         Check wallet balances and state
lazylotto-agent --audit          Comprehensive configuration audit
lazylotto-agent --dry-run        Show what would be played (no transactions)
lazylotto-agent --export-history Export play history to CSV
lazylotto-agent --mcp-server     Start MCP server (stdio, for Claude Desktop)
lazylotto-agent --mcp-server --http   Start MCP server (HTTP, for self-hosting)
lazylotto-agent --scheduled      Run play sessions on cron schedule
lazylotto-agent --multi-user     Start multi-user custodial agent
lazylotto-agent --multi-user --deploy-accounting  Deploy HCS-20 topic
lazylotto-agent --multi-user --mcp-server         MCP server with multi-user tools
lazylotto-agent --multi-user --mcp-server --http  Multi-user HTTP MCP server
```

Development equivalents:

```
npm run dev                      Single play session (tsx)
npm run dev:mcp                  MCP server via stdio (tsx)
npm run dev:http                 MCP server via HTTP (tsx)
npm run dev:multi-http           Multi-user HTTP MCP server (tsx)
npm run dev:scheduled            Scheduled mode (tsx)
npm run dev:audit                Configuration audit (tsx)
npm run dev:web                  Next.js dev server (port 3000)
npm run setup                    Token setup
npm run status                   Wallet status
npm run audit                    Configuration audit
npm run wizard                   Interactive .env wizard
npm run smoke-test               Auth flow smoke test
npm run read-accounting          HCS-20 audit trail reader
npm run build                    Compile CLI + shebang injection
npm run build:web                Next.js production build
npm test                         Run test suite (380 tests)
npm run check-protocols          MCP + A2A parity smoke test against a deployed URL
```

**Dual tsconfig note:** The project uses `tsconfig.json` for Next.js (App Router,
JSX, DOM types) and `tsconfig.cli.json` for the CLI/agent code (Node.js, no JSX).
The `npm run build` command uses `tsconfig.cli.json`.

---

## Testing

The project includes unit and integration tests using the Node.js test runner.
No network access or Hedera credentials needed -- all external calls are tested
against pure logic or mocked.

```bash
npm test
```

380 tests covering:
- **BudgetManager** -- spend tracking, pool limits, reserve checks
- **StrategyEngine** -- pool filtering, EV scoring, strategy accessors
- **ReportGenerator** -- aggregation, timestamps, reset behavior
- **StrategySchema** -- Zod validation, defaults, built-in strategy file parsing
- **estimateGas** -- gas calculations, multipliers, cap enforcement
- **Agent play loop** -- phase orchestration, budget exhaustion, error resilience, prerequisite handling
- **Auth system** -- challenge generation, signature verification, session lifecycle, tier enforcement
- **Multi-user** -- registration, deposit tracking, withdrawal, rake calculation, reconciliation, per-token reservation invariants
- **Operator tools** -- dead letters, refunds, health checks
- **A2A** -- Agent Card builder, message parsing, MCP-parity adapter (`src/a2a/__tests__/`)
- **HCS-20 audit reader** -- dual-shape parser for v1 batch + v2 sequence trails

---

## Troubleshooting

**"Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY"**
Your `.env` file is missing or has empty values. Copy `.env.example` and fill in credentials.

**"TOKEN_ALREADY_ASSOCIATED"**
Harmless -- the token is already set up. The `--setup` command handles this gracefully.

**"Balance below reserve"**
The agent won't play if your balance drops below the per-token `reserve` threshold in the strategy's `tokenBudgets`.
Fund the agent wallet with more HBAR/LAZY.

**"OWNER_EOA not set"**
Add `OWNER_EOA=0.0.XXXXX` to `.env`. Without it, prizes stay in the agent wallet.
(Not required in multi-user mode -- each user has their own EOA set at registration.)

**"No LAZY allowance to GasStation"**
Run `lazylotto-agent --setup` to set token approvals.

**Mirror node delays**
The Hedera mirror node has ~4 second propagation delay. The agent waits automatically
after transactions before checking results.

**MCP connection failures**
Verify `LAZYLOTTO_MCP_URL` is correct and the endpoint is reachable.
Check `LAZYLOTTO_MCP_API_KEY` if the endpoint requires authentication.
- Testnet dApp: `https://testnet-dapp.lazysuperheroes.com/api/mcp`
- Mainnet dApp: `https://dapp.lazysuperheroes.com/api/mcp`

**"Access denied" on multi-user tools**
Your session token does not have the required authorization tier. User-tier
sessions cannot call admin/operator tools. Check that your account ID is
listed in the appropriate admin or operator configuration.

**"Operation in progress for this user"**
Another request is already executing a play or withdrawal for this user.
The distributed lock prevents concurrent operations. Wait a moment and retry.

**Deposits not appearing (hosted mode)**
In serverless mode, deposits are detected on-demand, not via background polling.
Call `multi_user_deposit_info` or `multi_user_play` to trigger deposit detection.
If the deposit still does not appear, check that the transfer memo matches the
user's assigned deposit memo exactly.

---

## Known Limitations and Future Considerations

**Dual MCP role in serverless.** Each play request acts as both MCP server (receiving
the tool call) and MCP client (connecting to the dApp to read pool data). This works
but means two MCP transport handshakes per play. A future optimisation would be a
direct HTTP client for dApp reads in serverless mode, bypassing the MCP client
transport entirely. This would eliminate the webpack externalization requirement and
reduce cold start latency.

**Webpack externalization.** The `@modelcontextprotocol/sdk` package must be
externalized from webpack server-side builds because minification breaks its
transport layer. This is a standard pattern (similar to Prisma, etc.) but means the
SDK is loaded from `node_modules` at runtime rather than bundled.

**On-demand deposit detection.** Covered in detail under
[Production Hardening → Deferred Hardening](#deferred-hardening). Summary:
deposits are detected when a user interacts, not on a cron schedule. This is
a deliberate choice documented there with an explicit "revisit when"
condition. The `DepositWatcher.pollOnce()` API is already in place if a cron
route is ever added.

**Mirror node latency at scale.** Each balance-dependent request triggers a mirror
node query (~1-2s). With many concurrent users, consider adding a short cache layer
or moving to cron-based deposit polling to reduce per-request latency.

**Strategy files.** Built-in strategies are inlined in `src/config/loader.ts` for
serverless compatibility. If you modify `strategies/*.json`, update the inline copies
too, or they will diverge on Vercel.

---

## Links

| Resource | URL |
|----------|-----|
| LazyLotto dApp (testnet) | https://testnet-dapp.lazysuperheroes.com |
| LazyLotto dApp (mainnet) | https://dapp.lazysuperheroes.com |
| Hosted agent (testnet) | https://testnet-agent.lazysuperheroes.com |
| Agent MCP endpoint (testnet) | https://testnet-agent.lazysuperheroes.com/api/mcp |
| Agent A2A endpoint (testnet) | https://testnet-agent.lazysuperheroes.com/api/a2a |
| Agent Card (testnet) | https://testnet-agent.lazysuperheroes.com/.well-known/agent-card.json |
| Lazy Superheroes | https://lazysuperheroes.com |
| GitHub | https://github.com/lazysuperheroes/lazylotto-agent |

### Internal docs

- **[PLAYERS.md](PLAYERS.md)** — friendly guide for players
- **[FEATURES.md](FEATURES.md)** — feature breakdown by audience
- **[CHANGELOG.md](CHANGELOG.md)** — release history
- **[docs/blog/](docs/blog/)** — engineering blog (product, security, architecture)
- **[docs/getting-started.md](docs/getting-started.md)** — three-modes setup runbook
- **[docs/MULTI_USER.md](docs/MULTI_USER.md)** — custodial-mode reference
- **[docs/testnet-user-guide.md](docs/testnet-user-guide.md)** — end-user dashboard + Claude flow
- **[docs/hcs20-v2-schema.md](docs/hcs20-v2-schema.md)** — external-auditor wire spec
- **[docs/incident-playbook.md](docs/incident-playbook.md)** — 2am-page runbook
- **[docs/disaster-recovery.md](docs/disaster-recovery.md)** — Redis loss recovery
- **[docs/mainnet-deploy-checklist.md](docs/mainnet-deploy-checklist.md)** — production deploy

---

## License

MIT
