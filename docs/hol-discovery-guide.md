# Finding the LazyLotto Agent on HOL (Testnet)

> Audience: anyone who wants to understand how the LazyLotto testnet agent
> shows up in the [Hashgraph Online](https://hol.org) agent registry, how
> discovery actually works end-to-end, and how to poke at it from curl.

This is a tour of **how** our agent is discoverable, not a how-to for
signing in. If you just want to play, read the
[testnet user guide](./testnet-user-guide.md) — you don't need HOL at all
to use the web dashboard or Claude integration.

---

## What HOL is (in 30 seconds)

**Hashgraph Online** runs a public agent registry: a searchable index
over AI/autonomous agents deployed across a bunch of chains and
protocols. At the time of writing it indexes ~184,000 agents from 15
upstream registries (ERC-8004, Virtuals Protocol, Agentverse, PulseMCP,
Moltbook, Coinbase x402 Bazaar, NANDA, OpenRouter, Near AI, the
`hashgraph-online` namespace we live in, and a few others).

You can think of it as three layers, each one query-able on its own:

1. **Hedera consensus** — the immutable source of truth. Our profile is
   an [HCS-11](https://hashgraphonline.com/docs/standards/hcs-11/) JSON
   document pinned to a Hedera Consensus Service topic. Nothing can ever
   remove those messages — they're an append-only log on Hedera mainnet
   consensus.
2. **The HOL registry broker** — the public index at
   `https://hol.org/registry/api/v1`. It crawls HCS-11 topics plus
   profiles from other registries and exposes search/resolve/stats APIs
   over the top.
3. **Our `/api/discover` endpoint** — the live handshake document at
   `https://testnet-agent.lazysuperheroes.com/api/discover`. Returns the
   agent's *current* operational config: endpoints, fees, capabilities,
   auth flow. This is the layer that changes when we redeploy.

A well-behaved HOL client walks all three: search → resolve → live
discover. The layers progress from "oldest and most immutable" to
"freshest and most operational."

---

## Our registration at a glance

From `.agent-config.json` (gitignored) on the operator's machine:

| Field | Value |
|---|---|
| Network | testnet |
| Hedera account | `0.0.8456987` |
| HCS-11 profile topic | `0.0.8545460` (current, re-inscribed 2026-04-07) |
| Previous topic | `0.0.8500338` (orphaned, still on-chain but unreferenced) |
| UAID (bare aid form) | `uaid:aid:4PDJJwJMcXvTptApcCV4CP775CSkYBVn1dZk87kSHL4cAp8mdq7JDrL4oVQpaZcgoL` |
| UAID (namespaced form) | same aid + `;uid=lazylotto-agent;registry=hashgraph-online;proto=a2a;nativeId=lazylotto-agent` |
| Registry namespace | `hashgraph-online` |
| Protocol | `a2a` (Agent-to-Agent) |
| Category | `gaming` |
| Capabilities | `transaction_analytics`, `workflow_automation`, `market_intelligence`, `multi_agent_coordination` |

**A note on UAIDs.** The `aid` portion (`4PDJ...kSHL4cAp8mdq7JDrL4oVQpaZcgoL`)
is deterministically derived from our Hedera account + key pair, so it
never changes. The `;uid=...;registry=...;proto=...;nativeId=...`
suffix is registry metadata. Both forms resolve to the exact same
record.

---

## Poking at it from curl

Everything below is public. No auth, no API key needed for these reads.
All commands work on Linux, macOS, and Windows (Git Bash / WSL) without
modification. `jq` is optional — if you don't have it installed, drop
the ` | jq .` at the end and you'll get unformatted JSON (pipe through
`python -m json.tool` as a cross-platform alternative).

> **Windows Git Bash gotcha.** Don't use `node -e "encodeURIComponent(...)"`
> inside `$(...)` command substitution on Git Bash — winpty eats the
> output and you get an empty string, which turns the curl URL into a
> bare `/resolve/` that returns 404. The snippets below use pure bash
> parameter expansion (`${VAR//:/%3A}`) to avoid this entirely.

### Registry health & scale

```bash
curl -s https://hol.org/registry/api/v1/stats | jq .
```

Shows `totalAgents`, counts per registry, counts per capability code,
and the broker's `lastUpdate` timestamp.

### Search by keyword

```bash
curl -s "https://hol.org/registry/api/v1/search?q=lazylotto&limit=10" | jq '.hits[] | {name, id, uaid, registry}'
```

Without `jq`, drop the trailing pipe and you'll get the raw JSON — the
relevant fields are `hits[].name`, `hits[].id`, `hits[].uaid`, and
`hits[].registry`.

Expected hits:
- `lazylotto-agent` — the current multi-user custodial service (what
  this repo is)
- `lazylotto-player` — an older single-user version registered
  2026-04-01, still listed

You can also search by capability, by natural-language phrase, or
combine filters. Try `?q=hedera+lottery` or `?q=gaming+agent`.

### Resolve a specific UAID

A UAID contains colons, which need to be URL-encoded to `%3A` before
going into the path. Bash parameter expansion handles this in one line
and works identically on Linux, macOS, and Windows Git Bash:

```bash
UAID="uaid:aid:4PDJJwJMcXvTptApcCV4CP775CSkYBVn1dZk87kSHL4cAp8mdq7JDrL4oVQpaZcgoL"
ENCODED="${UAID//:/%3A}"
curl -s "https://hol.org/registry/api/v1/resolve/$ENCODED" | jq .
```

If you prefer to skip the variable dance, the pre-encoded URL works
directly:

```bash
curl -s "https://hol.org/registry/api/v1/resolve/uaid%3Aaid%3A4PDJJwJMcXvTptApcCV4CP775CSkYBVn1dZk87kSHL4cAp8mdq7JDrL4oVQpaZcgoL" | jq .
```

Returns the broker's cached copy of the agent record. **Read the next
section carefully** for what's actually in this response — it's
narrower than you probably expect.

### List all registries the broker indexes

```bash
curl -s https://hol.org/registry/api/v1/registries | jq .
```

Useful if you want to understand the ecosystem around us — who else is
indexed, what namespaces exist.

---

## What the broker actually stores (and what it drops)

This is the part that surprised us while writing this guide, so it gets
its own section.

When you register an HCS-11 agent with HOL you can attach an arbitrary
`properties` bag to the profile — we put things like `mcp_endpoint`,
`discover_endpoint`, `auth_endpoint`, `rake_range`, `accepted_tokens`
in there because the spec allows it. **The broker drops the entire
`properties` bag when it indexes you.** It also ignores any populated
endpoints map and shows `customEndpoints: {}` instead.

What the broker *does* surface via `/resolve`:

| Field | Source | Example |
|---|---|---|
| `id` | `alias` at registration | `lazylotto-agent` |
| `uaid` | derived from Hedera key | `uaid:aid:4PDJ...` |
| `name` | `display_name` | `LazyLotto Agent` |
| `description` | `bio` | long free-text, **including the auth URL** |
| `capabilities` | `AIAgentCapability[]` numeric codes | `[10, 18, 9, 16]` |
| `metadata.category` | registration metadata | `gaming` |
| `metadata.nativeId` | registration alias | `lazylotto-agent` |
| `metadata.registry` | registration namespace | `hashgraph-online` |
| `metadata.protocol` | registration protocol | `a2a` |
| `metadata.capabilityLabels` | string form of capabilities | `["transaction_analytics", ...]` |
| `metadata.additionalRegistries` | cross-listed registrations | ERC-8004 on SKALE Base in our case |
| `metadata.verified` | ownership verification status | `false` (we haven't done DNS/signature proof) |

What the broker *does not* surface:

- `properties.mcp_endpoint` — dropped
- `properties.discover_endpoint` — dropped
- `properties.auth_endpoint` — dropped
- `endpoints.customEndpoints` — empty object
- `profileTopicId` — not tracked at all; you can't find our HCS-11 topic via the broker
- Anything else in the HCS-11 `properties` bag

### Why this matters

A client searching HOL for "lottery agents on Hedera" will find us
instantly by name and capability — discovery works. But then if they
need to actually *connect* to us, the broker doesn't give them a URL.

Their options:

1. **Read the description text.** Our bio explicitly says
   *"Authenticate via Hedera signature challenge at
   https://testnet-agent.lazysuperheroes.com/auth"*. A smart client
   (or a human reading the profile) can extract that URL and derive
   the rest: `/api/discover` for live config, `/api/mcp` for the MCP
   endpoint. This is the pragmatic path.
2. **Walk the HCS-11 topic directly.** If the client knows our HCS-11
   topic ID (which isn't in the broker response — they'd need to look
   it up from Hedera mirror node via our `0.0.8456987` account memo),
   they can fetch the topic's latest message and read the full
   `properties` bag from the raw JSON. This gets them `mcp_endpoint`,
   `discover_endpoint`, etc. directly.
3. **Use HOL's chat routing.** The broker has a `/chat/session`,
   `/send-message`, and session APIs that proxy messages to
   registered agents. A client can talk to us *through* the broker
   without ever learning our URL. This is the most "HOL-native" path
   but requires both sides to speak the OpenConvAI message format.

For LazyLotto specifically, option 1 is the intended path — the agent
speaks MCP over HTTP, not OpenConvAI chat protocol, so clients will
end up at our `/api/discover` one way or another.

---

## The intended end-to-end discovery flow

Here's what a well-behaved HOL client does from scratch:

```
┌──────────────┐
│  1. Search   │ GET /search?q=lottery+hedera
└──────┬───────┘
       ▼
┌──────────────┐
│  2. Resolve  │ GET /resolve/{uaid}
└──────┬───────┘         returns name, description, capabilities
       ▼                 (but no URLs — that's the gap)
┌──────────────┐
│ 3. Extract   │ Parse description text for the auth URL
│   base URL   │ → https://testnet-agent.lazysuperheroes.com
└──────┬───────┘
       ▼
┌──────────────┐
│ 4. Discover  │ GET {baseUrl}/api/discover
└──────┬───────┘         returns live endpoints, fees, auth flow
       ▼
┌──────────────┐
│  5. Auth     │ POST /api/auth/challenge {accountId}
│              │ sign nonce with Hedera key
│              │ POST /api/auth/verify {challengeId, sig}
└──────┬───────┘         returns sk_ session token
       ▼
┌──────────────┐
│  6. Connect  │ POST /api/mcp with Authorization: Bearer sk_...
│              │ (or ?key=sk_... query parameter)
└──────────────┘
```

Steps 1–3 happen on HOL's infrastructure. Steps 4–6 hit our agent
directly. Once step 4 is done the client has a machine-readable
description of everything we offer — they don't need to ever talk to
HOL again for that session.

---

## Gaps and quirks (be aware of these)

- **The broker drops endpoint URLs.** Already covered above — we can't
  fix this from our side without the broker team adding `properties`
  passthrough. It's why the description text exists as a URL carrier.
- **Profile updates require support we don't have.** The broker's
  `PUT /register/{uaid}` endpoint returns `503 profile_registry_unavailable`
  for our registry. We tried. The only way to change what the broker
  holds is to re-register with a fresh `alias`/`nativeId`, which would
  create a second listing without removing the first.
- **Deletion needs ownership proof we haven't set up.** The broker has
  `DELETE /register/{uaid}` but the API key alone returns
  `401 Invalid API key`. It almost certainly needs a signature-based
  ownership challenge (moonscape's UI probably handles this for
  self-service). We haven't needed to delete anything, so we haven't
  pursued it.
- **The `verified: false` flag.** Our profile has this because we
  haven't completed HOL's DNS-TXT or on-chain ownership verification.
  That's optional — it just means HOL clients that filter for
  verified-only won't see us. We can add it later if it becomes a
  friction point.
- **Two LazyLotto agents in search.** The older `lazylotto-player`
  entry from 2026-04-01 is the previous single-user version. It still
  resolves, even though it's no longer the deployed service. Clients
  searching for "lazylotto" will see both — use the `lazylotto-agent`
  entry (the one whose description mentions "multi-user custodial"
  and points at `testnet-agent.lazysuperheroes.com`).

---

## For ecosystem partners: the short version

If you're building an HOL client or agent that wants to talk to
LazyLotto, here's the checklist:

1. Search HOL for `lazylotto` or query by capability `transaction_analytics`.
2. Pick the hit where `metadata.nativeId === "lazylotto-agent"` and
   `registry === "hashgraph-online"`.
3. Hit `https://testnet-agent.lazysuperheroes.com/api/discover` for
   the live config payload. Everything you need — auth flow, fee
   structure, MCP URL, supported tokens — is in there.
4. Walk the advertised auth flow to get a session token.
5. Connect to `/api/mcp` with the token.
6. Register your user via the `multi_user_register` tool, deposit HBAR
   with your memo, and call `multi_user_play`.

For the human-facing version of steps 4–6 (with screenshots, wallet
setup, and example prompts), see the
[testnet user guide](./testnet-user-guide.md).

---

## Reference endpoints

| Endpoint | Purpose |
|---|---|
| `https://hol.org/registry/api/v1/search?q=...` | Full-text agent search |
| `https://hol.org/registry/api/v1/resolve/{uaid}` | Fetch one agent's record |
| `https://hol.org/registry/api/v1/stats` | Registry-wide counts |
| `https://hol.org/registry/api/v1/registries` | List all upstream registries |
| `https://moonscape.tech/openconvai/agents` | HOL-aligned web UI for browsing agents |
| `https://hashscan.io/testnet/topic/0.0.8545460` | Our current HCS-11 profile topic |
| `https://hashscan.io/testnet/account/0.0.8456987` | Our agent Hedera account |
| `https://testnet-agent.lazysuperheroes.com/api/discover` | Live operational config (the source of truth for endpoints and fees) |
| `https://testnet-agent.lazysuperheroes.com/api/health` | Liveness check |
| `https://testnet-agent.lazysuperheroes.com/api/mcp` | MCP endpoint (requires auth) |

---

**Testnet reminder.** Everything above is on Hedera testnet. Testnet
HBAR has no real-world value, HOL's testnet entries come and go, and
this guide itself is a moving target until we graduate to mainnet.
If something here doesn't match what you see in the wild, the live
`/api/discover` endpoint is always the source of truth.
