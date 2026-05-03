# LazyLotto, played by an agent

LazyLotto is an on-chain lottery on Hedera. You can play it the manual way —
pick pools, buy entries, roll, claim — or you can let an autonomous AI agent
do all of that on your behalf.

This page is about the agent.

Testnet is live at **[testnet-agent.lazysuperheroes.com](https://testnet-agent.lazysuperheroes.com)**.
Mainnet is coming. Bring a Hedera wallet, bring some HBAR, and you're playing
in about five minutes.

---

## What the agent actually does

You deposit. The agent plays. Prizes come back to your wallet.

Specifically, every play session it:

1. Looks at every active LazyLotto pool
2. Scores them by expected value (the math behind whether a pool is worth entering)
3. Buys entries in the best ones, within your budget
4. Rolls for prizes
5. Sends anything you won straight to your registered wallet

It runs the same six-phase loop a careful human would run, except it does it
in 10 seconds, doesn't get bored, and never forgets to claim.

---

## Why "Lazy" is the whole point

In the Lazy Superheroes universe, "lazy" isn't an insult. It's a virtue. It
means doing more by doing less — automating the boring parts so the fun
parts get more of your attention.

The agent is an extreme example of that. It's so lazy it built a robot to
play the lottery for itself, then noticed it might as well let other people
tag along. That's it. That's the pitch.

You don't have to read pool stats. You don't have to do mental EV math. You
don't have to babysit a transaction. You hit Play (or you ask Claude to hit
Play), and the work happens without you.

---

## Getting started in five minutes

You need:

- A Hedera testnet wallet — [HashPack](https://www.hashpack.app/) or
  [Blade](https://bladewallet.io/), both browser extensions, two-minute install
- Some testnet HBAR — free from the [Hedera Faucet](https://portal.hedera.com/faucet)
- Optional: a Claude account if you want to drive the agent by talking to it

Then:

1. **Sign in.** Go to [testnet-agent.lazysuperheroes.com](https://testnet-agent.lazysuperheroes.com),
   click Connect Wallet, and sign a one-line challenge message. Nothing is
   transferred. Signing just proves the wallet is yours.
2. **Register.** One click. The "balanced" strategy is selected for you by
   default — sensible middle-of-the-road play.
3. **Fund.** The dashboard hands you the agent's wallet address and a unique
   deposit memo (looks like `ll-abc123`). Send any amount of HBAR with that
   memo attached. **The memo is critical** — without it, the agent can't tell
   whose deposit it is. Both HashPack and Blade have a memo field; the
   dashboard tells you exactly where it lives in each wallet.
4. **Play.** Once the deposit clears (10–15 seconds — Hedera is fast, but
   mirror nodes take a beat), a big gold PLAY button appears. Click it.
5. **Watch.** A character mascot narrates while the agent works:
   *Picking pools → Pulling the lever → Watching the wheels.* In 5–15 seconds
   you either get a quiet "no win this time" toast, or a confetti burst with
   a comic-book WIN! / BIG WIN! / JACKPOT! starburst.
6. **Withdraw whenever.** Your remaining balance is yours. Click Withdraw,
   choose an amount, hit confirm. Funds go straight back to the wallet you
   registered with — never anywhere else, by design.

That's the whole flow.

---

## Drive it from Claude (optional)

If you live in Claude, the agent is also a Model Context Protocol (MCP)
server *and* an Agent-to-Agent (A2A) endpoint. Translation: you can ask
Claude (or any AI agent that speaks either protocol) things like:

- *"Play a session for me"*
- *"How much HBAR do I have on the agent?"*
- *"Show my last 5 plays"*

…and the agent will do them. Same auth as the website — sign once with your
wallet, get a session token, plug it into your client. Wallet stays yours.

You don't need this. The dashboard does the same thing. But if your
day-to-day is already in Claude or Cursor, this might be more convenient.

---

## Rake on deposit, not rake on wins

Here's the fee model in one sentence: a small percentage (default 5%,
negotiable down to 2% if you're playing big) is taken when you deposit, and
that's the only fee you ever pay.

If you win, you keep the entire prize. The operator does not skim your
winnings. There is no withdrawal fee. There is no idle fee. There is no
"hidden 1% on every play."

This matters because most win-tax models punish you exactly when you're
winning, which is the worst possible psychology for a game. We'd rather
charge a flat, predictable infrastructure fee up front and let your wins
stay yours.

---

## The honest safety story

The agent is a custodial service. That means while your funds are deposited,
they sit in the agent's wallet — not yours. That's the trade-off you make
for not having to manage gas, token associations, contract approvals, or any
of the other Hedera-specific chores.

Three things make that trade-off honest:

- **Withdrawals are pinned to your wallet.** The address you registered with
  is the only address you can withdraw to. The operator can't redirect your
  funds. The code enforces this.
- **Every cent is on-chain.** Every deposit, every play, every fee, every
  prize is logged to a public Hedera Consensus Service topic. Anyone can
  read it. There's a verifier script in the repo that reconstructs the
  entire ledger from the public log alone — no operator cooperation
  required.
- **The source code is open.** The repo is public. The audit page on the
  dashboard links straight to HashScan and the raw HCS-20 trail. If
  something looks weird, you don't have to ask us — you can check.

> **Don't want to be custodial? You can run it yourself.**
> The agent is open source. The same code that runs the hosted testnet
> instance also runs in single-user mode on your laptop — you bring a
> Hedera wallet, the agent plays for you, prizes go to your wallet, and
> there's no operator wallet in the loop at all. Setup is one wizard
> command (`lazylotto-agent --wizard`). The full guide is in the
> [README](README.md) under "Single-User Mode."

---

## Where to play

Right now: **testnet.** Free play money. Break things. Tell us what's
broken. The links and characters and PLAY button all work, and so does the
audit trail, but the HBAR you're playing with has no real-world value.

Mainnet is queued behind a final round of UAT. Sign in on testnet to get on
the waitlist — when mainnet opens, you'll already have a player profile and
you can carry your strategy preference straight over.

---

## What to expect

You'll sign in, register, deposit a small amount (start with 5–10 HBAR), and
hit Play a few times. Sometimes the agent will play a couple of pools and
report no wins — that's the math doing its job, the lottery is still a
lottery. Sometimes it'll hit, and you'll see a confetti burst, NFTs and
tokens added to your balance, and a transaction on
[HashScan](https://hashscan.io/testnet) to prove it happened. After a
session or two you'll have a sense of whether you'd rather be on the
conservative, balanced, or aggressive strategy. Whenever you're done,
withdraw your balance back to your wallet. Total time invested: about as
much as a coffee break.

That's a first session. Now go ruin a few thousand testnet HBAR for us.

---

## Links

- [Play on testnet](https://testnet-agent.lazysuperheroes.com)
- [The dApp itself](https://testnet-dapp.lazysuperheroes.com) (the lottery the agent plays)
- [Lazy Superheroes](https://lazysuperheroes.com) (the universe)
- [HashPack](https://www.hashpack.app/) and [Blade](https://bladewallet.io/) (Hedera wallets)
- [Engineering blog](docs/blog/) — if you want to peek behind the curtain
- [Features](FEATURES.md) — full capability list
- [README](README.md) — the engineering / operator entrypoint
