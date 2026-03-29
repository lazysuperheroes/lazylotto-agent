# Multi-User Custodial Mode

## Table of Contents

1. [Overview](#1-overview)
2. [Why Use a Custodial Agent?](#2-why-use-a-custodial-agent)
3. [Operator Setup Guide](#3-operator-setup-guide)
4. [User Guide](#4-user-guide)
5. [Fee Schedule](#5-fee-schedule)
6. [Security Model](#6-security-model)
7. [Play Session Reports](#7-play-session-reports)
8. [On-Chain Accounting (HCS-20)](#8-on-chain-accounting-hcs-20)
9. [MCP Tools Reference](#9-mcp-tools-reference)
10. [CLI Commands](#10-cli-commands)
11. [Configuration Reference](#11-configuration-reference)
12. [Monitoring](#12-monitoring)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Overview

Multi-user custodial mode transforms the LazyLotto agent from a single-owner lottery player into
a shared platform that accepts deposits from multiple users, plays the lottery on their behalf,
routes prizes back to each user's designated address, and charges a configurable rake fee.

The agent runs in one of two modes:

- **Single-user** (default): One wallet, one owner, one strategy. The agent plays using its own
  funds and sends prizes to the configured `OWNER_EOA`. This is the existing behavior.
- **Multi-user** (`--multi-user`): Custodial mode. The agent accepts deposits from any number
  of registered users, maintains per-user ledger balances, plays on their behalf according to
  their chosen strategy, and records every operation on-chain via HCS-20.

### Architecture

```
                    +------------------------------------------+
                    |           MultiUserAgent                  |
                    |   (orchestrator, per-user mutex, play)    |
                    +-----+--------+--------+--------+---------+
                          |        |        |        |
              +-----------+--+  +--+------+ | +------+----------+
              | UserLedger   |  | Deposit | | | Negotiation     |
              | reserve/     |  | Watcher | | | Handler         |
              | settle/      |  | (mirror | | | (registration,  |
              | release      |  |  node   | | |  HCS-10 notify) |
              +-----------+--+  | polling)| | +------+----------+
                          |     +----+----+ |        |
                 +--------+----+     |      |   +----+----+
                 | Persistent  |     |      |   | Gas     |
                 | Store       +-----+------+   | Tracker |
                 | (JSON disk) |                +----+----+
                 +--------+----+                     |
                          |                          |
                 +--------+----+            +--------+--------+
                 | Accounting  |            | Hedera SDK      |
                 | Service     |            | (wallet, txns,  |
                 | (HCS-20    |            |  contracts)      |
                 |  audit log) |            +-----------------+
                 +-------------+
```

### Key Differences from Single-User

| Aspect             | Single-User                        | Multi-User                                  |
|--------------------|------------------------------------|---------------------------------------------|
| Wallet             | Agent owns all funds               | Agent is custodian of user deposits          |
| Strategy           | One global strategy                | Per-user strategy snapshot at registration   |
| Prize routing      | Prizes go to `OWNER_EOA`           | Prizes transfer to each user's EOA           |
| Budget             | From agent wallet balance           | From per-user ledger (reserve-before-spend)  |
| Accounting         | None (single-owner trust model)    | HCS-20 on-chain audit trail                  |
| Registration       | Not needed                         | Via MCP tool or HCS-10 negotiation           |
| Fees               | None                               | Rake on deposits (configurable)              |
| Play execution     | One play session                   | Sequential per-user, capped per cycle        |

---

## 2. Why Use a Custodial Agent?

### Shared NFT Boost

The LazyLotto contract grants a win rate boost based on delegated LSH NFTs. The operator
delegates their NFTs to the agent wallet, and every user who plays through the agent benefits
from the higher win rate. Users who do not hold LSH NFTs themselves gain access to a boost
they could not achieve independently.

### No Infrastructure Required

Users do not need to run their own agent, manage private keys for an agent wallet, handle
Hedera token associations, or maintain a server. They register, deposit funds, and the agent
handles all on-chain interactions.

### Professional Strategy Management

The operator curates and maintains strategy configurations (conservative, balanced, aggressive).
Users select a strategy at registration, and the agent freezes a snapshot of that strategy for
reproducibility. Strategy updates by the operator apply only to new registrations.

### Full Transparency

Every credit-affecting operation -- deposit, spend, rake fee, withdrawal -- is recorded as an
immutable HCS-20 message on a Hedera Consensus Service topic. Any third party can reconstruct
the full accounting history from the public mirror node without trusting the operator.

### Discoverable

The agent registers with the Hashgraph Online (HOL) registry using `FEE_BASED` inbound policy.
Other AI agents or wallets can discover it, negotiate terms via HCS-10, and onboard users
programmatically.

---

## 3. Operator Setup Guide

### Prerequisites

- Node.js 20 or later
- A funded Hedera account (HBAR for gas, LAZY for token operations)
- The `lazylotto-agent` package installed

### Step 1: Configure Environment

Copy `.env.example` to `.env` and set the multi-user variables:

```bash
cp .env.example .env
```

Required additions to `.env`:

```env
# Enable custodial mode
MULTI_USER_ENABLED=true

# Rake configuration (percentage of each deposit)
RAKE_DEFAULT_PERCENT=1.0
RAKE_MIN_PERCENT=0.5
RAKE_MAX_PERCENT=3.0

# Deposit watcher polling interval (milliseconds)
DEPOSIT_POLL_INTERVAL_MS=10000

# Maximum LAZY/HBAR balance per user (risk limit)
MAX_USER_BALANCE=10000

# HCS-20 accounting token ticker
HCS20_TICK=LLCRED

# HCS-20 topic ID (set after deploying -- see Step 4)
HCS20_TOPIC_ID=
```

All other standard variables (`HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, contract IDs, etc.)
must also be configured. See `.env.example` for the full list.

### Step 2: Fund the Agent Wallet

The agent wallet needs:

- **HBAR**: For gas on all on-chain operations (play, withdraw, HCS messages). A minimum of
  10 HBAR is recommended for initial operations.
- **LAZY**: Only if the agent itself needs to hold LAZY for token transfer operations. In most
  cases, users deposit LAZY directly.

Send funds to the `HEDERA_ACCOUNT_ID` configured in `.env`.

### Step 3: Run Setup

```bash
lazylotto-agent --setup
```

This performs first-time wallet configuration:

- Associates the LAZY token with the agent account
- Sets token allowances (LAZY to LazyGasStation, prize tokens to LazyLottoStorage)

### Step 4: Deploy HCS-20 Accounting Topic

```bash
lazylotto-agent --multi-user --deploy-accounting
```

This creates a new HCS topic on Hedera and submits the HCS-20 deploy message. The command
outputs a topic ID. Add it to your `.env`:

```env
HCS20_TOPIC_ID=0.0.XXXXXXX
```

The agent uses the operator's private key as both the admin key and submit key for the topic,
ensuring only the agent can write accounting records.

### Step 5: Register with HOL (Optional)

```bash
lazylotto-agent --register
```

This registers the agent in the Hashgraph Online registry with `FEE_BASED` inbound policy,
making it discoverable by other agents and wallets via HCS-10.

### Step 6: Delegate LSH NFTs (Optional)

From your owner wallet (not the agent wallet), delegate LSH NFTs to the agent's Hedera
account using the delegate registry contract. This gives all users the shared win rate boost.

### Step 7: Start the Agent

```bash
# Basic multi-user mode (deposit watcher + cron play sessions)
lazylotto-agent --multi-user

# With MCP server for tool-based interaction
lazylotto-agent --multi-user --mcp-server
```

---

## 4. User Guide

Users can interact with the custodial agent through two paths.

### Path A: Via HCS-10 (Agent-to-Agent)

This path is designed for AI agents and automated wallets that communicate via
Hedera Consensus Service messaging.

1. **Discover**: Query the HOL registry for LazyLotto agents. The agent's entry includes
   its inbound topic ID and `FEE_BASED` policy.

2. **Connect**: Send an HCS-10 connection request to the agent's inbound topic.

3. **Receive welcome**: The agent responds with a `welcome` message containing:
   - Available strategies (`conservative`, `balanced`, `aggressive`)
   - Default rake percentage and negotiable range
   - Current boost (basis points from delegated NFTs)
   - Minimum deposit and maximum balance
   - Agent wallet address

4. **Configure**: Send a `configure` message specifying:
   - Strategy name
   - EOA address for prize delivery
   - Optional rake percentage (within the configured band)

5. **Receive deposit memo**: The agent responds with a `deposit_memo` message containing
   a unique memo string (e.g., `ll-a3f8c2b91e04`) and the agent wallet address.

6. **Deposit**: Send HBAR or LAZY to the agent wallet with the memo in the transaction.

7. **Confirmation**: The agent sends a `deposit_confirmed` message with gross amount,
   rake deducted, net credited, and updated balances.

### Path B: Via MCP Tool

This path is for direct interaction through the agent's MCP server.

1. **Register**: Call `multi_user_register` with:
   - `accountId`: Your Hedera account ID (e.g., `0.0.12345`)
   - `eoaAddress`: Your EOA for prize delivery (Hedera `0.0.X` or Ethereum `0x` format)
   - `strategy`: One of `conservative`, `balanced`, `aggressive`
   - `rakePercent` (optional): Negotiated rake within the operator's band

2. **Receive deposit info**: The response includes your unique deposit memo and the
   agent wallet address.

3. **Deposit**: Send HBAR or LAZY to the agent wallet with your deposit memo.

### After Funding

Once a user has a positive balance, the following operations are available:

| Operation                  | How                                     | Description                                           |
|----------------------------|-----------------------------------------|-------------------------------------------------------|
| Play                       | Cron schedule or `multi_user_play`      | Agent plays lottery pools using the user's strategy   |
| Check balance              | `multi_user_status`                     | View available, reserved, total deposited/withdrawn   |
| View play history          | `multi_user_play_history`               | Full session results with pool-level detail           |
| Receive prizes             | Automatic via `transferPendingPrizes`   | Prizes route to the user's EOA after each session     |
| Withdraw remaining balance | `multi_user_withdraw`                   | On-chain transfer to the user's Hedera account        |
| Deregister                 | `multi_user_deregister`                 | Deactivates account; user can still withdraw balance  |

**Important**: After deregistration, no new deposits, plays, or reserves are permitted. The
user can only withdraw their remaining available balance.

---

## 5. Fee Schedule

### Rake

The rake is a percentage deducted from each deposit before crediting the user's balance.

| Parameter          | Default | Range         | Description                              |
|--------------------|---------|---------------|------------------------------------------|
| Default rake       | 5.0%    | --            | Applied for small deposits               |
| Minimum rake       | 2.0%    | --            | Floor (for large-volume users)           |
| Maximum rake       | 5.0%    | --            | Ceiling                                  |
| Negotiated rake    | Varies  | [min, max]    | Volume-based or per-user override        |

Volume-based tiers (automatic): 1000+ HBAR = 3%, 500+ = 3.5%, 200+ = 4%, under 50 = 5%.

**Example**: A user deposits 100 HBAR with a 5% rake. The rake amount is 5 HBAR. The user's
ledger is credited with 95 HBAR. The operator's platform balance increases by 5 HBAR.

### Negotiation

Rake negotiation is available during:

- HCS-10 onboarding: The user sends a `configure` message with a `rakePercent` field.
- MCP registration: The user passes `rakePercent` to `multi_user_register`.
- Operator override: The operator can set a per-user rake at any time.

Any proposed rate is clamped to the `[RAKE_MIN_PERCENT, RAKE_MAX_PERCENT]` range.

### Gas Costs

All HBAR gas costs for on-chain transactions (buying entries, rolling, transferring prizes,
HCS messages) are paid from the operator's platform balance, not from user balances. This
means users' deposited funds go entirely toward lottery entries (after rake).

### Connection Fee

When using the HCS-10 path, a small HBAR fee may be required for the connection request.
This serves as spam prevention and is configured by the HOL registry's `FEE_BASED` inbound
policy.

### Transparency

Use the `operator_balance` MCP tool to view full accounting:

```json
{
  "platformBalance": 45.2,
  "totalRakeCollected": 52.0,
  "totalGasSpent": 3.8,
  "totalWithdrawnByOperator": 3.0,
  "netProfit": 45.2
}
```

---

## 6. Security Model

### Reserve-Before-Spend

Before any on-chain play interaction, the agent atomically moves funds from a user's
`available` balance to `reserved`. If the play session fails at any point, the full reserved
amount is released back to `available`. If the play succeeds, only the actual amount spent is
settled (deducted from reserved), and any unused reservation is released.

```
available ──[reserve]──> reserved ──[settleSpend]──> deducted
                             │
                             └──[releaseReserve]──> available (on failure)
```

This prevents the agent from losing track of user funds even during partial failures.

### Per-User Mutex

A promise-based mutex keyed by `userId` prevents concurrent play sessions or withdrawals for
the same user. This is critical because the agent wallet is shared: if two operations for the
same user ran concurrently, prize disambiguation would be impossible.

Different users do not block each other at the mutex level, though `playForAllEligible`
processes users sequentially for prize disambiguation.

### Startup Recovery

On every startup, `PersistentStore.load()` scans all user balances. Any `reserved > 0`
amounts are moved back to `available`. This handles the case where the agent crashed mid-play
session with funds locked in reservation.

### Idempotent Deposits

Every processed transaction ID is stored in a `Set<string>` and persisted to disk. The
`DepositWatcher` and `UserLedger` both check this set before crediting. Restarting the agent
or re-polling the same mirror node page cannot double-credit a deposit.

### On-Chain Audit Trail

Every deposit, spend, rake, and withdrawal is recorded as an HCS-20 message on a Hedera
Consensus Service topic. These messages are immutable once written. Any party with access to
the mirror node can independently verify the accounting.

### Max User Balance Cap

The `MAX_USER_BALANCE` configuration sets an upper limit on any user's available balance.
Deposits that would push a user above this cap are rejected by the `DepositWatcher` (the
funds remain in the agent wallet for manual handling by the operator).

### Agent Wallet Security

The agent wallet is a hot wallet with the private key stored in the `.env` file. The operator
is responsible for:

- Securing server access (SSH, firewalls, etc.)
- Never using the treasury or primary wallet as the agent account
- Limiting the funding in the agent wallet to operational needs
- Regularly withdrawing accumulated rake fees

### Prize Routing

Prizes are transferred to the user's EOA via the LazyLotto contract's `transferPendingPrizes`
function. This is an in-contract reassignment -- the agent never holds prize tokens in its own
balance. The user's EOA receives the prizes directly from the contract.

---

## 7. Play Session Reports

Each play session produces a `PlaySessionResult` with the following structure:

| Field              | Type     | Description                                            |
|--------------------|----------|--------------------------------------------------------|
| `sessionId`        | string   | UUID for this session                                  |
| `userId`           | string   | User who owns the session                              |
| `timestamp`        | string   | ISO-8601 timestamp                                     |
| `strategyName`     | string   | Strategy used (proves which config was active)         |
| `strategyVersion`  | string   | Strategy version (frozen at registration)              |
| `boostBps`         | number   | Win rate boost in basis points from delegated NFTs     |
| `poolsEvaluated`   | number   | Total pools discovered and scored                      |
| `poolsPlayed`      | number   | Pools that passed evaluation and were played           |
| `poolResults`      | array    | Per-pool breakdown (see below)                         |
| `totalSpent`       | number   | Sum of all entry costs across pools                    |
| `totalWins`        | number   | Sum of all prize values                                |
| `prizesTransferred`| boolean  | Whether prizes were routed to user's EOA               |
| `gasCostHbar`      | number   | HBAR spent on gas for this session                     |
| `amountReserved`   | number   | Funds locked before play began                         |
| `amountSettled`    | number   | Funds actually deducted (should equal `totalSpent`)    |
| `amountReleased`   | number   | Unused reservation returned to available               |

### Pool Result Detail

Each entry in `poolResults`:

| Field            | Type    | Description                            |
|------------------|---------|----------------------------------------|
| `poolId`         | number  | On-chain pool identifier               |
| `poolName`       | string  | Human-readable pool name               |
| `entriesBought`  | number  | Number of entries purchased             |
| `amountSpent`    | number  | Total cost for entries in this pool     |
| `rolled`         | boolean | Whether the pool was rolled for prizes  |
| `wins`           | number  | Prize value won in this pool            |

### Reserve Accounting Invariant

For every session: `amountReserved = amountSettled + amountReleased`. If this invariant does
not hold, the agent logs a warning and the discrepancy is visible in the session report.

---

## 8. On-Chain Accounting (HCS-20)

### Overview

The agent deploys an HCS-20 token (default ticker: `LLCRED`) on a dedicated Hedera Consensus
Service topic. This token represents internal accounting credits. It is not a tradable token;
it exists solely as an immutable, publicly verifiable ledger.

### Topic Setup

The HCS-20 deploy message is submitted during `--deploy-accounting`:

```json
{
  "p": "hcs-20",
  "op": "deploy",
  "name": "LazyLotto Credits",
  "tick": "LLCRED",
  "max": "999999999",
  "lim": "999999999"
}
```

The topic's admin key and submit key are both set to the agent's operator key. Only the agent
can write to this topic.

### Operations

| Operation            | HCS-20 op   | Description                                          |
|----------------------|-------------|------------------------------------------------------|
| Deposit credited     | `mint`      | Credits minted to user's Hedera account ID           |
| Rake fee             | `transfer`  | Credits transferred from user to agent account       |
| Entry purchased      | `burn`      | Credits burned from user (within play session batch) |
| User withdrawal      | `burn`      | Credits burned from user's account                   |
| Operator withdrawal  | `burn`      | Credits burned from agent's account                  |

### Deposit Example

When user `0.0.12345` deposits 100 LAZY with a 1% rake, two messages are submitted:

**Mint (net deposit)**:
```json
{
  "p": "hcs-20",
  "op": "mint",
  "tick": "LLCRED",
  "amt": "99",
  "to": "0.0.12345",
  "memo": "deposit:0.0.12345@1711684800.123456789"
}
```

**Transfer (rake)**:
```json
{
  "p": "hcs-20",
  "op": "transfer",
  "tick": "LLCRED",
  "amt": "1",
  "from": "0.0.12345",
  "to": "0.0.AGENT",
  "memo": "rake"
}
```

### Play Session Batching

Play sessions that span multiple pools are batched into a single HCS message:

```json
{
  "p": "hcs-20",
  "op": "batch",
  "tick": "LLCRED",
  "sessionId": "a1b2c3d4-...",
  "operations": [
    { "op": "burn", "tick": "LLCRED", "amt": "50", "from": "0.0.12345", "memo": "play:pool-7:5-entries" },
    { "op": "burn", "tick": "LLCRED", "amt": "30", "from": "0.0.12345", "memo": "play:pool-12:3-entries" }
  ],
  "timestamp": "2026-03-29T10:00:00.000Z"
}
```

### Verification

Anyone can verify the accounting by:

1. Querying the mirror node for all messages on the HCS-20 topic ID
2. Replaying the mint/burn/transfer operations in order
3. Comparing final balances against the agent's reported state

The `memo` field on each operation links back to the corresponding Hedera transaction ID,
enabling cross-reference with on-chain token transfers.

---

## 9. MCP Tools Reference

### Multi-User Tools

These tools are registered when the agent starts with `--multi-user --mcp-server`.

| Tool                        | Parameters                                                        | Description                                                                 |
|-----------------------------|-------------------------------------------------------------------|-----------------------------------------------------------------------------|
| `multi_user_status`         | (none)                                                            | List all registered users with balances, strategy, rake, and last activity |
| `multi_user_register`       | `accountId`, `eoaAddress`, `strategy`, `rakePercent?`             | Register a new user; returns deposit memo and funding instructions          |
| `multi_user_deposit_info`   | `userId`                                                          | Get deposit memo and current balances for an existing user                  |
| `multi_user_play`           | `userId?`                                                         | Play for a specific user, or all eligible users if omitted                  |
| `multi_user_withdraw`       | `userId`, `amount`                                                | Withdraw funds to the user's Hedera account                                 |
| `multi_user_deregister`     | `userId`                                                          | Deactivate a user; withdrawal-only after this                               |
| `multi_user_play_history`   | `userId`, `limit?` (default 20)                                   | View play session history with pool-level results                           |

### Operator Tools

| Tool                        | Parameters                   | Description                                                          |
|-----------------------------|------------------------------|----------------------------------------------------------------------|
| `operator_balance`          | (none)                       | Platform balance, total rake, gas spent, net profit                  |
| `operator_withdraw_fees`    | `amount`, `to`               | Withdraw HBAR from platform balance to a recipient account           |
| `operator_health`           | (none)                       | Health snapshot: uptime, watcher status, errors, reserves            |

### Parameter Details

**`multi_user_register`**:
- `accountId` (string, required): Hedera account ID in `0.0.XXXXX` format.
- `eoaAddress` (string, required): Prize delivery address. Accepts `0.0.XXXXX` (Hedera) or `0x` followed by 40 hex characters (Ethereum-style).
- `strategy` (string, required): One of `conservative`, `balanced`, `aggressive`.
- `rakePercent` (number, optional): Proposed rake percentage. Clamped to the operator's `[min, max]` band.

**`multi_user_play`**:
- `userId` (string, optional): If provided, plays for that user only. If omitted, plays for all active users with sufficient balance, sequentially, capped at `maxUsersPerPlayCycle` (default 10).

**`multi_user_withdraw`**:
- `userId` (string, required): The user's internal ID (returned at registration).
- `amount` (number, required): Must be positive and not exceed the user's available balance. The currency (HBAR or LAZY) is determined by the user's strategy configuration.

---

## 10. CLI Commands

```
lazylotto-agent --multi-user                       Start custodial agent with deposit watcher
lazylotto-agent --multi-user --deploy-accounting   Deploy HCS-20 topic and print topic ID
lazylotto-agent --multi-user --mcp-server          Start MCP server with multi-user + operator tools
```

These flags combine with existing flags:

```
lazylotto-agent --setup                            First-time token associations and approvals
lazylotto-agent --register                         Register with HOL (FEE_BASED inbound)
lazylotto-agent --multi-user --mcp-server          Full custodial agent with MCP interface
```

The `--multi-user` flag activates the `MultiUserAgent` orchestrator instead of the default
single-user `LottoAgent`.

---

## 11. Configuration Reference

All multi-user environment variables, their defaults, and descriptions:

| Variable                  | Default     | Required | Description                                                         |
|---------------------------|-------------|----------|---------------------------------------------------------------------|
| `MULTI_USER_ENABLED`      | `false`     | Yes      | Set to `true` to enable custodial mode                              |
| `RAKE_DEFAULT_PERCENT`    | `1.0`       | No       | Default rake percentage applied to deposits                         |
| `RAKE_MIN_PERCENT`        | `0.5`       | No       | Minimum allowed rake (floor for negotiation)                        |
| `RAKE_MAX_PERCENT`        | `3.0`       | No       | Maximum allowed rake (ceiling for negotiation)                      |
| `DEPOSIT_POLL_INTERVAL_MS`| `10000`     | No       | Mirror node polling interval in milliseconds                        |
| `MAX_USER_BALANCE`        | `10000`     | No       | Maximum allowed balance per user (deposits above this are rejected) |
| `HCS20_TOPIC_ID`          | (empty)     | No*      | HCS-20 accounting topic ID (set after `--deploy-accounting`)        |
| `HCS20_TICK`              | `LLCRED`    | No       | HCS-20 token ticker symbol                                         |
| `HOL_API_KEY`             | (empty)     | No       | API key for HOL registry (needed for `--register`)                  |

*`HCS20_TOPIC_ID` is not required for the agent to run, but without it, on-chain accounting
is disabled and all `AccountingService` calls become no-ops with a warning log.

### Internal Defaults (Not Configurable via Environment)

| Parameter                | Value   | Description                                          |
|--------------------------|---------|------------------------------------------------------|
| `hcs10PollIntervalMs`    | 15000   | HCS-10 message polling interval                      |
| `minDepositAmount`       | 1       | Minimum deposit to be credited                       |
| `maxUsersPerPlayCycle`   | 10      | Maximum users processed per `playForAllEligible`     |
| `dataDir`                | `.custodial-data` | Directory for persistent JSON storage      |

### Persistent Data Files

All state is stored in the `dataDir` directory (default `.custodial-data/`):

| File               | Contents                                              |
|--------------------|-------------------------------------------------------|
| `users.json`       | All registered users with balances and strategy       |
| `operator.json`    | Operator platform balance and totals                  |
| `deposits.json`    | Full deposit history (also used for idempotency)      |
| `plays.json`       | All play session results                              |
| `withdrawals.json` | Withdrawal records                                    |
| `gas-log.json`     | Per-operation gas cost records                        |
| `watermark.json`   | Mirror node polling watermark (consensus timestamp)   |

All writes use atomic rename (write to `.tmp`, then `rename`) to prevent corruption on crash.
Writes are debounced at 500ms to batch rapid state changes.

---

## 12. Monitoring

The `operator_health` MCP tool returns a structured health snapshot:

```json
{
  "isRunning": true,
  "startedAt": "2026-03-29T08:00:00.000Z",
  "uptime": 3600000,
  "depositWatcherRunning": true,
  "totalUsers": 12,
  "activeUsers": 10,
  "pendingReserves": 0,
  "errorCount": 0,
  "operator": {
    "platformBalance": 45.2,
    "totalRakeCollected": 52.0,
    "totalGasSpent": 3.8,
    "totalWithdrawnByOperator": 3.0
  }
}
```

### What to Watch

**Uptime**: The `uptime` field is in milliseconds. Track this externally to detect unexpected
restarts. If the agent restarts, orphaned reserves are automatically recovered (see Security
Model).

**Deposit Watcher Status**: `depositWatcherRunning` should always be `true` when the agent is
running. If `false`, deposits are not being detected. Restart the agent.

**Error Count**: `errorCount` increments each time a play session fails for any user.
Occasional errors are expected (mirror node timeouts, gas estimation failures). A rapidly
increasing count indicates a systemic issue.

**Active vs Total Users**: `totalUsers - activeUsers` gives the count of deregistered users.
Deregistered users with remaining balances should be monitored until they withdraw.

**Pending Reserves**: `pendingReserves` is the sum of all users' `reserved` balances. This
should be `0` when no play sessions are active. A non-zero value during idle periods
indicates an incomplete session. On restart, orphaned reserves are automatically released.

**Platform Balance**: `operator.platformBalance` is the operator's accumulated rake minus gas
costs minus withdrawals. If this goes negative, gas costs are exceeding rake income and the
operator should adjust the rake or reduce play frequency.

---

## 13. Troubleshooting

### Deposits Not Detected

**Symptom**: User sends funds with the correct memo, but balance does not update.

**Check**:
1. Verify the transaction succeeded on HashScan or the mirror node.
2. Confirm the memo matches exactly (case-sensitive, no extra whitespace).
3. Check that the deposit would not exceed `MAX_USER_BALANCE`.
4. Verify `depositWatcherRunning` is `true` via `operator_health`.
5. Check agent logs for `[DepositWatcher]` warnings.

**Cause**: The mirror node has a ~4-second propagation delay. If the deposit was very recent,
wait 10-15 seconds and check again. The watcher polls at `DEPOSIT_POLL_INTERVAL_MS` intervals.

### "Insufficient balance" During Play

**Symptom**: Play session fails with `InsufficientBalanceError`.

**Check**:
1. User's `available` balance via `multi_user_status`.
2. The strategy's `maxSpendPerSession` (from the frozen snapshot).
3. The `minDepositAmount` configuration (default: 1).

**Cause**: The user's available balance is below the minimum required for a play session.
The agent reserves `min(maxSpendPerSession, available)` but requires at least
`minDepositAmount` to proceed.

### User Cannot Deposit After Deregistration

**Expected behavior**: Deregistered users (`active: false`) can only withdraw. Deposits to
their memo are still accepted by the deposit watcher, but new play sessions are blocked.
Re-registration is not currently supported; the user must register with a new account.

### HCS-20 Accounting Skipped

**Symptom**: Agent logs `[AccountingService] No HCS-20 topic configured -- skipping record`.

**Cause**: `HCS20_TOPIC_ID` is not set in `.env`. Run `--deploy-accounting` to create the
topic, then add the returned topic ID to `.env` and restart the agent.

**Impact**: The agent operates normally without on-chain accounting. Local ledger (JSON files)
is unaffected. However, no third-party verification is possible.

### Orphaned Reserves on Restart

**Symptom**: After a crash, users have funds in `reserved` that are not being played.

**Resolution**: Automatic. On startup, `PersistentStore.load()` detects all users with
`reserved > 0` and moves those funds back to `available`. Check agent logs for
`[PersistentStore]` messages confirming recovery.

### Gas Costs Exceeding Rake Income

**Symptom**: `operator.platformBalance` trending toward zero or negative.

**Resolution**:
1. Increase the default rake percentage (`RAKE_DEFAULT_PERCENT`).
2. Reduce play frequency (adjust cron schedule).
3. Withdraw less frequently to accumulate a buffer.
4. Monitor per-session gas costs via play session reports.

Gas costs are deducted from the operator's platform balance. If the balance goes negative,
the agent continues operating but the operator is effectively subsidizing users.

### Mirror Node Polling Overlap

**Symptom**: Duplicate deposit warnings in logs.

**Cause**: The deposit watcher has an overlapping poll guard (`isPolling` flag) that prevents
concurrent mirror node queries. If a previous poll is still in-flight when the interval fires,
the new poll is skipped. This is expected behavior and not an error.

The idempotency check (transaction ID deduplication) provides a second layer of protection
against double-crediting, even if the guard were to fail.

### Connection Refused on MCP Server

**Symptom**: MCP client cannot connect to the agent's stdio transport.

**Check**:
1. Verify the agent was started with `--mcp-server`.
2. Confirm the agent process is running.
3. Check that no other process is consuming the stdio streams.

The MCP server uses stdio transport, so the client must launch the agent as a subprocess
or connect through a pipe. It does not open a network port.
