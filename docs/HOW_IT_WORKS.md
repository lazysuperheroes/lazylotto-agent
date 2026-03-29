# How LazyLotto Agent Works

An autonomous AI agent that plays the [LazyLotto](https://lazylotto.app) lottery
on Hedera — so you don't have to.

---

## Two Ways to Play

### 1. Run Your Own Agent (Single-User Mode)

You deploy the agent with your own Hedera wallet. It plays on your behalf using
your strategy, your budget, and your funds. Prizes go directly to your wallet.

**Who it's for:** Developers, power users, and anyone who wants full control over
their lottery play.

```
You                          Your Agent                     LazyLotto
 |                               |                              |
 |-- configure strategy -------->|                              |
 |-- fund wallet with HBAR ----->|                              |
 |                               |-- evaluate pools ---------->|
 |                               |-- buy entries + roll ------->|
 |                               |<- prizes transferred -------|
 |<- session report ------------|                              |
```

**How it works:**

1. **Install**: `npm install -g @lazysuperheroes/lazylotto-agent`
2. **Configure**: Run `lazylotto-agent --wizard` to set up your wallet, strategy, and prize destination
3. **Setup**: `lazylotto-agent --setup` associates tokens and sets approvals
4. **Play**: `lazylotto-agent` runs a play session, or `--scheduled` for automated play
5. **Win**: Prizes transfer to your EOA. You claim them from the LazyLotto dApp.

**What the agent does each session:**

1. Checks your wallet balance and verifies you have enough to play
2. Discovers all available lottery pools via the LazyLotto MCP endpoint
3. Evaluates each pool by expected value (win rate x average prize - entry fee)
4. Buys entries in the best pools within your budget
5. Rolls for prizes automatically
6. Transfers any winnings to your wallet
7. Reports what happened: pools played, entries bought, wins, net result

**Your agent, your keys, your prizes.** The agent never shares your funds with
anyone else. You choose the strategy, you set the budget, you keep everything.

**Boost your win rate:** If you own Lazy Superheroes (LSH) NFTs, delegate them
to your agent wallet for a win rate bonus. The agent's `calculateBoost()` picks
them up automatically. You keep full custody of the NFTs.

---

### 2. Use a Hosted Agent (Multi-User Custodial Mode)

Don't want to run infrastructure? Connect to a hosted LazyLotto Agent run by an
operator. Deposit funds, pick a strategy, and the agent plays for you.

**Who it's for:** Anyone who wants to play LazyLotto without managing wallets,
keys, servers, or token associations.

```
You / Your Agent              Hosted Agent                   LazyLotto
 |                               |                              |
 |-- discover via HOL ---------->|                              |
 |<- welcome: strategies, fees --|                              |
 |-- configure + deposit ------->|                              |
 |                               |== plays on your behalf =====>|
 |                               |-- transferPendingPrizes ---->| -> your wallet
 |<- session report + balance --|                              |
 |                               |                              |
 |-- withdraw remaining -------->|                              |
 |<- funds returned ------------|                              |
```

**How it works:**

1. **Find the agent**: Discover it via the HOL Registry or get the agent's details from the operator
2. **Register**: Provide your Hedera account, prize destination (EOA), and choose a strategy
3. **Get your deposit memo**: The agent gives you a unique memo code (e.g., `ll-a1b2c3d4e5f6`)
4. **Fund your account**: Send HBAR or LAZY to the agent's wallet with your memo. The agent detects the deposit automatically.
5. **Agent plays for you**: On a schedule or on demand, the agent plays the best pools within your budget
6. **Prizes go to you**: Winnings transfer directly to your EOA. You claim from the LazyLotto dApp.
7. **Withdraw anytime**: Pull your remaining balance whenever you want

**What you're paying:**

The operator charges a **rake** — a small percentage of each deposit. This covers
gas costs and the operator's margin. The rake is negotiable based on how much you
intend to play:

| Intended Volume | Typical Rake |
|----------------|-------------|
| Under 50 HBAR | 5% |
| 50 - 200 HBAR | 4% |
| 200 - 500 HBAR | 3.5% |
| 500 - 1,000 HBAR | 3% |
| 1,000+ HBAR | Negotiable (as low as 2%) |

The rake is deducted when you deposit. Your play balance is the full net amount.
Prizes are yours — no cut taken from winnings.

**What you're getting:**

- **Higher win rate**: The operator delegates their LSH NFTs to the agent, giving
  it a boosted win rate that benefits all users. You might not own any LSH NFTs,
  but you still play with the operator's boost.
- **Zero infrastructure**: No server, no keys, no token associations, no gas management
- **Professional strategy**: The operator curates and optimizes strategies
- **Full transparency**: Every deposit, play, and fee is recorded on-chain via HCS-20.
  You can verify the audit trail independently from the Hedera mirror node.
- **Your prizes, your wallet**: Winnings go directly to your EOA. The agent never
  holds your prizes.

---

## Strategies

The agent evaluates pools and makes play decisions based on a configurable strategy.
Three built-in strategies are available, and operators can create custom ones.

| | Conservative | Balanced | Aggressive |
|--|-------------|----------|------------|
| **Risk** | Low | Moderate | Higher |
| **Pool selection** | High win rate (10%+) | All pools | Prize-rich pools (2+ prizes) |
| **Budget per session** | 50 HBAR | 100 HBAR | 500 HBAR |
| **Entries per pool** | Up to 3 | Up to 5 | Up to 20 |
| **Batch size** | 1 at a time | 2 at a time | 5 at a time |
| **EV threshold** | Tight (-5) | Moderate (-20) | Loose (-100) |
| **Reserve** | 20 HBAR | 10 HBAR | 5 HBAR |
| **Best for** | Small balances, cautious play | Most users | Large balances, big swings |

All strategies accept both HBAR and LAZY pools (`feeToken: "any"`). The budget
amounts are denominated in HBAR but the agent plays whichever pools match the
filter criteria regardless of fee token.

**How pool selection works:**

1. The agent fetches all pools from the LazyLotto dApp
2. It filters by the strategy's criteria (win rate, fee token, prize count)
3. For each surviving pool, it calculates the **expected value** (EV):
   `EV = (effective win rate x average prize value) - entry fee`
4. Pools are ranked by EV. The agent plays the best ones first.
5. It stops when the session budget is exhausted or the reserve threshold is hit.

**Expected value** is the mathematical edge. Positive EV means the pool pays out
more than it costs on average. Negative EV means you're paying for entertainment.
The `minExpectedValue` threshold controls how negative the agent is willing to go.

---

## MCP Integration

The agent exposes an MCP (Model Context Protocol) server, so Claude or any
MCP-compatible AI can control it conversationally.

**What Claude can do:**

- "Check my agent's status" -> `agent_status`
- "Play a lottery session with 50 HBAR budget" -> `agent_play`
- "Switch to conservative strategy" -> `agent_set_strategy`
- "Transfer my prizes" -> `agent_transfer_prizes`
- "Audit my configuration" -> `agent_audit`
- "Walk me through setup" -> `agent_onboard`

In multi-user mode, the operator can manage everything through Claude:

- "Register a new user" -> `multi_user_register`
- "Show me all user balances" -> `multi_user_status`
- "Play for all eligible users" -> `multi_user_play`
- "What's my operator profit?" -> `operator_balance`
- "Is the agent healthy?" -> `operator_health`

---

## On-Chain Transparency

In multi-user mode, every financial operation is recorded immutably on Hedera
via the HCS-20 standard:

| Event | HCS-20 Operation | Verifiable? |
|-------|-----------------|-------------|
| User deposits 100 HBAR | `mint 95 LLCRED to 0.0.user` | Yes, from mirror node |
| Rake deducted (5%) | `transfer 5 LLCRED to 0.0.agent` | Yes |
| Agent plays 3 pools | `batch: burn 20, burn 15, burn 10` | Yes, with session ID |
| User withdraws 50 HBAR | `burn 50 LLCRED from 0.0.user` | Yes, with tx ID |
| Operator withdraws fees | `burn 25 LLCRED from 0.0.agent` | Yes |

Anyone can reconstruct the full accounting history from the HCS topic on the
public Hedera mirror node. No trust required — verify everything.

---

## Security Model

| Aspect | Single-User | Multi-User |
|--------|------------|------------|
| **Key management** | You hold the key | Operator holds the key |
| **Fund custody** | Your wallet only | Operator's wallet (custodial) |
| **Prize custody** | Transferred to your EOA | Transferred to user's EOA |
| **Audit trail** | Transaction receipts | HCS-20 immutable ledger |
| **Reserve pattern** | Per-session budget | Reserve-before-spend with mutex |
| **Max exposure** | Your funded amount | Per-user balance cap |
| **Trust model** | Trustless (your keys) | Trust the operator + verify on-chain |

**For single-user:** Your agent, your keys. The only risk is the hot wallet
(private key on disk). Use a dedicated account with limited funding.

**For multi-user:** You trust the operator to play fairly and return your funds.
But every operation is recorded on-chain — you can verify independently. The
reserve-before-spend pattern prevents the operator from spending more than you
deposited. Prizes go directly to your EOA, never held by the agent.
