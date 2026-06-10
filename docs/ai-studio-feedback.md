# Feedback on Hedera AI Studio (Agent Kit V4 + x402)

Submitted for the Hedera Commerce Agent bounty. This is an earned retrospective:
we integrated the **Hedera Agent Kit V4** and **x402-on-Hedera** into an existing,
production, dual-protocol (MCP + A2A) agent — LazyLotto — adding a chat interface
and an HBAR-priced "rake holiday" payment gate. Both are verified working live on
testnet. Feedback below is concrete and ordered by where it cost us the most time,
because the parts that worked well need no fixing.

## Context

- Existing app: Next.js 16 (App Router, webpack) on Vercel; writes via
  `@hashgraph/sdk` with a server-held key; MCP server (23 tools) + A2A adapter.
- Added: a `/chat` route backed by `@hashgraph/hedera-agent-kit-ai-sdk`
  (`HederaAIToolkit`) routing read-only Hedera query plugins **plus** a custom
  plugin wrapping our existing MCP tools; and an x402 gate
  (`@x402/core` + `@x402/hedera`) collecting HBAR/USDC for a 0%-rake upgrade.

## What worked well (please don't change these)

- **V4's opt-in plugins are excellent for security.** Loading only the
  `*Query` (read-only) plugins and *never* the mutating ones means the chat LLM
  structurally has no kit tool that can move value — the guarantee is "what you
  didn't load," not "what you remembered to deny." We could route all value
  movement through our own audited path and use the kit purely as a tool router.
- **The Vercel AI SDK toolkit is the right abstraction.** `toolkit.getTools()`
  drops straight into `streamText({ tools })`, and `middleware()` into
  `wrapLanguageModel`. Near-zero glue between the kit and a streaming Next.js
  route.
- **Custom plugin authoring was straightforward.** Wrapping our existing tools as
  a plain-object `Tool` (`method` / `parameters` (Zod) / `execute`) and returning
  them from a `Plugin.tools(ctx)` function "just worked" — we threaded our session
  token via `configuration.context` and built the toolkit per request.
- **AUTONOMOUS vs RETURN_BYTES** is a clear, well-named model.

## Friction (papercuts, ordered by time cost)

1. **`@hiero-ledger/sdk` vs `@hashgraph/sdk` — the rename split.** The kit
   peer-deps `@hiero-ledger/sdk@^2.81.0`, but our app and a lot of the ecosystem
   still use `@hashgraph/sdk`. Worse, `@hashgraph/hedera-wallet-connect@2.1.2`
   **exact-pins** `@hiero-ledger/sdk@2.79.0`, which conflicts with the kit's
   `^2.81.0` — `npm install` fails with `ERESOLVE`. We fixed it with an npm
   `overrides` forcing a single hoisted version, and we build the kit's `Client`
   from `@hiero-ledger/sdk` so no object crosses between the two SDK identities.
   *Ask:* document the interop story (or ship a thin `@hashgraph/sdk`
   compatibility re-export), and nudge `hedera-wallet-connect` off the exact pin.

2. **Zod 3 vs 4.** The kit pins `zod@3.25.76`; our app (and much of the
   React/Next ecosystem) is on `zod@4`. `ZodObject` identity differs across
   majors, which breaks both compile-time typing of `Tool.parameters` *and* the
   kit's runtime zod-to-json-schema. We isolated a `zod3` npm alias and keep
   kit-facing schemas on it. *Ask:* state the supported zod major prominently and
   add a "mixing zod majors" note.

3. **Bundling under Next.js / Vercel.** The kit (and its bundled
   `@modelcontextprotocol/sdk@1.27.1`) had to go in `serverExternalPackages` +
   webpack externals — the same minification class as the MCP SDK ("b is not a
   function"). It works great once externalized, but the config isn't obvious.
   *Ask:* ship a Next.js App Router / Vercel serverless example with the externals
   snippet and a Node-runtime note.

4. **`ai` is pinned exactly, which fights `@ai-sdk/react`.** The toolkit pins
   `ai@6.0.86`; `@ai-sdk/react@3.0.200` pins `ai@6.0.198`. Two copies of `ai`
   cause type drift between the kit's tools and `streamText`/`useChat`. We forced
   a single `ai` version via overrides. *Ask:* depend on `ai` with a `^` range,
   not an exact pin.

5. **Small docs-vs-reality gaps that cost a confusing error each.**
   - `HederaClientSignerConfig.network` is documented as "defaults to testnet,"
     but the value must be the **CAIP-2** `hedera:testnet` — `testnet` (the SDK
     network name) is rejected by `assertSupportedHederaNetwork`. One example line
     would prevent the `Unsupported Hedera network: testnet` error.

## x402-on-Hedera (the "agentic commerce" angle — most relevant to this bounty)

The `@x402/core` + `@x402/hedera` stack + the Blocky402 testnet facilitator worked
end-to-end: an agent can pay an HBAR-gated endpoint and have a capability unlock,
with the facilitator co-signing the fee. That's genuinely the right primitive for
the "expose a service requiring HBAR payment" brief.

The gotchas that cost us the most:

- **`x402Version` is `2`, not `1`.** The x402-foundation stack and Blocky402 both
  use version 2; a lot of x402 material (and Coinbase's original) shows `1`. We
  sent `1` and got `"No facilitator registered for x402 version: 1"`. The
  facilitator's `/supported` endpoint is the source of truth (it lists
  `x402Version: 2` per kind). *Ask:* lead with version 2 and the `/supported`
  source-of-truth in the Hedera x402 docs/examples.
- **The official Hedera x402 docs say `@x402/hedera` "is not yet published to
  npm" — but it is** (we used `2.13.2`). That stale note nearly steered us away
  from the correct package. *Ask:* un-stale it.
- **There's no canonical "Agent Kit + x402 *server-side gate*" example.** The
  published material covers the agent-as-payer side (e.g. the MPP plugin), but the
  bounty's actual use case is the *resource server* side — exposing a paid
  capability. We had to wire `x402HTTPResourceServer` / `HTTPFacilitatorClient` and
  construct `PaymentRequirements` from the types ourselves. A server-side gate
  example would be the single highest-value addition for "commerce agent" builders.

## Summary of asks

1. Document `@hashgraph/sdk` ↔ `@hiero-ledger/sdk` interop (or ship a compat alias).
2. State the supported zod major; add a dual-major note.
3. Ship a Next.js/Vercel serverless example with the externals config.
4. Loosen the toolkit's `ai` dependency from an exact pin to a `^` range.
5. Fix the `HederaClientSignerConfig.network` doc to show the CAIP-2 value.
6. In the x402 docs: lead with `x402Version: 2` + `/supported`; un-stale the
   `@x402/hedera` "not published" note; add a server-side payment-gate example.

Net: the kit and x402-on-Hedera are good, capable tools that we shipped a real
commerce agent on in days. Almost all the friction was packaging/versioning and
small docs gaps — not the core APIs.
