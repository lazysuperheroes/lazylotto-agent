> **Archived — bootstrap PRD, not current documentation.**
> The wallet-based auth described here has shipped. Current spec lives in
> [`../../README.md`](../../README.md) under "Multi-User Authentication" and
> in source under `src/auth/`. See [`./README.md`](./README.md) for archive policy.

# Authentication UX: Product Requirements Document

> **Status**: Draft
> **Date**: 2026-04-01
> **Scope**: Wallet-based authentication for multi-user custodial LazyLotto Agent

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current State](#2-current-state)
3. [Proposed Architecture](#3-proposed-architecture)
4. [User Journey Maps](#4-user-journey-maps)
5. [Auth Page Requirements](#5-auth-page-requirements)
6. [Session Management Requirements](#6-session-management-requirements)
7. [Error Handling Requirements](#7-error-handling-requirements)
8. [Claude Desktop Configuration](#8-claude-desktop-configuration)
9. [Edge Cases and Resolutions](#9-edge-cases-and-resolutions)
10. [Success Metrics](#10-success-metrics)
11. [Open Questions](#11-open-questions)

---

## 1. Problem Statement

The LazyLotto custodial agent currently uses a single `MCP_AUTH_TOKEN` environment
variable for all authentication. This token is a shared secret: anyone who has it
can register users, trigger play sessions, process withdrawals, and access operator
tools. There is no way to distinguish between users, no way for a user to prove
they own the Hedera wallet they claim to represent, and no way to scope permissions
to individual accounts.

This creates three concrete problems:

1. **No user identity**: The operator must manually distribute the auth token to
   each user, and all users share the same privilege level. A user calling
   `multi_user_withdraw` could withdraw funds for any user, not just themselves.

2. **No wallet ownership proof**: When a user calls `multi_user_register` with
   `accountId: 0.0.12345`, the system trusts that they own that account. Nothing
   prevents someone from registering with another person's account ID and receiving
   their deposit credits.

3. **No role separation**: The operator, admin, and regular user all use the same
   token. There is no way to grant an admin limited powers (e.g., refunds only)
   without giving them full operator access.

The wallet-based authentication system solves all three by requiring a cryptographic
proof of wallet ownership before issuing a scoped session token.

---

## 2. Current State

### Authentication Model

```
MCP_AUTH_TOKEN (env var) ──> requireAuth() ──> timingSafeEqual ──> allow/deny
```

- Single shared secret, set by operator in `.env`
- Required for all fund-moving operations (play, withdraw, register, deregister)
- Same token for all users and the operator
- Validated via timing-safe SHA-256 comparison (good cryptographic practice)
- No user identity embedded in the token
- No session expiry
- No role-based access control

### Tool Authorization Matrix (Current)

| Tool                       | Auth Required | Who Can Call      |
|----------------------------|---------------|-------------------|
| `multi_user_register`      | Yes           | Anyone with token |
| `multi_user_play`          | Yes           | Anyone with token |
| `multi_user_withdraw`      | Yes           | Anyone with token |
| `multi_user_deregister`    | Yes           | Anyone with token |
| `multi_user_status`        | Yes           | Anyone with token |
| `multi_user_deposit_info`  | Yes           | Anyone with token |
| `multi_user_play_history`  | Yes           | Anyone with token |
| `operator_balance`         | Yes           | Anyone with token |
| `operator_withdraw_fees`   | Yes           | Anyone with token |
| `operator_health`          | Yes           | Anyone with token |
| `operator_reconcile`       | Yes           | Anyone with token |

Every authenticated tool has identical privilege. There is no concept of "this
user can only see their own balance."

### Registration Flow (Current)

```
User ──[MCP tool call]──> multi_user_register(accountId, eoaAddress, strategy)
                          │
                          └──> Trust: user claims to own accountId
                               No cryptographic verification
```

---

## 3. Proposed Architecture

### Authentication Flow

```
                          ┌─────────────────────────┐
                          │   Auth Web Page          │
                          │   (hosted by operator)   │
                          │                          │
                          │  1. Show challenge        │
User ─── browser ────────>│  2. Connect wallet       │
                          │  3. Sign challenge        │
                          │  4. Verify signature      │
                          │  5. Issue session token   │
                          └───────────┬───────────────┘
                                      │
                                      │ session token (JWT or opaque)
                                      │
                                      ▼
                          ┌───────────────────────────┐
                          │  Claude Desktop / CLI      │
                          │                            │
                          │  MCP config includes       │
                          │  session token in env      │
                          │                            │
                          │  All tool calls include    │
                          │  auth_token parameter      │
                          └───────────┬────────────────┘
                                      │
                                      ▼
                          ┌───────────────────────────┐
                          │  LazyLotto Agent           │
                          │  (MCP Server)              │
                          │                            │
                          │  Decode token ──> identity │
                          │  Check role ──> authorize  │
                          │  Scope data ──> filter     │
                          └───────────────────────────┘
```

### Token Structure

The session token encodes:

| Field           | Type     | Description                                     |
|-----------------|----------|-------------------------------------------------|
| `sub`           | string   | Hedera account ID (e.g., `0.0.12345`)           |
| `role`          | enum     | `user`, `admin`, `operator`                     |
| `iat`           | number   | Issued-at timestamp (Unix seconds)              |
| `exp`           | number   | Expiry timestamp (Unix seconds)                 |
| `nonce`         | string   | Challenge nonce (prevents replay)               |

Format: HMAC-signed JWT (HS256) using the agent's `MCP_AUTH_TOKEN` as the signing
key. This keeps the existing secret as infrastructure while adding per-user identity
on top.

### Role-Based Tool Authorization (Proposed)

| Tool                       | user (own) | user (other) | admin      | operator   |
|----------------------------|------------|--------------|------------|------------|
| `multi_user_register`      | self only  | --           | any        | any        |
| `multi_user_play`          | self only  | --           | any        | any        |
| `multi_user_withdraw`      | self only  | --           | any        | any        |
| `multi_user_deregister`    | self only  | --           | any        | any        |
| `multi_user_status`        | self only  | --           | all users  | all users  |
| `multi_user_deposit_info`  | self only  | --           | any        | any        |
| `multi_user_play_history`  | self only  | --           | any        | any        |
| `operator_balance`         | --         | --           | read only  | full       |
| `operator_withdraw_fees`   | --         | --           | --         | full       |
| `operator_health`          | --         | --           | read only  | full       |
| `operator_reconcile`       | --         | --           | --         | full       |
| `admin_refund`             | --         | --           | full       | full       |

"self only" means the user can only operate on the account matching their `sub`
claim. Attempting to pass a different `userId` returns a 403-equivalent error.

### Backwards Compatibility

The operator persona continues to use the raw `MCP_AUTH_TOKEN` directly (no JWT).
The `requireAuth` function detects this:

1. If `auth_token` is a JWT: decode, verify signature, extract identity and role.
2. If `auth_token` matches `MCP_AUTH_TOKEN` directly: treat as operator role.
3. If neither: reject.

This means the operator never needs to visit the auth page. Their existing
Claude Desktop config continues to work unchanged.

---

## 4. User Journey Maps

### Persona 1: New User Onboarding

**Context**: Non-technical user who heard about the agent from a friend or found
it in the HOL registry. They have a Hedera wallet (HashPack) but have never used
an MCP tool.

#### Journey Steps

```
Step 1: Discovery
├── Source: HOL registry listing, documentation link, or word of mouth
├── User sees: Agent description, network (testnet/mainnet), operator identity
├── Decision point: "Do I trust this operator?"
│   └── Information needed: operator's Hedera account, HCS-20 topic for audit,
│       rake fee schedule, boost level (NFT delegation status)
└── Action: Click "Connect" or visit auth page URL

Step 2: Auth Page — Landing State
├── User sees: Network badge (TESTNET / MAINNET), operator identity, fee schedule
├── User sees: "Connect Wallet" button (prominent, centered)
├── User sees: Brief explanation: "Sign a message to prove you own your wallet.
│   No transaction is sent. No funds are moved."
├── Decision point: "Which wallet do I use?"
│   └── Information needed: Supported wallets listed (HashPack, Blade, MetaMask*)
│       * MetaMask via Hedera Snap or EVM-compatible path
└── Action: Click "Connect Wallet"

Step 3: Auth Page — Wallet Connection
├── Wallet popup appears (HashPack pairing modal or WalletConnect QR)
├── User approves connection in their wallet
├── Auth page shows: Connected account ID (e.g., 0.0.12345) with checksum
├── Decision point: "Is this the right account?"
│   └── If wrong account: "Disconnect" link, connect again
└── Action: Automatic progression to challenge signing

Step 4: Auth Page — Challenge Signing
├── Auth page displays: "Sign this message to verify ownership"
├── Challenge text shown (human-readable):
│   "LazyLotto Agent Authentication
│    Account: 0.0.12345
│    Network: testnet
│    Timestamp: 2026-04-01T12:00:00Z
│    Nonce: a1b2c3d4..."
├── Wallet popup requests signature (NOT a transaction)
├── User signs in their wallet
└── Action: Signature submitted to auth page backend

Step 5: Auth Page — Verification & Token Issuance
├── Backend verifies signature against the connected account's public key
├── Backend checks: Is this account already registered with the agent?
│   ├── If YES: Welcome back message, show current balance
│   └── If NO: New user flow, proceed to registration guidance
├── Session token generated (JWT with 7-day expiry)
├── Auth page shows: Session token in a copy-friendly box
├── Auth page shows: Claude Desktop configuration snippet (ready to paste)
├── Auth page shows: Token expiry date
└── Action: User copies the configuration

Step 6: Configure Claude Desktop
├── User opens Claude Desktop settings (or claude_desktop_config.json)
├── User pastes the MCP server configuration with their session token
├── User restarts Claude Desktop
├── Decision point: "Did it work?"
│   └── Claude should show lazylotto-agent tools in the tool list
└── Action: Ask Claude to check status

Step 7: Registration (via Claude)
├── User asks Claude: "Register me for the lottery with balanced strategy"
├── Claude calls multi_user_register (token already includes the account ID)
├── System auto-fills accountId from the JWT — user does not need to type it
├── Response includes: deposit memo, agent wallet address, fee schedule
├── Decision point: "How much do I deposit?"
│   └── Information needed: minimum deposit (1 HBAR/LAZY), maximum balance cap,
│       current rake rate, what the strategies cost per session
└── Action: User deposits funds via their wallet

Step 8: Deposit
├── User opens their wallet (HashPack/Blade)
├── Sends HBAR or LAZY to the agent wallet with the deposit memo
├── Waits ~15 seconds for detection
├── Asks Claude: "Check my balance"
├── Claude calls multi_user_status (scoped to this user)
├── User sees: gross deposit, rake deducted, net credited
└── Action: Ready to play

Step 9: First Play Session
├── User asks Claude: "Play the lottery for me"
├── Claude calls multi_user_play (userId auto-resolved from token)
├── Results returned: pools played, entries bought, wins, prizes transferred
└── User has completed the full onboarding loop
```

#### Error States and Recovery

| Error | When | User Sees | Recovery |
|-------|------|-----------|----------|
| Wallet not installed | Step 3 | "No wallet detected. Install HashPack or Blade to continue." + download links | Install wallet, refresh page |
| Wrong network | Step 3 | "Your wallet is connected to mainnet but this agent runs on testnet. Switch networks in your wallet." | Switch network in wallet extension |
| Signature rejected | Step 4 | "Signature cancelled. Click 'Sign' to try again." | Re-attempt signing |
| Signature verification failed | Step 5 | "Signature could not be verified. Please disconnect and reconnect your wallet." | Disconnect, reconnect, try again |
| Claude Desktop won't connect | Step 6 | (Not on auth page) Claude shows no tools | Check config JSON syntax, restart Claude, verify paths |
| Registration fails (duplicate) | Step 7 | "An account with this wallet is already registered." | Use existing registration, or contact operator |
| Deposit not detected | Step 8 | Balance shows 0 after deposit | Verify memo is exact, check transaction on HashScan, wait 30s |

#### Friction Points and Mitigations

| Friction | Severity | Mitigation |
|----------|----------|------------|
| User must manually edit Claude config JSON | High | Auth page generates the complete JSON snippet. One-click copy button. Step-by-step instructions with screenshots for each OS. |
| User must understand deposit memos | Medium | Claude explains the deposit process conversationally. Auth page shows deposit instructions after token issuance. |
| Wallet pairing popup may be unfamiliar | Medium | Auth page includes "What to expect" accordion before the Connect button, showing screenshots of each wallet's pairing flow. |
| Session token is a long opaque string | Low | Copy button with confirmation toast. Token is never shown again after page close (but user can re-authenticate to get a new one). |
| User needs to restart Claude Desktop | Medium | Auth page explicitly says "Restart Claude Desktop after saving the configuration." Bold text, not buried. |

---

### Persona 2: Returning User (Session Expired)

**Context**: User has been using the agent for weeks. Their 7-day session token
expired. Claude tools start returning auth errors.

#### Journey Steps

```
Step 1: Error Detection
├── User asks Claude to play or check balance
├── Claude calls multi_user_play with the expired token
├── Agent returns: "Session expired. Visit [auth page URL] to re-authenticate."
├── Claude relays: "Your session has expired. Visit the auth page to get a new token."
└── Action: User clicks the auth page link

Step 2: Auth Page — Returning User
├── Auth page loads in default "Connect Wallet" state
├── No persistent login (auth page is stateless)
├── User clicks "Connect Wallet" — wallet remembers the dApp pairing
│   └── If wallet pairing expired: full pairing flow again (rare, wallets
│       usually persist pairings for 30 days)
└── Action: Wallet connects

Step 3: Auth Page — Fast Re-auth
├── Auth page detects the connected account is already registered
├── Shows: "Welcome back, 0.0.12345" with current balance summary
├── Shows: Strategy, last play date, account status
├── Challenge signing proceeds automatically (same flow as new user)
├── New session token issued
├── Auth page shows updated Claude Desktop config snippet
│   └── Only the env.MCP_SESSION_TOKEN value needs to change
└── Action: User updates the token in their Claude config

Step 4: Resume
├── User updates claude_desktop_config.json with new token
├── Restarts Claude Desktop
├── Resumes conversation — all tools work again
└── Total re-auth time: ~60 seconds (most is waiting for wallet popup)
```

#### Error States and Recovery

| Error | When | User Sees | Recovery |
|-------|------|-----------|----------|
| Wallet pairing expired | Step 2 | Full pairing flow (QR code or extension popup) | Complete pairing, then sign |
| Different wallet connected | Step 3 | "This wallet (0.0.67890) is not the one you registered with (0.0.12345). Connect the original wallet, or register a new account." | Disconnect, connect correct wallet |
| Account was deregistered | Step 3 | "This account has been deregistered. You can still authenticate to withdraw remaining funds." | Authenticate, withdraw via Claude |

#### Friction Points and Mitigations

| Friction | Severity | Mitigation |
|----------|----------|------------|
| User must manually update config JSON | High | Auth page highlights only the token value that changed. Diff view: "Replace this line." |
| User must restart Claude Desktop | Medium | Same mitigation as new user. Consider: future MCP spec may support token refresh without restart. |
| No warning before expiry | Medium | Agent could proactively warn when token is within 24h of expiry (on any tool call). |

---

### Persona 3: Admin

**Context**: The operator has designated a trusted person to handle refunds for
mis-sent deposits. The admin needs elevated access but should not have operator
withdrawal powers.

#### Journey Steps

```
Step 1: Operator Grants Admin Role
├── Operator adds the admin's Hedera account ID to an admin list
│   └── Configuration: ADMIN_ACCOUNTS=0.0.11111,0.0.22222 in .env
│       (or managed via an operator tool: operator_set_admin)
└── Action: Operator restarts agent (or hot-reloads admin list)

Step 2: Admin Authenticates
├── Same auth page as regular users
├── Admin connects wallet, signs challenge
├── Backend checks admin list during token issuance
│   ├── Account is in ADMIN_ACCOUNTS: role = "admin" in JWT
│   └── Account is not in list: role = "user" (default)
├── Admin receives session token with admin role
└── Action: Admin configures Claude Desktop with their token

Step 3: Admin Operations
├── Admin sees all user balances via multi_user_status (not scoped to self)
├── Admin can call admin_refund to process mis-sent deposit returns
├── Admin can view operator_balance and operator_health (read-only)
├── Admin CANNOT call operator_withdraw_fees (operator-only)
├── Admin CANNOT change rake configuration
└── Action: Admin performs refund, documented on HCS-20 audit trail

Step 4: Refund Workflow
├── User reports: "I sent HBAR to the agent without a memo"
├── Admin checks: transaction on mirror node, confirms the deposit
├── Admin calls: admin_refund(transactionId, recipientAccountId, amount)
├── Agent processes: on-chain HBAR transfer back to user
├── HCS-20 record: refund operation logged immutably
└── Action: User confirms receipt
```

#### Error States and Recovery

| Error | When | User Sees | Recovery |
|-------|------|-----------|----------|
| Not in admin list | Step 2 | Gets user-level token (no error, just reduced permissions) | Operator must add them to ADMIN_ACCOUNTS |
| Admin tries operator tool | Step 3 | "Insufficient permissions. This operation requires operator access." | Contact operator |
| Refund exceeds available | Step 4 | "Insufficient platform balance for refund." | Operator must fund or approve from platform balance |

#### Friction Points and Mitigations

| Friction | Severity | Mitigation |
|----------|----------|------------|
| Admin cannot self-elevate | Desirable | This is a security feature, not a friction point |
| Admin must re-auth same as users | Low | Same flow, same frequency. Consider longer expiry for admin tokens (14 days). |
| Refund requires manual transaction ID lookup | Medium | Future: admin_list_unmatched_deposits tool to surface deposits without matching memos |

---

### Persona 4: Operator

**Context**: The person running the infrastructure. Has server access, controls
the .env file, and manages the agent process.

#### Journey Steps

```
Step 1: Operator Access (No Auth Page Needed)
├── Operator sets MCP_AUTH_TOKEN in .env (minimum 32 characters)
├── Operator adds MCP_AUTH_TOKEN to their Claude Desktop config
├── All tool calls use MCP_AUTH_TOKEN directly
├── Agent recognizes raw MCP_AUTH_TOKEN as operator role
└── No wallet connection or signature needed

Step 2: Claude Desktop Config
├── Operator's claude_desktop_config.json:
│   {
│     "mcpServers": {
│       "lazylotto-agent": {
│         "command": "lazylotto-agent",
│         "args": ["--multi-user", "--mcp-server"],
│         "env": {
│           "MCP_AUTH_TOKEN": "<the 64-char hex secret>",
│           "DOTENV_CONFIG_PATH": "/path/to/.env"
│         }
│       }
│     }
│   }
├── Operator's tools are always available, no expiry
└── Action: Operator manages the platform via Claude

Step 3: Operator-Exclusive Operations
├── operator_withdraw_fees — withdraw rake earnings
├── operator_reconcile — compare on-chain vs ledger
├── operator_set_admin — grant/revoke admin roles (future)
├── All multi_user tools — can operate on any user
└── Full visibility into all user data
```

#### Error States and Recovery

| Error | When | User Sees | Recovery |
|-------|------|-----------|----------|
| MCP_AUTH_TOKEN too short | Startup | Agent refuses to start in multi-user mode | Generate proper 32+ char token |
| MCP_AUTH_TOKEN not set | Startup | Agent refuses to start in multi-user mode | Set the env var |
| Operator forgets token | Anytime | Cannot authenticate | Check .env file on server |

#### Friction Points and Mitigations

| Friction | Severity | Mitigation |
|----------|----------|------------|
| None significant | -- | Operator path is already minimal. No changes needed from current flow. |

---

## 5. Auth Page Requirements

### 5.1 Page States

The auth page is a single-page application with the following states:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Landing    │────>│  Connected   │────>│   Signing    │────>│  Completed   │
│              │     │              │     │              │     │              │
│ "Connect     │     │ Account      │     │ Waiting for  │     │ Token issued │
│  Wallet"     │     │ confirmed    │     │ signature    │     │ Config shown │
│              │     │              │     │              │     │              │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └──────────────┘
       │                    │                    │
       ▼                    ▼                    ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ No Wallet    │     │ Wrong        │     │ Signature    │
│ Detected     │     │ Network      │     │ Failed       │
└──────────────┘     └──────────────┘     └──────────────┘
```

### 5.2 Landing State

**Visual Elements**:
- Network badge: prominently displayed in the top-right corner
  - Testnet: yellow/amber badge with "TESTNET" label
  - Mainnet: green badge with "MAINNET" label
- Operator identity: Hedera account ID of the agent operator
- Agent wallet address: where deposits will be sent
- Fee schedule: default rake %, negotiable range, volume tiers
- Boost status: current NFT delegation boost in basis points
- "Connect Wallet" button: large, centered, primary action
- Supported wallets: icons for HashPack, Blade, with labels
- Trust information: HCS-20 topic ID for independent audit verification

**Copy**:
- Heading: "Authenticate with LazyLotto Agent"
- Subheading: "Connect your Hedera wallet to start playing the lottery through AI."
- Explanation: "You will sign a message to prove wallet ownership. No transaction
  is sent and no funds are moved."
- Footer: "Powered by LazyLotto on Hedera. Verify on-chain accounting at topic
  [HCS20_TOPIC_ID] via any mirror node explorer."

### 5.3 Connected State

**Visual Elements**:
- Connected account ID with checksum (e.g., `0.0.12345-vfmkw`)
- Account status indicator:
  - New user: "New account" badge
  - Returning user: "Registered" badge with balance summary
  - Deregistered user: "Deregistered (withdrawal only)" badge
- "Sign Challenge" button (auto-triggered after brief pause for user to confirm account)
- "Disconnect" link to switch accounts

**Copy**:
- Heading: "Connected as 0.0.12345"
- For returning users: "Welcome back. Your current balance: 95.0 HBAR, 450.0 LAZY"
- Explanation: "Click Sign to verify ownership and receive your session token."

### 5.4 Signing State

**Visual Elements**:
- Challenge text displayed (the human-readable message being signed)
- Spinner/loading indicator
- "Waiting for wallet signature..." message

**Copy**:
- "Approve the signature request in your wallet. This proves you own this account
  without sending a transaction."

### 5.5 Completed State

**Visual Elements**:
- Success checkmark
- Session token displayed in a monospace box with copy button
- Token expiry date displayed
- Claude Desktop configuration JSON in a code block with copy button
- Step-by-step instructions for configuring Claude Desktop
- For returning users: "Only the session token value has changed. Update this
  one line in your config."
- "Done" button (or just leave the page)

**Copy**:
- Heading: "Authenticated successfully"
- Token section: "Your session token (expires [date]):"
- Config section: "Add this to your Claude Desktop configuration:"
- Instructions:
  1. "Open Claude Desktop settings"
  2. "Navigate to the MCP Servers section"
  3. "Add the configuration below (or update the session token if already configured)"
  4. "Restart Claude Desktop"
  5. "Ask Claude: 'Check my LazyLotto status' to verify the connection"

### 5.6 Error States

**No Wallet Detected**:
- "No Hedera wallet detected in your browser."
- Download links for HashPack and Blade wallet extensions
- "Already installed? Try refreshing the page."

**Wrong Network**:
- "Your wallet is connected to [detected network], but this agent operates on
  [expected network]."
- "Switch your wallet to [expected network] and refresh this page."
- For testnet: include link to Hedera Portal faucet for funding

**Signature Failed**:
- "The signature could not be verified."
- "This usually means the wallet returned an invalid response."
- "Try again" button to restart from the Connected state
- "If this keeps happening, try a different wallet."

### 5.7 Technical Requirements

| Requirement | Specification |
|-------------|---------------|
| Framework | Static SPA (React/Preact, or vanilla JS). Must work without a backend server at the auth page level; the challenge/verify logic runs as API routes on the agent's HTTP endpoint. |
| Wallet connection | Use HashConnect (HashPack) and BladeConnect (Blade) SDKs. Abstract behind a common interface. |
| Challenge generation | Server-side: agent generates a nonce + timestamp, stores it in memory with 5-minute TTL. |
| Challenge format | EIP-191-style personal message signing (Hedera supports `signMessage` on ED25519 keys). |
| Signature verification | Server-side: agent verifies the signature using the account's public key fetched from mirror node. |
| Token issuance | Server-side: agent creates HMAC-SHA256 JWT signed with MCP_AUTH_TOKEN. |
| Token delivery | Displayed on the auth page. Not sent via email or push notification. |
| HTTPS | Required for mainnet. Self-signed acceptable for testnet/local. |
| Mobile support | Auth page must be responsive. See cross-device section below. |

---

## 6. Session Management Requirements

### 6.1 Token Lifetime

| Role     | Default Lifetime | Configurable | Rationale |
|----------|------------------|--------------|-----------|
| user     | 7 days           | Yes (env var) | Balance between convenience and security. Users who play daily should not need to re-auth more than weekly. |
| admin    | 14 days          | Yes (env var) | Admins need consistent access for operational tasks. |
| operator | No expiry        | N/A          | Operator uses MCP_AUTH_TOKEN directly. Rotation is manual. |

Configuration:
```env
SESSION_TTL_USER_HOURS=168        # 7 days
SESSION_TTL_ADMIN_HOURS=336       # 14 days
```

### 6.2 Token Refresh

There is no refresh token mechanism. When a session expires, the user must visit
the auth page and re-authenticate. This is deliberate:

- The MCP protocol (stdio transport) does not support mid-session credential
  updates. The token is baked into the Claude Desktop config, which requires a
  restart to change.
- A refresh token would add complexity without reducing friction, because the
  restart is the bottleneck, not the re-authentication.

### 6.3 Expiry Handling

When a tool call arrives with an expired session token:

1. Agent decodes the JWT and checks `exp`.
2. If expired: return an error result with a specific code:
   ```json
   {
     "error": "SESSION_EXPIRED",
     "message": "Your session expired on 2026-04-08T12:00:00Z. Visit the auth page to get a new token.",
     "authPageUrl": "https://agent.example.com/auth"
   }
   ```
3. Claude receives this structured error and can relay the re-auth instructions
   to the user conversationally.

### 6.4 Proactive Expiry Warning

On any successful tool call, if the token expires within 24 hours, the agent
appends a warning to the response:

```json
{
  "data": { ... normal response ... },
  "_sessionWarning": "Your session expires in 18 hours. Visit the auth page to renew before it expires."
}
```

This gives the user advance notice to re-authenticate at their convenience rather
than being interrupted mid-conversation.

### 6.5 Token Revocation

Tokens cannot be individually revoked in the initial implementation. The agent
stores only the signing key (MCP_AUTH_TOKEN), not a list of issued tokens. If
the operator needs to revoke all sessions:

1. Rotate `MCP_AUTH_TOKEN` in `.env`.
2. Restart the agent.
3. All existing JWTs become invalid (signature mismatch).
4. All users and admins must re-authenticate.

Future enhancement: per-user revocation via a deny-list stored in the persistent
store. This would add an `operator_revoke_session(accountId)` tool.

### 6.6 Concurrent Sessions

A user can have multiple valid session tokens simultaneously (e.g., Claude Desktop
on two machines). The agent does not track active sessions. Each JWT is
self-contained and independently verifiable.

Constraint: the per-user mutex still applies. If two Claude instances trigger
`multi_user_play` simultaneously for the same user, one will wait for the other
to complete. This is safe.

---

## 7. Error Handling Requirements

### 7.1 Error Taxonomy

| Error Code | HTTP Equivalent | When | User-Facing Message |
|------------|-----------------|------|---------------------|
| `AUTH_REQUIRED` | 401 | No token provided | "Authentication required. Visit the auth page to get a session token." |
| `SESSION_EXPIRED` | 401 | Token exp < now | "Your session expired on [date]. Visit the auth page to renew." |
| `INVALID_TOKEN` | 401 | Signature invalid | "Invalid session token. Visit the auth page to get a new one." |
| `INSUFFICIENT_ROLE` | 403 | Role lacks permission | "This operation requires [required role] access. You are authenticated as [current role]." |
| `WRONG_USER` | 403 | userId does not match sub | "You can only perform this operation on your own account." |
| `ACCOUNT_DEREGISTERED` | 403 | User deregistered, non-withdrawal op | "Your account is deregistered. Only withdrawal is permitted." |

### 7.2 Error Response Format

All auth errors follow a consistent structure:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable explanation with next steps.",
  "authPageUrl": "https://agent.example.com/auth"
}
```

The `authPageUrl` is included on all auth errors so Claude can always direct the
user to the right place.

### 7.3 Graceful Degradation

If the JWT decoding library fails (malformed token, unexpected format), the agent
falls back to the legacy `MCP_AUTH_TOKEN` comparison. This ensures the operator's
direct token always works, even if the JWT layer has a bug.

Fallback chain:
1. Try JWT decode and verify.
2. If JWT decode fails, try raw token comparison against `MCP_AUTH_TOKEN`.
3. If both fail, return `INVALID_TOKEN`.

---

## 8. Claude Desktop Configuration

### 8.1 New User Configuration (Generated by Auth Page)

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "command": "lazylotto-agent",
      "args": ["--multi-user", "--mcp-server"],
      "env": {
        "MCP_SESSION_TOKEN": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwLjAuMTIzNDUiLCJyb2xlIjoidXNlciIsImlhdCI6MTcxMjAwMDAwMCwiZXhwIjoxNzEyNjA0ODAwfQ.signature",
        "DOTENV_CONFIG_PATH": "/path/to/your/.env"
      }
    }
  }
}
```

Note: The generated config uses `MCP_SESSION_TOKEN` (not `MCP_AUTH_TOKEN`). The
agent reads both: `MCP_AUTH_TOKEN` for operator identity, `MCP_SESSION_TOKEN`
(passed by the user's Claude instance) for user identity.

Wait -- this requires clarification. In the stdio transport model, the user's
Claude Desktop launches the agent as a subprocess. The env vars in the Claude
config are passed to the subprocess. This means:

- The user's `MCP_SESSION_TOKEN` is set in the subprocess environment.
- The agent reads it from `process.env.MCP_SESSION_TOKEN`.
- On every tool call, the agent uses this token (the user does not need to pass
  `auth_token` as a parameter).

This eliminates the friction of passing `auth_token` on every tool call. The
token is ambient in the environment.

### 8.2 Implementation Detail: Ambient Token vs. Parameter Token

Two paths for the auth token to reach the agent:

**Path A: Environment variable (preferred for Claude Desktop)**
```
Claude Desktop config env → process.env.MCP_SESSION_TOKEN → auto-injected
```
- User never types or sees the token after initial config.
- The `requireAuth` function reads from env if no parameter is provided.
- Seamless UX.

**Path B: Tool parameter (for programmatic MCP clients)**
```
MCP client → tool call with auth_token parameter → explicit per-call
```
- Used by automated agents, scripts, or HTTP-transport MCP clients.
- Supports multi-tenant scenarios where one MCP client acts on behalf of
  multiple users.

The agent checks in order: explicit `auth_token` parameter, then
`process.env.MCP_SESSION_TOKEN`, then `process.env.MCP_AUTH_TOKEN`.

### 8.3 Returning User Configuration Update

When a returning user re-authenticates, only one value changes:

```diff
  "env": {
-   "MCP_SESSION_TOKEN": "eyJ...old_token...",
+   "MCP_SESSION_TOKEN": "eyJ...new_token...",
    "DOTENV_CONFIG_PATH": "/path/to/your/.env"
  }
```

The auth page shows this as a highlighted diff to minimize confusion.

### 8.4 Operator Configuration (Unchanged from Current)

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "command": "lazylotto-agent",
      "args": ["--multi-user", "--mcp-server"],
      "env": {
        "MCP_AUTH_TOKEN": "a1b2c3d4e5f6...64-char-hex...",
        "DOTENV_CONFIG_PATH": "/path/to/.env"
      }
    }
  }
}
```

### 8.5 Key Architectural Point: Subprocess Model

In the stdio transport, each Claude Desktop user runs their own instance of the
agent as a subprocess. This has important implications:

1. **Each user has their own agent process.** They do not share a process with
   other users. The multi-user features still work because they all read from the
   same `.custodial-data/` directory on the operator's server.

2. **Wait -- this is a problem.** If the agent runs as a subprocess of Claude
   Desktop on the user's machine, it does not have access to the operator's
   server, `.env` file, or Hedera private key.

**Resolution: Two deployment models.**

**Model A: Remote agent (operator-hosted)**
- Agent runs on the operator's server.
- Users connect via a future HTTP/SSE MCP transport (not stdio).
- Auth token is passed as a parameter on each tool call.
- This is the target architecture for production multi-user.

**Model B: Local agent (current, for testing)**
- Agent runs as a subprocess on the user's machine.
- User must have the `.env` file (or the operator distributes a read-only
  config with the session token embedded).
- Only practical for the operator themselves or for testnet evaluation.

The auth page and session token system is designed for Model A (remote agent).
The Claude Desktop config for Model A would use the streamable HTTP transport:

```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "url": "https://agent.example.com/mcp",
      "headers": {
        "Authorization": "Bearer eyJ...session_token..."
      }
    }
  }
}
```

This is the clean target UX. The user never touches a `.env` file. They paste
a URL and a token.

For the stdio model (Model B), the session token still works but the user needs
access to the operator's `.env` (or a subset of it). This is acceptable for
single-user and operator-only scenarios.

### 8.6 Claude Desktop Config: Final Form (HTTP Transport, Model A)

**New user after auth:**
```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "url": "https://agent.lazylotto.app/mcp",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwLjAuMTIzNDUiLCJyb2xlIjoidXNlciJ9.sig"
      }
    }
  }
}
```

**Returning user after re-auth (only the token changes):**
```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "url": "https://agent.lazylotto.app/mcp",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.NEW_TOKEN_HERE.sig"
      }
    }
  }
}
```

**Operator (uses server-side token, no JWT):**
```json
{
  "mcpServers": {
    "lazylotto-agent": {
      "url": "https://agent.lazylotto.app/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN value>"
      }
    }
  }
}
```

---

## 9. Edge Cases and Resolutions

### 9.1 Cross-Device Authentication (Mobile Wallet, Desktop Claude)

**Scenario**: User's Hedera wallet (HashPack) is on their phone. Claude Desktop
is on their laptop. The auth page is on the laptop's browser.

**Resolution**: WalletConnect bridging.

1. Auth page displays a WalletConnect QR code.
2. User scans QR with their mobile wallet.
3. Wallet connects to the auth page via the WalletConnect relay.
4. Challenge is sent to the phone wallet for signing.
5. Signed response returns to the auth page on the laptop.
6. Session token is issued on the laptop.
7. User configures Claude Desktop on the same laptop.

This is a standard WalletConnect flow and works today with HashPack mobile.
The auth page must support both extension-based connection (desktop wallet) and
QR-based connection (mobile wallet).

### 9.2 Session Expires Mid-Conversation

**Scenario**: User is chatting with Claude. Mid-conversation, their session token
expires. The next tool call fails.

**Resolution**:

1. Tool call returns `SESSION_EXPIRED` error with auth page URL.
2. Claude tells the user: "Your session has expired. Visit [URL] to get a new
   token, then update your Claude Desktop config and restart."
3. The conversation context is lost on restart (Claude Desktop does not persist
   MCP conversations across restarts).
4. The user can resume by asking Claude to check their status.

**Mitigation**: The 24-hour proactive warning (Section 6.4) reduces the chance
of mid-conversation expiry. A 7-day lifetime makes mid-session expiry rare for
daily users.

### 9.3 User Authenticates with Wrong Account

**Scenario**: User has multiple Hedera accounts. They authenticate with account A
but previously registered with account B.

**Resolution**:

1. Auth page shows the connected account and its registration status.
2. If account A is not registered: auth page says "This account is not registered.
   You can register it as a new account, or disconnect and connect a different wallet."
3. The user can disconnect and reconnect with account B.
4. Each Hedera account is an independent identity. There is no "account linking."

### 9.4 Auth Page Detects Registration Status

**Question**: Can the auth page detect if the user is already registered?

**Answer**: Yes, after wallet connection (before signing). The flow:

1. User connects wallet, auth page receives account ID.
2. Auth page calls a lightweight API on the agent: `GET /auth/status?account=0.0.12345`
3. Agent checks its persistent store for a user with that `hederaAccountId`.
4. Returns: `{ registered: true, active: true, strategy: "balanced" }` or
   `{ registered: false }`.
5. Auth page updates the UI accordingly.

This API does not require authentication (the response is non-sensitive: it only
confirms whether an account ID is registered, not any balance details). An
attacker knowing that an account is registered with the agent is not a meaningful
information leak since HCS-20 records are public anyway.

### 9.5 Auth Page Shows Balance After Auth

**Question**: Should the auth page show the user's balance after authentication?

**Answer**: Yes, for returning users. After successful authentication:

- Show current balances (per-token available/reserved)
- Show last play date
- Show account status (active/deregistered)
- Show strategy name

This provides immediate confirmation that the authentication succeeded and the
account is in the expected state. It also helps users who are re-authenticating
after a long absence confirm they have the right account.

For new users (not yet registered), show: "New account. Register through Claude
to get started."

### 9.6 Network Mismatch

**Question**: How does the user know which network they are connecting to?

**Answer**: Multiple reinforcements:

1. **Auth page URL**: Operator should use distinct URLs or subdomains
   (`testnet.agent.example.com` vs `agent.example.com`).
2. **Network badge**: Prominent visual indicator on the auth page (yellow for
   testnet, green for mainnet).
3. **Challenge message**: Network name is embedded in the signed challenge text.
4. **Wallet detection**: Auth page reads the wallet's active network and compares
   against the agent's configured network. Mismatch triggers the "Wrong Network"
   error state.
5. **Claude Desktop config**: The generated config snippet includes a comment
   with the network name.

### 9.7 Operator Changes MCP_AUTH_TOKEN

**Scenario**: Operator rotates the signing key. All existing JWTs become invalid.

**Resolution**:

1. Operator updates `MCP_AUTH_TOKEN` in `.env`.
2. Restarts the agent.
3. All users see `INVALID_TOKEN` on their next tool call.
4. All users must re-authenticate via the auth page.
5. The agent logs a warning: "N sessions invalidated by key rotation."

**Mitigation**: This should be a rare operation. The operator should notify users
in advance (via the agent's announcement channel, if one exists).

**Future enhancement**: Support two signing keys simultaneously during a rotation
window (old key valid for 24h after rotation, new key active immediately). This
allows gradual re-authentication.

### 9.8 Wallet Signing Capability Differences

**Scenario**: Different wallets have different `signMessage` implementations.

**Resolution**:

- **HashPack**: Supports `signMessage` via HashConnect. Returns an ED25519
  signature over the raw bytes of the challenge message.
- **Blade**: Supports `signMessage` via BladeConnect SDK.
- **MetaMask (via Hedera Snap)**: Returns an ECDSA signature. The agent must
  support both ED25519 and ECDSA verification, depending on the account's key
  type (queryable from mirror node).

The auth page backend must:
1. Fetch the account's public key from mirror node: `GET /api/v1/accounts/0.0.12345`
2. Determine key type (ED25519 vs ECDSA).
3. Verify the signature using the appropriate algorithm.

### 9.9 Account with Multi-Sig or Threshold Key

**Scenario**: A Hedera account has a threshold key (e.g., 2-of-3 multi-sig).

**Resolution**: Not supported in the initial implementation. The auth page
requires a single-key signature. Accounts with complex key structures will see
a verification failure.

**Error message**: "This account uses a multi-signature or threshold key, which
is not supported for authentication. Please use an account with a single key."

**Future enhancement**: Support threshold key authentication by collecting
multiple signatures on the auth page.

### 9.10 Rate Limiting

The auth page API endpoints must be rate-limited to prevent abuse:

| Endpoint | Rate Limit | Window |
|----------|-----------|--------|
| `POST /auth/challenge` | 10 requests | per minute per IP |
| `POST /auth/verify` | 5 requests | per minute per IP |
| `GET /auth/status` | 20 requests | per minute per IP |

Failed verification attempts are logged with the account ID and IP for audit.

---

## 10. Success Metrics

### 10.1 Definition of Good Auth UX

The authentication system is successful when:

1. **Time to first play**: A new user can go from zero to their first lottery
   session in under 10 minutes, including wallet setup time.

2. **Re-auth time**: A returning user can re-authenticate and resume in under
   2 minutes.

3. **Zero support tickets for auth**: Users should never need to ask the operator
   for help with authentication. The auth page and error messages should be
   self-service.

4. **No shared secrets**: No user should ever possess the `MCP_AUTH_TOKEN`. They
   should only interact with their own scoped session token.

5. **Wallet ownership is cryptographically proven**: It should be impossible to
   register or operate on behalf of a wallet you do not control.

### 10.2 Measurable Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Auth page completion rate | > 90% | (tokens issued) / (wallet connections initiated) |
| Time from page load to token issued | < 60 seconds | Client-side timing |
| Session expiry → re-auth time | < 120 seconds | Time between SESSION_EXPIRED error and next successful tool call |
| Auth error rate (INVALID_TOKEN) | < 1% of tool calls | Agent logs |
| Support requests about auth | 0 per 50 users | Operator tracking |
| Proactive expiry warnings heeded | > 50% | Re-auth before expiry / warnings issued |

### 10.3 Anti-Metrics (What We Are NOT Optimizing For)

- **Session length**: We do not try to keep sessions alive as long as possible.
  A 7-day lifetime with clean re-auth is better than a 30-day lifetime with
  security concerns.
- **Auth page interactivity**: The auth page is a utility, not a product surface.
  It should be fast and functional, not feature-rich.
- **Mobile Claude usage**: Claude Desktop is desktop-only. The auth page supports
  mobile wallets (for cross-device signing) but does not need to support a mobile
  Claude experience.

---

## 11. Open Questions

### 11.1 Should the Agent Serve the Auth Page?

**Option A: Agent serves auth page**
- Single deployment. Auth page is a route on the agent's HTTP server.
- Requires the agent to have an HTTP transport (beyond current stdio).
- Simplifies CORS and cookie concerns.

**Option B: Separate static site**
- Auth page is a static SPA hosted on Vercel/Netlify/GitHub Pages.
- Calls the agent's HTTP API for challenge/verify.
- Agent needs CORS headers for the auth page origin.
- More flexible deployment.

**Recommendation**: Option A for simplicity. When the agent adds HTTP transport
(required for Model A remote agent), the auth page can be served from the same
origin.

### 11.2 JWT vs. Opaque Token

**JWT pros**:
- Self-contained (agent does not need a token store).
- Inspectable by the user (they can decode it to see their account ID and expiry).
- Standard format with library support.

**Opaque token pros**:
- Revocable without key rotation (agent maintains a lookup table).
- Shorter (can be a 32-char hex string vs. a 200+ char JWT).
- No risk of sensitive data leaking in the token payload.

**Recommendation**: JWT for the initial implementation. The self-contained nature
eliminates the need for a token database, which aligns with the agent's current
stateless auth model. Per-user revocation can be added later via a deny-list.

### 11.3 Should Registration Happen on the Auth Page?

Currently, registration happens via Claude (calling `multi_user_register`). An
alternative is to allow registration directly on the auth page during the
authentication flow.

**Pros of auth-page registration**:
- Fewer steps for new users.
- No need to configure Claude before registering.
- Strategy selection can use a visual picker.

**Cons of auth-page registration**:
- Duplicates functionality between auth page and MCP tool.
- User loses the conversational guidance Claude provides.
- Strategy details are better explained conversationally.

**Recommendation**: Keep registration in Claude. The auth page's job is identity
verification, not account setup. The auth page should clearly tell new users:
"After configuring Claude, ask it to register you for the lottery."

### 11.4 HCS-10 Path and Auth

The HCS-10 agent-to-agent path (negotiation via Hedera Consensus Service
messages) does not use the auth page at all. Identity is established by the
HCS topic key: whoever can submit messages to their inbound topic is
authenticated by the fact that they hold the topic's submit key.

This is a separate authentication mechanism that works independently.
The two paths (auth page for human users, HCS-10 for agent users) do not
need to be unified.

### 11.5 Token in URL vs. Header

For the HTTP transport model, the session token travels in the `Authorization`
header. This is standard and secure (not logged in URL access logs).

For Claude Desktop with HTTP transport, the config supports a `headers` field:
```json
{ "url": "...", "headers": { "Authorization": "Bearer ..." } }
```

This is confirmed to work in Claude Desktop as of the current version.

---

## Appendix A: Challenge Message Format

The challenge message signed by the user's wallet:

```
LazyLotto Agent Authentication

Account: 0.0.12345
Network: testnet
Agent: 0.0.67890
Timestamp: 2026-04-01T12:00:00.000Z
Nonce: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4

By signing this message, you prove ownership of the above Hedera account.
No transaction will be submitted and no funds will be moved.
```

Fields:
- **Account**: The user's connected Hedera account ID.
- **Network**: The agent's configured network (testnet/mainnet).
- **Agent**: The agent's Hedera account ID (operator wallet).
- **Timestamp**: ISO-8601 timestamp when the challenge was generated. Challenges
  expire after 5 minutes.
- **Nonce**: 32 hex characters, cryptographically random. Stored server-side with
  a 5-minute TTL. Prevents replay attacks.

The entire message is encoded as UTF-8 bytes and signed as a personal message
by the wallet.

---

## Appendix B: API Endpoints (Agent HTTP Server)

These endpoints are added to the agent when running with HTTP transport:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth` | None | Serve the auth page SPA |
| GET | `/auth/status?account=0.0.X` | None | Check if an account is registered |
| GET | `/auth/info` | None | Agent metadata: network, operator ID, rake schedule, boost |
| POST | `/auth/challenge` | None | Generate a challenge nonce. Body: `{ accountId: "0.0.X" }`. Returns: `{ challenge: "...", expiresAt: "..." }` |
| POST | `/auth/verify` | None | Verify signature and issue token. Body: `{ accountId: "0.0.X", challenge: "...", signature: "..." }`. Returns: `{ token: "eyJ...", expiresAt: "...", role: "user" }` |
| POST | `/mcp` | Bearer token | MCP protocol endpoint (all tool calls) |

---

## Appendix C: Migration Path from Current Auth

### Phase 1: Add JWT Support (Backward Compatible)

1. Add JWT decode/verify to `requireAuth`.
2. Continue accepting raw `MCP_AUTH_TOKEN` as operator.
3. Add `/auth/*` HTTP endpoints to the agent.
4. Build and deploy the auth page SPA.
5. No changes required for existing operator configurations.

### Phase 2: Scope User Tools

1. Modify multi-user tools to extract `sub` from JWT.
2. When role is `user`, auto-fill `userId` from `sub` claim.
3. Reject attempts to operate on other users' accounts.
4. When role is `admin` or `operator`, allow cross-user operations.

### Phase 3: Add Admin Role

1. Add `ADMIN_ACCOUNTS` env var.
2. Admin list checked during token issuance.
3. Add `admin_refund` tool.
4. Admin role gets read access to operator_balance and operator_health.

### Phase 4: HTTP Transport

1. Add streamable HTTP transport alongside stdio.
2. Auth page generates HTTP-transport Claude Desktop config.
3. Users no longer need `.env` access.
4. The auth page becomes the sole onboarding entry point for non-operator users.

Each phase is independently deployable and backward compatible with the previous
phase.
