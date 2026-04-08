/**
 * GET /api/admin/monitoring
 *
 * Operator monitoring endpoint that derives daily aggregates
 * (TVL trend, deposit velocity, play velocity, active users)
 * from the HCS-20 audit topic. No new snapshot tables — pulls
 * the topic on demand and bins events by UTC day.
 *
 * Returns:
 *   {
 *     days: [
 *       {
 *         date: "2026-04-08",
 *         deposits: { count, totalHbar },
 *         plays:    { count, totalHbar },
 *         wins:     { count, totalHbar, nftCount },
 *         activeUsers: number  // unique accounts with any activity
 *       },
 *       ...
 *     ],
 *     summary: {
 *       totalDays: number,
 *       activeUsersLast7d: number,
 *       activeUsersLast30d: number,
 *       depositVelocity7d: number,  // avg deposits per day
 *       playVelocity7d: number       // avg plays per day
 *     }
 *   }
 *
 * Requires 'admin' tier auth. Cached for 60s in the response
 * headers because mirror node walks are not cheap.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { HEDERA_DEFAULTS } from '~/config/defaults';
import { parseAuditTopic, type RawTopicMessage } from '~/custodial/hcs20-reader';

interface DayBucket {
  date: string;
  deposits: { count: number; totalHbar: number };
  plays: { count: number; totalHbar: number };
  wins: { count: number; totalHbar: number; nftCount: number };
  activeUsers: Set<string>;
}

function emptyBucket(date: string): DayBucket {
  return {
    date,
    deposits: { count: 0, totalHbar: 0 },
    plays: { count: 0, totalHbar: 0 },
    wins: { count: 0, totalHbar: 0, nftCount: 0 },
    activeUsers: new Set(),
  };
}

function dayKey(iso: string): string {
  // ISO 8601 → YYYY-MM-DD (UTC)
  return iso.slice(0, 10);
}

function normalizeToken(token: string): string {
  if (token === 'LLCRED' || token === 'llcred' || token === 'hbar') return 'HBAR';
  return token;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

export async function GET(request: Request) {
  try {
    if (!(await checkRateLimit({ request, action: 'admin-monitoring', limit: 20, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    const topicId = process.env.HCS20_TOPIC_ID;
    if (!topicId) {
      return NextResponse.json(
        { error: 'HCS20_TOPIC_ID not configured', days: [], summary: null },
        { status: 503, headers: CORS_HEADERS },
      );
    }

    const network = (process.env.HEDERA_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
    const mirrorBase =
      HEDERA_DEFAULTS.mirrorNodeUrl[network] ?? HEDERA_DEFAULTS.mirrorNodeUrl.testnet;

    // Walk the topic
    const messages: RawTopicMessage[] = [];
    let nextPath: string | null = `/topics/${topicId}/messages?limit=100&order=asc`;
    while (nextPath) {
      const url = nextPath.startsWith('/api/v1')
        ? `${mirrorBase.replace(/\/api\/v1$/, '')}${nextPath}`
        : `${mirrorBase}${nextPath}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          return NextResponse.json(
            { days: [], summary: null, message: 'Topic empty or not found' },
            { headers: CORS_HEADERS },
          );
        }
        throw new Error(`Mirror node ${res.status}`);
      }
      const data = (await res.json()) as {
        messages?: { sequence_number: number; consensus_timestamp: string; message: string }[];
        links?: { next?: string };
      };
      for (const m of data.messages ?? []) {
        try {
          const payload = JSON.parse(Buffer.from(m.message, 'base64').toString('utf-8'));
          messages.push({
            sequence: m.sequence_number,
            timestamp: new Date(Number(m.consensus_timestamp.split('.')[0]) * 1000).toISOString(),
            payload,
          });
        } catch {
          /* skip */
        }
      }
      nextPath = data.links?.next ?? null;
    }

    // Run the reader to get normalized events
    const parsed = await parseAuditTopic(messages);

    // Bin by UTC day
    const buckets = new Map<string, DayBucket>();
    function getBucket(date: string): DayBucket {
      if (!buckets.has(date)) buckets.set(date, emptyBucket(date));
      return buckets.get(date)!;
    }

    for (const ev of parsed.events) {
      if (ev.type === 'deposit') {
        const b = getBucket(dayKey(ev.timestamp));
        b.deposits.count++;
        if (normalizeToken(ev.token) === 'HBAR') {
          b.deposits.totalHbar += ev.amount;
        }
        b.activeUsers.add(ev.user);
      } else if (ev.type === 'session') {
        const session = ev.session;
        const ts = session.openedAt ?? session.closedAt;
        if (!ts) continue;
        const b = getBucket(dayKey(ts));
        b.plays.count++;
        b.plays.totalHbar += session.totalSpentByToken['HBAR'] ?? session.totalSpentByToken['hbar'] ?? 0;
        if (session.totalWins > 0) {
          b.wins.count += session.totalWins;
          b.wins.totalHbar += session.totalPrizeValueByToken['HBAR'] ?? session.totalPrizeValueByToken['hbar'] ?? 0;
          b.wins.nftCount += session.totalNftCount;
        }
        if (session.user) b.activeUsers.add(session.user);
      } else if (ev.type === 'withdrawal') {
        const b = getBucket(dayKey(ev.timestamp));
        b.activeUsers.add(ev.user);
      }
    }

    // Sort buckets by date asc and serialize
    const sortedDays = Array.from(buckets.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((b) => ({
        date: b.date,
        deposits: {
          count: b.deposits.count,
          totalHbar: Math.round(b.deposits.totalHbar * 100) / 100,
        },
        plays: {
          count: b.plays.count,
          totalHbar: Math.round(b.plays.totalHbar * 100) / 100,
        },
        wins: {
          count: b.wins.count,
          totalHbar: Math.round(b.wins.totalHbar * 100) / 100,
          nftCount: b.wins.nftCount,
        },
        activeUsers: b.activeUsers.size,
      }));

    // Compute rolling summary
    const todayMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const last7dCutoff = todayMs - 7 * dayMs;
    const last30dCutoff = todayMs - 30 * dayMs;
    const usersLast7d = new Set<string>();
    const usersLast30d = new Set<string>();
    let depositsLast7d = 0;
    let playsLast7d = 0;
    for (const b of buckets.values()) {
      const dayMsStart = new Date(b.date + 'T00:00:00Z').getTime();
      if (dayMsStart >= last30dCutoff) {
        for (const u of b.activeUsers) usersLast30d.add(u);
      }
      if (dayMsStart >= last7dCutoff) {
        for (const u of b.activeUsers) usersLast7d.add(u);
        depositsLast7d += b.deposits.count;
        playsLast7d += b.plays.count;
      }
    }

    return NextResponse.json(
      {
        topicId,
        network,
        days: sortedDays,
        summary: {
          totalDays: sortedDays.length,
          activeUsersLast7d: usersLast7d.size,
          activeUsersLast30d: usersLast30d.size,
          depositVelocity7d: Math.round((depositsLast7d / 7) * 10) / 10,
          playVelocity7d: Math.round((playsLast7d / 7) * 10) / 10,
        },
        wireSchema: {
          v1Messages: parsed.stats.v1Messages,
          v2Messages: parsed.stats.v2Messages,
        },
      },
      {
        headers: {
          ...CORS_HEADERS,
          // 60s cache — mirror node walks are expensive; the
          // monitoring panel doesn't need second-by-second freshness
          'Cache-Control': 'private, max-age=60',
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
