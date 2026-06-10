# Turning an Autonomous Agent into a Commerce Agent

We already had an agent that plays the lottery for you. The question this post
answers: how do you bolt **agentic commerce** onto a production agent — a chat
interface and an on-chain payment gate — *without* loosening any of the
guarantees that made it trustworthy in the first place?

Two surfaces, both built for the Hedera Commerce Agent brief, both **feature-
flagged off by default**, and — the part we care about most — **neither one
touches the audited settlement path**. Here's how, and what it cost us.

## The constraint that shaped everything

LazyLotto's money path is boring on purpose. Deposits are raked at credit time,
plays reserve and settle per-token, and every movement lands on an immutable
HCS-20 topic an external auditor can replay without our database. That core
survived a twelve-round adversarial audit. The last thing we wanted was for
"add a chatbot" to become "add a chatbot that can move funds in a way the audit
trail doesn't see."

So the rule for both new surfaces was the same: **the commerce layer is a
client of the audited core, never a bypass of it.** Everything below follows
from that one sentence.

## Surface 1 — a chat agent that structurally cannot move value

The chat interface is built on the **Hedera Agent Kit** (V4) used as a *tool
router*, wired into the Vercel AI SDK. The kit ships opt-in plugins, and that
opt-in design turned out to be a security feature, not a convenience:

```ts
// src/agent-kit/toolkit.ts — the entire tool surface
plugins: [
  coreAccountQueryPlugin,      // read-only
  coreTokenQueryPlugin,        // read-only
  coreConsensusQueryPlugin,    // read-only
  coreTransactionQueryPlugin,  // read-only
  coreMiscQueriesPlugin,       // read-only
  createLazyLottoPlugin({ ... }) // our custodial tools, via the audited MCP path
]
```

The kit's four **mutating** core plugins (`coreAccountPlugin`, `coreTokenPlugin`,
`coreConsensusPlugin`, `coreEVMPlugin`) are *never loaded*. The guarantee isn't
"we told the model not to transfer funds" — it's "the model has no tool that
*can*." That's a structural property, not a prompt, and we lock it with a
source-level test that fails the build if any mutating plugin name appears in the
toolkit file.

Where does value movement go, then? Through our own custom plugin, whose tools
don't act directly — they re-issue the call as a `tools/call` against our local
`/api/mcp` endpoint with the user's session token. Same per-user ownership
checks, same reservation/settlement logic, same audit writes as every other MCP
client. The chat LLM is just one more authenticated caller of the audited core.

**Takeaway:** when an LLM framework lets you choose which capabilities to load,
treat the *unloaded* set as your security boundary. "What you didn't load" is a
stronger guarantee than "what you remembered to deny."

### Play-via-chat, and the two-step confirm

The one mutating action we do expose to chat — starting a play — is gated twice.
First by a flag (`CHAT_ALLOW_PLAY`, off even when chat is on), and then by
construction: the `multi_user_play` tool **refuses to act unless
`confirm === true`**, returning a `confirmation_required` prompt instead. The
system prompt is instructed to set `confirm=true` only after the user explicitly
says yes. So the unhappy path — model decides to play on its own initiative —
returns a confirmation request, not a play. And even a confirmed play still flows
through the audited MCP path; nothing about "it came from chat" changes the
settlement.

Withdrawals are never wired into chat at all. Some actions belong on a button.

### Keeping a demo from bankrupting you

A chat box on a public app is an open invitation to burn tokens. The scope is
locked by a system prompt that declines anything off-LazyLotto in one sentence,
and the cost is bounded structurally: per-turn output-token cap, input-length
cap, history truncation, a tool-step ceiling, and a per-identity daily message
cap. The model is Haiku by default — the cheapest tier that can route tools
reliably. None of this is novel; all of it is necessary if you don't want a
"cool demo" line item on your bill.

## Surface 2 — an HTTP-native payment gate (x402 on Hedera)

The second surface is the actual "commerce" in commerce agent: a paid capability.
We sell a **rake holiday** — pay a USD-denominated price and your deposits are
raked at 0% for 30 days — collected over **x402 on Hedera**.

x402 is HTTP-native payments: an endpoint answers an unpaid request with `402
Payment Required` and a machine-readable list of what it'll accept; the caller
signs a transfer and retries with an `X-PAYMENT` header; a facilitator verifies
and settles on-chain. It's the right primitive for "an agent pays for a service,"
because the whole negotiation lives in the request/response the agent is already
making.

The design choice that mattered: **x402 is an alternative payment channel, not a
replacement for the rake.** The deposit-time rake is untouched. A holiday doesn't
re-plumb how rake is computed — it flips a single seam:

```ts
// the ONLY integration point in the deposit path
const rakePercent = await getEffectiveRakePercent(user.userId, user.rakePercent);
// → 0 during an active holiday, else the base rate
await ledger.creditDeposit(/* ...unchanged... */ rakePercent);
```

`creditDeposit` — the audited function — is byte-for-byte the same. A holiday is
purely "which number gets passed in." The grant itself lives in Redis keyed by
the settlement transaction, idempotent through the same primitive that protects
withdrawals from double-execution. No new code path can rake differently; there's
only ever one rake path, fed a different rate.

### The on-chain receipt, without a new audit op

We wanted the payment visible to a topic-only auditor — so they can see *why* a
user's deposits were suddenly credited at 0%. The tempting move is a new HCS-20
message type. We didn't, because that v2 schema is load-bearing and rippling a
new op through the reader, the verifier, the doc generator, and the coverage
ratchet is real risk for a flag-gated feature.

Instead the receipt is a **control event** — an existing, non-balance-affecting
message kind the reader already handles generically and the verifier already
ignores for balance math. The settlement tx rides the dedup key; a human summary
rides a free-text field. It carries no amount that any reducer reads, so it can't
perturb the conservation invariants. New capability, zero new surface on the
part of the system that has to stay correct.

**Takeaway:** when you bolt a feature onto an audited core, look for the existing
extension point that's *already* outside the balance math before you invent a new
one. The cheapest change to a load-bearing system is the one that doesn't touch
its load-bearing parts.

### Discoverable commerce

When the gate is live, `/api/discover` grows a `commerce` block — endpoint,
price, accepted assets, facilitator, CAIP-2 network — and the A2A Agent Card
description names the capability. An agent can find the paid service and drive
the payment loop without reading our docs. Note what we *didn't* do: the paid
capability is an HTTP route, not a `tools/call` skill, so it's deliberately
absent from the Agent Card's `skills[]`. Putting it there would have broken the
MCP↔A2A parity gate that guarantees every advertised skill is a real tool. The
advertisement lives where free-form metadata belongs.

## The tax: SDK identity, zod majors, and a version that's `2`

None of the friction was in the ideas. It was all packaging, and it's worth
writing down so the next builder doesn't lose the same afternoon:

- **`@hashgraph/sdk` vs `@hiero-ledger/sdk`.** The kit peer-deps the renamed
  `@hiero-ledger/sdk`; our app (and WalletConnect) use `@hashgraph/sdk`, and one
  dependency exact-pins a version that conflicts with the kit's range. An npm
  `overrides` block forces a single hoisted copy, and we build the kit's `Client`
  from `@hiero-ledger/sdk` so no SDK object ever crosses the identity boundary
  and trips an `instanceof`.
- **zod 3 vs 4.** The kit pins zod 3; the app is on zod 4, and `ZodObject`
  identity differs across majors — enough to break both the kit's typing and its
  runtime schema conversion. We isolate kit-facing schemas behind a `zod3` npm
  alias.
- **`x402Version` is `2`, not `1`.** A lot of x402 material shows `1` (Coinbase's
  original). The x402-foundation stack and the Blocky402 facilitator use `2`;
  send `1` and you get `No facilitator registered for x402 version: 1`. The
  facilitator's `/supported` endpoint is the source of truth. This single integer
  cost us the most time of anything in the payment flow.

We wrote the rest up as structured feedback for the Hedera AI Studio team — see
`docs/ai-studio-feedback.md`. The APIs are good; the gaps are packaging and a few
stale docs.

## What it adds up to

Two surfaces, a few hundred lines, both off by default, both clients of a core
we didn't have to reopen. The agent that played the lottery for you can now talk
to you about it and sell you a fee discount you pay for on-chain — and the audit
trail you could already verify without us still reconstructs the exact same way.
That last clause is the whole point.

---

*More: [How We Built It](architecture-deep-dive.md) for the dual-protocol core,
[Trust by Design](trust-by-design.md) for the security model the commerce layer
had to respect, and `docs/x402-payment-guide.md` for the hands-on payment
walkthrough.*
