# UAT Runbook — Chat + x402 Rake-Holiday (feat/commerce-agent)

> Goal: stand the new surfaces up locally, exercise them, and find where the
> pain is. The chat path and the rake-holiday *accounting* are low-risk; the
> **live x402 payment round-trip is the unknown** — that's what this runbook is
> really for. Work top to bottom; each test states what "good" looks like.

## TL;DR — the things to actually test

With the flags on (§1) and signed in (§3):

1. **Chat** (§4) — `/chat` (now in the sidebar): ask your balance, ask for play
   history, then probe an off-topic question and confirm it declines.
2. **Play-via-chat** (§4a, needs `CHAT_ALLOW_PLAY=true`) — ask to play; confirm
   it asks before doing anything, then plays only after you say yes.
3. **Dashboard rake-holiday** (§5a) — the "💎 0% rake for 30 days" CTA on the
   dashboard → pick HBAR or USDC → pay with WalletConnect. **This is the new
   browser flow with the most unknowns.**
4. **402 challenge** (§5) — curl the gate with no payment, eyeball the quote.
5. **Scripted payment** (§6) — the canonical `uat-x402.ts` does the full
   402→pay→settle loop without a wallet (good fallback / CI-style check).
6. **Audit trail** (§6a) — buy a holiday, deposit, confirm 0% rake on the audit
   page, and (if `X402_RECORD_TO_HCS20=true`) the on-chain receipt anchor.
7. **Flag-off safety** (§7) — turn the flags off, confirm 404/503 and the Chat
   link disappears.

---

## 0. What you need

- **Two funded Hedera testnet accounts**, both with some HBAR:
  - the **agent wallet** (`HEDERA_ACCOUNT_ID` / `HEDERA_PRIVATE_KEY`), and
  - a **buyer** account (pays for the rake holiday). The buyer MUST differ from
    `X402_PAY_TO` — a self-transfer nets to zero and the facilitator rejects it.
- `ANTHROPIC_API_KEY` (already sourced).
- A Hedera wallet (HashPack etc.) to sign in at `/auth`.
- Redis is optional locally — the in-memory fallback covers sessions, the
  holiday key, and idempotency for a single dev process. (Sessions reset on
  restart; fine for UAT.)

### Funding test accounts (testnet)

- **HBAR** (all you need for the agent wallet and the HBAR payment path): the
  **Hedera Portal faucet** — https://portal.hedera.com/faucet — or HashPack's
  built-in faucet.
- **USDC** (only for the USDC payment path): Hedera testnet USDC is the HTS
  token **`0.0.429274`** (our `X402_USDC_TOKEN_ID` default). Get it from
  **Circle's faucet** — https://faucet.circle.com → select **Hedera** (testnet),
  enter your account ID. Public, no signup, **20 USDC / address / 2h**.
  - **Hedera gotcha:** an account can't *receive* an HTS token until it's
    **associated** with it. For the USDC path, associate token `0.0.429274` on
    BOTH the **buyer** and **`X402_PAY_TO`** (one click each in HashPack →
    "Associate token", or the snippet below). HBAR needs no association.

Associate the USDC token from the repo (run once per account):
```ts
// associate-usdc.ts — env: ACCOUNT_ID, PRIVATE_KEY (the account to associate, DER key)
import { Client, AccountId, PrivateKey, TokenAssociateTransaction, TokenId } from '@hiero-ledger/sdk';
const id = AccountId.fromString(process.env.ACCOUNT_ID!);
const client = Client.forTestnet().setOperator(id, PrivateKey.fromStringDer(process.env.PRIVATE_KEY!));
const resp = await new TokenAssociateTransaction()
  .setAccountId(id).setTokenIds([TokenId.fromString('0.0.429274')]).execute(client);
console.log('association:', (await resp.getReceipt(client)).status.toString());
client.close();
```
```
ACCOUNT_ID=0.0.x PRIVATE_KEY=302e... npx tsx associate-usdc.ts
```
(An already-associated account throws `TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT` — harmless.)

## 1. `.env` for UAT

Add / confirm these (everything else as in `.env.example`):

```
HEDERA_NETWORK=testnet
MULTI_USER_ENABLED=true

# Chat
CHAT_ENABLED=true
CHAT_MODEL=claude-haiku-4-5         # default (cheapest capable); claude-sonnet-4-6 for more headroom
CHAT_ALLOW_PLAY=true               # enable play-via-chat (§4a). Omit/false = read-only chat.
ANTHROPIC_API_KEY=sk-ant-...

# x402 rake-holiday
X402_ENABLED=true
X402_PAY_TO=0.0.<operator-account-that-RECEIVES-payment>   # NOT the buyer
X402_FEE_PAYER=0.0.7162784                                  # Blocky402 testnet
X402_FACILITATOR_URL=https://api.testnet.blocky402.com
X402_RECORD_TO_HCS20=true          # write the on-chain x402 receipt anchor (§6a)
# Defaults are fine: $5 / 30 days / 0.97 slippage, USDC 0.0.429274.
```

> Flag-off sanity (do this LAST, see §7): with `CHAT_ENABLED=false` /
> `X402_ENABLED=false`, `/api/chat` must 404 and `/api/premium/rake-holiday`
> must 503.

## 2. Start the app

```
npm run dev:web      # webpack (NOT turbopack — the repo requires --webpack)
```

Open `http://localhost:3000`. With `CHAT_ENABLED=true` a **Chat** link appears
in the sidebar (sourced from `/api/discover` `capabilities.chat`); you can also
reach it directly at `/chat`. With chat off, the link is hidden.

## Local-dev gotchas (read this — these caused most of the early pain)

1. **Use Upstash Redis locally, or state resets on every restart.** Set
   `KV_REST_API_URL` + `KV_REST_API_TOKEN` (the Vercel/KV names) — or the
   `UPSTASH_REDIS_REST_*` pair — to real values and your registered users,
   balances, and the deposit watermark **persist**. Leave them empty and the
   store is in-memory: **every `dev:web` restart wipes all custodial state.**

2. **Deposit only AFTER the agent's first poll.** The deposit watcher seeds its
   watermark to "now" on first run (so a fresh deploy doesn't re-scan the
   wallet's entire history). A deposit made *before* the current process's first
   poll is skipped → `check-deposits` returns `processed: 0` even though the
   deposit is perfect (right wallet, right memo). Correct sequence: **start →
   load the dashboard (or `curl` check-deposits) once to seed the cursor → THEN
   deposit** → refresh → it credits. In `dev:web` there's no background watcher;
   detection is on-demand (dashboard refresh or `POST /api/user/check-deposits`).
   - **Recover a deposit stuck behind the watermark:** add your account to
     `ADMIN_ACCOUNTS`, re-auth (admin tier), then `POST /api/admin/replay-deposit`
     with the HashScan **Transaction ID** (`0.0.payer@secs.nanos` — *not* the URL
     timestamp) + an `Idempotency-Key` header. It bypasses the watermark.

3. **After changing dependencies, fully clear `.next` — with the server STOPPED.**
   On Windows the running dev server locks `.next`, so deleting it mid-run leaves
   a half-deleted, corrupt cache. Symptom: `_interop_require_*` /
   `ReactCurrentDispatcher` errors in Next's *own* files, and **a soft refresh
   fails to load while a hard refresh works** (a stale/corrupt bundle, NOT an
   auth bug). Fix: stop `dev:web` → `rm -rf .next node_modules && npm ci` →
   restart → one hard refresh to flush the browser's cached chunks.

## 3. Get a session token

1. Go to `http://localhost:3000/auth`, connect your wallet, sign the challenge.
2. On `/dashboard`, **register** (creates your custodial user) and **fund** the
   deposit memo with a little HBAR so you have a balance to talk about.
3. Grab the session token — browser devtools console:
   ```js
   localStorage.getItem('lazylotto:sessionToken')   // sk_...
   ```
   Export it for the curl/script steps:
   ```
   export SESSION_TOKEN=sk_xxxxx           # PowerShell: $env:SESSION_TOKEN="sk_xxx"
   ```

---

## 4. Test — Chat (the hard-requirement surface)

**Browser:** open `/chat`. Ask:
- "What's my balance?" → should call the custodial tool and answer with your balances + deposit memo.
- "Show my recent plays." → play history.
- **Off-topic probe:** "Write me a Python quicksort." → should politely decline in one sentence and steer back (scope guardrail).

**Good:** answers are grounded in YOUR account, refusals are short, nothing
leaks another user's data.

**Cost guardrails to expect:** ~40 messages/user/day then a 429 "Daily chat
limit reached"; messages >1200 chars are rejected; responses are short.

Optional curl (streamed UI-message protocol — readable but noisy):
```
curl -N -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"what is my balance?"}]}]}'
```

---

## 4a. Test — Play-via-chat (needs `CHAT_ALLOW_PLAY=true`)

The ONLY mutating chat tool, and it is two-step by construction. In `/chat`:

1. "Play a session for me." → the assistant should **describe what will happen
   and ask you to confirm** — it must NOT play yet. (Under the hood the tool
   returned `confirmation_required` without touching the audited path.)
2. Reply "yes, play." → now it runs `multi_user_play` through the audited MCP
   path and reports the result.

**Good:** it never plays on the first ask; it plays only after your explicit
yes; the result matches a dashboard play. **Bad (report it):** it plays without
asking, or asks but then can't actually play. With `CHAT_ALLOW_PLAY` off/unset,
asking to play should get "coming soon / use the dashboard" instead.

> Note: a play makes real contract calls and can take a few seconds — if the
> chat request feels slow, that's the play running, not a hang.

---

## 5. Test — Rake-holiday **402 challenge** (Level 1, no payment — do this first)

This verifies the gate builds requirements (exchange-rate fetch, asset/amount,
feePayer, the 402 envelope) WITHOUT any payment. Highest value per effort.

```
curl -i -X POST http://localhost:3000/api/premium/rake-holiday \
  -H "Authorization: Bearer $SESSION_TOKEN" -H "Content-Type: application/json"
```

**Good (HTTP 402):** a JSON body like
```json
{
  "x402Version": 2,
  "resource": { "url": ".../api/premium/rake-holiday", "description": "LazyLotto rake holiday — 0% rake for 30 days · $5.00" },
  "accepts": [
    { "scheme":"exact","network":"hedera:testnet","asset":"0.0.429274","amount":"5000000","payTo":"0.0.X","maxTimeoutSeconds":120,"extra":{"feePayer":"0.0.7162784","priceUsd":"$5.00","display":"5 USDC"} },
    { "scheme":"exact","network":"hedera:testnet","asset":"0.0.0","amount":"617...","payTo":"0.0.X","maxTimeoutSeconds":120,"extra":{"feePayer":"0.0.7162784","priceUsd":"$5.00","display":"61.7 HBAR"} }
  ]
}
```
Check: **`x402Version` is `2`** (load-bearing — the x402-foundation stack uses 2,
not 1); the **HBAR `amount`** is ~`$5 / live-rate` in tinybars (≈ 6.1e9 today),
the USDC `amount` is `5000000` (= $5, 6 decimals), `payTo` is your operator
account, `feePayer` is set, and `extra.display` is the humanized amount.

**If you get 503:** `isX402Active` is false → `X402_ENABLED` not `true` or
`X402_PAY_TO` empty. **If 500/502 "Payment processing failed":** the mirror-node
rate fetch threw — check the server log; confirm `X402_MIRROR_NODE_URL` reaches
`/api/v1/network/exchangerate`.

---

## 5a. Test — Dashboard rake-holiday via WalletConnect (the new browser flow)

The friendliest path AND the one with the most browser unknowns (WalletConnect
session restore + signing). Sign in at `/auth` with a **funded** wallet (it pays
for the holiday — must differ from `X402_PAY_TO`), then on `/dashboard`:

1. On the rake line ("… 5% rake …") click **"💎 0% rake for 30 days ↗"**.
2. The modal fetches the quote and shows a **HBAR / USDC picker** with the
   humanized price. On testnet the USDC option shows a **"Need testnet USDC?"**
   faucet link.
3. Pick an asset → **Pay … with wallet** → approve in your wallet.

**Good:** the wallet prompts for a transfer of the quoted amount; on approval the
modal shows "✅ Rake holiday active …". **Watch for:** the modal creates its OWN
WalletConnect connector to restore the persisted session — if `signers[0]` is
missing it opens the WC modal to (re)connect. If signing fails, capture the
console error. HBAR needs no association; the USDC path needs the buyer
associated with `0.0.429274` first (§0).

---

## 6. Test — Rake-holiday **full payment**, scripted (Level 2 — no wallet needed)

The repo ships a reference payer at the root: **`uat-x402.ts`** (a KEPT,
documented tool — no longer a throwaway). It runs the full 402 → buyer-sign →
settle loop and prints each step, using **`x402Version: 2`** and the CAIP-2
network from the challenge. It reads the buyer creds from `.env` and takes the
session token as arg 1:

```
# .env: BUYER_ACCOUNT_ID + BUYER_PRIVATE_KEY (funded, DIFFERENT from X402_PAY_TO)
npx tsx uat-x402.ts $SESSION_TOKEN        # or set SESSION_TOKEN in .env and omit the arg
```

**Good:** `step1` is 402; `step2` is **200** with
`{ ok: true, rakeHoliday: { paid, until, settlementTx, ... } }`. The full
walkthrough — including the **agent-prompt path** for an AI agent that can pay
x402 itself — is in **`docs/x402-payment-guide.md`**. To pay USDC instead of
HBAR, fund + associate the buyer with `0.0.429274` first (§0), then point the
`accepts.find(a => a.asset === '0.0.0')` line at your USDC token id.

---

## 6a. Test — the accounting half (0% rake + on-chain receipt)

After a successful payment (dashboard §5a or script §6):

1. **0% rake applies.** Send a fresh HBAR deposit to your user's deposit memo →
   `GET /api/user/status` (or refresh the dashboard) → it's credited at **0%
   rake** (full amount net) while the holiday is active. The audited
   `creditDeposit` path is unchanged — it just receives `rakePercent = 0`.
1a. **Dashboard reflects it.** `/api/user/status` now returns
   `rakeHoliday: {active, until}`, so the dashboard rake box + funded strip and
   `/account` show **0% · Rake holiday active until <date>** and the 💎 CTA flips
   to an "active" indicator. (If it still shows the base %, you hit the Upstash
   double-parse bug — `getRakeHoliday` must guard `typeof v === 'string'`.)
2. **Idempotent.** Re-run the script (same settlement) → `alreadyProcessed:
   true`, no second grant.
3. **On-chain receipt.** With `X402_RECORD_TO_HCS20=true`, a control anchor
   (`event: x402_rake_holiday_granted`) lands on the HCS-20 topic — visible via
   `npm run read-accounting` or `npx tsx src/scripts/test-v2-reader.ts`. It's
   non-balance-affecting: it records the CAUSE of the 0% deposits.
4. **Audit filter.** On `/audit`, use the **type chips** to show only Deposits,
   only Rakes, etc. Default view is unchanged; the filter is additive.

> Discovery check: `curl http://localhost:3000/api/discover` → with x402 active,
> `capabilities.chat` / `capabilities.x402Payments` are `true` and a `commerce`
> block lists the rake-holiday endpoint, price, and assets.

---

## 7. Test — flag-off safety + wallet-connect bump

- Set `CHAT_ENABLED=false`, `X402_ENABLED=false`, restart `dev:web`:
  - `POST /api/chat` → **404**; `POST /api/premium/rake-holiday` → **503**.
  - The **Chat** sidebar link disappears (discover `capabilities.chat=false`).
  - **All rake-holiday UI disappears** — both dashboard 💎 CTAs and the tutorial's
    "Prefer 0%?" step are gated on discover `capabilities.x402Payments=false`.
  - **The rake itself still shows** — the "Your rake" box (first-run), the
    `{rakePercent}% rake` in the funded strip, `/account`'s Rake field, and the
    rake explainer steps all render exactly as before. The rake is integral; only
    the holiday upsell is gated. (Sanity: `curl …/api/discover` → no `commerce`
    block, `capabilities.x402Payments=false`.)
- **Wallet-connect 2.79→2.84 bump:** the whole reason `/auth` matters — sign in,
  sign the challenge, confirm a session token is issued and the dashboard loads.
  This is the one pre-existing surface the dependency bump could affect.

---

## 8. Where the pain most likely is (x402 live flow)

These are the un-unit-testable unknowns — watch the **server console** (the
route logs `[rake-holiday] x402 flow failed:` on a 502) and the script output:

1. **`extra` fields** — we send `extra: { feePayer }`. The Hedera exact scheme
   may want more (or a different shape). If `verify` returns `isValid: false`
   with an `invalidReason`, that's the tell — adjust `buildRakeHolidayRequirements`
   in `src/x402/scheme.ts`.
2. **`x402Version`** — we send `2` (resolved: the x402-foundation stack +
   Blocky402 use 2, not Coinbase's 1). If you see "No facilitator registered for
   x402 version: N", a payload is sending the wrong version — check
   `X402_VERSION` in `src/x402/scheme.ts` and the payer's envelope.
3. **PaymentPayload envelope** — we assemble `{ x402Version, accepted, payload }`.
   If `verify` rejects the shape, log `payloadResult` (step 3) and compare to what
   `@x402/hedera`'s own client/x402Client produces.
4. **Signer config** — `createClientHederaSigner(..., { network: 'testnet' })`.
   If it throws, the config shape is wrong — check `HederaClientSignerConfig` in
   `node_modules/@x402/hedera`.
5. **Facilitator liveness** — `curl https://api.testnet.blocky402.com/supported`
   should list `hedera:testnet` and a `feePayer`. If `feePayer` differs from
   `0.0.7162784`, set `X402_FEE_PAYER` to match.
6. **Two `ai` / kit quirks** — if the chat errors at runtime (not a type error),
   check the dev console for an `ai`-version or kit middleware message; the single
   pinned `ai@6.0.198` should prevent it, but flag it if seen.

When something breaks, paste the server log line + the script's step1/step2/
payloadResult output back and we'll pinpoint it fast.
