# Testnet UAT Checklist

Operator validation guide for the deployed LazyLotto Agent at
**testnet-agent.lazysuperheroes.com**. Work through each section in order.

---

## Prerequisites

- [X] Agent wallet funded with testnet HBAR (check on [HashScan](https://hashscan.io/testnet))
- [X] Your operator wallet account ID is in `ADMIN_ACCOUNTS` env var on Vercel
- [X] A second testnet wallet for user-role testing (HashPack or Blade)
- [X] Claude Desktop installed
- [X] Browser with wallet extension (HashPack or Blade)

---

## 1. Discovery Endpoint

```bash
curl https://testnet-agent.lazysuperheroes.com/api/discover
```

Verify:
- [X] Returns JSON with `name`, `version`, `uaid`
- [X] `endpoints.mcp` is `/api/mcp`
- [X] `endpoints.auth.challenge` is `/api/auth/challenge`
- [X] `capabilities.multiUser` is `true`
- [X] `fees.rakePercent` shows the correct default

---

## 2. Web Auth Flow (Operator)

1. Visit https://testnet-agent.lazysuperheroes.com/auth
2. Connect your **operator wallet** via WalletConnect

Verify:
- [X] Character mascot appears with tagline
- [X] Challenge nonce appears for signing
- [X] After signing, redirects to /dashboard
- [X] Sidebar shows your account ID and "testnet" badge
- [X] Session token stored in localStorage (DevTools > Application > Local Storage)

---

## 3. Admin Dashboard

Visit https://testnet-agent.lazysuperheroes.com/admin

Verify:
- [X] Page loads (not 403/404)
- [X] Shows user count, operator balance, dead letter count
- [X] If no users yet, shows zeros (not errors)

---

## 4. MCP Endpoint — Raw JSON-RPC

Test the MCP endpoint directly with curl:

```bash
# Initialize
curl -s -X POST https://testnet-agent.lazysuperheroes.com/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"uat","version":"1.0"}},"id":1}'
```

- [X] Returns `serverInfo` with `name: lazylotto-agent`

```bash
# List tools
curl -s -X POST https://testnet-agent.lazysuperheroes.com/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

- [X] Returns 22 (7 multi-user + 6 operator)

---

## 5. Claude Desktop — Operator Connection

In Claude Desktop, add the MCP server via URL:

**URL:** `https://testnet-agent.lazysuperheroes.com/api/mcp`

When prompted for headers, add:
```
Authorization: Bearer sk_YOUR_SESSION_TOKEN
```

(Get the token from localStorage after step 2, or from the auth success response.)

Verify:
- [X] Claude shows the MCP server as connected
- [X] Ask Claude: "What tools do you have from lazylotto?" — lists all tools
- [X] Ask Claude: "Check operator health" — calls `operator_health`
- [X] Response shows `mode: "serverless"` and `depositDetection: "on-demand"`

---

## 6. User Registration (Second Wallet)

Switch to your **user test wallet**:

1. Visit /auth, connect with user wallet, sign challenge
2. Copy the session token
3. In Claude Desktop, update the MCP server's auth header with the new token

```
Ask Claude: "Register me for LazyLotto. My EOA is 0.0.XXXXX"
```

Verify:
- [X] Returns `status: "registered"`, a `userId`, and `deposit.memo`
- [X] Shows agent wallet address to send deposits to

```
Ask Claude: "Register me again"
```

- [X] Returns `status: "already_registered"` with existing userId and memo

---

## 7. Deposit Flow

From your user test wallet, send testnet HBAR to the agent wallet:
- **Amount**: 10 HBAR (or whatever is convenient)
- **Memo**: The deposit memo from step 6

Wait ~10 seconds for mirror node propagation, then:

```
Ask Claude: "Check my deposit info"
```

Verify:
- [X] Calls `multi_user_deposit_info`
- [X] Balance shows deposited amount minus rake
- [X] Deposit memo is correct

Also check the web dashboard at /dashboard:
- [X] Balance matches what Claude reported

---

## 8. Play Flow

```
Ask Claude: "Play a lottery session for me"
```

Verify:
- [X] Calls `multi_user_play` with your userId auto-resolved
- [X] Returns session result: pools evaluated, entries bought, wins/losses
- [X] Balance decreased by amount spent

```
Ask Claude: "Show my play history"
```

- [X] Returns the session with correct details

---

## 9. Withdrawal Flow

```
Ask Claude: "Withdraw 1 HBAR from my account"
```

Verify:
- [X] Calls `multi_user_withdraw`
- [X] Returns withdrawal record with transaction ID
- [X] Check [HashScan](https://hashscan.io/testnet) for the withdrawal transaction
- [X] Balance decreased by withdrawal amount

---

## 10. Operator Tools

Switch back to your **operator wallet** token in Claude Desktop.

```
Ask Claude: "Show me the operator balance"
```
- [X] Shows rake collected, gas spent, net profit

```
Ask Claude: "Run a reconciliation check"
```
- [X] Returns ReconciliationResult with on-chain vs ledger comparison
- [X] `solvent: true` (no shortfall)

```
Ask Claude: "Show dead letters"
```
- [X] Returns dead letter queue (may be empty)

---

## 11. Admin API Routes

```bash
# Reconciliation (use operator session token)
curl -s -X POST https://testnet-agent.lazysuperheroes.com/api/admin/reconcile \
  -H "Authorization: Bearer sk_OPERATOR_TOKEN" | jq .
```

- [X] Returns ReconciliationResult JSON
- [X] `solvent: true`

---

## 12. Security Spot-Checks

With a **user-tier** session token:

```bash
# User trying to call operator tool — should be denied
curl -s -X POST https://testnet-agent.lazysuperheroes.com/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"operator_balance","arguments":{"auth_token":"sk_USER_TOKEN"}},"id":1}' | jq .
```

- [X] Returns error: "Access denied"

```bash
# User trying to access another user's data
curl -s -X POST https://testnet-agent.lazysuperheroes.com/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"multi_user_play","arguments":{"userId":"some-other-user","auth_token":"sk_USER_TOKEN"}},"id":1}' | jq .
```

- [X] Returns error: "Access denied"

Without any token:

```bash
curl -s -X POST https://testnet-agent.lazysuperheroes.com/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"multi_user_status","arguments":{}},"id":1}' | jq .
```

- [X] Returns error: "Authentication required"

---

## 13. Rate Limiting

Rate limit counters live in Upstash Redis (shared across all warm Lambdas
via INCR + EXPIRE), so the limit you see here is the actual cluster-wide
cap, not per-Lambda. If this test never trips, double-check that
`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set on Vercel
— without them the in-memory fallback kicks in and limits silently
degrade to per-Lambda (you'll see a `[Auth] No Upstash Redis configured`
warning in the deploy logs).

```bash
for i in $(seq 1 35); do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}" -X POST \
    https://testnet-agent.lazysuperheroes.com/api/mcp \
    -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
  echo
done
```

- [X] Requests 1-30 return 200
- [X] Requests 31+ return 429

Each response now includes diagnostic headers for debugging and client
backoff logic:

```
X-RateLimit-Limit:         30
X-RateLimit-Remaining:     <remaining in current window>
X-RateLimit-Count:         <current count>
X-RateLimit-Ttl:           <seconds until window resets>
X-RateLimit-Expire-Called: <true on the 1st request of a fresh window>
X-RateLimit-Mode:          upstash | memory
X-RateLimit-Identity:      <token prefix or IP used for keying>
```

To verify Upstash is wired correctly, look for `X-RateLimit-Mode: upstash`
in any single response. `memory` means env vars aren't set and limits
silently degrade to per-Lambda.

---

## 14. IPFS Character Images

Visit /auth and inspect the character image in DevTools (Network tab).

- [X] Image loads from Filebase CDN (lazysuperheroes.myfilebase.com)
- [X] Image dimensions are optimized (256x256 or similar)
- [X] No broken image placeholders

---

## Summary

| Area | Tests | Critical? |
|------|-------|-----------|
| Discovery | 1 | Yes |
| Web auth | 2, 3 | Yes |
| MCP endpoint | 4 | Yes |
| Claude Desktop | 5 | Yes |
| Registration + dedup | 6 | Yes |
| Deposits | 7 | Yes |
| Play | 8 | Yes |
| Withdrawal | 9 | Yes |
| Operator tools | 10, 11 | Yes |
| Security | 12 | Yes |
| Rate limiting | 13 | No (defense-in-depth) |
| Images | 14 | No (cosmetic) |
