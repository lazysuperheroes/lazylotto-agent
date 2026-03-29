# LazyLotto MCP Server

> **Status**: Live on Testnet
> **Endpoint**: `https://lazy-dapp-v3-env-testnet-lazysuperheroes.vercel.app/api/mcp`
> **Transport**: Streamable HTTP (MCP spec 2025-03-26)
> **Auth**: Optional Bearer token (required for write tools in production)

## What is this?

The LazyLotto MCP (Model Context Protocol) server lets AI agents query lottery pool data, prizes, user state, and expected value calculations on the Hedera network. Write tools return **transaction intents** — the server never holds private keys. Agents build, sign, and submit transactions locally.

## Quick Start

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "lazylotto": {
      "url": "https://lazy-dapp-v3-env-testnet-lazysuperheroes.vercel.app/api/mcp"
    }
  }
}
```

With authentication (for write tools):
```json
{
  "mcpServers": {
    "lazylotto": {
      "url": "https://lazy-dapp-v3-env-testnet-lazysuperheroes.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer ll_your_api_key"
      }
    }
  }
}
```

---

## Read Tools (No Auth Required)

### lazylotto_get_system_info
Contract addresses, network, total pool count. Cached 5 minutes.

### lazylotto_list_pools
Paginated pool list with win rates, entry fees, prize counts.
- `type`: all | global | community (default: all)
- `offset`: number (default: 0)
- `limit`: number (default: 20, max: 50)

### lazylotto_get_pool
Full pool detail including owner, platform fee, CIDs.
- `poolId`: number (required)

### lazylotto_get_prizes
Prize packages with human-readable amounts (HBAR/tokens/NFTs).
- `poolId`: number (required)
- `offset`: number (default: 0)
- `limit`: number (default: 20, max: 50)

### lazylotto_get_user_state
User's entries per pool, pending prizes, win rate boost.
- `address`: string (0.0.X or 0x format)

### lazylotto_calculate_ev
Expected value analysis with NFT breakdown and recommendation.
- `poolId`: number (required)
- `address`: string (optional, for boost calculation)

---

## Write Tools (Return Transaction Intents)

Write tools return a `TransactionIntent` — a structured object containing everything an agent needs to build, verify, and submit a transaction locally. The server never holds private keys.

### lazylotto_check_prerequisites
Check what's needed before an operation: token associations, allowances, balances. Returns actionable Hedera SDK instructions for each unsatisfied prerequisite.
- `address`: string (required)
- `poolId`: number (required)
- `action`: buy | buy_and_roll | buy_and_redeem | roll | claim
- `count`: number (default: 1)

### lazylotto_buy_entries
Generate a transaction intent to buy lottery entries.
- `poolId`: number (required)
- `count`: number (1-100, default: 1)
- `action`: buy | buy_and_roll | buy_and_redeem (default: buy)
- `address`: string (required — the account that will sign)

### lazylotto_roll
Generate a transaction intent to roll tickets. Omit count for rollAll.
- `poolId`: number (required)
- `count`: number (optional — omit to roll all outstanding entries)
- `address`: string (required)

### lazylotto_transfer_prizes
Transfer pending prizes to another wallet (typically the agent's owner EOA). In-memory reassignment — no token movements, no associations needed. The recipient claims via the dApp.
- `recipientAddress`: string (required — owner's Hedera account)
- `index`: number (optional — omit to transfer all prizes)
- `address`: string (required — account holding the prizes)

---

## TransactionIntent Format

Every write tool returns this structure:

```json
{
  "type": "transaction_intent",
  "chain": "hedera:testnet",
  "intent": {
    "contractId": "0.0.8399255",
    "functionName": "buyEntry",
    "functionSignature": "buyEntry(uint256,uint256)",
    "params": { "poolId": 1, "count": 5 },
    "paramsOrdered": [1, 5],
    "gas": 1100000,
    "gasBreakdown": {
      "base": 350000,
      "perUnit": 150000,
      "units": 5,
      "formula": "350000 + 150000 × 5 = 1100000"
    },
    "payableAmount": "0",
    "payableToken": "0.0.8011209",
    "payableUnit": "token_smallest_unit",
    "payableHumanReadable": "25 LAZY"
  },
  "abi": [{ "name": "buyEntry", "type": "function", "inputs": [...], "outputs": [...] }],
  "encoded": "0x...",
  "humanReadable": "Buy 5 entries in pool 1 for 25 LAZY",
  "prerequisites": [...],
  "warnings": []
}
```

### Trust-But-Verify

The agent verifies the encoded calldata:
```typescript
const iface = new ethers.Interface(response.abi);
const expected = iface.encodeFunctionData(intent.functionName, intent.paramsOrdered);
assert(expected === response.encoded, 'Calldata mismatch — do not execute');
```

And verifies gas:
```typescript
const { base, perUnit, units, prngAddon } = intent.gasBreakdown;
assert(base + perUnit * units + (prngAddon ?? 0) === intent.gas);
```

### Building a Hedera Transaction from an Intent

```typescript
import { ContractExecuteTransaction, ContractId, Hbar } from '@hashgraph/sdk';

const tx = new ContractExecuteTransaction()
  .setContractId(ContractId.fromString(intent.contractId))
  .setGas(intent.gas)
  .setFunctionParameters(Buffer.from(response.encoded.slice(2), 'hex'));

if (intent.payableToken === 'HBAR' && BigInt(intent.payableAmount) > 0n) {
  tx.setPayableAmount(Hbar.fromTinybars(intent.payableAmount));
}

const response = await tx.execute(client);
const receipt = await response.getReceipt(client);
```

### Prerequisites

Each unsatisfied prerequisite includes Hedera SDK instructions:
```json
{
  "type": "ft_allowance",
  "satisfied": false,
  "reason": "Insufficient LAZY allowance for LazyGasStation",
  "token": "0.0.8011209",
  "symbol": "LAZY",
  "target": "0.0.8011801",
  "targetName": "LazyGasStation",
  "requiredAmount": "50",
  "currentAmount": "0",
  "action": {
    "sdkTransaction": "AccountAllowanceApproveTransaction",
    "description": "Approve 500 LAZY (10× buffer) to LazyGasStation",
    "params": {
      "tokenId": "0.0.8011209",
      "spender": "0.0.8011801",
      "amount": 500
    }
  }
}
```

### Agent Flow

1. `lazylotto_check_prerequisites` → identify what's needed
2. Execute each unsatisfied prerequisite (SDK transactions)
3. `lazylotto_buy_entries` → get transaction intent
4. Verify `encoded` against `abi + paramsOrdered`
5. Build `ContractExecuteTransaction`, sign, submit
6. After rolling and winning: `lazylotto_transfer_prizes` → forward to owner EOA

---

## Gas Calculation

| Action | Base | Per-Unit | PRNG Add-on | Notes |
|--------|------|----------|-------------|-------|
| buyEntry | 350k | 150k/ticket | — | Standard |
| buyAndRedeemEntry | 400k | 200k/ticket | — | Includes NFT mint |
| buyAndRollEntry | 750k | 610k/ticket | Included | Buy + immediate roll |
| rollAll / rollBatch | 400k | 400k/ticket | Included | PRNG uncertainty |
| transferPendingPrizes | 500k | — | — | In-memory, flat |

All capped at 14.5M (Hedera's 15M block limit with headroom).

## Entry Fee Units

- **HBAR pools**: `payableAmount` is in **tinybar** (1 HBAR = 100,000,000 tinybar). `payableUnit = 'tinybar'`.
- **FT pools** (LAZY etc.): `payableAmount = '0'` because the fee is paid via prior FT allowance, not as msg.value. The prerequisite FT allowance covers the cost.
- **`payableHumanReadable`**: Always includes the formatted amount + symbol (e.g., "10 HBAR", "25 LAZY").

## Allowance Routing

| Token | Approval Target | Why |
|-------|----------------|-----|
| LAZY | LazyGasStation | Contract's `_pullPayment` draws LAZY from GasStation |
| Other FTs | LazyLottoStorage | Storage holds custody of all non-LAZY tokens |
| HBAR | Not needed | Sent directly as msg.value |

## Authentication

API keys follow format `ll_<random>`. Pass as Bearer token:
```
Authorization: Bearer ll_your_api_key
```

Read tools work without auth. Write tools require `address` parameter (the signing account). With auth, the address is auto-resolved from the API key.

## Contract Addresses (Testnet)

| Contract | Address |
|----------|---------|
| LazyLotto | `0.0.8399255` |
| PoolManager | `0.0.8399271` |
| GasStation | `0.0.8011801` |
| LAZY Token | `0.0.8011209` |

## Limitations

- **NFT pricing**: Cannot price NFTs on-chain — EV calculations cover fungible value only
- **Caching**: Pool data cached 30-60s, system info 5 min, user state uncached
- **Testnet only**: This endpoint queries testnet contracts
- **No direct execution**: Write tools return intents, not executed transactions
