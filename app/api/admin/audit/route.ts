/**
 * GET /api/admin/audit
 *
 * Returns ALL HCS-20 on-chain accounting records (unfiltered), with an
 * optional `?user=0.0.XXXX` query param to filter by a specific user.
 *
 * Requires 'admin' tier auth.
 *
 * Response shape matches the user audit route, with additional fields:
 *   - filteredBy: the account ID filter applied (or null for all)
 *   - users: array of all unique account IDs seen in the messages
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { HEDERA_DEFAULTS } from '~/config/defaults';
import type { PlaySessionResult } from '~/custodial/types';

// ---------------------------------------------------------------------------
// Mirror node types
// ---------------------------------------------------------------------------

interface TopicMessage {
  sequence_number: number;
  consensus_timestamp: string;
  message: string; // base64
}

interface TopicMessagesResponse {
  messages: TopicMessage[];
  links?: { next?: string };
}

// ---------------------------------------------------------------------------
// Decoded entry shape returned to the client
// ---------------------------------------------------------------------------

interface AuditEntry {
  sequence: number;
  timestamp: string;
  type:
    | 'deposit'
    | 'rake'
    | 'play'
    | 'withdrawal'
    | 'operator_withdrawal'
    | 'deploy'
    | 'prize_recovery'
    | 'unknown';
  operation: string;
  amount?: string;
  token?: string;
  from?: string;
  to?: string;
  memo?: string;
  sessionId?: string;
  burns?: { amount: string; memo: string }[];
  /**
   * Play session results enriched from the local store when sessionId
   * matches. Mirror node messages only contain the burn sub-operations
   * (per-pool entry buys), so without this enrichment a play entry has
   * no cost total, no win count, and no prize details — which makes
   * walking through the audit impossible. We join HCS-20 messages
   * back to PlaySessionResult records via sessionId to fill in the
   * gaps.
   */
  totalWins?: number;
  totalSpent?: number;
  poolResults?: {
    poolName: string;
    wins: number;
    prizeDetails: unknown[];
  }[];
  /**
   * Structured fields parsed from a `prize_recovery` HCS-20 message.
   * Populated only when type === 'prize_recovery'.
   */
  recovery?: {
    userAccountId: string;
    agentAccountId: string;
    prizesTransferred: number;
    prizesByToken?: Record<string, number>;
    contractTxId: string;
    reason: string;
    performedBy: string;
    affectedSessions?: string[];
    attempts?: number;
    gasUsed?: number;
  };
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers (duplicated from user audit route for Next.js API isolation)
// ---------------------------------------------------------------------------

type Network = 'testnet' | 'mainnet';

function getNetwork(): Network {
  return (process.env.HEDERA_NETWORK ?? 'testnet') as Network;
}

function getMirrorBase(): string {
  const network = getNetwork();
  return HEDERA_DEFAULTS.mirrorNodeUrl[network] ?? HEDERA_DEFAULTS.mirrorNodeUrl.testnet;
}

function decodeMessage(msg: TopicMessage): { seq: number; timestamp: string; payload: Record<string, unknown> } {
  const raw = Buffer.from(msg.message, 'base64').toString('utf-8');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { _raw: raw };
  }

  // Convert consensus timestamp (seconds.nanoseconds) to ISO string
  const seconds = Number(msg.consensus_timestamp.split('.')[0]);
  const iso = new Date(seconds * 1000).toISOString();

  return { seq: msg.sequence_number, timestamp: iso, payload };
}

/** Check whether a payload (or sub-operation) involves a given account ID. */
function involvesAccount(payload: Record<string, unknown>, accountId: string): boolean {
  const to = String(payload.to ?? '');
  const from = String(payload.from ?? '');
  const memo = String(payload.memo ?? '');
  // prize_recovery messages identify the user via top-level `user`
  // and the agent via top-level `agent`. Match against either so
  // user-filtered admin views surface their own recovery actions.
  const user = String(payload.user ?? '');
  const agent = String(payload.agent ?? '');

  if (
    to === accountId ||
    from === accountId ||
    user === accountId ||
    agent === accountId ||
    memo.includes(accountId)
  ) {
    return true;
  }

  // Check batch sub-operations
  if (payload.op === 'batch' && Array.isArray(payload.operations)) {
    for (const sub of payload.operations as Record<string, unknown>[]) {
      if (involvesAccount(sub, accountId)) return true;
    }
  }

  return false;
}

/** Classify an HCS-20 operation into a user-friendly type. */
function classifyType(payload: Record<string, unknown>): AuditEntry['type'] {
  const op = payload.op as string | undefined;
  const memo = String(payload.memo ?? '');

  if (op === 'deploy') return 'deploy';
  if (op === 'prize_recovery') return 'prize_recovery';

  if (op === 'mint') {
    return 'deposit';
  }

  if (op === 'transfer') {
    if (memo === 'rake' || memo.startsWith('rake')) return 'rake';
    if (memo.startsWith('operator_withdrawal') || memo.startsWith('operator-withdrawal')) return 'operator_withdrawal';
    return 'rake'; // transfers in the accounting system are typically rake
  }

  if (op === 'burn') {
    const m = memo.toLowerCase();
    if (m.startsWith('withdraw') || m.includes('withdrawal')) return 'withdrawal';
    if (m.startsWith('play:') || m.startsWith('play-')) return 'play';
    return 'play'; // burns are typically play spending
  }

  if (op === 'batch') {
    // Check sub-operations to determine type
    const ops = (payload.operations as Record<string, unknown>[]) ?? [];
    const hasBurns = ops.some((o) => o.op === 'burn');
    if (hasBurns) return 'play';
    return 'unknown';
  }

  return 'unknown';
}

/** Convert a decoded payload into a client-facing AuditEntry. */
function toAuditEntry(seq: number, timestamp: string, payload: Record<string, unknown>): AuditEntry {
  const op = String(payload.op ?? 'unknown');
  const type = classifyType(payload);

  const entry: AuditEntry = {
    sequence: seq,
    timestamp,
    type,
    operation: op,
    raw: payload,
  };

  if (payload.amt !== undefined) entry.amount = String(payload.amt);
  if (payload.tick !== undefined) entry.token = String(payload.tick);
  if (payload.to !== undefined) entry.to = String(payload.to);
  if (payload.from !== undefined) entry.from = String(payload.from);
  if (payload.memo !== undefined) entry.memo = String(payload.memo);
  if (payload.sessionId !== undefined) entry.sessionId = String(payload.sessionId);

  // Extract structured fields from prize_recovery messages so the
  // audit page can render the recovery details (who, what, why, how
  // many attempts, contract tx ID) without re-parsing raw payload.
  if (op === 'prize_recovery') {
    entry.recovery = {
      userAccountId: String(payload.user ?? ''),
      agentAccountId: String(payload.agent ?? ''),
      prizesTransferred: Number(payload.prizesTransferred ?? 0),
      contractTxId: String(payload.contractTxId ?? ''),
      reason: String(payload.reason ?? ''),
      performedBy: String(payload.performedBy ?? ''),
      ...(payload.prizesByToken
        ? { prizesByToken: payload.prizesByToken as Record<string, number> }
        : {}),
      ...(Array.isArray(payload.affectedSessions)
        ? { affectedSessions: payload.affectedSessions as string[] }
        : {}),
      ...(payload.attempts !== undefined ? { attempts: Number(payload.attempts) } : {}),
      ...(payload.gasUsed !== undefined ? { gasUsed: Number(payload.gasUsed) } : {}),
    };
  }

  // For batch operations, extract burn sub-entries
  if (op === 'batch' && Array.isArray(payload.operations)) {
    const ops = payload.operations as Record<string, unknown>[];
    entry.burns = ops
      .filter((o) => o.op === 'burn')
      .map((o) => ({
        amount: String(o.amt ?? '0'),
        memo: String(o.memo ?? ''),
      }));
  }

  return entry;
}

/** Extract all unique account IDs referenced in a payload. */
function extractAccountIds(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const hederaIdPattern = /^0\.0\.\d+$/;

  const to = String(payload.to ?? '');
  const from = String(payload.from ?? '');
  const user = String(payload.user ?? '');
  const agent = String(payload.agent ?? '');

  if (hederaIdPattern.test(to)) ids.add(to);
  if (hederaIdPattern.test(from)) ids.add(from);
  if (hederaIdPattern.test(user)) ids.add(user);
  if (hederaIdPattern.test(agent)) ids.add(agent);

  // Check batch sub-operations
  if (payload.op === 'batch' && Array.isArray(payload.operations)) {
    for (const sub of payload.operations as Record<string, unknown>[]) {
      for (const id of extractAccountIds(sub)) {
        ids.add(id);
      }
    }
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(request: Request) {
  try {
    // Mirror node topic scan — tighter limit
    if (!(await checkRateLimit({ request, action: 'admin-audit', limit: 20, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const topicId = process.env.HCS20_TOPIC_ID;

    if (!topicId) {
      return NextResponse.json(
        {
          topicId: null,
          filteredBy: null,
          users: [],
          entries: [],
          summary: { totalDeposited: 0, totalRake: 0, totalBurned: 0, totalWithdrawn: 0, netBalance: 0 },
          message: 'On-chain accounting not configured',
        },
        { headers: CORS_HEADERS },
      );
    }

    // Parse optional user filter from query params
    const url = new URL(request.url);
    const userFilter = url.searchParams.get('user') ?? null;

    const network = getNetwork();
    const mirrorBase = getMirrorBase();

    // Fetch all topic messages with pagination
    const allMessages: TopicMessage[] = [];
    let nextPath: string | null = `/topics/${topicId}/messages?limit=100&order=asc`;

    while (nextPath) {
      const fetchUrl = nextPath.startsWith('/api/v1')
        ? `${mirrorBase.replace(/\/api\/v1$/, '')}${nextPath}`
        : `${mirrorBase}${nextPath}`;

      const res = await fetch(fetchUrl);
      if (!res.ok) {
        if (res.status === 404) {
          return NextResponse.json(
            {
              topicId,
              network,
              filteredBy: userFilter,
              users: [],
              entries: [],
              summary: { totalDeposited: 0, totalRake: 0, totalBurned: 0, totalWithdrawn: 0, netBalance: 0 },
              message: `Topic ${topicId} not found on ${network}`,
            },
            { headers: CORS_HEADERS },
          );
        }
        throw new Error(`Mirror node returned ${res.status}`);
      }

      const data = (await res.json()) as TopicMessagesResponse;
      allMessages.push(...(data.messages ?? []));
      nextPath = data.links?.next ?? null;
    }

    // Decode all messages and collect unique account IDs
    const allAccountIds = new Set<string>();
    const decoded: { seq: number; timestamp: string; payload: Record<string, unknown> }[] = [];

    for (const msg of allMessages) {
      const { seq, timestamp, payload } = decodeMessage(msg);
      decoded.push({ seq, timestamp, payload });

      for (const id of extractAccountIds(payload)) {
        allAccountIds.add(id);
      }
    }

    // Build a sessionId → PlaySessionResult map so we can enrich each
    // play audit entry with cost/wins/prizes. The HCS-20 batch message
    // for a play only has the per-pool burn sub-ops, NOT the rich
    // session metadata — that lives in the local store keyed by
    // sessionId.
    //
    // Two strategies:
    //   1. User filter active → resolve that user, refresh just their
    //      plays, build the map from one user's sessions. Cheap.
    //   2. No filter → iterate all users and union their sessions.
    //      Slower (one Redis fetch per user) but the only way to
    //      enrich the unfiltered admin view.
    //
    // Failure here is non-fatal: if the store lookup fails, plays
    // just render unenriched (the way they did before this fix).
    const store = await getStore();
    await store.refreshUserIndex();
    const sessionMap = new Map<string, PlaySessionResult>();
    try {
      if (userFilter) {
        const filteredUser = store.getUserByAccountId(userFilter);
        if (filteredUser) {
          await store.refreshPlaysForUser(filteredUser.userId);
          for (const s of store.getPlaySessionsForUser(filteredUser.userId)) {
            sessionMap.set(s.sessionId, s);
          }
        }
      } else {
        for (const u of store.getAllUsers()) {
          await store.refreshPlaysForUser(u.userId);
          for (const s of store.getPlaySessionsForUser(u.userId)) {
            sessionMap.set(s.sessionId, s);
          }
        }
      }
    } catch (err) {
      console.warn('[admin/audit] session enrichment failed:', err);
    }

    // Build entries — optionally filtered by user
    const entries: AuditEntry[] = [];
    let totalDeposited = 0;
    let totalRake = 0;
    let totalBurned = 0;
    let totalWithdrawn = 0;
    let totalWon = 0;

    for (const { seq, timestamp, payload } of decoded) {
      // If user filter is active, skip messages that don't involve that user
      if (userFilter && !involvesAccount(payload, userFilter)) continue;

      const entry = toAuditEntry(seq, timestamp, payload);

      // Enrich play entries with the matching session record so the
      // dashboard can show per-pool wins, prize NFT cards, and the
      // total spent vs won. Mirrors the user audit endpoint's
      // enrichment block (app/api/user/audit/route.ts:298-313).
      if (entry.type === 'play' && entry.sessionId) {
        const session = sessionMap.get(entry.sessionId);
        if (session) {
          entry.totalWins = session.totalWins;
          entry.totalSpent = session.totalSpent;
          entry.poolResults = session.poolResults
            .filter((p) => p.wins > 0)
            .map((p) => ({
              poolName: p.poolName,
              wins: p.wins,
              prizeDetails: p.prizeDetails,
            }));
          // Aggregate prize value into the summary so users can see
          // wins alongside spend, not buried inside session cards.
          totalWon += session.totalPrizeValue ?? 0;
        }
      }

      entries.push(entry);

      // Accumulate summary
      const amt = Number(entry.amount) || 0;

      switch (entry.type) {
        case 'deposit':
          totalDeposited += amt;
          break;
        case 'rake':
          totalRake += amt;
          break;
        case 'play':
          if (entry.burns && entry.burns.length > 0) {
            totalBurned += entry.burns.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
          } else {
            totalBurned += amt;
          }
          break;
        case 'withdrawal':
          totalWithdrawn += amt;
          break;
      }
    }

    // `balanceLeft` is the user's remaining play money in the agent's
    // internal ledger (NOT a profit/loss net). Prizes never enter this
    // ledger because winnings flow directly to the user's EOA via the
    // contract's transferPendingPrizes call. The previous "Net" label
    // confused this with P/L; the field is now explicitly named
    // balanceLeft and the audit page surfaces totalWon as a separate
    // dimension. See user feedback in commit history.
    const balanceLeft = totalDeposited - totalRake - totalBurned - totalWithdrawn;

    const explorerBase = network === 'mainnet'
      ? 'https://hashscan.io/mainnet'
      : 'https://hashscan.io/testnet';

    // Sort users list for stable output
    const users = Array.from(allAccountIds).sort();

    return NextResponse.json(
      {
        topicId,
        network,
        explorerUrl: `${explorerBase}/topic/${topicId}`,
        filteredBy: userFilter,
        users,
        entries,
        summary: {
          totalDeposited: Math.round(totalDeposited * 100) / 100,
          totalRake: Math.round(totalRake * 100) / 100,
          totalBurned: Math.round(totalBurned * 100) / 100,
          totalWithdrawn: Math.round(totalWithdrawn * 100) / 100,
          totalWon: Math.round(totalWon * 100) / 100,
          balanceLeft: Math.round(balanceLeft * 100) / 100,
          // Legacy field for any consumer that hasn't been updated.
          // Removed in a future PR after the dashboard cuts over.
          netBalance: Math.round(balanceLeft * 100) / 100,
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
