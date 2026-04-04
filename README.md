# LazyLotto Agent

Autonomous AI agent that plays the [LazyLotto](https://lazysuperheroes.com) lottery
on Hedera. The agent evaluates pools, buys entries, rolls for prizes, transfers
winnings, and manages its budget -- all without human intervention.

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
| **admin** | Refund, dead-letter queue, all user views | Configured admin accounts |
| **operator** | Fee withdrawal, reconciliation, health | Configured operator accounts |

**Per-user ownership enforcement:** User-tier sessions can only access their own
data. The server resolves the caller's identity from their session token and
rejects cross-user access attempts.

**Distributed locking:** Concurrent play and withdrawal operations for the same
user are prevented via per-user mutex locks (Redis-backed in hosted mode). This
ensures sequential execution even across multiple serverless function instances.

**Rate limiting:** The MCP endpoint enforces 30 requests per minute per
authenticated identity.

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
admin/operator account IDs. See the dedicated guides:

- [Multi-User Guide](docs/MULTI_USER.md) -- full custodial mode documentation
- [Auth Architecture](docs/HEDERA_AUTH_ARCHITECTURE.md) -- challenge-response auth design
- [Testnet Playbook](docs/TESTNET_PLAYBOOK.md) -- end-to-end testnet walkthrough

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
| `MCP_AUTH_TOKEN` | No | Static auth token for single-user MCP server |
| `OPERATOR_WITHDRAW_ADDRESS` | No | Restrict operator fee withdrawals to this address |

**Hosted deployment (Vercel):**

| Variable | Required | Description |
|----------|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL for sessions and persistence |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token |

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

See [MCP Server Reference](docs/MCP_SERVER.md) for detailed parameter schemas and examples.

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
npm test                         Run test suite (339 tests)
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

339 tests covering:
- **BudgetManager** -- spend tracking, pool limits, reserve checks
- **StrategyEngine** -- pool filtering, EV scoring, strategy accessors
- **ReportGenerator** -- aggregation, timestamps, reset behavior
- **StrategySchema** -- Zod validation, defaults, built-in strategy file parsing
- **estimateGas** -- gas calculations, multipliers, cap enforcement
- **Agent play loop** -- phase orchestration, budget exhaustion, error resilience, prerequisite handling
- **Auth system** -- challenge generation, signature verification, session lifecycle, tier enforcement
- **Multi-user** -- registration, deposit tracking, withdrawal, rake calculation, reconciliation
- **Operator tools** -- dead letters, refunds, health checks

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

## Links

| Resource | URL |
|----------|-----|
| LazyLotto dApp (testnet) | https://testnet-dapp.lazysuperheroes.com |
| LazyLotto dApp (mainnet) | https://dapp.lazysuperheroes.com |
| Hosted agent (testnet) | https://testnet-agent.lazysuperheroes.com |
| Lazy Superheroes | https://lazysuperheroes.com |
| GitHub | https://github.com/lazysuperheroes/lazylotto-agent |

---

## License

MIT
