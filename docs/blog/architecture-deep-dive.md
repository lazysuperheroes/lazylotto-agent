# How We Built an Autonomous Lottery Agent on Hedera

Most MCP servers are talkers or listeners. Ours is both — and it has to be,
because it plays the lottery.

LazyLotto Agent is an autonomous player on the Hedera network. It reads
pool data, scores pools by expected value, buys entries, rolls for prizes,
and routes winnings back to users — all without a human in the loop. What
follows is a tour of the architectural choices we'd defend if we had to
build it again from scratch.

## One Lambda, multiple protocols

In serverless mode, a single Vercel Lambda boots three things at once:

- An **MCP server** (`/api/mcp`) that receives `tools/call` requests from
  Claude Desktop, Claude Code, Cursor, and the web dashboard.
- An **A2A endpoint** (`/api/a2a`) that other agents can discover via
  `/.well-known/agent-card.json` and call over JSON-RPC 2.0.
- An **MCP client** that connects *outbound* to the LazyLotto dApp's own
  MCP endpoint to read pool data.

That last bullet is the one people don't expect. The dApp lives in a
separate repo and exposes its own MCP surface for read tools. Our agent
consumes that endpoint as a client *while simultaneously* serving its own
endpoint to other clients. Two transport handshakes, one cold start.

The A2A layer is deliberately thin. `src/a2a/adapter.ts` doesn't reimplement
any business logic — it parses the incoming A2A message, extracts a `skill`
ID and `params` object, and re-issues the call as an HTTP `tools/call`
against the local MCP endpoint. Parity is by *construction*, not by
discipline. `npm run check-protocols` calls every tool both ways against a
deployed URL and compares outputs; the deploy fails if they drift.

**Takeaway:** MCP is a graph, not a tree. Treat your service as both server
and client of the protocol when the data lives in a peer. And if you must
support a second protocol, make one a thin re-emission of the other so
there's only one handler tree to maintain.

## Three deployment modes, one codebase

The same `tsx` entry point runs on your laptop, on an operator's box, or
fronted by Vercel — and the only thing that changes is which `Store`
implementation we wire up.

- **Single-user local** — your wallet, your prizes, in-memory state, no
  Redis. The agent plays for itself.
- **Multi-user local** — operator runs a CLI managing many users.
  `PersistentStore` writes JSON files in `.custodial-data/` with atomic
  writes and debounced flush.
- **Multi-user hosted** — Vercel + Upstash Redis. `RedisStore` with
  write-through cache, distributed locks via `SET NX EX` + Lua
  compare-and-delete. This is the primary mode at
  `testnet-agent.lazysuperheroes.com`.

The persistence seam is one interface, three backends. Distributed locks
degrade to in-memory mutex when there's no Redis. Strategy files are
inlined in the loader (`src/config/loader.ts`) so the serverless
filesystem-less environment still has them. Auth sessions fall back to an
in-memory `Map`.

We built local-without-Redis first, on purpose. Every leaky abstraction
that would have surfaced in production showed up against a JSON-file
backend instead, where iteration costs nothing.

**Takeaway:** Build the production mode last. Ship the local-without-Redis
mode first; you'll catch every leaky abstraction before users do.

## HCS-20 v2: an audit trail auditors can actually audit

The standard answer to "can I trust your custodial agent?" is "read our
code." Ours is "read the topic."

Every play session writes a structured sequence directly to a Hedera
Consensus Service topic:

```
play_session_open  →  N × play_pool_result  →  play_session_close
                                              (or play_session_aborted)
```

Plus `mint` (deposits), `transfer` (rake), `burn` (withdrawals), `refund`,
`prize_recovery`, and `control` ops for everything else. The wire format
is fully specified in
[`docs/hcs20-v2-schema.md`](../hcs20-v2-schema.md).

Three constraints made it work:

1. **Each message is self-sufficient.** A reader can interpret any single
   message without context from the others. No back-references to "see
   sequence 4271 for token mapping."
2. **Each message is ≤ 1024 bytes.** `AccountingService.submitV2Message`
   hard-fails on overflow. A truncated audit message is worse than a
   dropped one.
3. **Each message stamps a monotonic per-agent sequence number.** Recovered
   at startup via mirror node scan. Gaps in the sequence are detectable.

We ship a **standalone** verifier (`src/scripts/verify-audit.ts`) that
reconstructs every user's ledger from the topic alone — no Redis
dependency, no agent code path. That's the artifact we'd hand a regulator.

The reader (`src/custodial/hcs20-reader.ts`) handles both v1 batch and v2
sequence shapes via an anti-corruption layer — legacy testnet sessions
parse correctly and surface as `closed_success` with a "v1 legacy"
warning. We changed the format without orphaning history.

**Takeaway:** "Self-sufficient" is the bar. If your audit trail needs your
software to be interpretable, it's not an audit trail — it's a database
backup.

## Per-token reservation and settlement

The agent serves multiple users from one operator wallet. Cross-user
fund leakage is the kind of failure mode the architecture must rule
out by design, not by review.

The model is a strict invariant: build a
`Map<token, reservedAmount>` over the intersection of the user's
positive-balance tokens with the strategy's budgeted tokens. Reserve
each token independently. Settle each from
`report.poolResults[].feeTokenId` after the play. The pool filter is
restricted to the reserved-token set so the LottoAgent only ever sees
pools the user can afford. `FeeTokenFilterSchema` accepts an array
form (`['HBAR','LAZY']`) for mixed-balance users — the data structure
is a Map, not a sum, all the way down.

Defense-in-depth: if the play loop ever attempts to spend a token
outside the reservation set, `MultiUserAgent.playForUser` throws and
the catch block releases every outstanding reservation. The
invariant is locked in by a regression test —
*"HBAR-only user only has HBAR in the reservation set"* — that runs
on every commit.

**Takeaway:** When an invariant spans multiple resources, the data
structure should reflect that, and the tests should encode the
failure mode, not just the happy path.

## Layered safety: individual fail-open, aggregate fail-closed

The agent's safety surface is several guards on top of one Redis
dependency: a kill switch, a withdrawal velocity cap, a per-identity
rate limiter, distributed locks. The architectural choice is what each
layer does when Redis hiccups.

The individual guards fail open on transient errors. A 200ms upstream
blip should not lock everyone out of withdrawals; that responsiveness
is the right policy at the per-call layer.

The aggregate is governed by a separate policy. A process-local
circuit breaker watches the same Redis client every guard uses.
Three failures within 60 seconds opens the breaker. While the breaker
is open, write-path routes (play, withdraw) return a clean
`redis_degraded` 503 until a successful Redis operation closes it.
Reads continue normally throughout.

Two layers, two policies — the individual layer optimizes for
responsiveness, the aggregate layer optimizes for correctness when the
shared dependency is genuinely unhealthy. Same shape as the per-token
reservation invariant: when the property spans multiple components,
the answer is a structural one, not a per-component patch.

**Takeaway:** When safety guards share a dependency, the dependency's
health is itself a guarded surface. Two-layer policies — local
fail-open, aggregate fail-closed — give you both responsiveness and
correctness without either compromising the other.

## Serverless × Hedera: making the constraints work for you

Serverless gives you scale-to-zero. Hedera gives you a 4-second
mirror node lag. The agent's design accepts both as constraints and
composes around them rather than fighting either.

**On-demand deposit detection.** No cron. A balance-dependent route
(`multi_user_deposit_info`, `multi_user_play`, `multi_user_play_history`)
runs `pollOnce()` before answering. No idle Lambdas, no cron drift,
deposits credit when the user next looks. The "revisit when" condition is
documented: when push notifications need balance-change events, we'll add
a cron route. The `DepositWatcher.pollOnce()` API is already in place for
that day.

**Webpack externalization.** Minification mangles
`@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` (you get
`b is not a function` at runtime). Solution: mark it `external` so Node
loads it from `node_modules` directly — same pattern Prisma uses.
Standards-SDK was externalized for a similar file-type ESM issue; fixed
upstream in v0.1.174 so we removed that one.

**Distributed locks via Redis.** `SET NX EX` for acquisition, fence token
via `randomUUID()`, Lua compare-and-delete for release — the standard
correct pattern. Used at every play and withdraw entry point so two
warm Lambdas can't double-spend the same user's balance. Same pattern
backs the per-identity rate limiter (`INCR` + TTL).

**Stderr-only logging.** `src/lib/logger.ts` writes exclusively to
`process.stderr`. The stdio MCP transport uses stdout for JSON-RPC, so
anything on stdout corrupts the protocol. `src/index.ts` redirects stray
`console.log` calls to stderr in `--mcp-server` mode as a belt-and-braces
guard. JSON format in production, pretty colored text in dev. The
invariant is non-negotiable.

**Prize transfer retry ladder.** Gas scales with prize count: 500K base
+ 225K per prize, escalating to 300K then 400K per prize on retries,
capped at 14M. Defined in `PRIZE_TRANSFER_RETRY` in
`src/config/defaults.ts`. Failures dead-letter as
`prize_transfer_failed` with the full retry log and surface in the admin
dashboard. The recovery path
(`operator_recover_stuck_prizes`, plus a CLI script) uses the same
ladder and writes a `prize_recovery` event to the audit trail.

**Production preflight.** Hosted deploys require Upstash Redis to be
configured before any API route will serve a request. Missing
credentials in production cause every route to return
`PRODUCTION_REDIS_REQUIRED` 503 on the first call. Redis is required
by design — there is no in-memory fallback in production that could
let the system run with diminished safety guarantees.

**Takeaway:** Lazy Superheroes earned their name twice over — the
agent's whole job is to be lazy on your behalf, and the production
stack is engineered to do the minimum until a real user actually
shows up. Lazy is a discipline applied selectively, though.
Infrastructure preconditions get the loud-fail treatment; transient
upstream errors get responsiveness; sustained dependency outages get
structural strictness. Pick the right policy for the right layer.

## What's next on the architecture roadmap

A few forward-looking items worth flagging:

- **Direct HTTP for dApp reads in serverless.** The dual MCP role
  works, but each play burns two MCP transport handshakes. A direct
  HTTP client for dApp reads in serverless mode would eliminate the
  webpack externalization requirement and shave cold-start latency.
- **Push-based deposit detection.** On-demand polling is the right
  default for low traffic, but a Hedera mirror node webhook (or a
  slow cron) would unblock balance-change push notifications for
  power users.
- **Hardware-backed signing graduation.** The trust boundary is
  documented and bounded today; the operator-wallet AUM threshold for
  graduation is wired into the monthly reconcile report so the
  trigger fires on its own.

We're not in a rush. The system runs. Users play. The audit trail is
verifiable from public data. The agent is doing its lazy job, and so
are we.

---

If this kind of thing is your jam, the repo is at
[github.com/lazysuperheroes/lazylotto-agent](https://github.com/lazysuperheroes/lazylotto-agent)
and the testnet instance is at
[testnet-agent.lazysuperheroes.com](https://testnet-agent.lazysuperheroes.com).
PRs welcome. Tickets even more so.
