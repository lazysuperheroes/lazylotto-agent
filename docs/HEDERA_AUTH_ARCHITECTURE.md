# Hedera Signature Challenge-Response Authentication

Architecture design for replacing the shared `MCP_AUTH_TOKEN` with per-user
Hedera account signature verification. Each user proves ownership of a Hedera
account by signing a server-issued nonce; the server verifies the signature
against the account's public key fetched from the Hedera mirror node.

---

## Table of Contents

1. [Auth Tier Model](#1-auth-tier-model)
2. [Sequence Diagrams](#2-sequence-diagrams)
3. [Data Models](#3-data-models)
4. [API Endpoint Specifications](#4-api-endpoint-specifications)
5. [Mirror Node Public Key Lookup](#5-mirror-node-public-key-lookup)
6. [Signature Verification](#6-signature-verification)
7. [Session Storage (Upstash Redis)](#7-session-storage-upstash-redis)
8. [MCP Tool Authorization Middleware](#8-mcp-tool-authorization-middleware)
9. [File-by-File Change List](#9-file-by-file-change-list)
10. [Security Considerations](#10-security-considerations)
11. [Migration Path](#11-migration-path)

---

## 1. Auth Tier Model

Four tiers, each with distinct verification requirements:

```
Tier         Verification                          Tools
-----------  ------------------------------------  ----------------------------------------
Public       Rate-limited, no auth                 multi_user_register, agent_onboard
User         Session token (Hedera sig proof)      multi_user_play, multi_user_withdraw,
                                                   multi_user_status, multi_user_deposit_info,
                                                   multi_user_play_history, multi_user_deregister,
                                                   agent_play, agent_status, agent_wallet_info,
                                                   agent_set_strategy, agent_transfer_prizes,
                                                   agent_withdraw, agent_stop, agent_audit
Admin        Session token + ADMIN_ACCOUNTS env    operator_balance (read-only view),
                                                   future: refund, dead-letter management
Operator     MCP_AUTH_TOKEN (infrastructure)        operator_withdraw_fees, operator_reconcile,
                                                   operator_health
```

Key design decisions:
- **User tier** tools are scoped: a user session token only authorizes
  operations on that user's own account. The `userId` is embedded in the session
  and enforced server-side (the caller cannot specify a different userId).
- **Admin tier** is a superset of User: an admin session can act on any user.
- **Operator tier** remains a shared secret for infrastructure automation
  (cron jobs, monitoring, CI pipelines). It does not go through the challenge
  flow. This avoids forcing human key-signing for automated infrastructure.

---

## 2. Sequence Diagrams

### 2.1 Challenge-Response Authentication (User/Admin)

```
Frontend (Vercel)         Agent HTTP Server          Mirror Node        Upstash Redis
      |                          |                       |                   |
      |  POST /auth/challenge    |                       |                   |
      |  { accountId }           |                       |                   |
      |------------------------->|                       |                   |
      |                          |  GET /accounts/{id}   |                   |
      |                          |---------------------->|                   |
      |                          |  { key: { _type, key } }                  |
      |                          |<----------------------|                   |
      |                          |                       |                   |
      |                          |  SET challenge:{nonce} |                  |
      |                          |  { accountId, pubKey,  |                  |
      |                          |    createdAt, expiresAt }                 |
      |                          |----------------------------------------->|
      |                          |                       |                   |
      |  { challengeId, nonce,   |                       |                   |
      |    message, expiresAt }  |                       |                   |
      |<-------------------------|                       |                   |
      |                          |                       |                   |
      |  [User signs message     |                       |                   |
      |   via WalletConnect      |                       |                   |
      |   or local key]          |                       |                   |
      |                          |                       |                   |
      |  POST /auth/verify       |                       |                   |
      |  { challengeId,          |                       |                   |
      |    signature,            |                       |                   |
      |    accountId }           |                       |                   |
      |------------------------->|                       |                   |
      |                          |  GET challenge:{nonce} |                  |
      |                          |----------------------------------------->|
      |                          |  DEL challenge:{nonce} |                  |
      |                          |----------------------------------------->|
      |                          |                       |                   |
      |                          |  Verify signature     |                   |
      |                          |  against stored pubKey |                  |
      |                          |                       |                   |
      |                          |  SET session:{token}  |                   |
      |                          |  { accountId, userId, |                   |
      |                          |    tier, createdAt,   |                   |
      |                          |    expiresAt }        |                   |
      |                          |----------------------------------------->|
      |                          |                       |                   |
      |  { sessionToken,         |                       |                   |
      |    accountId,            |                       |                   |
      |    tier, expiresAt }     |                       |                   |
      |<-------------------------|                       |                   |
```

### 2.2 Authenticated MCP Tool Call (User Tier)

```
Frontend / Client            Agent HTTP Server            Upstash Redis
      |                              |                          |
      |  MCP tool call               |                          |
      |  (multi_user_play)           |                          |
      |  meta.authToken = "ses_..."  |                          |
      |----------------------------->|                          |
      |                              |  GET session:{token}     |
      |                              |------------------------->|
      |                              |  { accountId, userId,    |
      |                              |    tier: "user" }        |
      |                              |<-------------------------|
      |                              |                          |
      |                              |  Verify: session.userId  |
      |                              |  matches tool's target   |
      |                              |  userId (scoping)        |
      |                              |                          |
      |                              |  Execute tool            |
      |                              |                          |
      |  { result }                  |                          |
      |<-----------------------------|                          |
```

### 2.3 Operator Tool Call (Infrastructure)

```
Automation (cron/CI)         Agent HTTP Server
      |                              |
      |  MCP tool call               |
      |  (operator_health)           |
      |  meta.authToken = "op_..."   |
      |----------------------------->|
      |                              |
      |                              |  Detect "op_" prefix     |
      |                              |  Hash-compare against    |
      |                              |  MCP_AUTH_TOKEN           |
      |                              |                          |
      |  { result }                  |
      |<-----------------------------|
```

### 2.4 Session Refresh

```
Frontend                     Agent HTTP Server            Upstash Redis
      |                              |                          |
      |  POST /auth/refresh          |                          |
      |  { sessionToken }            |                          |
      |----------------------------->|                          |
      |                              |  GET session:{old}       |
      |                              |------------------------->|
      |                              |                          |
      |                              |  Check: > 50% TTL        |
      |                              |  remaining? Reject.      |
      |                              |                          |
      |                              |  DEL session:{old}       |
      |                              |  SET session:{new}       |
      |                              |  (refreshCount += 1)     |
      |                              |------------------------->|
      |                              |                          |
      |  { sessionToken (new),       |                          |
      |    expiresAt }               |                          |
      |<-----------------------------|                          |
```

---

## 3. Data Models

All TypeScript interfaces for the new auth system. These go in
`src/auth/types.ts`.

```typescript
// src/auth/types.ts

/** The four authorization tiers. */
export type AuthTier = 'public' | 'user' | 'admin' | 'operator';

/**
 * Hedera account key type as returned by mirror node.
 * ED25519 keys are 32 bytes; ECDSA_SECP256K1 keys are 33 bytes (compressed).
 */
export type HederaKeyType = 'ED25519' | 'ECDSA_SECP256K1';

// ── Challenge ────────────────────────────────────────────────────

/** Stored in Redis during the challenge window. */
export interface AuthChallenge {
  /** Random UUID identifying this challenge. */
  challengeId: string;
  /** The 32-byte hex nonce the user must sign. */
  nonce: string;
  /** Hedera account ID that requested the challenge (e.g. "0.0.12345"). */
  accountId: string;
  /** DER-hex public key fetched from mirror node at challenge time. */
  publicKeyDer: string;
  /** Key type for dispatch to the correct verification algorithm. */
  keyType: HederaKeyType;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry (challenge TTL = 5 minutes). */
  expiresAt: string;
  /** Client IP that requested the challenge (for abuse tracking). */
  requestIp: string;
}

/** Returned to the client after POST /auth/challenge. */
export interface ChallengeResponse {
  challengeId: string;
  /** Human-readable message embedding the nonce, for wallet display. */
  message: string;
  /** Raw hex nonce (32 bytes). Wallet signs this or the message. */
  nonce: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

// ── Verification Request ─────────────────────────────────────────

/** POST /auth/verify request body. */
export interface VerifyRequest {
  challengeId: string;
  /** Hex-encoded signature bytes. */
  signature: string;
  /** Account ID (must match the challenge). */
  accountId: string;
  /**
   * What was signed: "nonce" means raw 32-byte nonce was signed;
   * "message" means the human-readable message string was signed.
   * Default: "message".
   */
  signedPayload?: 'nonce' | 'message';
}

// ── Session ──────────────────────────────────────────────────────

/** Stored in Redis as the session record. */
export interface AuthSession {
  /** Opaque session token (returned to client). */
  sessionToken: string;
  /** Hedera account ID that authenticated. */
  accountId: string;
  /**
   * Internal userId in the custodial system, if registered.
   * Null for accounts that have not yet registered.
   * Looked up at verification time and refreshed on each session refresh.
   */
  userId: string | null;
  /** Auth tier determined at verification time. */
  tier: AuthTier;
  /** DER-hex public key (frozen at auth time for audit). */
  publicKeyDer: string;
  keyType: HederaKeyType;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
  /** How many times this session lineage has been refreshed. */
  refreshCount: number;
  /** Client IP at session creation. */
  createdFromIp: string;
}

/** Returned to the client after POST /auth/verify. */
export interface VerifyResponse {
  sessionToken: string;
  accountId: string;
  userId: string | null;
  tier: AuthTier;
  expiresAt: string;
}

/** Returned after POST /auth/refresh. */
export interface RefreshResponse {
  sessionToken: string;
  expiresAt: string;
}

// ── Mirror Node Account Response ─────────────────────────────────

/** Subset of the mirror node /accounts/{id} response we need. */
export interface MirrorAccountInfo {
  account: string;
  key: {
    _type: string; // "ED25519" | "ECDSA_SECP256K1" | "ProtobufEncoded"
    key: string;   // Hex-encoded public key
  } | null;
  deleted: boolean;
}

// ── Auth Context (injected into tool handlers) ───────────────────

/**
 * The resolved identity after middleware processes the auth token.
 * Passed into tool handlers so they can enforce scoping.
 */
export interface AuthIdentity {
  tier: AuthTier;
  /** Hedera account ID. Null only for operator tier. */
  accountId: string | null;
  /** Internal userId. Null if not registered or operator tier. */
  userId: string | null;
  /** The raw session token (for audit logging). */
  sessionToken: string | null;
}

// ── Rate Limiting ────────────────────────────────────────────────

/** Per-IP rate limit tracking for challenge endpoint. */
export interface RateLimitEntry {
  /** Number of challenges requested in the current window. */
  count: number;
  /** Window start (epoch ms). */
  windowStart: number;
}

// ── Configuration ────────────────────────────────────────────────

export interface AuthConfig {
  /** Challenge TTL in seconds. Default: 300 (5 min). */
  challengeTtlSec: number;
  /** Session TTL in seconds. Default: 3600 (1 hour). */
  sessionTtlSec: number;
  /** Maximum session refreshes before re-auth required. Default: 24. */
  maxRefreshCount: number;
  /** Minimum session age (% of TTL elapsed) before refresh allowed. Default: 0.5. */
  minRefreshAge: number;
  /** Challenge requests per IP per window. Default: 10. */
  challengeRateLimit: number;
  /** Rate limit window in seconds. Default: 300 (5 min). */
  challengeRateWindowSec: number;
  /** Comma-separated Hedera account IDs for admin tier. */
  adminAccounts: string[];
  /** Redis key prefix. Default: "lla:". */
  redisPrefix: string;
}

export function loadAuthConfig(): AuthConfig {
  const adminRaw = process.env.ADMIN_ACCOUNTS ?? '';
  return {
    challengeTtlSec: Number(process.env.AUTH_CHALLENGE_TTL_SEC ?? 300),
    sessionTtlSec: Number(process.env.AUTH_SESSION_TTL_SEC ?? 3600),
    maxRefreshCount: Number(process.env.AUTH_MAX_REFRESH ?? 24),
    minRefreshAge: Number(process.env.AUTH_MIN_REFRESH_AGE ?? 0.5),
    challengeRateLimit: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT ?? 10),
    challengeRateWindowSec: Number(process.env.AUTH_CHALLENGE_RATE_WINDOW_SEC ?? 300),
    adminAccounts: adminRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    redisPrefix: process.env.AUTH_REDIS_PREFIX ?? 'lla:',
  };
}
```

---

## 4. API Endpoint Specifications

These are plain REST endpoints served on the same HTTP server as the MCP
StreamableHTTPServerTransport, but on separate paths. They are NOT MCP tools
because the challenge-response flow happens before the user has an MCP session.

### 4.1 POST /auth/challenge

Request a nonce challenge for a Hedera account.

**Request:**
```json
{
  "accountId": "0.0.12345"
}
```

**Response (200):**
```json
{
  "challengeId": "uuid-v4",
  "message": "Sign this message to authenticate with LazyLotto Agent:\n\nNonce: a1b2c3d4...64hex\nAccount: 0.0.12345\nTimestamp: 2026-04-01T12:00:00Z\nExpires: 2026-04-01T12:05:00Z",
  "nonce": "a1b2c3d4...64hex",
  "expiresAt": "2026-04-01T12:05:00.000Z"
}
```

**Error responses:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "Invalid Hedera account ID format" }` | Bad accountId |
| 404 | `{ "error": "Account not found or has no public key" }` | Mirror node 404 or null key |
| 422 | `{ "error": "Account uses key type 'ProtobufEncoded' ..." }` | Multi-sig / threshold key |
| 429 | `{ "error": "Rate limit exceeded", "retryAfterSec": N }` | Too many challenges from IP |

**Implementation notes:**
- Validate `accountId` matches `/^0\.0\.\d+$/`.
- Fetch account info from mirror node. Cache the key for 60s to absorb
  retries without hammering the mirror node.
- Reject accounts with `deleted: true`.
- Reject accounts whose `key._type` is `ProtobufEncoded` (multi-sig,
  threshold keys, key lists). Only `ED25519` and `ECDSA_SECP256K1` are
  supported. A future iteration could support `ThresholdKey` but that
  requires complex multi-party verification.
- Generate nonce: `crypto.randomBytes(32).toString('hex')`.
- Build the human-readable `message` string that wallets display to the user.
  The nonce is embedded in the message.
- Store `AuthChallenge` in Redis with key `{prefix}challenge:{challengeId}`
  and TTL = `challengeTtlSec`.

### 4.2 POST /auth/verify

Submit a signed challenge to receive a session token.

**Request:**
```json
{
  "challengeId": "uuid-v4",
  "signature": "hex-encoded-signature",
  "accountId": "0.0.12345",
  "signedPayload": "message"
}
```

**Response (200):**
```json
{
  "sessionToken": "ses_hex64",
  "accountId": "0.0.12345",
  "userId": "uuid-or-null",
  "tier": "user",
  "expiresAt": "2026-04-01T13:00:00.000Z"
}
```

**Error responses:**
| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "Missing required fields" }` | Incomplete body |
| 401 | `{ "error": "Signature verification failed" }` | Bad signature |
| 404 | `{ "error": "Challenge not found or expired" }` | Unknown/expired challengeId |
| 409 | `{ "error": "Account ID mismatch" }` | accountId differs from challenge |

**Implementation notes:**
- Fetch and immediately delete the challenge from Redis (single-use).
  Use a Lua script or `GETDEL` for atomicity.
- Verify the accountId in the request matches the challenge's accountId.
- Verify the signature (see section 6).
- Determine the tier: if `accountId` is in `ADMIN_ACCOUNTS`, tier = `admin`;
  otherwise tier = `user`.
- Look up the userId: query the PersistentStore for a user whose
  `hederaAccountId` matches the authenticated accountId. May be null
  (user authenticated but not yet registered).
- Generate session token: `"ses_" + crypto.randomBytes(32).toString('hex')`.
- Store `AuthSession` in Redis with key `{prefix}session:{sessionToken}`
  and TTL = `sessionTtlSec`.

### 4.3 POST /auth/refresh

Exchange a valid session token for a new one with a reset TTL.

**Request:**
```json
{
  "sessionToken": "ses_hex64"
}
```

**Response (200):**
```json
{
  "sessionToken": "ses_newhex64",
  "expiresAt": "2026-04-01T14:00:00.000Z"
}
```

**Error responses:**
| Status | Body | Cause |
|--------|------|-------|
| 401 | `{ "error": "Session not found or expired" }` | Invalid/expired token |
| 429 | `{ "error": "Too early to refresh" }` | < 50% of TTL elapsed |
| 403 | `{ "error": "Max refresh count exceeded, re-authenticate" }` | Exceeded `maxRefreshCount` |

**Implementation notes:**
- Fetch session from Redis. If missing, return 401.
- Check that at least `minRefreshAge` fraction of the TTL has elapsed
  since `createdAt`. This prevents token-spinning attacks.
- Check `refreshCount < maxRefreshCount`. After 24 refreshes (default 24h
  of continuous use), force re-authentication.
- Delete old session, create new session with incremented `refreshCount`
  and refreshed `userId` lookup (in case the user registered since last
  auth).

### 4.4 POST /auth/revoke

Explicitly invalidate a session (logout).

**Request:**
```json
{
  "sessionToken": "ses_hex64"
}
```

**Response (200):**
```json
{
  "revoked": true
}
```

Always returns 200 even if the session was already expired/missing
(idempotent logout).

### 4.5 GET /auth/session

Introspect the current session (for frontend to check session validity).

**Request:** `Authorization: Bearer ses_hex64`

**Response (200):**
```json
{
  "accountId": "0.0.12345",
  "userId": "uuid-or-null",
  "tier": "user",
  "expiresAt": "2026-04-01T13:00:00.000Z"
}
```

**Error responses:**
| Status | Body | Cause |
|--------|------|-------|
| 401 | `{ "error": "Not authenticated" }` | Missing/invalid/expired token |

---

## 5. Mirror Node Public Key Lookup

New function in `src/hedera/mirror.ts`:

```typescript
export interface AccountKeyInfo {
  accountId: string;
  keyType: 'ED25519' | 'ECDSA_SECP256K1';
  /** Hex-encoded raw public key bytes (no DER prefix). */
  publicKeyHex: string;
  /** Full DER-encoded hex key as returned by mirror node. */
  publicKeyDer: string;
  deleted: boolean;
}

/**
 * Fetch the public key for a Hedera account from the mirror node.
 *
 * Rejects accounts that:
 *   - Do not exist (404)
 *   - Are deleted
 *   - Have no key
 *   - Use ProtobufEncoded keys (multi-sig, threshold, key lists)
 *
 * The mirror node response shape for the key field:
 *   { "_type": "ED25519", "key": "302a300506032b6570032100<32-byte-hex>" }
 *   { "_type": "ECDSA_SECP256K1", "key": "3a21..." }
 *
 * For ED25519:
 *   DER prefix is 302a300506032b657003210 (varies), raw key is last 32 bytes.
 * For ECDSA_SECP256K1:
 *   DER prefix is 3036301006072a8648ce3d020106052b8104000a032200, raw key is
 *   last 33 bytes (compressed).
 */
export async function getAccountKey(accountId: string): Promise<AccountKeyInfo> {
  // Implementation fetches GET /accounts/{accountId}
  // and extracts key._type + key.key
}
```

The mirror node returns DER-encoded hex keys. We need the raw bytes for
signature verification. The Hedera SDK's `PublicKey.fromString()` handles
DER decoding internally, so we can use it directly:

```typescript
import { PublicKey } from '@hashgraph/sdk';

// PublicKey.fromString() accepts the DER hex from the mirror node
const pubKey = PublicKey.fromString(challenge.publicKeyDer);
```

**Caching strategy:** Cache `getAccountKey` results for 60 seconds in a
local LRU map (not Redis). This absorbs rapid challenge retries without
adding latency. The cache is small (one entry per account that requested
a challenge in the last minute).

---

## 6. Signature Verification

### 6.1 What Gets Signed

The challenge message is a human-readable string:

```
Sign this message to authenticate with LazyLotto Agent:

Nonce: <64-char-hex>
Account: 0.0.12345
Timestamp: 2026-04-01T12:00:00.000Z
Expires: 2026-04-01T12:05:00.000Z
```

WalletConnect wallets display this message and the user approves it. The
wallet signs the UTF-8 encoded message bytes.

The `signedPayload` field in the verify request indicates whether the
wallet signed the full message string or just the raw nonce bytes. This
accommodates different wallet implementations:
- **HashPack / Blade / WalletConnect**: Sign the message string.
- **CLI / programmatic**: May sign the raw nonce bytes for simplicity.

### 6.2 Ed25519 Verification

```typescript
import { PublicKey } from '@hashgraph/sdk';

function verifyEd25519(
  publicKeyDer: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  const pubKey = PublicKey.fromString(publicKeyDer);
  return pubKey.verify(message, signature);
}
```

The Hedera SDK's `PublicKey.verify()` handles Ed25519 natively. It uses
the `@hashgraph/cryptography` package which wraps tweetnacl internally.

### 6.3 ECDSA (secp256k1) Verification

```typescript
import { PublicKey } from '@hashgraph/sdk';

function verifyEcdsaSecp256k1(
  publicKeyDer: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  const pubKey = PublicKey.fromString(publicKeyDer);
  // The Hedera SDK's PublicKey.verify() supports ECDSA_SECP256K1 as well.
  // It hashes the message with SHA-256 before verification (standard
  // Hedera ECDSA signing convention), matching what wallets do.
  return pubKey.verify(message, signature);
}
```

**Important nuance**: Hedera's ECDSA signing convention SHA-256 hashes the
message before signing (unlike Ethereum which uses keccak256). The Hedera
SDK handles this internally. If the frontend uses a Hedera-native wallet
(HashPack, Blade), the signature will use Hedera's convention. If using
a generic WalletConnect provider that uses Ethereum signing, we need a
separate code path that hashes with keccak256. The `signedPayload` field
helps disambiguate this.

### 6.4 Unified Verification Function

```typescript
// src/auth/verify.ts

import { PublicKey } from '@hashgraph/sdk';

/**
 * Verify a signature against a Hedera public key.
 *
 * Uses the Hedera SDK's PublicKey which handles both ED25519 and
 * ECDSA_SECP256K1 key types, including proper hashing conventions.
 *
 * @returns true if signature is valid
 */
export function verifyHederaSignature(
  publicKeyDer: string,
  payload: Uint8Array,
  signatureBytes: Uint8Array,
): boolean {
  try {
    const pubKey = PublicKey.fromString(publicKeyDer);
    return pubKey.verify(payload, signatureBytes);
  } catch {
    return false;
  }
}
```

---

## 7. Session Storage (Upstash Redis)

### 7.1 Why Upstash Redis

- **Vercel KV is retired** (sunset notice Q1 2026).
- Upstash Redis provides a REST-based Redis API, serverless-friendly.
- Native TTL support for automatic challenge/session expiry.
- Atomic operations (GETDEL, Lua scripts) for single-use challenges.
- Global edge replication for low latency.

### 7.2 Redis Key Schema

```
Prefix: lla:  (configurable via AUTH_REDIS_PREFIX)

lla:challenge:{challengeId}    -> JSON(AuthChallenge)    TTL: 300s
lla:session:{sessionToken}     -> JSON(AuthSession)      TTL: 3600s
lla:ratelimit:{ip}             -> count (integer)        TTL: 300s
lla:account-sessions:{acctId}  -> SET of session tokens  TTL: 3600s
```

The `account-sessions` set enables:
- Revoking all sessions for an account (admin action).
- Limiting concurrent sessions per account (default: 5).
- Listing active sessions for introspection.

### 7.3 Upstash Client Setup

```typescript
// src/auth/redis.ts

import { Redis } from '@upstash/redis';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set'
      );
    }
    redis = new Redis({ url, token });
  }
  return redis;
}
```

**New dependency:** `@upstash/redis` (REST-based, no native TCP connection
needed, works in serverless and Node.js).

### 7.4 Redis Operations

```typescript
// Challenge lifecycle
async storeChallenge(challenge: AuthChallenge): Promise<void>
async getAndDeleteChallenge(challengeId: string): Promise<AuthChallenge | null>

// Session lifecycle
async storeSession(session: AuthSession): Promise<void>
async getSession(token: string): Promise<AuthSession | null>
async deleteSession(token: string): Promise<void>
async deleteAllSessionsForAccount(accountId: string): Promise<number>

// Rate limiting
async checkRateLimit(ip: string, limit: number, windowSec: number): Promise<{
  allowed: boolean;
  remaining: number;
  retryAfterSec?: number;
}>
```

---

## 8. MCP Tool Authorization Middleware

### 8.1 Updated ServerContext

The `ServerContext` interface gains new auth-aware methods:

```typescript
// Updated src/mcp/tools/types.ts

export interface ServerContext {
  // ... existing fields ...

  /** Legacy shared-secret auth (kept for operator tier). */
  authToken: string | null;

  /**
   * Resolve an auth token to an identity.
   *
   * Token prefix determines the code path:
   *   "ses_..." -> Redis session lookup (user/admin tier)
   *   "op_..."  -> Legacy MCP_AUTH_TOKEN comparison (operator tier)
   *   undefined  -> Returns public tier identity
   *
   * Returns null on auth failure (caller should return errorResult).
   */
  resolveAuth: (token?: string) => Promise<AuthIdentity | null>;

  /**
   * Enforce a minimum tier for a tool.
   *
   * Returns an error ToolResult if the identity's tier is insufficient,
   * or null if authorized.
   */
  requireTier: (
    identity: AuthIdentity,
    minTier: AuthTier,
  ) => ToolResult | null;

  /**
   * Enforce that a user-tier identity can only act on their own account.
   *
   * For user tier: identity.userId must match targetUserId.
   * For admin tier: any userId is allowed.
   * For operator tier: any userId is allowed.
   *
   * Returns an error ToolResult if scoping fails, or null if authorized.
   */
  requireUserScope: (
    identity: AuthIdentity,
    targetUserId: string,
  ) => ToolResult | null;

  /** @deprecated Use resolveAuth + requireTier instead. */
  requireAuth: (providedToken?: string) => ToolResult | null;
}
```

### 8.2 Tier Hierarchy

```
operator > admin > user > public
```

A tool requiring `user` tier accepts `user`, `admin`, and `operator`
identities. The hierarchy is encoded as a simple numeric comparison:

```typescript
const TIER_LEVEL: Record<AuthTier, number> = {
  public: 0,
  user: 1,
  admin: 2,
  operator: 3,
};

function requireTier(identity: AuthIdentity, minTier: AuthTier): ToolResult | null {
  if (TIER_LEVEL[identity.tier] >= TIER_LEVEL[minTier]) return null;
  return errorResult(`Requires ${minTier} authorization. Current: ${identity.tier}.`);
}
```

### 8.3 Tool Registration Pattern (After Migration)

Example of how `multi_user_play` changes:

```typescript
// Before (shared secret)
server.tool(
  'multi_user_play',
  'Trigger a play session for a specific user or all eligible users.',
  {
    userId: z.string().optional(),
    auth_token: z.string().optional(),
  },
  async ({ userId, auth_token }) => {
    const authErr = requireAuth(auth_token);
    if (authErr) return authErr;
    // ... userId comes from the caller, no scoping enforcement
  }
);

// After (Hedera signature auth)
server.tool(
  'multi_user_play',
  'Trigger a play session for a specific user or all eligible users.',
  {
    userId: z.string().optional(),
    auth_token: z.string().optional(),
  },
  async ({ userId, auth_token }) => {
    const identity = await resolveAuth(auth_token);
    if (!identity) return errorResult('Authentication required.');

    const tierErr = requireTier(identity, 'user');
    if (tierErr) return tierErr;

    // For user tier: force userId to the authenticated user's ID.
    // For admin/operator: allow explicit userId or all-users.
    const effectiveUserId = identity.tier === 'user'
      ? identity.userId  // Always their own
      : (userId ?? undefined);

    if (identity.tier === 'user' && !identity.userId) {
      return errorResult('Account not registered. Call multi_user_register first.');
    }

    if (effectiveUserId) {
      const scopeErr = requireUserScope(identity, effectiveUserId);
      if (scopeErr) return scopeErr;
    }

    // ... proceed with effectiveUserId
  }
);
```

### 8.4 Auth Token Delivery in MCP

The MCP protocol does not have a native concept of "auth headers." For
stdio transport, there is no HTTP layer. For StreamableHTTPServerTransport,
the token rides in the HTTP `Authorization` header.

Two approaches are supported simultaneously:

1. **MCP tool parameter**: `auth_token` field on every tool (current
   approach). Maintained for backward compatibility and stdio transport.
2. **HTTP header**: `Authorization: Bearer ses_...` on the HTTP transport.
   The server extracts the token from the header and injects it into the
   tool execution context before the handler runs.

The middleware checks both sources, preferring the HTTP header:

```typescript
function extractAuthToken(request: IncomingMessage, toolArgs: any): string | undefined {
  // 1. HTTP Authorization header (preferred)
  const authHeader = request?.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // 2. Tool parameter (fallback for stdio)
  return toolArgs?.auth_token;
}
```

---

## 9. File-by-File Change List

### New Files

| File | Purpose |
|------|---------|
| `src/auth/types.ts` | All auth data models (section 3) |
| `src/auth/config.ts` | `loadAuthConfig()`, env var parsing |
| `src/auth/redis.ts` | Upstash Redis client singleton, challenge/session CRUD |
| `src/auth/challenge.ts` | `createChallenge()`, `buildChallengeMessage()` |
| `src/auth/verify.ts` | `verifyHederaSignature()`, unified Ed25519/ECDSA verification |
| `src/auth/session.ts` | `createSession()`, `resolveSession()`, `refreshSession()`, `revokeSession()` |
| `src/auth/middleware.ts` | `resolveAuth()`, `requireTier()`, `requireUserScope()`, tier hierarchy |
| `src/auth/routes.ts` | Express/http route handlers for `/auth/*` endpoints |
| `src/auth/index.ts` | Barrel export |
| `src/auth/__tests__/verify.test.ts` | Unit tests for signature verification |
| `src/auth/__tests__/middleware.test.ts` | Unit tests for tier enforcement and scoping |
| `src/auth/__tests__/challenge.test.ts` | Unit tests for challenge creation/expiry |

### Modified Files

| File | Changes |
|------|---------|
| `src/mcp/server.ts` | (1) Import `StreamableHTTPServerTransport` alongside `StdioServerTransport`. (2) Create HTTP server with `/auth/*` routes mounted. (3) Build `ServerContext` with new `resolveAuth`, `requireTier`, `requireUserScope` methods. (4) Detect transport mode from env/CLI flag. (5) Keep `requireAuth` as deprecated backward-compat shim. |
| `src/mcp/tools/types.ts` | Add `resolveAuth`, `requireTier`, `requireUserScope` to `ServerContext`. Import `AuthIdentity`, `AuthTier` from `src/auth/types.ts`. |
| `src/mcp/tools/multi-user.ts` | Replace every `requireAuth(auth_token)` call with the `resolveAuth` + `requireTier('user')` + `requireUserScope` pattern. Remove user-supplied `userId` for user-tier callers (force to `identity.userId`). `multi_user_register` becomes public tier (rate-limited). |
| `src/mcp/tools/operator.ts` | Replace `requireAuth` with `requireTier('operator')`. These tools are infrastructure-only. |
| `src/mcp/tools/single-user.ts` | Replace `requireAuth` with `requireTier('user')`. `agent_onboard` becomes public tier. |
| `src/hedera/mirror.ts` | Add `getAccountKey(accountId)` function. Add `MirrorAccountInfo` type. Add local 60s LRU cache for key lookups. |
| `src/custodial/MultiUserAgent.ts` | Add `getUserByAccountId(accountId: string)` method that queries `PersistentStore` for a user whose `hederaAccountId` matches. |
| `src/custodial/PersistentStore.ts` | Add `findUserByAccountId(accountId: string)` query method (iterate users, match `hederaAccountId`). |
| `package.json` | Add `@upstash/redis` dependency. |
| `.env.example` | Add `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ADMIN_ACCOUNTS`, `AUTH_SESSION_TTL_SEC`, `AUTH_CHALLENGE_TTL_SEC`. |

### Unchanged Files

| File | Reason |
|------|--------|
| `src/mcp/client.ts` | Outbound MCP client to the dApp; unrelated to agent auth. |
| `src/custodial/DepositWatcher.ts` | Deposit watching is internal; no auth needed. |
| `src/custodial/AccountingService.ts` | HCS-20 is internal infrastructure. |
| `src/agent/LottoAgent.ts` | Core agent logic; auth is at the MCP layer above. |

---

## 10. Security Considerations

### 10.1 Challenge Replay Prevention

Challenges are single-use: the verify endpoint atomically reads and
deletes the challenge from Redis. An attacker who intercepts a challenge
cannot replay it after the legitimate user verifies. The 5-minute TTL
bounds the window of exposure.

**Redis operation:** Use `GETDEL` (Redis 6.2+, supported by Upstash) to
atomically fetch and delete in one round-trip.

### 10.2 Session Token Entropy

Session tokens are 32 random bytes (256 bits of entropy) prefixed with
`ses_`. This provides ~2^256 possible tokens, making brute-force
infeasible. Tokens are compared using `timingSafeEqual` through the Redis
lookup (the Redis key itself is the token, so lookup is O(1) and
timing-safe by construction).

### 10.3 Public Key Trust

The public key is fetched from the Hedera mirror node at challenge time
and stored in the challenge record. At verification time, the stored key
is used (not re-fetched). This prevents a TOCTOU attack where an attacker
rotates the account's key between challenge and verify.

**Limitation:** If the account's key is rotated between challenge creation
and signature submission, the old key is used for verification. This is
the correct behavior (the user who requested the challenge must sign with
the key that was active at that time).

### 10.4 Multi-sig and Threshold Key Rejection

Accounts with `ProtobufEncoded` key types (threshold keys, key lists,
multi-sig) are rejected at challenge time with a clear error message. These
require multiple signatures and cannot be verified with a single
challenge-response. A future enhancement could support threshold keys
by requiring N-of-M signatures, but this is out of scope for v1.

### 10.5 User Scoping Enforcement

The most critical security property: a user-tier session can only operate
on the user's own data. The `userId` is resolved at session creation and
stored server-side. Tool handlers never trust a caller-supplied `userId`
for user-tier sessions.

```
Invariant: For tier === 'user', the effective userId is ALWAYS
           identity.userId, never a tool parameter.
```

Admin and operator tiers are exempt from this restriction (they can act
on any user).

### 10.6 Session Fixation Prevention

- Session tokens are generated server-side with `crypto.randomBytes(32)`.
- The client never influences the token value.
- On refresh, a completely new token is generated (the old one is deleted).

### 10.7 Rate Limiting

Challenge creation is rate-limited per IP address to prevent nonce
flooding (exhausting Redis storage or mirror node bandwidth). Default:
10 challenges per 5-minute window per IP.

Redis key: `{prefix}ratelimit:{ip}` with TTL = window size.
Increment with `INCR` + `EXPIRE` (only set TTL on first increment).

### 10.8 Transport Security

- HTTP transport MUST use TLS (HTTPS) in production. The session token
  travels in the `Authorization` header and must be encrypted in transit.
- The `/auth/*` endpoints should set `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY` headers.
- CORS should be restricted to the Vercel frontend origin.

### 10.9 Redis Security

- Upstash Redis REST API uses HTTPS with a per-database token.
- The `UPSTASH_REDIS_REST_TOKEN` is a secret and must not be exposed to
  clients.
- All Redis keys have TTLs to prevent unbounded growth.
- No sensitive data (private keys, raw signatures) is stored in Redis.
  Stored data: account IDs, public keys (already public), session metadata.

### 10.10 Operator Token Backward Compatibility

The `MCP_AUTH_TOKEN` remains for operator-tier authentication. During the
migration period, if a tool receives a token that does not start with
`ses_`, it falls through to the legacy hash-comparison logic. After
migration, non-`ses_` tokens are only accepted for operator-tier tools.

### 10.11 Concurrent Session Limit

Each account is limited to 5 concurrent sessions (tracked via the
`account-sessions` Redis set). When a new session would exceed the limit,
the oldest session is revoked. This prevents an attacker who compromises
a session token from creating unlimited sessions.

---

## 11. Migration Path

### Phase 1: Infrastructure (non-breaking)

1. Add `@upstash/redis` dependency.
2. Create all `src/auth/` files.
3. Add `getAccountKey()` to `src/hedera/mirror.ts`.
4. Add `findUserByAccountId()` to `PersistentStore`.
5. Deploy Upstash Redis database (testnet first).
6. Add new env vars to `.env.example`.

**Verification:** Unit tests for signature verification, challenge
creation/expiry, tier enforcement. No production behavior changes.

### Phase 2: HTTP Transport + Auth Endpoints (opt-in)

1. Add HTTP server creation to `src/mcp/server.ts`, gated behind
   `--http` CLI flag or `MCP_TRANSPORT=http` env var.
2. Mount `/auth/*` routes on the HTTP server.
3. Mount `StreamableHTTPServerTransport` on `/mcp` path.
4. Both stdio and HTTP transports available simultaneously during
   migration.

**Verification:** Manual testing with curl against `/auth/challenge` and
`/auth/verify`. Verify session tokens work for MCP tool calls over HTTP.

### Phase 3: Middleware Migration (backward-compatible)

1. Update `ServerContext` with new auth methods.
2. Update tool handlers one file at a time:
   - `operator.ts` first (smallest, most isolated).
   - `single-user.ts` second.
   - `multi-user.ts` last (most complex scoping).
3. Each tool handler checks for `ses_` prefix first, falls back to
   legacy `requireAuth` if not present.
4. Add deprecation warnings when legacy auth is used in multi-user mode.

**Verification:** Existing MCP_AUTH_TOKEN users continue to work. New
session-token users also work. Both code paths are tested.

### Phase 4: Frontend (WalletConnect Page)

1. Build Vercel page at `/auth` with WalletConnect integration.
2. Page flow: Connect wallet -> Request challenge -> Sign -> Receive
   session token -> Store in localStorage -> Redirect to agent UI.
3. Agent UI passes session token in MCP tool calls or HTTP headers.

**Verification:** End-to-end flow with HashPack/Blade wallet on testnet.

### Phase 5: Deprecation of Shared Secret for User/Admin

1. Log warnings when `MCP_AUTH_TOKEN` is used for user-tier tools.
2. After 30-day deprecation period, remove `auth_token` parameter from
   user/admin tools (operator tools keep it).
3. Remove `requireAuth` from `ServerContext` (breaking change, bumps
   minor version per 0.x convention).

**Verification:** Confirm no user-tier callers still use the legacy token.
Operator-tier automation continues to work with `MCP_AUTH_TOKEN`.

---

## Appendix A: Environment Variables

```bash
# ── Auth (new) ─────────────────────────────────────────────
UPSTASH_REDIS_REST_URL=https://xyz.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXyz...
ADMIN_ACCOUNTS=0.0.12345,0.0.67890

# Optional tuning (defaults shown)
AUTH_CHALLENGE_TTL_SEC=300
AUTH_SESSION_TTL_SEC=3600
AUTH_MAX_REFRESH=24
AUTH_MIN_REFRESH_AGE=0.5
AUTH_CHALLENGE_RATE_LIMIT=10
AUTH_CHALLENGE_RATE_WINDOW_SEC=300
AUTH_REDIS_PREFIX=lla:
MCP_TRANSPORT=stdio  # or "http"
HTTP_PORT=3001

# ── Existing (unchanged) ──────────────────────────────────
MCP_AUTH_TOKEN=...   # Retained for operator tier only
```

## Appendix B: Dependency Additions

```json
{
  "dependencies": {
    "@upstash/redis": "^1.34.0"
  }
}
```

No other new dependencies are needed. The Hedera SDK (`@hashgraph/sdk`)
already provides `PublicKey.verify()` for both Ed25519 and ECDSA. The MCP
SDK already provides `StreamableHTTPServerTransport`. Node.js built-in
`crypto` provides `randomBytes`, `createHash`, and `timingSafeEqual`.

## Appendix C: Tool-to-Tier Mapping (Complete)

```
Tool Name                    Tier Required   Scoping
---------------------------  -------------   --------------------------------
multi_user_register          public          Rate-limited by IP
agent_onboard                public          Rate-limited by IP
multi_user_status            admin           Returns all users (admin only)
multi_user_deposit_info      user            Scoped to identity.userId
multi_user_play              user            Scoped to identity.userId
multi_user_withdraw          user            Scoped to identity.userId
multi_user_deregister        user            Scoped to identity.userId
multi_user_play_history      user            Scoped to identity.userId
agent_play                   user            Single-user mode (owner only)
agent_status                 user            Single-user mode (owner only)
agent_wallet_info            user            Single-user mode (owner only)
agent_set_strategy           user            Single-user mode (owner only)
agent_transfer_prizes        user            Single-user mode (owner only)
agent_withdraw               user            Single-user mode (owner only)
agent_stop                   user            Single-user mode (owner only)
agent_audit                  user            Single-user mode (owner only)
operator_balance             operator        No scoping (platform-wide)
operator_withdraw_fees       operator        No scoping (platform-wide)
operator_reconcile           operator        No scoping (platform-wide)
operator_health              operator        No scoping (platform-wide)
```
