# Lazy Wins: Why We Built an Agent That Plays the Lottery So You Don't Have To

There's a particular kind of Web3 fatigue that hits at exactly the moment
you realize the cool new on-chain thing you signed up for has, in fact,
become a chore.

Approve a token. Wait for consensus. Click a button. Sign a transaction.
Wait again. Read the receipt. Claim the result. Repeat next week. Every
protocol promises a magical user experience and ships a to-do list.

LazyLotto is a Hedera-based lottery with token rewards and NFT prizes.
Played manually, it has the same problem. You'd want to know which pools
have positive expected value. You'd want to size entries against your
budget. You'd want to actually remember to claim. You'd want to do this
often enough to matter, but not so often it becomes a job.

So we built an agent that does all of it for you. And we made the agent
itself a Lazy Superhero.

## The thesis

Three things just landed at the same time and nobody is talking about the
combination:

1. **AI agents** that can be reasoned with conversationally and called
   programmatically.
2. **A blockchain (Hedera)** that's fast enough and cheap enough to be the
   back-end for a real consumer product instead of a science fair demo.
3. **Open agent protocols** — MCP for AI clients, A2A for agent-to-agent
   discovery — that finally give software agents a standard way to take
   actions in the world without bespoke API glue per service.

Stack those, and "I have an agent that plays a lottery for me" stops being
a tech demo and becomes a perfectly reasonable consumer product. You log in
with a wallet. You deposit. You go do something else. You check back later.

That's the bet. AI-native, on-chain, and so quiet you forget it's there.

## "Lazy" is a virtue

The Lazy Superheroes universe runs on a premise we believe in earnestly:
laziness, applied correctly, is just efficiency with better branding. The
lazy hero is the hero who automated their job, delegated their nemesis,
and got a nap in by 3pm. The lazy villain is plotting world domination,
but only as a passive-income stream.

The LazyLotto Agent is exactly that character. It's so lazy it built a
robot to play the lottery for itself. Then it figured out it might as well
let everyone else hire the robot. Now it sits there, scores pools by
expected value, presses buttons, and routes the prizes back to whoever's
name is on the deposit memo, while the rest of us go do anything else.

This isn't a marketing tagline. It's a design constraint. Anywhere we
caught ourselves adding a step the user had to remember to do, we asked:
can we make the agent do it instead? Token associations? Agent does it.
Contract approvals? Agent does it. Picking pools? Agent does it. Claiming
prizes? Agent does it. Gas escalation when a transaction undershoots?
Agent does it, with a retry ladder. The user's job is to have a wallet
and to want to play.

## Two protocols, one agent

There's a small architectural decision we're proud of. The agent isn't a
website with an API stapled on, and it isn't an MCP server with a website
stapled on. It's *both protocols, equally*, sharing one underlying brain.

- **MCP (Model Context Protocol)** is how AI clients like Claude Desktop,
  Claude Code, Claude.ai, and Cursor talk to it. Tool calls, structured
  results, the whole pattern.
- **A2A (Agent-to-Agent)** is how *other* AI agents discover and call this
  one. There's a standard `/.well-known/agent-card.json` they fetch to
  learn what skills exist and how to authenticate. They speak JSON-RPC
  2.0, get back tasks with artifacts.
- The web dashboard is a third surface, same auth, same tools, just with
  a much nicer character mascot.

Pick whichever surface fits your day. The agent doesn't care. The math is
the same.

## Who this is for

A few different shapes of person:

**The degens.** You don't want another DeFi chore. You want to deposit and
you want it to compound while you sleep. The agent runs sessions, plays the
math, and claims. You wake up with results.

**The NFT holders.** If you own Lazy Superheroes (Gen 1) or Lazy Super
Villains (Gen 2) NFTs, you can delegate them to the agent — the agent never
takes custody — and the LazyLotto contract reads that delegation as a
win-rate boost. You don't lift a finger. The boost just shows up.

**The AI-native crowd.** You already live in Claude or Cursor. Connect the
agent's MCP endpoint, and *"play a lottery session, but only on
positive-EV pools"* is something you can ask in plain English. We tested
against Claude.ai, Claude Desktop, Claude Code, and Cursor. Anything that
speaks MCP works. Anything that speaks A2A works.

**The self-sovereignty crowd.** You read "custodial" and your eyebrow
goes up. Fair. The agent is open source, and the same code that powers
the hosted testnet runs single-user on your laptop with your own Hedera
wallet — Claude Desktop talks to it over stdio, prizes go straight to
your account, no operator wallet in the loop at all. If you'd rather
hold your own keys, you can. The README has setup down to one wizard
command.

**The crypto-curious.** You have a Hedera wallet. You want to play. You
don't want to learn what an HTS allowance is. You hit Play. That's the
whole onboarding.

## What's actually different

Plenty of bots play crypto games. Plenty of dApps offer lotteries. The
combination here is what's new:

- **Genuinely autonomous.** The agent runs a six-phase play loop end-to-end
  without supervision. It handles its own gas, retries failed prize
  transfers with an escalating gas ladder, dead-letters the truly broken
  cases for an operator to look at later, and never gets stuck waiting on
  a human.
- **Protocol-native, not API-shimmed.** First-class MCP and first-class A2A.
  Skill IDs map 1:1 to MCP tool names. The two surfaces share the same
  handler tree by construction — there's a smoke test (`npm run
  check-protocols`) that calls each tool both ways and compares outputs.
- **Auditable by anyone.** Every deposit, every play, every fee, every
  prize, every refund is written to an HCS-20 topic on Hedera. We ship a
  standalone verifier script that reconstructs the per-user ledger from
  the public mirror node alone. No special access. The artifact we'd hand
  a regulator is the same artifact a curious user can run from their
  laptop.
- **Custodial, but with the lid off.** Yes, while you're playing, your
  funds sit in the agent wallet — that's the trade for not having to
  manage Hedera tokens yourself. But withdrawals are pinned to the wallet
  you registered with (the operator literally cannot reroute them), and
  the on-chain log is the source of truth for every cent. Trust, but
  verify, because the verifier exists.

## The Lazy Superheroes universe

Quick context for the unfamiliar: Lazy Superheroes is a two-generation NFT
collection on Hedera. Gen 1 is the heroes — Lazy Superheroes proper. Gen 2
is the villains — Lazy Super Villains. The dApp is a full ecosystem
(staking, farming, NFT exchange, missions). LazyLotto is one of the games
inside it. The agent is a new species: not a passive utility, not a smart
contract, but a character — an autonomous AI player that's a citizen of
the same universe. LAZY Gold accents, Unbounded headings, dark mode,
in-character on the mascot — you'll see what we mean.

## Try it

Testnet is live now: **[testnet-agent.lazysuperheroes.com](https://testnet-agent.lazysuperheroes.com).**
Wallet, faucet, deposit, play. Bring HashPack or Blade, get free testnet
HBAR from the Hedera faucet, and you're playing in five minutes.

Mainnet is one UAT pass away. If you sign in on testnet now, your account
carries over and you'll be at the front of the mainnet line.

We've done the work. You go be lazy. That's what the agent is for.
