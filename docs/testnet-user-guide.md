# LazyLotto Agent — Testnet User Guide

Welcome! This guide walks you through playing the LazyLotto lottery via the
autonomous AI agent on Hedera testnet. The agent handles pool selection,
entries, and prize transfer — you just deposit, hit PLAY, and check your
results.

**Time needed**: ~5 minutes to play your first round.

---

## What You Need

1. **A Hedera testnet wallet** — [HashPack](https://www.hashpack.app/) or
   [Blade](https://bladewallet.io/) (browser extension)
2. **Testnet HBAR** — Free from the [Hedera Faucet](https://portal.hedera.com/faucet)

That's it. No Claude Desktop, no CLI, no command line — the web dashboard
handles the full flow. (If you prefer to drive the agent from Claude Desktop,
see the [Advanced section](#advanced-driving-the-agent-from-claude-desktop) at
the end.)

If you don't have a testnet wallet yet:

1. Install HashPack (or Blade) browser extension
2. Create a new wallet and switch to **Testnet** in settings
3. Copy your account ID (looks like `0.0.12345`)
4. Get free testnet HBAR from https://portal.hedera.com/faucet

---

## Step 1: Sign In

Visit: **https://testnet-agent.lazysuperheroes.com/auth**

1. Click **Connect wallet**
2. Approve the connection in your wallet
3. When prompted, **sign the challenge message** — this proves you own the
   wallet. **No funds are transferred.** It's a free off-chain signature.
4. After signing, you'll land on the dashboard with your character mascot,
   an empty pot balance, and a 3-step ribbon showing **Fund → Play → Withdraw**

Your character mascot is assigned randomly at first sign-in and follows you
across pages. If you want a different one, click the 🎲 die in the corner of
the mascot frame to reroll.

---

## Step 2: Register

On first visit, the dashboard will prompt you to register with a **Register
now** button. One click creates your player profile and the default
**balanced** strategy is applied.

No confirmation dialog, no paperwork — it's instant.

---

## Step 3: Fund Your Account

The dashboard's empty-state ribbon has a big gold **Step 01: Fund** button.
Click it to open the Top Up panel showing:

- **Agent wallet address** — where to send HBAR
- **Your deposit memo** — looks like `ll-abc123`, unique to you
- **Wallet-specific instructions** for HashPack, Blade, and other wallets

Copy both values (click the Copy buttons), open your wallet, and send any
amount of testnet HBAR to the agent wallet **with your memo set**. Minimum
1 HBAR, maximum 10,000 HBAR per account.

**⚠ Critical: the memo is how the agent matches the deposit to your account.
Without it, your funds are stuck and need a manual refund.** HashPack and
Blade both put the memo field under Advanced or Optional Fields — the
instructions panel shows where to find it in each wallet.

After sending, wait ~10–15 seconds (Hedera consensus + mirror node lag), then
click the **Check for deposits** button in the Top Up panel, or just refresh
the page. Your balance will update to show the deposited amount minus the
rake fee (default 5%, covers gas and infrastructure).

---

## Step 4: Play

With funds in your pot, the dashboard's 3-step ribbon is replaced by the
**PLAY** button — a big gold button below your character mascot and pot
balance.

Click it.

The agent runs a play session which takes **5–15 seconds**. During the wait
you'll see:

- A phase ticker: *Waking up the agent → Picking pools → Pulling the lever →
  Watching the wheels → Hedera consensus…*
- A progress bar filling under the button
- A seconds counter so you know time is moving
- Your character commenting in the speech bubble

When the session completes, one of two things happens:

- **You won**: a gold confetti burst + a comic-book starburst with WIN! /
  BIG WIN! / JACKPOT! (scaling with prize value). Your balance updates
  with the winnings.
- **You didn't**: a quiet toast confirms how many pools were played.

Either way, the **Recent plays** panel below the hero shows the session with
pool names, entry counts, amounts spent, and any prizes won. If you win
NFTs, they appear as enriched cards with names and images.

---

## Step 5: Withdraw (Whenever You Want)

When you want to take your balance out of the agent and back to your wallet:

1. Click **← Or withdraw funds** below the PLAY button (or on the Top Up
   panel's metadata strip)
2. Enter an amount (or click **Max** to withdraw everything)
3. Hit **Confirm withdraw**

Funds are sent back to your registered Hedera account. Check the transaction
on [HashScan](https://hashscan.io/testnet) if you want to verify.

**Daily velocity cap**: the agent enforces a per-user daily withdrawal cap
for safety. If you hit it, the modal shows how much you have left before the
24-hour rolling window resets.

---

## Step 6: Manage Your Account

Click the **Account** link in the sidebar to reach
**https://testnet-agent.lazysuperheroes.com/account**. This is where you
manage the non-lottery side of the agent:

- **Profile** — your Hedera account, strategy, rake, registration date,
  last-played timestamp
- **Stuck deposits** — if a deposit ever fails to credit automatically
  (wrong memo, unknown token, etc.), it appears here with a **Contact
  Support** button that prefills an email with the transaction ID
- **API session** — your `sk_` session token (for Claude Desktop or other
  MCP clients), a **Lock API key** button to make it permanent, a
  **Revoke** button to sign out and invalidate the token
- **Verify on-chain** — links to HashScan for the agent wallet, HCS-20
  audit trail, and the on-chain audit log page

You can sign out either from the sidebar (**Sign out** at the top) or from
the account chip in the top-right corner of the dashboard.

---

## FAQ

**How much does it cost?**
A small rake fee (default 5%, negotiable down to 2% for high-volume
depositors) is deducted from each deposit. This covers the agent operator's
gas costs and infrastructure. The rest is yours to play with. Winnings are
paid out in full — no rake on wins.

**What if I send funds without the memo?**
The deposit lands in the agent wallet but can't be matched to your account.
Check the **Account** page — stuck deposits appear there with a Contact
Support button. The operator can process a manual refund via the
`operator_refund` flow.

**Can I use a different wallet to withdraw than the one I deposited from?**
No. Withdrawals always go to the Hedera account you used to register. This
is an anti-theft measure — nobody can withdraw to a different address, not
even the operator.

**Can the agent steal my funds?**
The agent wallet holds deposited funds and a small operating reserve. All
actions are on-chain and auditable via HCS-20 on the
[audit trail page](https://testnet-agent.lazysuperheroes.com/audit). The
operator can process refunds but cannot arbitrarily move user funds to
non-registered accounts. Source code is public at
https://github.com/lazysuperheroes/lazylotto-agent.

**How do I see what happened on-chain?**
Every deposit, play, and withdrawal is a real Hedera transaction. Your
**Recent plays** panel shows transaction IDs, and the **Account → Verify
on-chain** section links directly to HashScan, the HCS-20 topic, and the
on-chain audit log. You can verify everything independently.

**What's the difference between HBAR and LAZY?**
HBAR is Hedera's native token (used for gas and most pool entries). LAZY is
the LazyLotto game token used in some pools. The agent plays whichever token
matches the active pools and your deposited balance.

**What if the agent is "temporarily closed"?**
If the operator engages the kill switch during an incident, the dashboard
shows a banner at the top: *"Agent temporarily closed — new plays and
registrations are paused. Your balance is safe and withdrawals remain
available."* You can still withdraw and sign out. Check back later.

**Can I change my strategy?**
Not yet. You're on the **balanced** default strategy, which is a sensible
choice for new players. Strategy switching is a planned feature — contact
the operator if you need a different strategy configured manually.

**Something went wrong — who do I contact?**
Reach out to the operator who shared this guide with you. If you have a
stuck deposit, use the **Contact Support** button on the Account page — it
prefills an email with your transaction ID for faster triage.

---

## Advanced: Driving the Agent from Claude Desktop

If you want to talk to the agent in natural language instead of clicking
dashboard buttons, you can connect Claude Desktop (or any MCP-compatible
client) to the agent.

1. After signing in, go to **Account → API session**
2. Copy your `sk_...` session token
3. In Claude Desktop, go to **Settings → MCP Servers → Add**
4. Enter the URL:
   ```
   https://testnet-agent.lazysuperheroes.com/api/mcp
   ```
5. When prompted for authentication headers, add:
   ```
   Authorization: Bearer sk_YOUR_TOKEN_HERE
   ```
6. Claude should list the agent's tools

Then you can say things like:

- *"Check my balance"*
- *"Show my deposit info"*
- *"Play a lottery session"*
- *"Show my play history"*
- *"Withdraw 5 HBAR"*

The same `user` tier restrictions apply — you can only access your own data,
operator tools are denied.

**Tip**: you can lock your session token (make it permanent, never expires)
via the **Lock API key** button on /account. Useful if you're wiring the
token into a long-running script or MCP client that doesn't handle
re-authentication.

---

## Quick Reference

| What | Where |
|------|-------|
| Sign in | https://testnet-agent.lazysuperheroes.com/auth |
| Dashboard (play here) | https://testnet-agent.lazysuperheroes.com/dashboard |
| Account (manage here) | https://testnet-agent.lazysuperheroes.com/account |
| On-chain audit trail | https://testnet-agent.lazysuperheroes.com/audit |
| Agent discovery | https://testnet-agent.lazysuperheroes.com/api/discover |
| MCP URL (for Claude) | `https://testnet-agent.lazysuperheroes.com/api/mcp` |
| Hedera faucet | https://portal.hedera.com/faucet |
| Block explorer | https://hashscan.io/testnet |
| LazyLotto dApp | https://testnet-dapp.lazysuperheroes.com |
| Source code | https://github.com/lazysuperheroes/lazylotto-agent |

---

**You're on testnet.** Your HBAR has no real-world value. Play around, break
things, and tell the operator what's confusing or broken. This is the stage
where feedback matters most.
