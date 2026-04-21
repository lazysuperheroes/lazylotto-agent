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
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { HEDERA_DEFAULTS } from '~/config/defaults';
import { parseAuditTopic, type RawTopicMessage } from '~/custodial/hcs20-reader';
import type { NormalizedSession } from '~/custodial/hcs20-v2';

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
    | 'refund'
    | 'unknown';
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
  /**
   * Structured fields parsed from a `prize_recovery` HCS-20 message.
   * Populated only when type === 'prize_recovery'. Same shape as the
   * admin route — kept duplicated to avoid cross-route imports.
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
  // prize_recovery messages identify the user via top-level `user`
  // (and the agent via top-level `agent`). Match against either so
  // user-filtered audit views surface their own recovery actions.
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
function classifyType(payload: Record<string, unknown>, accountId: string): AuditEntry['type'] {
  const op = payload.op as string | undefined;
  const memo = String(payload.memo ?? '');

  if (op === 'deploy') return 'deploy';
  if (op === 'prize_recovery') return 'prize_recovery';
  if (op === 'refund') return 'refund';

  // v2 play-session sequence ops. Classified as 'play' so the client
  // hides them from the raw timeline when v2 SessionCards render
  // (see app/audit/page.tsx nonPlayEntries filter). Without this they
  // surface as "Unknown" cards alongside the session card.
  if (
    op === 'play_session_open' ||
    op === 'play_pool_result' ||
    op === 'play_session_close' ||
    op === 'play_session_aborted'
  ) {
    return 'play';
  }

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

  // Extract structured fields from prize_recovery messages so the
  // audit page can render them. Mirror of the admin route's parser.
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
    // Audit hits the mirror node — tighter limit
    if (!(await checkRateLimit({ request, action: 'user-audit', limit: 20, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

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
    // Per-token accumulators. Deposit/rake/withdrawal writers stamp
    // payload.token with the actual asset (HBAR or a Hedera token id
    // like 0.0.8011209); summing by token keeps the ribbon honest
    // when mixed-token deposits eventually land. payload.tick
    // (LLCRED) is the HCS-20 ledger tick — not a token identifier
    // — so it is deliberately NOT used here.
    const depositedByToken: Record<string, number> = {};
    const rakeByToken: Record<string, number> = {};
    const withdrawnByToken: Record<string, number> = {};
    let totalBurned = 0;
    let totalWon = 0;

    const tokenOf = (payload: Record<string, unknown>): string => {
      const t = String(payload.token ?? 'HBAR');
      if (!t || t.toUpperCase() === 'HBAR') return 'HBAR';
      return t.startsWith('0.0.') ? t : t.toUpperCase();
    };

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
          // Aggregate prize value into the summary so users can see
          // wins alongside spend, not buried inside session cards.
          totalWon += session.totalPrizeValue ?? 0;
        }
      }

      entries.push(entry);

      // Accumulate summary
      const amt = Number(entry.amount) || 0;
      const token = tokenOf(payload);

      switch (entry.type) {
        case 'deposit':
          depositedByToken[token] = (depositedByToken[token] ?? 0) + amt;
          break;
        case 'rake':
          rakeByToken[token] = (rakeByToken[token] ?? 0) + amt;
          break;
        // 'play' is handled below from the v2 reader's normalized
        // sessions instead of the in-loop accumulator. The legacy
        // accumulator only knew about op:'batch' (v1) and silently
        // skipped v2 ops, causing the audit summary to undercount
        // every v2 play session. The reader correctly aggregates
        // both shapes via its v1 fallback path.
        case 'withdrawal':
          withdrawnByToken[token] = (withdrawnByToken[token] ?? 0) + amt;
          break;
        // A refund inverts a deposit (same token, same amount,
        // opposite direction). Subtract from depositedByToken so the
        // net-deposited figure reflects reality and balanceLeft math
        // stays consistent — otherwise a refunded deposit would
        // inflate the "Deposited" ribbon forever.
        case 'refund':
          depositedByToken[token] = (depositedByToken[token] ?? 0) - amt;
          break;
      }
    }

    // Build the v2 normalized sessions list. The reader handles
    // both v1 batch messages and v2 sequence messages, producing a
    // single uniform NormalizedSession[] that the dashboard can
    // render as session cards. Filter to messages that involve
    // this user so the reader's per-session math reflects only
    // their activity.
    const userTopicMessages: RawTopicMessage[] = [];
    for (const msg of allMessages) {
      const { seq, timestamp, payload } = decodeMessage(msg);
      if (!involvesAccount(payload, hederaAccountId)) continue;
      userTopicMessages.push({ sequence: seq, timestamp, payload });
    }
    let v2Sessions: NormalizedSession[] = [];
    let wireSchemaStats: { v1Messages: number; v2Messages: number; unknownMessages: number } = {
      v1Messages: 0,
      v2Messages: 0,
      unknownMessages: 0,
    };
    try {
      const parsed = await parseAuditTopic(userTopicMessages);
      v2Sessions = parsed.sessions;
      wireSchemaStats = {
        v1Messages: parsed.stats.v1Messages,
        v2Messages: parsed.stats.v2Messages,
        unknownMessages: parsed.stats.unknownMessages,
      };
    } catch (parseErr) {
      console.warn('[user/audit] v2 reader failed:', parseErr);
    }

    // Aggregate per-token totals from the reader's normalized
    // sessions. See the matching block in
    // app/api/admin/audit/route.ts for the full rationale.
    const spentByToken: Record<string, number> = {};
    const wonByToken: Record<string, number> = {};
    let totalNftWins = 0;
    for (const session of v2Sessions) {
      for (const [rawToken, amt] of Object.entries(session.totalSpentByToken)) {
        const token = rawToken === 'hbar' ? 'HBAR' : rawToken;
        spentByToken[token] = (spentByToken[token] ?? 0) + amt;
      }
      for (const [rawToken, amt] of Object.entries(session.totalPrizeValueByToken)) {
        const token = rawToken === 'hbar' ? 'HBAR' : rawToken;
        wonByToken[token] = (wonByToken[token] ?? 0) + amt;
      }
      totalNftWins += session.totalNftCount;
    }
    totalBurned = spentByToken['HBAR'] ?? 0;
    totalWon = wonByToken['HBAR'] ?? 0;
    for (const token of Object.keys(spentByToken)) {
      spentByToken[token] = Math.round(spentByToken[token]! * 10000) / 10000;
    }
    for (const token of Object.keys(wonByToken)) {
      wonByToken[token] = Math.round(wonByToken[token]! * 10000) / 10000;
    }
    for (const token of Object.keys(depositedByToken)) {
      depositedByToken[token] = Math.round(depositedByToken[token]! * 10000) / 10000;
    }
    for (const token of Object.keys(rakeByToken)) {
      rakeByToken[token] = Math.round(rakeByToken[token]! * 10000) / 10000;
    }
    for (const token of Object.keys(withdrawnByToken)) {
      withdrawnByToken[token] = Math.round(withdrawnByToken[token]! * 10000) / 10000;
    }

    // Top-level totals are the HBAR slice of the per-token maps. The
    // ribbon labels them "HBAR" explicitly; non-HBAR activity surfaces
    // in the per-token row below the ribbon.
    const totalDeposited = depositedByToken['HBAR'] ?? 0;
    const totalRake = rakeByToken['HBAR'] ?? 0;
    const totalWithdrawn = withdrawnByToken['HBAR'] ?? 0;

    // `balanceLeft` is the user's remaining play money in the agent's
    // internal ledger (NOT a profit/loss net). Prizes never enter this
    // ledger because winnings flow directly to the user's EOA via the
    // contract's transferPendingPrizes call. The previous "Net" label
    // confused this with P/L; surfaced as balanceLeft + totalWon as
    // a separate dimension on the audit page. This is the HBAR slice
    // — a per-token balanceLeftByToken is possible but not needed
    // until mixed-token deposits exist.
    const balanceLeft = totalDeposited - totalRake - totalBurned - totalWithdrawn;

    const explorerBase = network === 'mainnet'
      ? 'https://hashscan.io/mainnet'
      : 'https://hashscan.io/testnet';

    return NextResponse.json(
      {
        topicId,
        network,
        explorerUrl: `${explorerBase}/topic/${topicId}`,
        entries,
        sessions: v2Sessions,
        wireSchema: wireSchemaStats,
        summary: {
          totalDeposited: Math.round(totalDeposited * 100) / 100,
          totalRake: Math.round(totalRake * 100) / 100,
          totalBurned: Math.round(totalBurned * 100) / 100,
          totalWithdrawn: Math.round(totalWithdrawn * 100) / 100,
          totalWon: Math.round(totalWon * 100) / 100,
          balanceLeft: Math.round(balanceLeft * 100) / 100,
          spentByToken,
          wonByToken,
          depositedByToken,
          rakeByToken,
          withdrawnByToken,
          totalNftWins,
          // Legacy field for any consumer that hasn't been updated.
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
