'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  PrizeNftCard,
  type PrizeNftRef,
} from '../components/PrizeNftCard';
import { useNftEnrichment } from '../components/useNftEnrichment';
import { ComicPanel } from '../components/ComicPanel';
import { SkeletonBox } from '../components/SkeletonBox';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BurnEntry {
  amount: string;
  memo: string;
}

interface PoolWinResult {
  poolName: string;
  wins: number;
  prizeDetails: Array<{
    fungibleAmount?: number;
    fungibleToken?: string;
    nftCount?: number;
    nfts?: PrizeNftRef[];
  }>;
}

interface RecoveryEntry {
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
}

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
  burns?: BurnEntry[];
  totalWins?: number;
  totalSpent?: number;
  poolResults?: PoolWinResult[];
  recovery?: RecoveryEntry;
  raw: Record<string, unknown>;
}

interface AuditSummary {
  totalDeposited: number;
  totalRake: number;
  totalBurned: number;
  totalWithdrawn: number;
  /** Total prize value won across all play sessions (informational, not part of balance math). */
  totalWon?: number;
  /**
   * Remaining play money in the agent's internal ledger:
   * deposited - rake - played - withdrawn. NOT a profit/loss net —
   * prizes never flow into this ledger because they go directly to
   * the user's EOA via the contract's transferPendingPrizes call.
   */
  balanceLeft?: number;
  /** Legacy alias for balanceLeft. Will be removed in a future PR. */
  netBalance: number;
}

// ── v2 normalized session shape ──────────────────────────────
//
// Mirrors src/custodial/hcs20-v2.ts NormalizedSession but inlined
// here so the client doesn't need a server-only import. The reader's
// state machine produces these alongside the legacy entries[].

interface V2PrizeFt { t: 'ft'; tk: string; amt: number }
interface V2PrizeNft { t: 'nft'; tk: string; sym: string; ser: number[] }
type V2Prize = V2PrizeFt | V2PrizeNft;

interface V2NormalizedPool {
  poolId: number;
  seq: number;
  entries: number;
  spent: number;
  spentToken: string;
  wins: number;
  prizes: V2Prize[];
  ts: string;
}

type V2SessionStatus =
  | 'closed_success'
  | 'closed_aborted'
  | 'in_flight'
  | 'orphaned'
  | 'corrupt';

interface V2NormalizedSession {
  sessionId: string;
  user: string;
  agent?: string;
  status: V2SessionStatus;
  strategy?: string;
  boostBps?: number;
  openedAt?: string;
  closedAt?: string;
  pools: V2NormalizedPool[];
  totalSpent: number;
  totalSpentByToken: Record<string, number>;
  totalWins: number;
  totalPrizeValue: number;
  totalPrizeValueByToken: Record<string, number>;
  totalNftCount: number;
  prizeTransfer?: {
    status: 'succeeded' | 'skipped' | 'failed' | 'recovered';
    txId?: string;
    attempts?: number;
    gasUsed?: number;
    lastError?: string;
  };
  warnings: string[];
  firstSeq: number;
  lastSeq: number;
}

interface AuditResponse {
  topicId: string | null;
  network?: string;
  explorerUrl?: string;
  entries: AuditEntry[];
  /**
   * Normalized session list from the v2 audit reader. Each session
   * aggregates 1 open + N pool results + 1 close (or aborted) into
   * a single card-renderable object. Replaces the per-message play
   * cards in the entries[] list. Both v1 batch and v2 sequence
   * sessions surface here.
   */
  sessions?: V2NormalizedSession[];
  summary: AuditSummary;
  message?: string;
  // Admin-only fields
  filteredBy?: string | null;
  users?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(amount: number): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

/** Map HCS-20 tick names to user-friendly token names. */
function displayToken(tick?: string): string {
  if (!tick) return '';
  if (tick === 'LLCRED') return 'HBAR';
  return tick;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Accent border color class for each entry type. */
function accentColor(type: AuditEntry['type']): string {
  switch (type) {
    case 'deposit':
      return 'border-l-success';
    case 'rake':
      return 'border-l-brand';
    case 'play':
      return 'border-l-info';
    case 'withdrawal':
      return 'border-l-muted';
    case 'operator_withdrawal':
      return 'border-l-destructive';
    case 'deploy':
      return 'border-l-secondary';
    case 'prize_recovery':
      return 'border-l-brand';
    default:
      return 'border-l-secondary';
  }
}

/** Badge background + text color for each entry type. */
function badgeClasses(type: AuditEntry['type']): string {
  switch (type) {
    case 'deposit':
      return 'bg-success/15 text-success';
    case 'rake':
      return 'bg-brand/15 text-brand';
    case 'play':
      return 'bg-info/15 text-info';
    case 'withdrawal':
      return 'bg-muted/15 text-muted';
    case 'operator_withdrawal':
      return 'bg-destructive/15 text-destructive';
    case 'deploy':
      return 'bg-secondary text-muted';
    case 'prize_recovery':
      return 'bg-brand/15 text-brand';
    default:
      return 'bg-secondary text-muted';
  }
}

function typeLabel(type: AuditEntry['type']): string {
  switch (type) {
    case 'deposit':
      return 'Deposit';
    case 'rake':
      return 'Rake';
    case 'play':
      return 'Play';
    case 'withdrawal':
      return 'Withdraw';
    case 'operator_withdrawal':
      return 'Operator';
    case 'deploy':
      return 'Deploy';
    case 'prize_recovery':
      return 'Recovery';
    default:
      return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Skeleton — structural placeholder shown while the first payload loads.
// The audit route is slower than most (mirror node topic scan) so giving the
// user a structured view sooner is especially worthwhile here.
// ---------------------------------------------------------------------------

function AuditSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 lg:px-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-2">
        <SkeletonBox className="h-8 w-48" />
        <SkeletonBox className="h-4 w-96 max-w-full" />
      </div>

      {/* Topic link box */}
      <SkeletonBox className="mb-6 h-12 w-full" />

      {/* Summary bar */}
      <div className="mb-8 flex flex-wrap gap-x-4 gap-y-2">
        <SkeletonBox className="h-4 w-24" />
        <SkeletonBox className="h-4 w-24" />
        <SkeletonBox className="h-4 w-24" />
        <SkeletonBox className="h-4 w-24" />
        <SkeletonBox className="h-4 w-24" />
      </div>

      {/* Timeline */}
      <div className="space-y-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="border border-l-4 border-secondary p-4 pl-6"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <SkeletonBox className="h-5 w-16" />
                <SkeletonBox className="h-4 w-32" />
              </div>
              <SkeletonBox className="h-4 w-24" />
            </div>
            <div className="space-y-2">
              <SkeletonBox className="h-3 w-3/4" />
              <SkeletonBox className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionCard — single normalized session, expand for detail
// ---------------------------------------------------------------------------
//
// Renders one v2 NormalizedSession. The face shows the operator's
// signed close-message claim (or the v1 totals); clicking expands
// to show open + per-pool detail + warnings if any. Status badges:
//   closed_success  → brand gold (winning) or muted (losing)
//   closed_aborted  → destructive
//   in_flight       → muted spinner
//   orphaned        → destructive
//   corrupt         → destructive with hash icon

function statusBadgeClasses(status: V2SessionStatus): string {
  switch (status) {
    case 'closed_success': return 'bg-success/15 text-success';
    case 'closed_aborted': return 'bg-destructive/15 text-destructive';
    case 'in_flight': return 'bg-info/15 text-info';
    case 'orphaned': return 'bg-destructive/15 text-destructive';
    case 'corrupt': return 'bg-destructive/15 text-destructive';
  }
}

function statusLabel(status: V2SessionStatus): string {
  switch (status) {
    case 'closed_success': return 'Closed';
    case 'closed_aborted': return 'Aborted';
    case 'in_flight': return 'In flight';
    case 'orphaned': return 'Orphaned';
    case 'corrupt': return 'CORRUPT';
  }
}

function prizeTransferLabel(
  status: 'succeeded' | 'skipped' | 'failed' | 'recovered' | undefined,
): { text: string; className: string } {
  switch (status) {
    case 'succeeded': return { text: 'Delivered to your wallet', className: 'text-success' };
    case 'skipped': return { text: 'Nothing to deliver', className: 'text-muted' };
    case 'failed': return { text: 'Delivery failed — operator notified', className: 'text-destructive' };
    case 'recovered': return { text: 'Recovered by operator', className: 'text-brand' };
    default: return { text: 'Unknown', className: 'text-muted' };
  }
}

function SessionCard({
  session,
  explorerUrl,
}: {
  session: V2NormalizedSession;
  explorerUrl?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isWin = session.totalWins > 0;

  return (
    <div className="border border-l-4 border-secondary border-l-brand bg-[var(--color-panel)]">
      {/* Card face */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-4 transition-colors hover:bg-brand/5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${statusBadgeClasses(session.status)}`}>
                {statusLabel(session.status)}
              </span>
              <span className="text-xs text-muted">
                {session.openedAt ? formatTimestamp(session.openedAt) : '—'}
              </span>
              {session.strategy && (
                <span className="text-xs text-muted">· {session.strategy}</span>
              )}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="text-foreground">
                Spent <span className="num-tabular text-info">{formatAmount(session.totalSpent)}</span>
              </span>
              {isWin && (
                <span className="text-foreground">
                  Won <span className="num-tabular text-brand">+{formatAmount(session.totalPrizeValue)}</span>
                  {session.totalNftCount > 0 && (
                    <span className="ml-1 text-muted">+ {session.totalNftCount} NFT{session.totalNftCount === 1 ? '' : 's'}</span>
                  )}
                </span>
              )}
              <span className="text-xs text-muted">
                {session.pools.length} pool{session.pools.length === 1 ? '' : 's'}
              </span>
            </div>
            {/* Prize transfer status (the field that would have made
                the 668 HBAR stuck-prize incident self-explanatory) */}
            {session.prizeTransfer && (
              <p className={`mt-1 text-xs ${prizeTransferLabel(session.prizeTransfer.status).className}`}>
                Prize delivery: {prizeTransferLabel(session.prizeTransfer.status).text}
                {session.prizeTransfer.txId && (
                  <span className="ml-1 text-muted/60 font-mono text-[10px]">
                    {session.prizeTransfer.txId}
                  </span>
                )}
              </p>
            )}
            {/* Warnings (corrupt sessions, mismatches) */}
            {session.warnings.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[11px] text-destructive">
                {session.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
          </div>
          <span className="text-xs text-muted shrink-0">
            {expanded ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-secondary px-4 py-3 text-xs text-muted space-y-3">
          {/* Open metadata */}
          <div>
            <p className="text-foreground/60 mb-1">Session opened</p>
            <p className="font-mono break-all">{session.sessionId}</p>
            <p>
              User: <code className="font-mono">{session.user}</code>
              {session.agent && (
                <span className="ml-2">
                  Agent: <code className="font-mono">{session.agent}</code>
                </span>
              )}
            </p>
            {session.openedAt && (
              <p>Opened: {formatTimestamp(session.openedAt)}</p>
            )}
            {session.closedAt && (
              <p>Closed: {formatTimestamp(session.closedAt)}</p>
            )}
            <p>
              Sequence: #{session.firstSeq}
              {session.lastSeq !== session.firstSeq && ` – #${session.lastSeq}`}
              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 text-brand hover:underline"
                >
                  View topic on HashScan ↗
                </a>
              )}
            </p>
          </div>

          {/* Per-pool breakdown */}
          {session.pools.length > 0 && (
            <div>
              <p className="text-foreground/60 mb-1">Pools played</p>
              <div className="space-y-1.5">
                {session.pools.map((pool) => (
                  <div key={pool.seq} className="flex items-center justify-between gap-2 border-l-2 border-secondary px-2 py-1">
                    <div>
                      <span className="text-foreground/80">Pool #{pool.poolId}</span>
                      <span className="ml-2">{pool.entries} entries</span>
                      <span className="ml-2 text-info">{formatAmount(pool.spent)} {pool.spentToken}</span>
                    </div>
                    {pool.wins > 0 && (
                      <div className="text-right">
                        <span className="text-brand">{pool.wins} win{pool.wins === 1 ? '' : 's'}</span>
                        {pool.prizes.length > 0 && (
                          <div className="text-[10px] text-muted">
                            {pool.prizes.map((p, i) => {
                              if (p.t === 'ft') {
                                return <span key={i} className="ml-1">+{formatAmount(p.amt)} {p.tk}</span>;
                              }
                              return <span key={i} className="ml-1">+{p.ser.length} {p.sym} NFT{p.ser.length === 1 ? '' : 's'} (#{p.ser.join(', #')})</span>;
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Close: prize transfer details */}
          {session.prizeTransfer && (
            <div>
              <p className="text-foreground/60 mb-1">Prize delivery</p>
              <p className={prizeTransferLabel(session.prizeTransfer.status).className}>
                {prizeTransferLabel(session.prizeTransfer.status).text}
              </p>
              {session.prizeTransfer.txId && (
                <p className="font-mono break-all text-[10px]">{session.prizeTransfer.txId}</p>
              )}
              {session.prizeTransfer.attempts != null && (
                <p>Attempts: {session.prizeTransfer.attempts}{session.prizeTransfer.gasUsed != null && ` · Gas: ${session.prizeTransfer.gasUsed.toLocaleString()}`}</p>
              )}
              {session.prizeTransfer.lastError && (
                <p className="text-destructive">Error: {session.prizeTransfer.lastError}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AuditPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notRegistered, setNotRegistered] = useState(false);
  const [data, setData] = useState<AuditResponse | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Admin state
  const [isAdmin, setIsAdmin] = useState(false);
  const [users, setUsers] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [filterLoading, setFilterLoading] = useState(false);

  // Extract all raw NFT refs across play entries for lazy enrichment.
  const rawNftRefs = useMemo((): PrizeNftRef[] => {
    const refs: PrizeNftRef[] = [];
    if (!data) return refs;
    for (const entry of data.entries) {
      if (entry.type !== 'play' || !entry.poolResults) continue;
      for (const pr of entry.poolResults) {
        for (const pd of pr.prizeDetails) {
          if (pd.nfts) refs.push(...pd.nfts);
        }
      }
    }
    return refs;
  }, [data]);

  const {
    data: enrichedMap,
    loading: enrichmentLoading,
    error: enrichmentError,
    retry: retryEnrichment,
  } = useNftEnrichment(rawNftRefs);

  // Set page title
  useEffect(() => {
    document.title = 'Audit Trail | LazyLotto Agent';
  }, []);

  /** Fetch audit data from admin or user endpoint. */
  const fetchAudit = useCallback(async (adminMode: boolean, userFilter?: string) => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
      return null;
    }

    const headers = { Authorization: `Bearer ${token}` };

    if (adminMode) {
      const params = userFilter ? `?user=${encodeURIComponent(userFilter)}` : '';
      const res = await fetch(`/api/admin/audit${params}`, { headers });

      if (res.status === 403) {
        // Not admin, fall back to user route
        return null;
      }

      if (res.status === 401) {
        localStorage.removeItem('lazylotto:sessionToken');
        localStorage.removeItem('lazylotto:accountId');
        router.replace('/auth?expired=1');
        return null;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `API returned ${res.status}`,
        );
      }

      return (await res.json()) as AuditResponse;
    }

    // User route
    const res = await fetch('/api/user/audit', { headers });

    if (res.status === 401) {
      localStorage.removeItem('lazylotto:sessionToken');
      localStorage.removeItem('lazylotto:accountId');
      router.replace('/auth?expired=1');
      return null;
    }

    if (res.status === 404) {
      setNotRegistered(true);
      return null;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? `API returned ${res.status}`,
      );
    }

    return (await res.json()) as AuditResponse;
  }, [router]);

  // Initial load: try admin first, then fall back to user
  useEffect(() => {
    (async () => {
      try {
        // Try admin endpoint first
        const adminData = await fetchAudit(true);

        if (adminData) {
          setIsAdmin(true);
          setUsers(adminData.users ?? []);
          setData(adminData);
          setLoading(false);
          return;
        }

        // Fall back to user endpoint (if not redirected already)
        if (!notRegistered) {
          const userData = await fetchAudit(false);
          if (userData) {
            setData(userData);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchAudit, notRegistered]);

  // Handle user filter change (admin only)
  const handleUserFilterChange = useCallback(async (accountId: string) => {
    setSelectedUser(accountId);
    setFilterLoading(true);
    setShowAll(false);

    try {
      const filtered = await fetchAudit(true, accountId || undefined);
      if (filtered) {
        setData(filtered);
        // Preserve the full users list (don't overwrite from a filtered response)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setFilterLoading(false);
    }
  }, [fetchAudit]);

  // --- Loading ---
  if (loading) {
    return <AuditSkeleton />;
  }

  // --- Not registered ---
  if (notRegistered) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <ComicPanel label="WELCOME" halftone="dense">
            <div className="p-8 text-center">
              <p className="label-caps-brand-lg mb-3">Almost there</p>
              <h1 className="display-md mb-3 text-foreground">
                Not registered
              </h1>
              <p className="type-body prose-width mx-auto mb-6 text-muted">
                You need to be registered as a player before you can view your
                on-chain audit trail.
              </p>
              <a href="/auth" className="btn-primary-sm">
                Sign in →
              </a>
            </div>
          </ComicPanel>
        </div>
      </div>
    );
  }

  // --- Error ---
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <ComicPanel label="ERROR" tone="destructive" halftone="none">
            <div className="p-8 text-center">
              <p className="label-caps-destructive mb-3">Trouble loading</p>
              <h1 className="display-md mb-3 text-foreground">
                Something went wrong
              </h1>
              <p className="type-body prose-width mx-auto mb-6 text-destructive">
                {error}
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="btn-primary-sm"
              >
                Retry
              </button>
            </div>
          </ComicPanel>
        </div>
      </div>
    );
  }

  // --- Topic not configured ---
  if (data && data.topicId === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <ComicPanel label="OFFLINE" tone="muted" halftone="none">
            <div className="p-8 text-center">
              <p className="label-caps mb-3">Accounting</p>
              <h1 className="display-md mb-3 text-foreground">
                Not configured
              </h1>
              <p className="type-body prose-width mx-auto text-muted">
                On-chain accounting isn&apos;t configured for this agent
                instance. Contact the operator to enable the audit trail.
              </p>
            </div>
          </ComicPanel>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { entries, sessions: v2Sessions, summary, explorerUrl, topicId } = data;
  // Hide raw 'play' entries when we have v2 sessions to render
  // them as cards instead. Other entry types (deposit, rake,
  // withdrawal, refund, recovery) still come through entries[].
  const nonPlayEntries = (v2Sessions && v2Sessions.length > 0)
    ? entries.filter((e) => e.type !== 'play')
    : entries;
  const displayedEntries = showAll ? nonPlayEntries : nonPlayEntries.slice(0, 20);

  return (
    <div className="w-full px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">

        {/* ---- Header ---- */}
        <header className="mb-8">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-heading text-2xl text-foreground">
              On-Chain Audit Trail
            </h1>
            {isAdmin && (
              <span className="rounded bg-brand/15 px-2 py-0.5 text-xs font-semibold text-brand">
                Admin
              </span>
            )}
            {isAdmin && (
              <span className="rounded bg-secondary px-2 py-0.5 text-xs text-muted">
                {entries.length} messages &middot; {users.length} users
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-muted">
            {isAdmin
              ? 'Full on-chain HCS-20 accounting ledger. Filter by user or view all records.'
              : 'Every transaction involving your account is recorded on-chain via HCS-20 on Hedera Consensus Service. This is your immutable, verifiable record.'}
          </p>
        </header>

        {/* ---- HashScan Topic Link ---- */}
        {topicId && (
          <a
            href={explorerUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-6 flex items-center gap-2 border border-secondary bg-[var(--color-panel)] px-4 py-3 text-sm text-muted transition-colors hover:border-brand"
          >
            <span>On-chain ledger: Topic {topicId} on HashScan</span>
            <span className="text-brand">&#x2197;</span>
          </a>
        )}

        {/* ---- Admin Filter Dropdown ---- */}
        {isAdmin && users.length > 0 && (
          <div className="mb-6 flex items-center gap-3">
            <label htmlFor="user-filter" className="text-sm text-muted">
              Filter by user:
            </label>
            <select
              id="user-filter"
              value={selectedUser}
              onChange={(e) => handleUserFilterChange(e.target.value)}
              disabled={filterLoading}
              className="border-2 border-secondary bg-[var(--color-panel)] text-foreground text-sm px-3 py-2 transition-colors focus:border-brand disabled:opacity-50"
            >
              <option value="">All users</option>
              {users.map((user) => (
                <option key={user} value={user}>
                  {user}
                </option>
              ))}
            </select>
            {filterLoading && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-brand" />
            )}
          </div>
        )}

        {/* ---- Summary Bar ────────────────────────────────────
            Two-row layout that distinguishes the two distinct
            dimensions of the user's account state:

              Row 1 (money flow): Deposited - Rake - Played - Withdrawn = Balance left.
                "Balance left" is the remaining play money in the
                agent's internal ledger, NOT a profit/loss net.

              Row 2 (winnings, informational): Total prize value won.
                Prizes never enter the internal ledger — they go
                directly to the user's EOA via the contract's
                transferPendingPrizes call. Surfaced separately so
                users can see at a glance what they've won without
                expanding individual session cards.

            Previously the summary had a single "Net" field
            computed as deposit - rake - played - withdrawn, which
            confused users who read "Net" as P/L. The relabel +
            split fixes that. ---- */}
        <div className="mb-8 space-y-1 text-sm text-muted">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>
              Deposited:{' '}
              <span className="text-success">{formatAmount(summary.totalDeposited)}</span>
            </span>
            <span className="hidden sm:inline">|</span>
            <span>
              Rake:{' '}
              <span className="text-brand">{formatAmount(summary.totalRake)}</span>
            </span>
            <span className="hidden sm:inline">|</span>
            <span>
              Played:{' '}
              <span className="text-info">{formatAmount(summary.totalBurned)}</span>
            </span>
            <span className="hidden sm:inline">|</span>
            <span>
              Withdrawn:{' '}
              <span className="text-foreground">{formatAmount(summary.totalWithdrawn)}</span>
            </span>
            <span className="hidden sm:inline">|</span>
            <span>
              Balance left:{' '}
              <span className={(summary.balanceLeft ?? summary.netBalance) >= 0 ? 'text-success' : 'text-destructive'}>
                {formatAmount(summary.balanceLeft ?? summary.netBalance)}
              </span>
            </span>
          </div>
          {summary.totalWon != null && summary.totalWon > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                Won (claim on dApp):{' '}
                <span className="text-brand">+{formatAmount(summary.totalWon)}</span>
              </span>
              <span className="text-[11px] italic text-muted/60">
                Winnings flow to your wallet directly via the contract; they don&apos;t
                offset your balance above.
              </span>
            </div>
          )}
        </div>

        {/* NFT enrichment error banner */}
        {enrichmentError && rawNftRefs.length > 0 && (
          <div className="mb-4 flex items-center justify-between border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-sm">
            <span className="text-destructive">
              Couldn&apos;t load NFT details. Your raw wins are shown below.
            </span>
            <button
              type="button"
              onClick={retryEnrichment}
              className="shrink-0 rounded border border-destructive/40 px-3 py-1 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/20"
            >
              Retry
            </button>
          </div>
        )}

        {/* ---- v2 Session Cards ─────────────────────────────────
            Reconstructed play sessions from the HCS-20 v2 reader.
            One card per session, regardless of whether it's a v1
            legacy batch or a v2 sequence (open + pools + close).
            The face shows the close-message claims (or v1 totals)
            so users can scan top to bottom and verify the math.
            Click to expand for the per-pool breakdown.
            ---- */}
        {v2Sessions && v2Sessions.length > 0 && (
          <div className="mb-6 space-y-4">
            <h2 className="font-heading text-lg text-foreground">
              Play sessions ({v2Sessions.length})
            </h2>
            {v2Sessions.map((s) => (
              <SessionCard key={s.sessionId} session={s} explorerUrl={explorerUrl} />
            ))}
          </div>
        )}

        {/* ---- Timeline ---- */}
        {entries.length > 0 ? (
          <>
            <div className="space-y-4">
              {displayedEntries.map((entry) => (
                <div
                  key={entry.sequence}
                  className={`relative border border-secondary ${accentColor(entry.type)} border-l-4 p-4 pl-6`}
                >
                  {/* Header row: badge + timestamp + amount.
                      For deposit/rake/withdrawal entries, the HCS-20
                      message has a top-level `amt` field that lands in
                      entry.amount. For play entries, the batch message
                      has no top-level amount (the cost lives in the
                      burn sub-ops), so we surface the enriched
                      totalSpent here instead — same right-column
                      placement, so the user can scan a column of
                      amounts to walk through the audit. The "spent"
                      annotation distinguishes it from a deposit/rake
                      readout. */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${badgeClasses(entry.type)}`}
                      >
                        {typeLabel(entry.type)}
                      </span>
                      <span className="text-sm text-muted">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>

                    {entry.amount ? (
                      <span className="font-heading text-sm text-foreground">
                        {entry.amount} {displayToken(entry.token)}
                      </span>
                    ) : entry.type === 'play' && entry.totalSpent != null ? (
                      <span className="font-heading text-sm text-foreground">
                        {formatAmount(entry.totalSpent)}
                        <span className="ml-1 text-[10px] uppercase tracking-wider text-muted">
                          spent
                        </span>
                      </span>
                    ) : null}
                  </div>

                  {/* Details */}
                  <div className="space-y-1 text-xs text-muted">
                    {entry.memo && (
                      <p>
                        <span className="text-foreground/60">Memo:</span> {entry.memo}
                      </p>
                    )}

                    {entry.from && (
                      <p>
                        <span className="text-foreground/60">From:</span>{' '}
                        <code className="font-mono">{entry.from}</code>
                      </p>
                    )}

                    {entry.to && (
                      <p>
                        <span className="text-foreground/60">To:</span>{' '}
                        <code className="font-mono">{entry.to}</code>
                      </p>
                    )}

                    {entry.sessionId && (
                      <p>
                        <span className="text-foreground/60">Session:</span>{' '}
                        <code className="font-mono">{entry.sessionId}</code>
                      </p>
                    )}

                    {/* Burn sub-entries for batch/play operations */}
                    {entry.burns && entry.burns.length > 0 && (
                      <div className="mt-2 space-y-1 rounded bg-secondary/50 px-3 py-2">
                        {entry.burns.map((burn, i) => (
                          <p key={i}>
                            <span className="text-info">{burn.amount}</span>
                            {burn.memo && (
                              <span className="ml-2 text-muted">{burn.memo}</span>
                            )}
                          </p>
                        ))}
                      </div>
                    )}

                    {/* Win results (enriched from play session data) */}
                    {entry.type === 'play' && entry.totalWins != null && entry.totalWins > 0 && (
                      <div className="mt-2 rounded bg-success/10 px-3 py-2">
                        <p className="text-sm font-semibold text-success">
                          {entry.totalWins} win{entry.totalWins > 1 ? 's' : ''}!
                        </p>
                        {entry.poolResults && entry.poolResults.length > 0 && (
                          <div className="mt-1 space-y-2">
                            {entry.poolResults.map((pr, i) => {
                              // Fungible prize summary — inline text
                              const fungibleParts = (pr.prizeDetails as Array<Record<string, unknown>>)
                                .map((d) =>
                                  d.fungibleAmount
                                    ? `${d.fungibleAmount} ${d.fungibleToken ?? ''}`
                                    : '',
                                )
                                .filter(Boolean);
                              return (
                                <div key={i}>
                                  <p className="text-xs text-success/80">
                                    {pr.poolName}: {pr.wins} win{pr.wins > 1 ? 's' : ''}
                                    {fungibleParts.length > 0 && (
                                      <span className="ml-1 text-muted">
                                        ({fungibleParts.join(', ')})
                                      </span>
                                    )}
                                  </p>
                                  {/* NFT cards — raw first, enriched in background */}
                                  {(() => {
                                    const rawNfts = pr.prizeDetails.flatMap(
                                      (pd) => pd.nfts ?? [],
                                    );
                                    if (rawNfts.length === 0) return null;
                                    return (
                                      <div className="mt-1 flex flex-wrap gap-2">
                                        {rawNfts.map((raw) => {
                                          const key = `${raw.hederaId}!${raw.serial}`;
                                          const enriched = enrichedMap.get(key);
                                          return (
                                            <PrizeNftCard
                                              key={key}
                                              raw={raw}
                                              enriched={enriched}
                                              loading={!enriched && enrichmentLoading}
                                              size="compact"
                                            />
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    {entry.type === 'play' && (entry.totalWins === 0 || entry.totalWins == null) && entry.totalSpent != null && (
                      <p className="mt-1 text-xs text-muted">No wins this session</p>
                    )}

                    {/* Prize recovery details — surfaces operator-initiated
                        recoveries from the prize_recovery HCS-20 op so an
                        independent third party can verify "user X had Y
                        prizes recovered, here's the contract tx, here's
                        the reason." This is the audit-trail companion to
                        the operator_recover_stuck_prizes MCP tool. */}
                    {entry.type === 'prize_recovery' && entry.recovery && (
                      <div className="mt-2 rounded bg-brand/10 px-3 py-2">
                        <p className="text-sm font-semibold text-brand">
                          {entry.recovery.prizesTransferred} prize{entry.recovery.prizesTransferred === 1 ? '' : 's'} recovered
                        </p>
                        <div className="mt-1 space-y-1 text-xs text-muted">
                          <p>
                            <span className="text-foreground/60">User:</span>{' '}
                            <code className="font-mono">{entry.recovery.userAccountId}</code>
                          </p>
                          <p>
                            <span className="text-foreground/60">From agent:</span>{' '}
                            <code className="font-mono">{entry.recovery.agentAccountId}</code>
                          </p>
                          {entry.recovery.prizesByToken && Object.keys(entry.recovery.prizesByToken).length > 0 && (
                            <p>
                              <span className="text-foreground/60">Tokens:</span>{' '}
                              {Object.entries(entry.recovery.prizesByToken)
                                .map(([t, a]) => `${a} ${displayToken(t)}`)
                                .join(', ')}
                            </p>
                          )}
                          <p>
                            <span className="text-foreground/60">Reason:</span> {entry.recovery.reason}
                          </p>
                          <p>
                            <span className="text-foreground/60">Performed by:</span>{' '}
                            <code className="font-mono">{entry.recovery.performedBy}</code>
                          </p>
                          {entry.recovery.attempts != null && (
                            <p>
                              <span className="text-foreground/60">Attempts:</span> {entry.recovery.attempts}
                              {entry.recovery.gasUsed != null && (
                                <span className="ml-2">
                                  <span className="text-foreground/60">Gas:</span> {entry.recovery.gasUsed.toLocaleString()}
                                </span>
                              )}
                            </p>
                          )}
                          <p>
                            <span className="text-foreground/60">Contract tx:</span>{' '}
                            <code className="font-mono break-all">{entry.recovery.contractTxId}</code>
                          </p>
                          {entry.recovery.affectedSessions && entry.recovery.affectedSessions.length > 0 && (
                            <p>
                              <span className="text-foreground/60">Affected sessions:</span>{' '}
                              {entry.recovery.affectedSessions.length}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Sequence number (subtle) */}
                  <p className="mt-2 text-[11px] text-muted/50">
                    #{entry.sequence}
                  </p>
                </div>
              ))}
            </div>

            {/* Show more / less toggle */}
            {entries.length > 20 && !showAll && (
              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="text-sm text-brand transition-colors hover:text-brand/80"
                >
                  Show older entries ({entries.length - 20} more)
                </button>
              </div>
            )}
            {showAll && entries.length > 20 && (
              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={() => setShowAll(false)}
                  className="text-sm text-brand transition-colors hover:text-brand/80"
                >
                  Show less
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="border border-secondary bg-[var(--color-panel)] px-5 py-6 text-center">
            <p className="text-sm text-muted">
              {isAdmin && selectedUser
                ? `No on-chain records for ${selectedUser}.`
                : 'No on-chain records yet. Records appear after the first deposit.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
