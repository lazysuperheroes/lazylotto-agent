# Getting Started with LazyLotto Agent

This guide covers three distinct ways to run the LazyLotto Agent. Pick the mode
that matches your use case, follow the steps, and you will have the agent playing
the LazyLotto lottery on Hedera.

---

## Table of Contents

1. [Overview: Three Modes](#overview-three-modes)
2. [Mode 1: Single-User Local](#mode-1-single-user-local)
3. [Mode 2: Multi-User Local (Operator CLI)](#mode-2-multi-user-local-operator-cli)
4. [Mode 3: Multi-User Hosted (Primary Use Case)](#mode-3-multi-user-hosted-primary-use-case)
5. [Strategies](#strategies)
6. [Troubleshooting](#troubleshooting)

---

## Overview: Three Modes

| | Single-User Local | Multi-User Local | Multi-User Hosted |
|---|---|---|---|
| **Who runs it** | You, on your machine | You, as an operator | Deployed to Vercel |
| **Whose funds** | Yours | Multiple users' deposits | Multiple users' deposits |
| **Prizes go to** | Your OWNER_EOA | Each user's registered EOA | Each user's registered EOA |
| **Accounting** | None (single owner) | HCS-20 on-chain ledger | HCS-20 on-chain ledger |
| **Fees** | None | Rake on deposits | Rake on deposits |
| **Auth** | Optional MCP_AUTH_TOKEN | Optional MCP_AUTH_TOKEN | Hedera wallet signature |
| **Persistence** | None needed | JSON files (or Redis) | Upstash Redis (required) |
| **Frontend** | None | None | Web dashboard + auth page |
| **Good for** | Individual automated play | Operators on own infra | Default user experience |

---

## Mode 1: Single-User Local

The agent runs on your machine and plays with your funded wallet. You own the
strategy, the budget, and the prizes. No users, no fees, no web frontend.

### Prerequisites

- Node.js 20+
- A **dedicated** Hedera testnet account (not your main wallet)
- That account's private key in DER hex format (starts with `302e` or `3030`)
- The account funded with testnet HBAR (use https://portal.hedera.com/faucet)
- Testnet LAZY tokens in the account (token ID: `0.0.8011209`)
- Your personal wallet account ID (this is the owner -- where prizes go)

### Setup

**Step 1: Clone and install.**

```bash
git clone https://github.com/lazysuperheroes/lazylotto-agent.git
cd lazylotto-agent
npm install
```

**Step 2: Run the interactive wizard.**

```bash
npm run wizard
```

The wizard walks you through creating a `.env` file. It will ask for:

1. Network (`testnet` or `mainnet`)
2. Agent account ID and private key
3. Owner account ID (your personal wallet -- prizes go here)
4. LazyLotto MCP URL (accept the default for testnet)
5. Strategy (`conservative`, `balanced`, or `aggressive`)
6. Contract addresses (accept testnet defaults)

Alternatively, copy `.env.example` and fill it in manually.

**Step 3: Run first-time setup.**

```bash
npm run setup
```

This associates the LAZY token with your agent wallet and sets the required
contract approvals (LAZY to GasStation, other tokens to LazyLottoStorage).

**Step 4: Verify your configuration.**

```bash
npm run audit
```

Check that your wallet balances, token associations, and approvals all look
correct. Fix any warnings before playing.

### Environment Variables (Single-User)

| Variable | Required | Description |
|---|---|---|
| `HEDERA_NETWORK` | Yes | `testnet` or `mainnet` |
| `HEDERA_ACCOUNT_ID` | Yes | Agent wallet account (e.g., `0.0.12345`) |
| `HEDERA_PRIVATE_KEY` | Yes | Agent wallet private key (DER hex) |
| `OWNER_EOA` | Yes | Your personal wallet -- prizes transfer here |
| `LAZYLOTTO_MCP_URL` | Yes | dApp MCP endpoint for pool data reads |
| `LAZY_TOKEN_ID` | Yes | LAZY token ID (`0.0.8011209` testnet, `0.0.1311037` mainnet) |
| `STRATEGY` | Yes | `conservative`, `balanced`, `aggressive`, or path to JSON |
| `LAZYLOTTO_CONTRACT_ID` | Yes | LazyLotto contract address |
| `LAZYLOTTO_STORAGE_ID` | Yes | LazyLotto storage address |
| `LAZYLOTTO_POOL_MANAGER_ID` | Yes | Pool manager address |
| `LAZY_GAS_STATION_ID` | Yes | GasStation contract address |
| `LAZYLOTTO_MCP_API_KEY` | No | API key for the dApp MCP (if required) |

### How to Play

**One-off session** -- evaluates pools, buys entries, rolls, transfers prizes:

```bash
npm run dev
```

**Scheduled mode** -- runs sessions on a cron schedule defined in your strategy:

```bash
npm run dev:scheduled
```

**Via Claude Desktop** -- start as an MCP server on stdio:

```bash
npm run dev:mcp
```

Then add this to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "command": "node",
      "args": [
        "--import", "tsx",
        "/path/to/lazylotto-agent/src/index.ts",
        "--mcp-server"
      ],
      "env": {
        "DOTENV_CONFIG_PATH": "/path/to/lazylotto-agent/.env"
      }
    }
  }
}
```

Restart Claude Desktop. You can then ask Claude to "play a lottery session",
"check agent status", or "transfer my prizes".

### Verify It Works

1. `npm run audit` -- should show green checks, correct balances, no critical warnings
2. `npm run dev` -- should discover pools, evaluate EV, buy entries, report results
3. Check your OWNER_EOA on https://hashscan.io/testnet for prize transfers
4. Claim prizes from the LazyLotto dApp at https://testnet-dapp.lazysuperheroes.com

### How Users Interact

There is only one user: you. Interaction is via the CLI or via Claude Desktop
when running as an MCP server. Available tools in MCP mode:

- `agent_play` -- run a play session
- `agent_status` -- check wallet and session state
- `agent_transfer_prizes` -- move prizes to your OWNER_EOA
- `agent_set_strategy` -- change the active strategy
- `agent_wallet_info` -- wallet balances and token info
- `agent_audit` -- full configuration diagnostic
- `agent_onboard` -- guided first-time setup
- `agent_withdraw` -- withdraw funds from agent wallet

---

## Mode 2: Multi-User Local (Operator CLI)

You run the agent as an operator managing multiple users' funds. Users deposit
to the agent wallet with a unique memo, the agent plays on their behalf, charges
a rake fee, and records everything on an HCS-20 on-chain audit trail.

### Prerequisites

Everything from Single-User, plus:

- Familiarity with custodial responsibilities (you hold users' funds)
- An HCS-20 topic for on-chain accounting (the agent can deploy one for you)
- Optionally: an Upstash Redis instance for persistent session/user storage

### Setup

**Step 1: Start from a working single-user setup.**

Complete Mode 1 first. Verify the agent can play and your wallet is funded.

**Step 2: Add multi-user environment variables.**

Add these to your `.env`:

```bash
# Multi-User Mode
MULTI_USER_ENABLED=true
RAKE_DEFAULT_PERCENT=5.0
RAKE_MIN_PERCENT=2.0
RAKE_MAX_PERCENT=5.0
MAX_USER_BALANCE=10000

# MCP Server Authentication (recommended)
MCP_AUTH_TOKEN=your-secret-token-here
```

**Step 3: Deploy the HCS-20 accounting topic.**

```bash
npx lazylotto-agent --multi-user --deploy-accounting
```

This creates an HCS-20 topic on Hedera and prints the topic ID. Add it to `.env`:

```bash
HCS20_TOPIC_ID=0.0.XXXXXXX
HCS20_TICK=LLCRED
```

**Step 4: Start the multi-user agent.**

```bash
npx lazylotto-agent --multi-user
```

Or as an MCP server:

```bash
npx lazylotto-agent --multi-user --mcp-server
```

### Environment Variables (Multi-User Local)

Everything from Single-User, plus:

| Variable | Required | Description |
|---|---|---|
| `MULTI_USER_ENABLED` | Yes | Set to `true` |
| `RAKE_DEFAULT_PERCENT` | No | Default rake fee (default: `5.0`) |
| `RAKE_MIN_PERCENT` | No | Minimum negotiable rake (default: `2.0`) |
| `RAKE_MAX_PERCENT` | No | Maximum rake (default: `5.0`) |
| `MAX_USER_BALANCE` | No | Maximum per-user balance (default: `10000`) |
| `HCS20_TOPIC_ID` | Yes | HCS-20 accounting topic (from deploy step) |
| `HCS20_TICK` | No | Accounting token tick (default: `LLCRED`) |
| `MCP_AUTH_TOKEN` | Recommended | Shared token for MCP tool authentication |
| `DEPOSIT_POLL_INTERVAL_MS` | No | Deposit detection polling (default: `10000`) |
| `OPERATOR_WITHDRAW_ADDRESS` | No | Restrict operator fee withdrawals to this address |
| `KV_REST_API_URL` | No | Upstash Redis URL (optional, falls back to JSON) |
| `KV_REST_API_TOKEN` | No | Upstash Redis token |

### How to Verify

1. Start the agent with `--multi-user --mcp-server`
2. Connect via Claude Desktop or another MCP client
3. Call `multi_user_register` with a test account -- should return a deposit memo
4. Send a small HBAR deposit to the agent wallet with that memo
5. Call `multi_user_deposit_info` -- should show the credited balance (minus rake)
6. Call `multi_user_play` -- should run a play session and return results
7. Run `npm run read-accounting` to verify the HCS-20 audit trail

### How Users Interact

Users connect to the agent via MCP (Claude Desktop or other MCP clients). The
typical flow:

1. User adds the MCP server to their client with the `MCP_AUTH_TOKEN`
2. User calls `multi_user_register` with their Hedera account ID and preferred strategy
3. Agent returns a unique deposit memo
4. User transfers HBAR or LAZY to the agent wallet using that memo
5. Agent detects the deposit and credits the user's ledger (minus rake)
6. User calls `multi_user_play` to trigger a lottery session
7. Agent plays using the user's ledger balance and strategy
8. User checks results via `multi_user_deposit_info` or `multi_user_play_history`
9. User calls `multi_user_withdraw` to send remaining balance to their EOA

### Persistence Note

Without Redis, the agent stores user data in JSON files on disk. This is fine
for testing but not suitable for production. If the process crashes, in-memory
session state is lost (though ledger data on disk and HCS-20 records survive).

---

## Mode 3: Multi-User Hosted (Primary Use Case)

This is the default experience. The agent is deployed to Vercel at a public URL.
Users connect via a web dashboard (WalletConnect) or MCP clients (Claude Desktop).
Authentication uses Hedera wallet signature challenge-response. The agent is
discoverable via HOL (HCS-11 registry).

### Prerequisites

- A Vercel account
- An Upstash Redis instance (for sessions and persistence)
- A dedicated Hedera account for the agent (funded)
- An HCS-20 topic (deploy before or during first setup)
- A domain or Vercel subdomain for the agent URL

### Setup

**Step 1: Clone and configure.**

```bash
git clone https://github.com/lazysuperheroes/lazylotto-agent.git
cd lazylotto-agent
npm install
```

**Step 2: Deploy HCS-20 accounting topic (if not done already).**

```bash
npx lazylotto-agent --multi-user --deploy-accounting
```

Save the printed topic ID.

**Step 3: Configure Vercel environment variables.**

Set all of these in your Vercel project settings (Settings > Environment Variables):

| Variable | Required | Description |
|---|---|---|
| `HEDERA_NETWORK` | Yes | `testnet` or `mainnet` |
| `HEDERA_ACCOUNT_ID` | Yes | Agent wallet account ID |
| `HEDERA_PRIVATE_KEY` | Yes | Agent wallet private key (DER hex) |
| `LAZYLOTTO_MCP_URL` | Yes | dApp MCP endpoint (see URLs below) |
| `LAZY_TOKEN_ID` | Yes | LAZY token ID for the target network |
| `STRATEGY` | Yes | Default strategy name |
| `MULTI_USER_ENABLED` | Yes | `true` |
| `LAZYLOTTO_CONTRACT_ID` | Yes | LazyLotto contract address |
| `LAZYLOTTO_STORAGE_ID` | Yes | LazyLotto storage address |
| `LAZYLOTTO_POOL_MANAGER_ID` | Yes | Pool manager address |
| `LAZY_GAS_STATION_ID` | Yes | GasStation contract address |
| `HCS20_TOPIC_ID` | Yes | HCS-20 accounting topic ID |
| `RAKE_DEFAULT_PERCENT` | No | Default rake (default: `5.0`) |
| `RAKE_MIN_PERCENT` | No | Minimum negotiable rake (default: `2.0`) |
| `RAKE_MAX_PERCENT` | No | Maximum rake (default: `5.0`) |
| `ADMIN_ACCOUNTS` | Yes | Comma-separated account IDs for admin tier |
| `AUTH_PAGE_ORIGIN` | Yes | CORS origin for the web frontend (e.g., `https://testnet-agent.lazysuperheroes.com`) |
| `KV_REST_API_URL` | Yes | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Yes | Upstash Redis REST token |

Alternative Redis variable names also work: `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`.

**Step 4: Deploy to Vercel.**

```bash
vercel --prod
```

Or connect the GitHub repo to Vercel for automatic deployments.

**Step 5: Register with HOL (optional but recommended).**

```bash
npx lazylotto-agent --register
```

This creates an HCS-11 agent profile and registers the agent with the HOL
Registry, making it discoverable by other agents and MCP clients via its UAID.

**Step 6: Verify the deployment.**

```bash
# Discovery endpoint (no auth required)
curl https://your-agent-url.com/api/discover

# Health check
curl https://your-agent-url.com/api/health
```

The discovery endpoint returns the agent's identity, supported strategies, fee
schedule, accepted deposit tokens, and all available endpoints.

### Key URLs

**dApp MCP endpoints (READ side -- pool data, EV calculations):**

| Network | URL |
|---|---|
| Testnet | `https://testnet-dapp.lazysuperheroes.com/api/mcp` |
| Mainnet | `https://dapp.lazysuperheroes.com/api/mcp` |

**Agent endpoints (WRITE side -- the hosted agent itself):**

| Endpoint | Purpose |
|---|---|
| `/api/discover` | Public discovery (no auth) |
| `/api/health` | Health check |
| `/auth` | Web auth page (WalletConnect) |
| `/api/auth/challenge` | Request a signing challenge |
| `/api/auth/verify` | Submit signed challenge, receive session token |
| `/api/mcp` | MCP endpoint (requires session token) |
| `/dashboard` | User dashboard (requires auth) |

**Hosted agent (testnet):** `https://testnet-agent.lazysuperheroes.com`

### User Flow

This is the end-to-end experience for someone using the hosted agent.

**Via the web dashboard:**

1. Visit `/auth` on the agent URL
2. Connect your Hedera wallet via WalletConnect (HashPack, Blade, etc.)
3. The server generates a challenge nonce
4. Sign the challenge with your wallet
5. The server verifies the signature and issues a session token (7-day expiry)
6. You are redirected to `/dashboard`
7. Register with a preferred strategy
8. Deposit HBAR or LAZY to the agent wallet using the memo shown on your dashboard
9. Trigger play sessions and monitor results from the dashboard

**Via Claude Desktop (MCP):**

1. Visit `/auth` on the agent URL and complete wallet auth (steps 1-5 above)
2. Copy the session token and MCP URL from the auth success screen
3. Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "url": "https://testnet-agent.lazysuperheroes.com/api/mcp",
      "headers": {
        "Authorization": "Bearer sk_your_session_token_here"
      }
    }
  }
}
```

4. Restart Claude Desktop
5. Ask Claude: "Register me for LazyLotto" -- calls `multi_user_register`
6. Deposit to the agent wallet with the memo Claude provides
7. Ask Claude: "Play a lottery session" -- calls `multi_user_play`
8. Ask Claude: "Check my balance" -- calls `multi_user_deposit_info`

### How to Verify (Hosted)

1. `curl /api/discover` returns valid JSON with agent identity and endpoints
2. `curl /api/health` returns a healthy status
3. Visit `/auth`, complete wallet sign-in, receive a session token
4. Add the MCP URL and token to Claude Desktop, verify tools appear
5. Register, deposit a small amount, play a session, check results
6. Run `npm run read-accounting` locally to verify the HCS-20 audit trail

---

## Strategies

The agent ships with three built-in strategies. Set the `STRATEGY` environment
variable or pass a path to a custom JSON file.

| Strategy | Risk | Session Budget | EV Threshold | Play Style |
|---|---|---|---|---|
| `conservative` | Low | Small bets, high reserves | Strict positive EV | Fewer entries, safer pools |
| `balanced` | Moderate | Reasonable budgets | Allows slightly negative EV | Good default for most users |
| `aggressive` | High | Larger bets, more pools | Lenient threshold | More entries, bigger swings |

Strategy files are in the `strategies/` directory. Each defines:

- **Pool filters** -- which pool types and fee tokens to target
- **Budget** -- max spend per session and per pool, reserve amounts
- **Play style** -- entries per batch, EV threshold, prize preferences
- **Schedule** -- cron expression and session caps (for `--scheduled` mode)

To use a custom strategy, create a JSON file following the schema and set
`STRATEGY=/path/to/your-strategy.json`.

---

## Troubleshooting

**"Insufficient balance"**
Fund the agent wallet with more HBAR and/or LAZY. Use the Hedera testnet faucet
at https://portal.hedera.com/faucet for HBAR.

**"No pools match strategy"**
The MCP endpoint may have no active pools, or your strategy filters are too
restrictive. Try `balanced` strategy and verify the `LAZYLOTTO_MCP_URL` is correct.

**"Token not associated"**
Run `npm run setup` to associate the LAZY token and set contract approvals.

**"Contract call failed"**
Verify contract addresses in `.env` match the target network. Testnet and mainnet
have different addresses.

**"Challenge verification failed" (hosted mode)**
Make sure you are signing with the same account you used to request the challenge.
The agent verifies the signature against the account's public key via the Hedera
mirror node.

**Sessions lost on restart (local multi-user)**
Without Redis, in-memory sessions are lost when the process stops. User ledger
data in JSON files and HCS-20 records are preserved. Users will need to
re-authenticate but their balances remain intact.

**Mirror node delay**
Hedera's mirror node has a roughly 4-second propagation delay. After a deposit
or transaction, wait a few seconds before checking balances.

---

## Further Reading

- [How It Works](HOW_IT_WORKS.md) -- architecture overview and flow diagrams
- [Multi-User Guide](MULTI_USER.md) -- deep dive into custodial mode
- [MCP Server Reference](MCP_SERVER.md) -- all available MCP tools
- [Auth Architecture](HEDERA_AUTH_ARCHITECTURE.md) -- signature challenge design
- [Testnet Playbook](TESTNET_PLAYBOOK.md) -- step-by-step testing checklist
