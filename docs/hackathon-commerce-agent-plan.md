# Build Plan — Hedera Commerce Agent (Week-4 Bounty)

> Status: **APPROVED — Day 5 complete.**
> Author: Claude (Opus 4.8) · Started: 2026-06-08 · Branch: `feat/commerce-agent` · Base: v0.3.5
> Bounty: "Hedera Commerce Agent", $1,000 in HBAR, Live.

---

## Decisions locked (owner, 2026-06-09)

1. **Chat model → `claude-haiku-4-5`** (cheapest capable tier for this scoped tool-routing chat —
   3× cheaper than Sonnet; via `@ai-sdk/anthropic`; configurable via `CHAT_MODEL`, bump to
   `claude-sonnet-4-6` for headroom). *(Updated 2026-06-09 from the original Sonnet default.)*
2. **Gated capability → "rake holiday"**: pay a **USD-denominated price (default $5)** via x402 —
   in **USDC (1:1), or the live HBAR equivalent** (quoted from the mirror-node exchange rate
   `…/api/v1/network/exchangerate`, with a config-driven slippage tolerance, default 97%, to
   absorb quote→settle rate drift) — → **0% rake for 30 days** (price/duration configurable). This
   is the one option that touches the rake path; implemented **additively** via an *effective-rake
   resolver* (paid holiday active → pass `rakePercent = 0` into the UNCHANGED `creditDeposit`
   settlement code), locked by a regression test. Supersedes the earlier "premium analysis read"
   gated capability in §4/§5.
3. **HCS-20 x402 receipt → wired but flag-gated** (`X402_RECORD_TO_HCS20`, default off).

## Day-1 changes vs. the original plan (what actually shipped)

- **Dual-SDK fix changed from an *alias* to a *single forced version*.** The original plan proposed
  `overrides: { "@hiero-ledger/sdk": "npm:@hashgraph/sdk@..." }`. Install surfaced that
  `@hashgraph/hedera-wallet-connect@2.1.2` exact-pins `@hiero-ledger/sdk@2.79.0` while the kit needs
  `^2.81.0`. Resolved with `overrides: { "@hiero-ledger/sdk": "$@hiero-ledger/sdk" }` + a direct
  `@hiero-ledger/sdk@^2.81.0` dep → a **single `@hiero-ledger/sdk@2.84.0`** across the whole tree
  (verified via `npm ls`). This removes the `instanceof` hazard structurally; the chat handler will
  build the kit's `Client` from `@hiero-ledger/sdk` (same identity the kit uses). **Watch:** this
  bumps wallet-connect's SDK 2.79→2.84 — server-side signature *verification* uses `@hashgraph/sdk`
  + `@hashgraph/proto` (unaffected), but the **browser** WalletConnect signing flow should get a
  testnet UAT pass before merge.
- **Versions pinned as installed:** `@ai-sdk/anthropic@^3.0.81`, `ai@^6.0.86`,
  `@hashgraph/hedera-agent-kit@4.0.0`, `@hashgraph/hedera-agent-kit-ai-sdk@1.0.0`,
  `@hiero-ledger/sdk@^2.81.0`, `@x402/core@2.14.0`, `@x402/hedera@2.13.2`.
- **New env vars** (see `.env.example`): `CHAT_ENABLED`, `CHAT_MODEL`, `ANTHROPIC_API_KEY`,
  `X402_ENABLED`, `X402_FACILITATOR_URL`, `X402_PAY_TO`, `X402_RAKE_HOLIDAY_PRICE_TINYBARS`,
  `X402_RAKE_HOLIDAY_DAYS`, `X402_RECORD_TO_HCS20` — all default OFF.
- **Day-3 watch:** two `ai` copies (root `6.0.198`, kit-bundled `6.0.86`) — same major, expected
  compatible; confirm when wiring `streamText({ tools: toolkit.getTools() })`.

### Day-1 status — DONE ✅
- [x] Deps added + `overrides` + `npm install` clean (46 added; single SDK identity verified)
- [x] `src/config/features.ts` (default-OFF flag aggregator) + `.env.example` blocks
- [x] `next.config.mjs` externals (kit packages) + `tsconfig.cli.json` excludes (`src/agent-kit`, `src/x402`)
- [x] **`npm test` → 748/748** · **`npm run build:web` → clean** (both pre-push gates green, all flags OFF)

### Day-2 status — DONE ✅
- [x] `src/agent-kit/mcpBridge.ts` — chat→MCP bridge over HTTP, copied from the A2A adapter
      (origin → `/api/mcp`, R3-FG-60 strip-then-inject auth). Parity-by-construction.
- [x] `src/agent-kit/plugin.ts` — `createLazyLottoPlugin({ origin, authToken })` wrapping two
      **user-scoped read tools**: `multi_user_deposit_info` (balance + funding) and
      `multi_user_play_history`. (`multi_user_status` deliberately NOT wrapped — admin-only.)
- [x] **zod-major split solved**: kit-facing tool schemas use `zod3` (npm alias `zod@3.25.76`,
      `"zod3": "npm:zod@3.25.76"`) to match the kit's bundled zod major; app stays on zod@4. Plugin
      compiles clean under whole-program `tsc`.
- [x] `src/agent-kit/mcpBridge.test.ts` — 6 `revert-proof:`-documented tests, incl. the
      strip-then-inject auth invariant in this second location.
- [x] **Rake-holiday repriced in USD** (owner decision): `priceUsdCents` (default 500),
      USDC-or-HBAR, mirror-node rate + `minAcceptedFraction` (default 0.97) slippage tolerance;
      `features.ts` + `.env.example` updated. Mirror-node + USDC token id are network-aware.
- [x] **`npm test` → 754/754** · **`npm run build:web` → clean.**

> **Day-3 next:** `toolkit.ts` (`HederaAIToolkit({ client, configuration })` with the read-only
> `*Query` plugins + `createLazyLottoPlugin`, Client built from `@hiero-ledger/sdk`) and the
> `/api/chat` route (flag-gate + dynamic import + `streamText`). Verified Day-3 shapes:
> `HederaAIToolkit` constructor is `{ client, configuration }`, `.getTools()` returns AI-SDK tools;
> query plugin exports are `coreAccountQueryPlugin` / `coreTokenQueryPlugin` /
> `coreConsensusQueryPlugin` / `coreEVMQueryPlugin` / `coreTransactionQueryPlugin`.

### Day-3 status — DONE ✅
- [x] `src/agent-kit/toolkit.ts` — `buildChatToolkit({origin, authToken})` → `HederaAIToolkit`
      with the 5 read-only `*Query` plugins + the custodial plugin. Client built from
      `@hiero-ledger/sdk` (same identity the kit uses), cached per warm Lambda, DER key via
      `PrivateKey.fromStringDer` (mirrors `src/hedera/wallet.ts`). `AgentMode.AUTONOMOUS`. **The 4
      mutating core plugins are NEVER loaded** — the structural "no value-mover" guarantee.
- [x] `src/agent-kit/toolkit.test.ts` — source-level guards (comment-stripped): no mutating
      plugin / `allCorePlugins`; custodial + query plugins present.
- [x] `app/api/chat/route.ts` — flag-gated (404 when `CHAT_ENABLED!=='true'`, kit never imported),
      Bearer auth, token-hash rate limit (mirrors A2A), dynamic-imports the handler.
- [x] `app/api/chat/_handler.ts` — `streamText` over `@ai-sdk/anthropic(cfg.chat.model)`
      (configurable, default `claude-haiku-4-5`) + `toolkit.middleware()` +
      `toolkit.getTools()`, `stopWhen: stepCountIs(cfg.chat.maxSteps)`,
      `toUIMessageStreamResponse()`. Play-via-chat (`CHAT_ALLOW_PLAY`) added later
      with a two-step confirm.
- [x] **`ai` pinned to 6.0.86** → deduped with the kit's bundled copy (single `ai`, no two-copies
      type drift). Caught + fixed: `convertToModelMessages` is **async** in ai@6 (must `await`).
- [x] `src/config/features.test.ts` — 5 default-OFF / flag tests.
- [x] **`npm test` → 761/761** · **`npm run build:web` → clean** (`/api/chat` registered; only the
      pre-existing `standards-sdk` dynamic-require warning).

> **Not yet runtime-tested:** a live chat turn needs the dev server + `ANTHROPIC_API_KEY` + a
> registered testnet user (UAT). Flag-OFF behaviour is structurally correct and config-tested.
> **Day-4 next:** the `/chat` UI page — reuse the dashboard shell + `useChat` → `/api/chat` with
> the session bearer; render tool calls; add the value-moving `multi_user_play` tool with an
> explicit confirmation step.

### Day-4 status — DONE ✅
- [x] `app/chat/page.tsx` — auth-gated chat page (LSH dark + gold), reuses `getSessionToken()` /
      redirect-to-`/auth`, links to the dashboard.
- [x] `app/chat/ChatPanel.tsx` — `useChat` (`@ai-sdk/react`) + `DefaultChatTransport` with the
      session Bearer header; renders text parts, a "thinking…" indicator, and errors.
- [x] **Cost guardrails (owner request — keep the demo ≤ ~$20; all config-driven):**
  - **Scope lock**: strict on-topic system prompt — refuses general-assistant use (coding, trivia,
    other chains) in one sentence and steers back, so nobody can use it as free Claude.
  - **Output cap** `maxOutputTokens` (800), **input cap** `maxInputChars` (1200 → 400),
    **history trim** to last `maxHistoryMessages` (10), **step cap** `maxSteps` (4).
  - **Per-user volume cap**: `dailyMessageLimit` (40 / rolling 24h) via Redis `INCR` (reuses
    `checkRateLimit`, `action: 'chat-daily'`, `windowSec: 86400`) on top of the 30/min burst cap.
  - Budget math: Sonnet 4.6 + these caps ⇒ ~$0.05/msg worst case, ~$2/user/day ceiling — $20
    covers a multi-user demo comfortably. Knobs: `CHAT_MAX_OUTPUT_TOKENS` / `CHAT_MAX_INPUT_CHARS`
    / `CHAT_MAX_HISTORY_MESSAGES` / `CHAT_MAX_STEPS` / `CHAT_DAILY_MESSAGE_LIMIT`.
- [x] **`ai` forced to a single `6.0.198`** (override `"ai": "$ai"`) so `@ai-sdk/react@3.0.200`
      (pins 6.0.198) and the kit (built on 6.0.86) share one copy — no two-copies type drift.
- [x] `src/config/features.test.ts` — added a guard locking the conservative cost-knob defaults.
- [x] **`npm test` → 762/762** · **`npm run build:web` → clean** (`/chat` + `/api/chat` registered).

> **Deferred (deliberate):** the value-moving `multi_user_play` chat tool. Shipping read-only chat
> first is safer since a live value path can't be exercised headless; play-via-chat needs the
> AI-SDK human-in-the-loop confirmation pattern + live UAT. (Plan §6 lists this as cut-if-behind.)
> **Not runtime-tested:** a live chat turn still needs the dev server + `ANTHROPIC_API_KEY` + a
> registered testnet user. Flag-OFF + compile + cost-default behaviour are verified.
> **Day-5 next:** the x402 rake-holiday gate (`@x402/core` + `@x402/hedera`, USD-priced, USDC or
> live-HBAR, mirror-node rate + 0.97 tolerance) and the effective-rake resolver.

### Day-5 status — DONE ✅
**Accounting core (fully tested — the security-critical, headless-verifiable part):**
- [x] `src/custodial/rakeHoliday.ts` — `getEffectiveRakePercent` (0 during an active holiday,
      else base), holiday store (auth Redis, TTL = window), and an **idempotent grant** built on
      the canonical `withIdempotency` primitive (NOT a hand-rolled SADD — keeps atomic claims in
      the approved primitive layer; the claim-archetype gate caught + enforced this).
- [x] `DepositWatcher.ts:567` — passes the **resolved** effective rake into the **UNCHANGED**
      `creditDeposit`. The audited settlement math is untouched; only the rate argument differs.
      All `UserLedger` / concurrency-invariant tests stay green.
- [x] `src/x402/exchangeRate.ts` — mirror-node rate fetch + `usdCentsToTinybars` /
      `tinybarsToUsdCents` / `usdCentsToUsdcBaseUnits` (the corrected ~$0.081/HBAR formula).
- [x] 8 new `revert-proof:` tests (rake holiday + exchange rate); **`npm test` → 770/770**.

**x402 gate (built against the real SDK; live flow needs UAT):**
- [x] `src/x402/scheme.ts` — `HTTPFacilitatorClient` + builds the two `PaymentRequirements`
      (USDC 1:1, and live-HBAR via the mirror rate) + `X-PAYMENT` decode. Verified import paths:
      `@x402/core/http` (client), `@x402/core/types` (wire types), `@x402/hedera` (`HBAR_ASSET_ID`).
- [x] `app/api/_lib/x402Gate.ts` — `settleOrChallenge`: no/invalid payment → **402** with
      `PaymentRequired{accepts}`; valid → facilitator `verify` → `settle` → `{settled}`.
- [x] `app/api/premium/rake-holiday/route.ts` — `isX402Active` off → **503** (never a free
      holiday); auth (`user` tier) → build requirements → gate → on settle, grant the holiday
      (idempotent per settlement tx) + `X-PAYMENT-RESPONSE` header.
- [x] Config: `feePayer` (Blocky402 testnet `0.0.7162784` default) + `maxTimeoutSeconds`; `@x402`
      added to `serverExternalPackages`. **`npm run build:web` → clean** (`/api/premium/rake-holiday`
      registered).

> **VERIFIED LIVE (2026-06-09) against the Blocky402 testnet facilitator** — full
> `402 → buyer-signed HBAR transfer → facilitator verify → settle (on-chain) → grant` round-trip
> returned `200 { ok:true, rakeHoliday:{ paid:"62.79 HBAR", settlementTx:"0.0.7162784@1781031765…" } }`.
> Then a fresh deposit credited at **0% rake** (accounting half confirmed; `creditDeposit` untouched).
> **Findings from UAT (load-bearing):**
> - **`x402Version` is `2`, not `1`** — the x402-foundation stack + Blocky402 use v2 (the facilitator's
>   `/supported` and `@x402/core` both confirm). Fixed in `scheme.ts` (`X402_VERSION = 2`).
> - `extra: { feePayer }` is sufficient — verify/settle accepted it as-is.
> - The client signer wants the **CAIP-2** network (`hedera:testnet`), not the SDK name `testnet`.
> - Chat (Agent Kit tools + Haiku 4.5 + scope guardrail) verified live in the same session.
> See `docs/x402-payment-guide.md` for the reusable agent-prompt + manual-payment paths.
> **Day-6 next:** end-to-end demo dry-run + submission polish. Deferred items to weigh:
> `multi_user_play`-via-chat (human-in-the-loop confirm), the flag-gated HCS-20 x402 receipt,
> Agent-Card/`/api/discover` advertising the commerce capability, README + AI-Studio feedback.

---

## 0. The bounty, decoded

> "Build a Hedera agent that exposes services requiring payment in HBAR, with a hosted UI,
> chat interface, and wallet integration. Payments should gate access to capabilities or
> workflows. We're particularly interested in implementations that incorporate
> interoperability standards like AP2, UCP, ACP, and MPP."

**Hard requirements & our current status:**

| Requirement | Status | Action |
|---|---|---|
| Public GitHub repo | ✅ Met | — |
| Live demo URL | ✅ Met (`testnet-agent.lazysuperheroes.com`) | — |
| ≥90-day uptime | ✅ Met (reconcile cron + uptime monitor) | — |
| Wallet integration | ✅ Met (WalletConnect) | — |
| Hosted UI | ✅ Met (Next.js dashboards) | — |
| **Built using Hedera Agent Kit** | ❌ Missing | **Integrate V4 as chat tool-router** |
| **Chat interface** | ❌ Missing | **Build `/chat`** |
| Payment gates a capability | 🟡 Partial (deposit-gated play) | **Add x402 HBAR gate (flag-off-able)** |
| Interop standards (AP2/UCP/ACP/MPP) | 🟡 Bonus | We already speak MCP + A2A (the comms layer); x402 adds the settlement layer |

**Framing (the narrative the submission leads with):** *"An autonomous Hedera agent that sells
EV-optimized, fully-audited on-chain execution as a service — discoverable over A2A, callable
over MCP, gated by HBAR payment, with every cent reconstructible from an HCS-20 ledger."* Lottery
is the *domain*, not the headline. The rake **is** the commerce model; the audit trail **is** the
answer to the gambling objection.

---

## 1. Owner constraints (these are load-bearing on every decision below)

1. **x402 is an ALTERNATIVE payment channel, not a replacement for the rake.** Rake is a
   deposit-time levy; x402 is a request-time levy on a capability call. They charge *different
   events* — no double-charge by construction.
2. **Everything new is feature-flagged and default-OFF in prod.** If a piece (esp. x402) isn't
   fully ready, prod disables it with one env flag — no code removal.
3. **The audited HCS-20 custodial accounting/settlement path stays UNTOUCHED.** Value movement
   only flows through existing audited handlers. `git diff src/custodial/ src/services/ src/agent/`
   should be empty for this feature (except one optional additive `AccountingService` method).
4. **Don't pollute it.** New code is additive + isolated, mirroring the existing A2A adapter
   pattern — not woven into the custodial core.

---

## 2. Step-A findings (verified ground truth — the spike is GO/GO)

### x402 on Hedera — GO (YELLOW-strong)
- **Do NOT use Coinbase `x402-next`** — it's EVM/Solana-only, no Hedera.
- Use the **x402-foundation** lineage: `@x402/core@2.14.0` + `@x402/hedera@2.13.2` (pin exact;
  ~2 weeks old, fast cadence — re-verify on bump).
- Wrap `x402ResourceServer` (`@x402/core/server`) yourself in a route handler (~40 LOC). Register
  `ExactHederaScheme` (`@x402/hedera/exact/server`) for `hedera:*`. Bind exact method names from
  the dist `.d.ts` at build time (~1 hr).
- **Live keyless testnet facilitator:** `https://api.testnet.blocky402.com` (feePayer `0.0.7162784`,
  confirmed answering). Self-host later via `@x402/hedera`'s `./exact/facilitator`.
- **Settlement:** native HBAR (asset id `0.0.0`, tinybars, 1 HBAR = 1e8 tinybars). Server returns
  402 + requirements → client builds a `TransferTransaction` to `payTo` with facilitator as
  fee-payer, signs with own key, base64s into `X-PAYMENT` → server calls facilitator verify+settle
  → facilitator co-signs fee + submits. Buyer signs the transfer (server key for agent-to-agent;
  browser WalletConnect/HashPack for a user).

### Hedera Agent Kit — GO (V4)
- Install `@hashgraph/hedera-agent-kit@4.0.0` + `@hashgraph/hedera-agent-kit-ai-sdk@1.0.0` +
  `ai@6` + a model provider. (Old unscoped `hedera-agent-kit@3.x` is V3 — do not use.)
- `HederaAIToolkit({ client, configuration: { plugins, context } })`; `toolkit.getTools()` feeds
  `streamText({ tools })`; `toolkit.middleware()` wraps the model.
- **V4 plugins are opt-in.** Load only the **read-only** `*Query` plugins + our custom plugin;
  **never** `allCorePlugins` or the 4 mutating plugins (`coreAccountPlugin`, `coreTokenPlugin`,
  `coreConsensusPlugin`, `coreEVMPlugin`). This *structurally guarantees the chat LLM has zero
  kit tool that can move value.*
- Custom plugin = plain object `{ name, version, description, tools: (ctx) => Tool[] }`;
  `Tool = { method, name, description, parameters: ZodObject(zod3), execute }`. Thread the session
  auth token via `configuration.context`; build the toolkit **per request**.
- Feature-flag clean: no import-time side effects → gate route with env check + **dynamic import**
  of the handler; keep kit packages in `dependencies` so Vercel file-tracing ships them.

### Hazards (verified against the repo)
1. **Dual SDK identity (#1 risk).** Kit peer-deps `@hiero-ledger/sdk@^2.81.0` (renamed
   `@hashgraph/sdk`); we already have `@hiero-ledger/sdk@2.79.0` transitively and our app uses
   `@hashgraph/sdk@^2.81.0`. Two `Client` identities → `instanceof` breaks at runtime (passes
   `tsc`). Fix with npm `overrides` alias and pass the kit a `Client` from our SDK.
2. **Bundling.** Kit + `@modelcontextprotocol/sdk@1.27.1` must be in `serverExternalPackages` +
   webpack externals (we already externalize the MCP SDK for the same minification reason).
   Node runtime, never Edge.
3. **Zod 3 vs 4.** Our app uses `zod@^4`; kit pins `zod@3.25.76`. Keep custom-plugin schemas on
   zod 3, isolated under `src/agent-kit/`; never share schema objects with `src/config/` (zod 4).
4. **Dual tsconfig.** `src/agent-kit/` + `src/x402/` are web-only — must be in `tsconfig.json`
   (Next) and **excluded from `tsconfig.cli.json`** so the published CLI doesn't pull kit/ai/x402.

---

## 3. Architecture (additive + isolated)

```
                 ┌─────────────────────────────────────────────────────────┐
   Browser ─────▶│ app/chat/page.tsx (useChat, bearer token)               │
                 └─────────────────────────────────────────────────────────┘
                                   │ POST /api/chat  (Authorization: Bearer sk_…)
                                   ▼
   app/api/chat/route.ts   ── flag check (CHAT_ENABLED) ──▶ 404 if off
        │  dynamic import (kit loaded only when on)
        ▼
   app/api/chat/_handler.ts
        │  HederaAIToolkit(per-request, context={accountId, authToken})
        │    plugins = [read-only *Query plugins] + lazyLottoPlugin
        ▼
   streamText({ model, tools: toolkit.getTools() })
        │
        ├── read-only Hedera query tools  (no value movement, ever)
        └── lazyLottoPlugin tools ──▶ src/agent-kit/mcpBridge.ts
                                          │  HTTP call to /api/mcp (copy of A2A callTool)
                                          │  injects trusted auth_token, strips model-supplied
                                          ▼
                              EXISTING audited MCP tools  (multi_user_status, _play, …)
                              → playForUser / creditDeposit / withdrawForUser
                              → reservation/settlement + HCS-20 + Redis locks  [UNCHANGED]

   x402 (separate, parallel channel):
   app/api/premium/analysis/route.ts ──▶ app/api/_lib/x402Gate.ts (withX402)
        flag off  → transparent: serve analysis via normal read path (no 402)
        flag on   → 402 → client pays HBAR → facilitator verify+settle → serve analysis
```

**Why the chat tools call MCP over HTTP (not in-process):** it copies the proven, parity-tested
A2A `callTool` bridge (`app/api/a2a/route.ts:97-156`), so the chat inherits every auth-tier check,
rate limit, idempotency guard, and HCS-20 write **by construction** — zero new value-path code,
zero new audit surface. Cost is one localhost round-trip (~5-20ms), irrelevant next to LLM latency.

---

## 4. File-by-file changes

### New files
| File | Purpose |
|---|---|
| `src/config/features.ts` | `loadFeatureConfig()` — pure-env flag aggregator, mirrors `loadCustodialConfig`. Default-OFF. |
| `src/agent-kit/mcpBridge.ts` | HTTP `callMcpTool(origin, name, args, authToken)` — extracted copy of A2A `callTool`, with the `R3-FG-60` strip-then-inject auth sanitization. |
| `src/agent-kit/plugin.ts` | The `lazyLottoPlugin` object wrapping existing MCP tools as kit tools. |
| `src/agent-kit/toolkit.ts` | Builds `HederaAIToolkit` per request: read-only query plugins + our plugin + `{accountId, authToken}` context. |
| `src/x402/scheme.ts` | Registers `ExactHederaScheme` for `hedera:*`, binds `HTTPFacilitatorClient` to the facilitator URL. |
| `app/api/_lib/x402Gate.ts` | `withX402(capabilityKey, handler)` — ~40 LOC. The ONLY x402-aware code. Transparent when flag-off. |
| `app/api/chat/route.ts` | Flag-gate + bearer extract + dynamic import. `runtime='nodejs'`, `maxDuration=60`. |
| `app/api/chat/_handler.ts` | Real chat handler (`streamText` + toolkit). Imported only when `CHAT_ENABLED`. |
| `app/api/premium/analysis/route.ts` | The first gated capability (premium EV/pool analysis read). |
| `app/chat/page.tsx` | Chat UI — reuses dashboard shell, LSH branding, `getSessionToken()`. |
| `app/chat/ChatPanel.tsx` | Message list + input (keeps `page.tsx` composition-only). |
| Tests | `src/agent-kit/mcpBridge.test.ts`, `src/agent-kit/toolkit.test.ts`, `src/config/features.test.ts`, x402 flag-off + transparency tests. |

### Modified files (additive only)
| File | Change |
|---|---|
| `package.json` | Add 6 pinned deps (in `dependencies`); add `overrides` alias for dual-SDK dedupe. |
| `next.config.mjs` | Add kit + MCP SDK to `serverExternalPackages` and webpack `externals` (extend existing pattern at `:46-59`). |
| `tsconfig.cli.json` | Exclude `src/agent-kit/` + `src/x402/` so the CLI bundle stays kit-free. |
| `.env.example` | Append `── AI Chat ──` and `── x402 ──` blocks, all default-OFF. |
| `app/api/_lib/AccountingService.ts` | **Optional, behind `X402_RECORD_TO_HCS20`:** additive `recordX402Payment()` modeled on `recordControlEvent`/`recordPrizeRecovery`. No existing writer touched. Cut if behind. |

### Explicitly NOT modified
`src/custodial/UserLedger.ts` (rake), `src/custodial/MultiUserAgent.ts`, `src/services/`,
`src/agent/`, the HCS-20 reader/writers (except the optional additive method), any MCP tool
handler, any A2A code. The audit-coverage ratchet files are untouched.

### Dependency block (pinned)
```jsonc
"@hashgraph/hedera-agent-kit": "4.0.0",
"@hashgraph/hedera-agent-kit-ai-sdk": "1.0.0",
"ai": "6",
"@ai-sdk/anthropic": "^1",          // default provider; see Open Decisions
"@x402/core": "2.14.0",
"@x402/hedera": "2.13.2",
// + overrides:
"overrides": { "@hiero-ledger/sdk": "npm:@hashgraph/sdk@2.81.0" }
```

### New env vars (all default-OFF)
```
CHAT_ENABLED=false
CHAT_MODEL_PROVIDER=anthropic
CHAT_MODEL=claude-3-7-sonnet-latest
ANTHROPIC_API_KEY=
X402_ENABLED=false
X402_FACILITATOR_URL=https://api.testnet.blocky402.com
X402_PAY_TO=0.0.XXXXXX                       # operator wallet
X402_PRICE_PREMIUM_ANALYSIS_TINYBARS=5000000 # 0.05 HBAR
X402_RECORD_TO_HCS20=false
```

---

## 5. The x402 ↔ rake relationship (no double-charge)

- **Rake** = deposit-time levy in `UserLedger.creditDeposit` (`:123-124`). **Untouched.**
- **x402** = request-time levy on a *capability call*, collected entirely inside `x402Gate.ts`.
  It never calls `creditDeposit`, never touches `user.balances`, never settles a play.
- First gated capability is a **read** (premium analysis), which moves **zero** custodial value —
  so it cannot entangle with the rake at all. This is the cleanest possible proof that x402 is a
  separate channel.
- **Flag-off behavior:** `withX402` serves the capability directly with no 402 — the same route
  works in both modes; prod ships `X402_ENABLED=false` and simply serves the analysis (optionally
  tier-gated behind `user` auth so it isn't fully public).

---

## 6. 7-day plan (configurability + don't-touch-accounting baked in)

| Day | Milestone | Cut-if-behind |
|---|---|---|
| **1** | Add deps + `overrides` alias; **verify single SDK identity** (`npm ls @hashgraph/sdk @hiero-ledger/sdk`); `src/config/features.ts` + `.env.example`; `serverExternalPackages`/externals; tsconfig.cli exclude. **Gate: `npm run build:web` clean, all flags OFF.** | — (de-risks #1 hazard first) |
| **2** | `mcpBridge.ts` (extract from A2A); `plugin.ts` wrapping tools 1-3 (status, history, deposit-info — reads); `toolkit.ts`. Unit-test bridge auth injection + sanitization. | Wrap 3 tools, not 5 |
| **3** | `app/api/chat/route.ts` + `_handler.ts` (`streamText`). Verify flag-off → 404 + zero kit code loaded. | — |
| **4** | `app/chat/page.tsx` + `ChatPanel.tsx` (shell/branding/session reuse); `useChat` → `/api/chat`. Add `multi_user_play` tool (#5) with explicit-confirmation UX. | Ship read-only chat; drop play tool |
| **5** | `src/x402/scheme.ts` (bind names from dist `.d.ts`); `app/api/_lib/x402Gate.ts` (transparent when off). | — |
| **6** | `app/api/premium/analysis/route.ts` using existing EV read client; end-to-end paid flow vs. testnet facilitator (server key). Optional `recordX402Payment`. | Cut HCS-20 receipt; cut browser WC signing (server-key demo) |
| **7** | **Flag-off verification (below)**; both pre-push gates; tests; demo video; README section + AI-Studio feedback. | Keep buffer sacred |

**Single biggest timeline risk:** the **dual-SDK `instanceof` break** (Day 1) — if `overrides`
doesn't fully dedupe, every kit tool throws at request time while `tsc` stays green. Scheduled
first; fallback is to build the kit's `Client` from its own SDK import rather than sharing ours.
Everything else is additive and independently shippable.

---

## 7. Success criteria

**Functional:**
- A judge can open `/chat`, sign in with a wallet, and converse: "what's my balance",
  "what have I played", "run a conservative play" — all through Agent-Kit-routed tools.
- With `X402_ENABLED=true`, calling the premium analysis returns **402 → pay HBAR → result**
  end-to-end against the testnet facilitator (the on-camera "payment gates a capability" moment).
- The Agent Kit is the chat's actual tool router (not decorative) — kit query tools + our custom
  plugin in one surface.

**Flag-off verification (Day 7, required):**
1. `CHAT_ENABLED=false X402_ENABLED=false npm run build:web` → clean.
2. `POST /api/chat` → **404**; confirm `_handler.ts` (and the kit) was never dynamically imported.
3. `GET /api/premium/analysis` with flag-off → serves analysis, **no 402**.
4. `git diff src/custodial/ src/services/ src/agent/` → **empty** (accounting untouched), except
   the optional additive `recordX402Payment` (no caller when its flag is off).
5. `npm test` → 748/748 still green.

**Pre-push gates (both must be green, per CLAUDE.md):** `npm test` + `npm run build:web`.
`npm run check-protocols` unchanged (no new MCP tools → no A2A skill changes).

**Audit ratchet:** no new findings created → no manifest entry invented (per CLAUDE.md's
"don't re-enter the audit reflex"). Ratchet stays green because no referenced file's fix-locations
change; if the optional `recordX402Payment` is added, run `npm run audit:coverage:check` to confirm.

---

## 8. Open decisions for the owner

1. **Chat model provider** — default **Anthropic / Claude** (`@ai-sdk/anthropic`, needs
   `ANTHROPIC_API_KEY`). Swap to OpenAI trivially if preferred. *(Recommendation: Anthropic.)*
2. **First gated capability** — default **premium EV/pool analysis (read)**. Safest, most
   demo-able, zero rake entanglement. *(Recommendation: keep.)*
3. **HCS-20 x402 receipt** — default **off / optional**. The facilitator's on-chain transfer is
   already an audit trail. *(Recommendation: ship without; add only if time remains.)*
4. **Doc home** — this file is at `docs/hackathon-commerce-agent-plan.md`; move to `docs/archive/`
   on completion per the design-doc convention.

---

## 9. Key file references (absolute)

- Rake path (do **not** modify): `src/custodial/UserLedger.ts:54-147`
- Config precedent: `src/custodial/types.ts:238` (`loadCustodialConfig`)
- Serverless config inlining: `src/config/loader.ts:47`
- Auth-token threading to copy: `app/api/a2a/route.ts:60-156`
- Route tier enforcement: `app/api/_lib/auth.ts:25`
- MCP externals: `next.config.mjs:46-59`
- Per-request agent context: `app/api/_lib/mcp.ts:129-216`
- Tools to wrap: `src/mcp/tools/multi-user.ts`
- EV read client: `src/mcp/client.ts:208,283`
- Additive HCS-20 writer precedent: `src/custodial/AccountingService.ts:411,522`
- Dashboard shell/session: `app/dashboard/page.tsx`, `app/lib/session.ts:66`
- Audit ratchet: `src/__tests__/audit-coverage.json`, `audit-coverage-scan.ts:24`
