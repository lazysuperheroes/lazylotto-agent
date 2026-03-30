# Testnet Playbook — Step-by-Step

This is your personal walkthrough for standing up, testing, and validating
the LazyLotto Agent on testnet. Follow each step in order. Check the box
when done.

---

## Prerequisites

You need:
- [ ] Node.js 20+ installed
- [ ] A dedicated testnet Hedera account (NOT your main wallet)
- [ ] That account's private key in DER hex format (starts with `302e`)
- [ ] The account funded with testnet HBAR (use https://portal.hedera.com/faucet)
- [ ] Testnet LAZY tokens in the account (token ID: `0.0.8011209`)
- [ ] Your personal wallet account ID (this is the OWNER — where prizes go)

---

## Phase 1: Single-User Agent (You Playing)

This tests the core agent — your wallet, your strategy, your prizes.

### Step 1: Install and configure

```bash
cd D:\github\lazylotto-agent
npm install
```

### Step 2: Run the wizard

```bash
npm run wizard
```

The wizard will ask you:
1. **Network**: type `testnet`
2. **Agent Account ID**: your dedicated testnet account (e.g., `0.0.12345`)
3. **Private Key**: paste the DER hex key (it will be visible — that's OK for testnet)
4. **Owner Account ID**: YOUR personal wallet (e.g., `0.0.67890`) — prizes go here
5. **MCP URL**: `https://lazylotto.app/api/mcp` (or your testnet endpoint)
6. **MCP API Key**: press Enter to skip (or enter if you have one)
7. **Strategy**: type `balanced`
8. **Contract addresses**: accept the testnet defaults (Enter for each)
9. **Delegation**: press Enter to skip for now

The wizard writes `.env` and optionally runs `--setup`.

**What to check**: `.env` file exists with your values. No errors.

### Step 3: Verify your setup

```bash
npm run audit
```

This prints a full diagnostic. **What to look for**:
- Your wallet account ID and HBAR balance
- LAZY token balance (should be > 0)
- "No warnings" or only non-critical recommendations
- Approvals section shows LAZY → GasStation

**If you see warnings about missing approvals**, run:
```bash
npm run setup
```

### Step 4: Dry run (see what would happen without spending)

```bash
node --import tsx src/index.ts --dry-run
```

This connects to the MCP endpoint, discovers pools, evaluates EV, and shows
what pools the agent would play — but does NOT execute any transactions.

**What to check**:
- Pools are discovered (if none: the MCP endpoint may have no active pools)
- EV calculations show for each pool
- "X pool(s) would be played" at the bottom

**If no pools found**: check your MCP URL is correct and has active testnet pools.

### Step 5: Play a real session

```bash
npm run dev
```

This runs a single play session. Watch the console output:

```
[1/6] Preflight        — checks your wallet balance
[2/6] Discovering pools — fetches from MCP
[3/6] Evaluating pools  — calculates expected value
[4/6] Playing           — buys entries, rolls for prizes
[5/6] Checking prizes   — transfers any wins to your owner wallet
[6/6] Session complete  — prints report
```

**What to check**:
- Preflight shows your HBAR and LAZY balances
- Pools are found and evaluated
- Entries are bought (you'll see transaction IDs)
- If you win: prizes transfer to your OWNER_EOA
- Session report shows pools played, entries, wins

**If something fails**: the error messages should be descriptive. Common issues:
- "Insufficient balance" — fund your agent wallet
- "No pools match" — check MCP endpoint has pools, check strategy filters
- Contract errors — verify contract addresses in `.env`

### Step 6: Check your owner wallet

Go to https://hashscan.io/testnet and look up your OWNER_EOA account.
If you won any prizes, you should see them as pending in the LazyLotto dApp.
Visit https://lazylotto.app (testnet) to claim them.

### Step 7: Export history

```bash
node --import tsx src/index.ts --export-history
```

If the session persisted data (via MCP server mode), this creates a CSV.
In direct CLI mode, there may be no history file yet — that's expected.

---

## Phase 2: MCP Server (Claude Controls the Agent)

This tests Claude Desktop integration.

### Step 8: Start the MCP server

```bash
npm run dev:mcp
```

This starts the agent as an MCP server on stdio. It sits waiting for
Claude to connect.

**To connect from Claude Desktop**, add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "command": "node",
      "args": ["--import", "tsx", "src/index.ts", "--mcp-server"],
      "cwd": "D:\\github\\lazylotto-agent",
      "env": {
        "DOTENV_CONFIG_PATH": "D:\\github\\lazylotto-agent\\.env"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the agent's tools in the tool list.

### Step 9: Test MCP tools via Claude

Ask Claude:
- "Check my agent status" → calls `agent_status`
- "Audit my agent configuration" → calls `agent_audit`
- "Walk me through setup" → calls `agent_onboard`
- "Play a lottery session" → calls `agent_play`
- "Transfer my prizes" → calls `agent_transfer_prizes`

**What to check**: Claude can invoke all tools and get meaningful responses.

---

## Phase 3: HOL Registration (Make It Discoverable)

### Step 10: Register with HOL

```bash
node --import tsx src/index.ts --register
```

This:
1. Creates an HCS-11 agent profile on Hedera (costs a small HBAR fee)
2. Registers with the HOL Registry Broker
3. Gets a UAID (Universal Agent ID)
4. Saves everything to `.agent-config.json`

**What to check**:
- "Registered! UAID: ..." appears
- `.agent-config.json` is created with profileTopicId, uaid, inboundTopicId

### Step 11: Verify registration

```bash
npm run audit
```

The audit should now show an "HOL REGISTRY" section with your UAID.

You can also check https://hol.org to see if your agent appears in the registry.

---

## Phase 4: Multi-User Custodial Mode (Others Play Through You)

This is the big test. You become an operator running a custodial agent.

### Step 12: Enable multi-user mode

Edit your `.env` and add:

```
MULTI_USER_ENABLED=true
RAKE_DEFAULT_PERCENT=5.0
RAKE_MIN_PERCENT=2.0
RAKE_MAX_PERCENT=5.0
```

### Step 13: Deploy HCS-20 accounting

```bash
node --import tsx src/index.ts --multi-user --deploy-accounting
```

This creates an HCS topic for on-chain accounting. It prints a topic ID.
**Add it to your `.env`:**

```
HCS20_TOPIC_ID=0.0.XXXXXX
```

### Step 14: Start the multi-user agent

```bash
node --import tsx src/index.ts --multi-user --mcp-server
```

This starts:
- The MCP server with all 19 tools (9 single-user + 7 multi-user + 3 operator)
- The deposit watcher (polls mirror node every 10 seconds)
- Ready to accept users

### Step 15: Register a test user (simulate someone connecting)

Via Claude (or directly via MCP tool call):

```
Register a new user with account 0.0.XXXXX, EOA 0.0.YYYYY, balanced strategy
```

Claude calls `multi_user_register`. You get back:
- A user ID
- A deposit memo (e.g., `ll-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`)
- Instructions: "Send HBAR or LAZY to [agent wallet] with memo [deposit memo]"

**Write down the deposit memo.**

### Step 16: Simulate a deposit

From a DIFFERENT testnet wallet (the "user"), send HBAR or LAZY to your
agent's wallet with the deposit memo as the transaction memo.

You can do this via:
- HashPack wallet (testnet mode)
- Hedera SDK script
- HashScan transaction builder

**Important**: The memo must EXACTLY match what was given (e.g., `ll-a1b2c3d4...`).

### Step 17: Wait for deposit detection

The deposit watcher polls every 10 seconds. Within ~15 seconds you should
see in the console:

```
[DepositWatcher] Deposit: X HBAR for user [userId] (memo: ll-...)
```

### Step 18: Check user balance

Ask Claude: "Show me all user balances"
→ calls `multi_user_status`
→ should show the user with their deposited amount (minus rake)

### Step 19: Play for the user

Ask Claude: "Play a session for user [userId]"
→ calls `multi_user_play`
→ the agent plays lottery pools using the user's deposited funds
→ prizes transfer to the user's EOA

### Step 20: Check operator profit

Ask Claude: "What's my operator balance?"
→ calls `operator_balance`
→ should show: rake collected per token, gas spent, net profit per token

### Step 21: Test withdrawal

Ask Claude: "Withdraw 5 HBAR for user [userId]"
→ calls `multi_user_withdraw`
→ funds transfer from agent wallet to user's account
→ user balance decreases

### Step 22: Test operator fee withdrawal

Ask Claude: "Withdraw my operator fees to [your wallet]"
→ calls `operator_withdraw_fees`
→ rake fees transfer to your personal wallet

---

## Phase 5: Edge Cases to Test

Once the happy path works, test these:

### Error handling
- [ ] Try to play with insufficient balance
- [ ] Try to withdraw more than available
- [ ] Send a deposit with wrong memo (should be ignored, logged)
- [ ] Send a deposit to a deregistered user (should dead-letter)
- [ ] Try to register with invalid account ID

### Security
- [ ] Set `MCP_AUTH_TOKEN=mysecrettoken` in `.env`
- [ ] Restart the MCP server
- [ ] Try to play without providing auth_token (should be rejected)
- [ ] Try with correct auth_token (should work)

### Budget limits
- [ ] Deposit a small amount (< 1 HBAR) — should credit but not enough to play
- [ ] Play until budget is exhausted — agent should stop gracefully
- [ ] Check reserve balance enforcement — agent stops before going below reserve

### Crash recovery
- [ ] Start multi-user mode, register a user, deposit funds
- [ ] Kill the process mid-session (Ctrl+C during a play)
- [ ] Restart — check that reserved funds are recovered to available

---

## What You're Validating

| Test | What It Proves |
|------|---------------|
| Phase 1 | Core play loop works end-to-end |
| Phase 2 | MCP integration with Claude works |
| Phase 3 | Agent is discoverable via HOL |
| Phase 4 | Multi-user deposit → play → prize → withdraw cycle works |
| Phase 5 | Error handling and security are robust |

## If Something Goes Wrong

1. **Check the console output** — errors are logged with context
2. **Run `--audit`** — it checks everything and gives recommendations
3. **Check `.env`** — most issues are missing or wrong config
4. **Check the MCP endpoint** — if no pools exist, nothing can be played
5. **Check HashScan** — look up transactions on https://hashscan.io/testnet

---

## After Testnet Validation

Once all phases pass:
1. Document any issues found
2. Fix any bugs discovered
3. Update mainnet contract addresses
4. Set `LAZY_TOKEN_ID=0.0.1311037` for mainnet
5. Set `HEDERA_NETWORK=mainnet`
6. Publish to npm: `npm publish --access public`
7. Start with single-user on mainnet (limited funds)
8. Graduate to multi-user after operational confidence
