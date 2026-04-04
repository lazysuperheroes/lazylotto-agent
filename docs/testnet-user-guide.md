# LazyLotto Agent — Testnet User Guide

Welcome! This guide walks you through playing the LazyLotto lottery via the
AI agent on Hedera testnet. The agent handles everything — you just deposit,
ask it to play, and check your results.

**Time needed**: ~10 minutes

---

## What You Need

1. **A Hedera testnet wallet** — [HashPack](https://www.hashpack.app/) or
   [Blade](https://bladewallet.io/) (browser extension)
2. **Testnet HBAR** — Free from the [Hedera Faucet](https://portal.hedera.com/faucet)
3. **Claude Desktop** — [Download here](https://claude.ai/download) (or use
   the web dashboard instead)

If you don't have a testnet wallet yet:
1. Install HashPack browser extension
2. Create a new wallet and switch to **Testnet** in settings
3. Copy your account ID (looks like `0.0.12345`)
4. Get free testnet HBAR from https://portal.hedera.com/faucet

---

## Step 1: Sign In

Visit: **https://testnet-agent.lazysuperheroes.com/auth**

1. Click **Connect Wallet**
2. Select your wallet (HashPack or Blade)
3. Approve the connection in your wallet
4. The agent will ask you to **sign a message** — this proves you own the
   wallet. It does not transfer any funds.
5. After signing, you'll land on your dashboard

---

## Step 2: Connect Claude Desktop

You can interact with the agent through Claude Desktop (recommended) or
through the web dashboard.

**To connect Claude Desktop:**

1. After signing in (Step 1), your dashboard shows a session token starting
   with `sk_...` — copy it
2. In Claude Desktop, go to **Settings > MCP Servers > Add**
3. Enter the URL:
   ```
   https://testnet-agent.lazysuperheroes.com/api/mcp
   ```
4. When prompted for authentication headers, add:
   ```
   Authorization: Bearer sk_YOUR_TOKEN_HERE
   ```
5. Claude should show the LazyLotto agent as connected

---

## Step 3: Register

In Claude Desktop, say:

> "Register me for LazyLotto. My wallet address is 0.0.XXXXX"

(Use your actual testnet account ID.)

The agent will:
- Create your account
- Give you a **deposit memo** (looks like `ll-abc123`)
- Tell you where to send funds

---

## Step 4: Deposit

Send testnet HBAR to the agent:

1. Open your wallet (HashPack/Blade)
2. Send **10 HBAR** (or any amount) to the agent wallet address shown in Step 3
3. **Important**: Set the memo to your deposit memo from Step 3 (e.g., `ll-abc123`)

Without the correct memo, the agent can't match the deposit to your account.

Wait about 15 seconds, then ask Claude:

> "Check my balance"

You should see your deposit (minus a small rake fee).

---

## Step 5: Play

Ask Claude:

> "Play a lottery session"

The agent will:
1. Check available pools on the LazyLotto dApp
2. Buy entries with your deposited HBAR
3. Roll for prizes
4. Report what happened — wins, losses, amount spent

You can ask:

> "Show my play history"

to see all your sessions.

---

## Step 6: Withdraw (Optional)

When you want your remaining balance back:

> "Withdraw 5 HBAR"

The agent sends the HBAR back to your wallet. You can check the transaction
on [HashScan](https://hashscan.io/testnet).

---

## Using the Web Dashboard Instead

If you prefer not to use Claude Desktop, the web dashboard works too:

- **https://testnet-agent.lazysuperheroes.com/dashboard** — Your balance,
  play history, and deposit instructions
- **https://testnet-agent.lazysuperheroes.com/auth** — Sign in with your wallet

The dashboard shows your current balance, recent play sessions, and deposit
status. Note that registration and play actions currently require Claude
Desktop (or another MCP client).

---

## FAQ

**How much does it cost?**
A small rake fee (default 5%) is deducted from deposits. This covers the
agent operator's gas costs. The rest is yours to play with.

**What if I send funds without the memo?**
The agent can't match the deposit to your account. Contact the operator —
they can process a refund of the original transaction.

**Can the agent steal my funds?**
The agent wallet holds deposited funds. The operator can see all user balances
but can only send funds back to the depositing account via refund. The system
is designed for testnet use and trust with the operator.

**How do I see what happened on-chain?**
Every play session, deposit, and withdrawal happens on Hedera. Look up
transactions on [HashScan](https://hashscan.io/testnet) using the transaction
IDs shown in your play history.

**What's the difference between HBAR and LAZY?**
HBAR is Hedera's native token. LAZY is the LazyLotto game token. The agent
can play with either, depending on which pools are available and which tokens
you deposit.

**Something went wrong — who do I contact?**
Reach out to the operator who shared this guide with you.

---

## Quick Reference

| What | Where |
|------|-------|
| Sign in | https://testnet-agent.lazysuperheroes.com/auth |
| Dashboard | https://testnet-agent.lazysuperheroes.com/dashboard |
| MCP URL (for Claude) | `https://testnet-agent.lazysuperheroes.com/api/mcp` |
| Agent info | https://testnet-agent.lazysuperheroes.com/api/discover |
| Hedera faucet | https://portal.hedera.com/faucet |
| Block explorer | https://hashscan.io/testnet |
| LazyLotto dApp | https://testnet-dapp.lazysuperheroes.com |
