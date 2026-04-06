/**
 * GET /api/user/audit
 *
 * Returns the authenticated user's HCS-20 on-chain accounting records.
 * Reads topic messages from the Hedera mirror node, decodes them, and
 * filters for operations that involve this user's Hedera account ID.
 *
 * Requires 'user' tier auth.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { HEDERA_DEFAULTS } from '~/config/defaults';

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
  type: 'deposit' | 'rake' | 'play' | 'withdrawal' | 'operator_withdrawal' | 'deploy' | 'unknown';
  operation: string;
  amount?: string;
  token?: string;
  from?: string;
  to?: string;
  memo?: string;
  sessionId?: string;
  burns?: { amount: string; memo: string }[];
  /** Play session results (enriched from store when sessionId matches) */
  totalWins?: number;
  totalSpent?: number;
  /** Pool results with raw PrizeDetail[]. Client lazily enriches via enrich-nfts. */
  poolResults?: {
    poolName: string;
    wins: number;
    prizeDetails: unknown[];
  }[];
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
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

  if (to === accountId || from === accountId || memo.includes(accountId)) {
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
function classifyType(payload: Record<string, unknown>, accountId: string): AuditEntry['type'] {
  const op = payload.op as string | undefined;
  const memo = String(payload.memo ?? '');

  if (op === 'deploy') return 'deploy';

  if (op === 'mint') {
    // Mints to this user are deposits
    if (String(payload.to) === accountId) return 'deposit';
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
function toAuditEntry(seq: number, timestamp: string, payload: Record<string, unknown>, accountId: string): AuditEntry {
  const op = String(payload.op ?? 'unknown');
  const type = classifyType(payload, accountId);

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
    const auth = await requireTier(request, 'user');
    if (isErrorResponse(auth)) return auth;

    const store = await getStore();
    const accountId = auth.accountId;

    // Refresh user index (so recently-registered accounts are resolvable)
    await store.refreshUserIndex();

    // Resolve user
    let user = store.getUserByAccountId(accountId);

    if (!user) {
      const allUsers = store.getAllUsers();
      user = allUsers.find(
        (u) => u.eoaAddress.toLowerCase() === accountId.toLowerCase(),
      );
    }

    if (!user) {
      return NextResponse.json(
        { error: 'User not found for this account' },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const topicId = process.env.HCS20_TOPIC_ID;

    if (!topicId) {
      return NextResponse.json(
        {
          topicId: null,
          entries: [],
          summary: { totalDeposited: 0, totalRake: 0, totalBurned: 0, totalWithdrawn: 0, netBalance: 0 },
          message: 'On-chain accounting not configured',
        },
        { headers: CORS_HEADERS },
      );
    }

    const network = getNetwork();
    const mirrorBase = getMirrorBase();
    const hederaAccountId = user.hederaAccountId;

    // Fetch all topic messages with pagination
    const allMessages: TopicMessage[] = [];
    let nextPath: string | null = `/topics/${topicId}/messages?limit=100&order=asc`;

    while (nextPath) {
      const url = nextPath.startsWith('/api/v1')
        ? `${mirrorBase.replace(/\/api\/v1$/, '')}${nextPath}`
        : `${mirrorBase}${nextPath}`;

      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          return NextResponse.json(
            {
              topicId,
              network,
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

    // Load play sessions for enriching play entries with win data.
    // Refresh just this user's plays so we see recent wins.
    await store.refreshPlaysForUser(user.userId);
    const playSessions = store.getPlaySessionsForUser(user.userId);
    const sessionMap = new Map(playSessions.map(s => [s.sessionId, s]));

    // Decode, filter, and transform
    const entries: AuditEntry[] = [];
    let totalDeposited = 0;
    let totalRake = 0;
    let totalBurned = 0;
    let totalWithdrawn = 0;

    for (const msg of allMessages) {
      const { seq, timestamp, payload } = decodeMessage(msg);

      if (!involvesAccount(payload, hederaAccountId)) continue;

      const entry = toAuditEntry(seq, timestamp, payload, hederaAccountId);

      // Enrich play entries with win results from the store.
      // Prize NFT display metadata (images, badges) is lazy-loaded on the
      // client via /api/user/enrich-nfts to keep this response fast.
      if (entry.type === 'play' && entry.sessionId) {
        const session = sessionMap.get(entry.sessionId);
        if (session) {
          entry.totalWins = session.totalWins;
          entry.totalSpent = session.totalSpent;
          entry.poolResults = session.poolResults
            .filter(p => p.wins > 0)
            .map(p => ({
              poolName: p.poolName,
              wins: p.wins,
              prizeDetails: p.prizeDetails,
            }));
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

    const netBalance = totalDeposited - totalRake - totalBurned - totalWithdrawn;

    const explorerBase = network === 'mainnet'
      ? 'https://hashscan.io/mainnet'
      : 'https://hashscan.io/testnet';

    return NextResponse.json(
      {
        topicId,
        network,
        explorerUrl: `${explorerBase}/topic/${topicId}`,
        entries,
        summary: {
          totalDeposited: Math.round(totalDeposited * 100) / 100,
          totalRake: Math.round(totalRake * 100) / 100,
          totalBurned: Math.round(totalBurned * 100) / 100,
          totalWithdrawn: Math.round(totalWithdrawn * 100) / 100,
          netBalance: Math.round(netBalance * 100) / 100,
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
