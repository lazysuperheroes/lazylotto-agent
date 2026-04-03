'use client';

import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BurnEntry {
  amount: string;
  memo: string;
}

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
  burns?: BurnEntry[];
  raw: Record<string, unknown>;
}

interface AuditSummary {
  totalDeposited: number;
  totalRake: number;
  totalBurned: number;
  totalWithdrawn: number;
  netBalance: number;
}

interface AuditResponse {
  topicId: string | null;
  network?: string;
  explorerUrl?: string;
  entries: AuditEntry[];
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
      return 'border-l-primary';
    case 'withdrawal':
      return 'border-l-muted';
    case 'operator_withdrawal':
      return 'border-l-destructive';
    case 'deploy':
      return 'border-l-secondary';
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
      return 'bg-primary/15 text-primary';
    case 'withdrawal':
      return 'bg-muted/15 text-muted';
    case 'operator_withdrawal':
      return 'bg-destructive/15 text-destructive';
    case 'deploy':
      return 'bg-secondary text-muted';
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
    default:
      return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AuditPage() {
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

  // Set page title
  useEffect(() => {
    document.title = 'Audit Trail | LazyLotto Agent';
  }, []);

  /** Fetch audit data from admin or user endpoint. */
  const fetchAudit = useCallback(async (adminMode: boolean, userFilter?: string) => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      window.location.href = '/auth';
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
        window.location.href = '/auth';
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
      window.location.href = '/auth';
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
  }, []);

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
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
          <p className="text-sm text-muted">Loading audit trail...</p>
        </div>
      </div>
    );
  }

  // --- Not registered ---
  if (notRegistered) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-secondary p-8 text-center shadow-lg">
          <h1 className="mb-3 font-heading text-xl text-foreground">
            Not Registered
          </h1>
          <p className="mb-6 text-sm text-muted">
            You need to be registered as a player before you can view your audit trail.
          </p>
          <a
            href="/auth"
            className="inline-block rounded-lg bg-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-primary/90"
          >
            Go to Authentication
          </a>
        </div>
      </div>
    );
  }

  // --- Error ---
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-destructive/30 p-8 text-center shadow-lg">
          <h1 className="mb-3 font-heading text-xl text-foreground">
            Something went wrong
          </h1>
          <p className="mb-6 text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-block rounded-lg bg-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // --- Topic not configured ---
  if (data && data.topicId === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-secondary p-8 text-center shadow-lg">
          <h1 className="mb-3 font-heading text-xl text-foreground">
            Accounting Not Configured
          </h1>
          <p className="text-sm text-muted">
            On-chain accounting is not configured for this agent instance. Contact the operator.
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { entries, summary, explorerUrl, topicId } = data;
  const displayedEntries = showAll ? entries : entries.slice(0, 20);

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
            className="mb-6 flex items-center gap-2 rounded-lg bg-secondary/30 px-4 py-3 text-sm text-muted transition-colors hover:bg-secondary/50"
          >
            <span>On-chain ledger: Topic {topicId} on HashScan</span>
            <span className="text-primary">&nearr;</span>
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
              className="rounded-lg border border-secondary bg-secondary text-foreground text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            >
              <option value="">All users</option>
              {users.map((user) => (
                <option key={user} value={user}>
                  {user}
                </option>
              ))}
            </select>
            {filterLoading && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-primary" />
            )}
          </div>
        )}

        {/* ---- Summary Bar ---- */}
        <div className="mb-8 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
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
            <span className="text-primary">{formatAmount(summary.totalBurned)}</span>
          </span>
          <span className="hidden sm:inline">|</span>
          <span>
            Withdrawn:{' '}
            <span className="text-foreground">{formatAmount(summary.totalWithdrawn)}</span>
          </span>
          <span className="hidden sm:inline">|</span>
          <span>
            Net:{' '}
            <span className={summary.netBalance >= 0 ? 'text-success' : 'text-destructive'}>
              {summary.netBalance >= 0 ? '+' : ''}{formatAmount(summary.netBalance)}
            </span>
          </span>
        </div>

        {/* ---- Timeline ---- */}
        {entries.length > 0 ? (
          <>
            <div className="space-y-4">
              {displayedEntries.map((entry) => (
                <div
                  key={entry.sequence}
                  className={`relative rounded-lg border border-secondary ${accentColor(entry.type)} border-l-4 p-4 pl-6`}
                >
                  {/* Header row: badge + timestamp + amount */}
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

                    {entry.amount && (
                      <span className="font-heading text-sm text-foreground">
                        {entry.amount} {entry.token ?? ''}
                      </span>
                    )}
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
                            <span className="text-primary">{burn.amount}</span>
                            {burn.memo && (
                              <span className="ml-2 text-muted">{burn.memo}</span>
                            )}
                          </p>
                        ))}
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
                  className="text-sm text-primary transition-colors hover:text-primary/80"
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
                  className="text-sm text-primary transition-colors hover:text-primary/80"
                >
                  Show less
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-lg bg-secondary/30 px-5 py-6 text-center">
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
