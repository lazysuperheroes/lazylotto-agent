# LazyLotto Agent

Autonomous AI agent that plays the [LazyLotto](https://lazylotto.app) lottery on Hedera.
The agent evaluates pools, buys entries, rolls for prizes, transfers winnings to
your wallet, and manages its budget — all without human intervention.

```
 Your Wallet (Owner)                 Agent Wallet
 +-----------------------+          +------------------------+
 | Holds LSH NFTs        |  delegate|  Funded with HBAR/LAZY |
 | Holds main funds      |--------->|  Plays lottery pools   |
 | Claims prizes on dApp |  NFTs   |  Transfers prizes back |
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

---

## Security Model

> **The agent wallet is a HOT WALLET. Its private key is stored in `.env` on disk.**

**Follow these rules:**

1. **Use a DEDICATED Hedera account** for the agent. Never use your main wallet,
   treasury, or any account holding significant assets.

2. **Fund it minimally.** Load only enough HBAR and LAZY for a few play sessions.
   You can always top it up later.

3. **Never commit `.env`** to version control. The `.gitignore` already excludes it.

4. **Set `OWNER_EOA`** to your main wallet. Prizes are transferred in-memory to this
   address — you claim them from the LazyLotto dApp. The agent never needs your
   main wallet's private key.

5. **Use `--audit`** to verify your configuration before playing on mainnet.

6. **Keep NFTs in your owner wallet.** Delegate them to the agent for win rate
   bonuses — don't transfer them. See [Delegation & Bonuses](#delegation--bonuses).

---

## Getting Started

There are three ways to set up the agent. Pick the one that suits you.

### Path A: Interactive Wizard (recommended for first-timers)

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

### Path B: Claude-Guided Setup (via MCP)

If the agent is already connected to Claude Desktop as an MCP server,
Claude can guide you through setup using the `agent_onboard` tool.

Claude will call `agent_onboard`, get a checklist of what's configured and
what's missing, then walk you through each step conversationally — checking
balances, explaining delegation, and running the audit.

See [MCP Server](#mcp-server-claude-desktop-integration) for how to connect.

### Path C: Manual Setup

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
| `OWNER_EOA` | Yes | Your wallet address — receives prizes |
| `STRATEGY` | No | Strategy name or path (default: `balanced`) |
| `DELEGATE_REGISTRY_ID` | No | Delegate registry contract (for --audit) |
| `LSH_TOKEN_ID` | No | LSH NFT token ID (for --audit) |
| `HOL_API_KEY` | No | HOL registry API key |

### Strategy Files

Three built-in strategies ship in `strategies/`:

| Strategy | Budget | Entries/Pool | Risk | Approach |
|----------|--------|-------------|------|----------|
| **conservative** | 50 HBAR/session | 3 | Low | High win rate pools only (>10%), small bets |
| **balanced** | 100 HBAR/session | 5 | Moderate | All pools, moderate EV threshold |
| **aggressive** | 500 HBAR/session | 20 | Higher | Pools with 2+ prizes, large batches |

Select via `STRATEGY=conservative` in `.env` or pass a path to a custom JSON file.

### Custom Strategies

Create a JSON file matching this schema:

```json
{
  "name": "my-strategy",
  "description": "My custom strategy",
  "poolFilter": {
    "type": "all",
    "minWinRate": 5,
    "maxEntryFee": 100,
    "feeToken": "LAZY",
    "minPrizeCount": 1
  },
  "budget": {
    "maxSpendPerSession": 100,
    "maxSpendPerPool": 50,
    "maxEntriesPerPool": 10,
    "reserveBalance": 10,
    "currency": "LAZY"
  },
  "playStyle": {
    "action": "buy_and_roll",
    "entriesPerBatch": 3,
    "minExpectedValue": -10,
    "claimImmediately": true,
    "transferToOwner": true,
    "ownerAddress": "0.0.67890"
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

## Delegation & Bonuses

LazyLotto applies win rate bonuses based on:

1. **Delegated LSH NFTs** — Lazy Superheroes NFTs whose bonus authority is
   delegated to the agent via the LazyDelegateRegistry.
2. **LAZY token balance** — The agent's own LAZY holding can contribute to boost.

### How Delegation Works

The owner (you) calls `delegateNFT` on the LazyDelegateRegistry contract from
**your wallet** — not the agent's. This grants the agent the win rate bonus
from your NFTs without transferring custody.

```
Owner wallet → delegateNFT(agentAddress, lshTokenAddress, [serial1, serial2])
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
        "LAZYLOTTO_MCP_URL": "https://lazylotto.app/api/mcp",
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

| Tool | Description |
|------|-------------|
| `agent_onboard` | Step-by-step onboarding checklist — Claude uses this to guide you |
| `agent_play` | Run a play session (optional budget/poolId override) |
| `agent_status` | Wallet balances, pending prizes, session history, cumulative stats |
| `agent_transfer_prizes` | Transfer all pending prizes to OWNER_EOA |
| `agent_set_strategy` | Switch strategy (built-in name or full JSON) |
| `agent_wallet_info` | Detailed wallet: tokens, NFTs, approvals, contracts |
| `agent_withdraw` | Withdraw HBAR or LAZY to owner (fund recovery) |
| `agent_stop` | Stop active session, transfer prizes, return summary |
| `agent_audit` | Full config audit with warnings and recommendations |

**Multi-user tools** (available when running with `--multi-user --mcp-server`):

| Tool | Description |
|------|-------------|
| `multi_user_status` | List all users with balances and activity |
| `multi_user_register` | Register a user, get deposit memo |
| `multi_user_deposit_info` | Get deposit instructions for existing user |
| `multi_user_play` | Play for a specific user or all eligible |
| `multi_user_withdraw` | Process user withdrawal |
| `multi_user_deregister` | Deactivate user (withdraw-only) |
| `multi_user_play_history` | View play session results for a user |
| `operator_balance` | Operator rake collected, gas spent, net profit |
| `operator_withdraw_fees` | Withdraw operator earnings |
| `operator_health` | Uptime, watcher status, error count |

See [Multi-User Documentation](docs/MULTI_USER.md) for the full custodial mode guide.

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
lazylotto-agent --mcp-server     Start MCP server (for Claude Desktop)
lazylotto-agent --scheduled      Run play sessions on cron schedule
lazylotto-agent --multi-user     Start multi-user custodial agent
lazylotto-agent --multi-user --deploy-accounting  Deploy HCS-20 topic
lazylotto-agent --multi-user --mcp-server         MCP server with multi-user tools
```

Development equivalents:

```
npm run dev                      Single play session (tsx)
npm run dev:mcp                  MCP server (tsx)
npm run dev:scheduled            Scheduled mode (tsx)
npm run dev:audit                Configuration audit (tsx)
npm run setup                    Token setup
npm run status                   Wallet status
npm run audit                    Configuration audit
npm test                         Run test suite
```

---

## How the Agent Plays

Each session follows a 6-phase loop:

1. **Preflight** — Verify wallet balance (HBAR + LAZY), check reserve threshold
2. **Discover** — Query all pools via MCP, filter by strategy criteria
3. **Evaluate** — Calculate expected value (EV) per pool including win rate boost
4. **Play** — For each qualifying pool: check prerequisites, auto-fix (associate
   tokens, approve allowances), buy entries, roll
5. **Transfer** — Move pending prizes to owner via `transferPendingPrizes`
6. **Report** — Print session summary (pools played, wins, net P&L)

The agent is resilient: individual pool failures are caught and logged without
crashing the session. Prize transfer is always attempted even if play operations fail.

---

## Testing

The project includes unit and integration tests using the Node.js test runner.
No network access or Hedera credentials needed — all external calls are tested
against pure logic or mocked.

```bash
npm test
```

Test coverage:
- **BudgetManager** — spend tracking, pool limits, reserve checks
- **StrategyEngine** — pool filtering, EV scoring, strategy accessors
- **ReportGenerator** — aggregation, timestamps, reset behavior
- **StrategySchema** — Zod validation, defaults, built-in strategy file parsing
- **estimateGas** — gas calculations, multipliers, cap enforcement
- **Agent play loop** — phase orchestration, budget exhaustion, error resilience, prerequisite handling

---

## Troubleshooting

**"Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY"**
Your `.env` file is missing or has empty values. Copy `.env.example` and fill in credentials.

**"TOKEN_ALREADY_ASSOCIATED"**
Harmless — the token is already set up. The `--setup` command handles this gracefully.

**"Balance below reserve"**
The agent won't play if your balance drops below the strategy's `reserveBalance`.
Fund the agent wallet with more HBAR/LAZY.

**"OWNER_EOA not set"**
Add `OWNER_EOA=0.0.XXXXX` to `.env`. Without it, prizes stay in the agent wallet.

**"No LAZY allowance to GasStation"**
Run `lazylotto-agent --setup` to set token approvals.

**Mirror node delays**
The Hedera mirror node has ~4 second propagation delay. The agent waits automatically
after transactions before checking results.

**MCP connection failures**
Verify `LAZYLOTTO_MCP_URL` is correct and the endpoint is reachable.
Check `LAZYLOTTO_MCP_API_KEY` if the endpoint requires authentication.

---

## License

MIT
