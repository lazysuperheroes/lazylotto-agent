'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Types -- shaped to match actual API responses
// ---------------------------------------------------------------------------

interface TokenBalanceEntry {
  available: number;
  reserved: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalRake: number;
}

interface UserBalances {
  tokens: Record<string, TokenBalanceEntry>;
}

interface OverviewResponse {
  users: { total: number; active: number; inactive: number };
  balances: {
    totalDeposited: Record<string, number>;
    totalAvailable: Record<string, number>;
    totalReserved: Record<string, number>;
    totalWithdrawn: Record<string, number>;
  };
  operator: {
    balances: Record<string, number>;
    totalRakeCollected: Record<string, number>;
    totalGasSpent: number;
    totalWithdrawnByOperator: Record<string, number>;
  };
  deadLetterCount: number;
}

interface ManagedUser {
  userId: string;
  hederaAccountId: string;
  eoaAddress: string;
  depositMemo: string;
  strategyName: string;
  strategyVersion: string;
  rakePercent: number;
  balances: UserBalances;
  active: boolean;
  registeredAt: string;
  lastPlayedAt: string | null;
}

interface UsersResponse {
  users: ManagedUser[];
}

interface DeadLetter {
  transactionId: string;
  timestamp: string;
  error: string;
}

interface DeadLettersResponse {
  deadLetters: DeadLetter[];
  count: number;
}

interface OperatorBalanceRow {
  token: string;
  rakeCollected: number;
  gasSpent: number;
  netProfit: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(value: number, decimals = 1): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function summariseTokenMap(map: Record<string, number>): string {
  const entries = Object.entries(map).filter(([, v]) => v !== 0);
  if (entries.length === 0) return '0';
  return entries.map(([token, value]) => `${fmt(value)} ${token}`).join(', ');
}

function deriveOperatorBalances(
  operator: OverviewResponse['operator'],
): OperatorBalanceRow[] {
  const tokenSet = new Set<string>();
  for (const key of Object.keys(operator.balances)) tokenSet.add(key);
  for (const key of Object.keys(operator.totalRakeCollected)) tokenSet.add(key);
  if (operator.totalGasSpent > 0) tokenSet.add('hbar');

  const rows: OperatorBalanceRow[] = [];
  for (const token of Array.from(tokenSet)) {
    const rake = operator.totalRakeCollected[token] ?? 0;
    const gas = token === 'hbar' ? operator.totalGasSpent : 0;
    const net = rake - gas;
    rows.push({ token, rakeCollected: rake, gasSpent: gas, netProfit: net });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Skeleton — structural placeholder for the admin landing page.
// ---------------------------------------------------------------------------

function SkeletonBox({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-secondary/50 ${className}`} />;
}

function AdminSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:px-8">
      {/* Header */}
      <div className="mb-6">
        <SkeletonBox className="h-8 w-56" />
      </div>

      {/* Top stats row: Users / Deposited / Rake / Gas */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-secondary p-4 shadow">
            <SkeletonBox className="mb-2 h-3 w-24" />
            <SkeletonBox className="h-7 w-32" />
          </div>
        ))}
      </div>

      {/* Managed Users table */}
      <div className="mb-6 rounded-xl border border-secondary p-6 shadow">
        <SkeletonBox className="mb-4 h-5 w-32" />
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <SkeletonBox className="h-4 w-24" />
              <SkeletonBox className="h-4 w-32" />
              <SkeletonBox className="h-4 w-20" />
              <SkeletonBox className="h-4 w-24" />
              <SkeletonBox className="h-6 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* Two-column row: Dead letters + Reconciliation */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-secondary p-6 shadow">
          <SkeletonBox className="mb-4 h-5 w-40" />
          <SkeletonBox className="h-12 w-full" />
        </div>
        <div className="rounded-xl border border-secondary p-6 shadow">
          <SkeletonBox className="mb-4 h-5 w-40" />
          <SkeletonBox className="h-12 w-full" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [operatorBalances, setOperatorBalances] = useState<OperatorBalanceRow[]>([]);

  // Reconciliation state
  interface ReconciliationResult {
    timestamp: string;
    onChain: Record<string, number>;
    ledgerTotal: Record<string, number>;
    actualNetworkFeesHbar: number;
    trackedGasHbar: number;
    untrackedFeesHbar: number;
    delta: Record<string, number>;
    adjustedDelta: Record<string, number>;
    solvent: boolean;
    warnings: string[];
  }
  const [reconRunning, setReconRunning] = useState(false);
  const [reconMessage, setReconMessage] = useState<string | null>(null);
  const [reconResult, setReconResult] = useState<ReconciliationResult | null>(null);
  const [reconOpen, setReconOpen] = useState(false);

  const [operatorOpen, setOperatorOpen] = useState(false);

  // Withdraw fees modal state
  const [withdrawFeesOpen, setWithdrawFeesOpen] = useState(false);
  const [withdrawFeesAmount, setWithdrawFeesAmount] = useState('');
  const [withdrawFeesTo, setWithdrawFeesTo] = useState('');
  const [withdrawFeesToken, setWithdrawFeesToken] = useState<'HBAR' | 'LAZY'>('HBAR');
  const [withdrawFeesLoading, setWithdrawFeesLoading] = useState(false);

  const [refundMessages, setRefundMessages] = useState<Record<string, string>>({});

  const [sortColumn, setSortColumn] = useState<string>('hederaAccountId');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Set page title
  useEffect(() => {
    document.title = 'Administration | LazyLotto Agent';
  }, []);

  // ------------------------------------------------------------------
  // Auth-aware fetch helper
  // ------------------------------------------------------------------
  const authFetch = useCallback(
    async (url: string, options?: RequestInit): Promise<Response> => {
      const token = localStorage.getItem('lazylotto:sessionToken');
      if (!token) {
        window.location.href = '/auth';
        return new Promise(() => {});
      }

      const res = await fetch(url, {
        ...options,
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.status === 401) {
        localStorage.removeItem('lazylotto:sessionToken');
        localStorage.removeItem('lazylotto:accountId');
        window.location.href = '/auth';
        return new Promise(() => {});
      }

      if (res.status === 403) {
        setError('Insufficient permissions. Admin access required.');
        setLoading(false);
        throw new Error('forbidden');
      }

      return res;
    },
    [],
  );

  // ------------------------------------------------------------------
  // Load data on mount
  // ------------------------------------------------------------------
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      window.location.href = '/auth';
      return;
    }

    let cancelled = false;

    // Fire all three requests independently so each section renders as soon
    // as its own data arrives. Overview is the critical path (header stats +
    // operator balance), so it gates the skeleton; users table and dead
    // letters fill in separately.

    void (async () => {
      try {
        const res = await authFetch('/api/admin/overview');
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(
            (body as { error?: string }).error ?? `Overview failed (${res.status})`,
          );
          return;
        }
        const data: OverviewResponse = await res.json();
        if (cancelled) return;
        setOverview(data);
        setOperatorBalances(deriveOperatorBalances(data.operator));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.message === 'forbidden') return;
        setError(err instanceof Error ? err.message : 'Failed to load overview');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    void (async () => {
      try {
        const res = await authFetch('/api/admin/users');
        if (cancelled || !res.ok) return;
        const data: UsersResponse = await res.json();
        if (cancelled) return;
        setUsers(data.users);
      } catch {
        /* silent failure — table shows empty state */
      }
    })();

    void (async () => {
      try {
        const res = await authFetch('/api/admin/dead-letters');
        if (cancelled || !res.ok) return;
        const data: DeadLettersResponse = await res.json();
        if (cancelled) return;
        setDeadLetters(data.deadLetters);
      } catch {
        /* silent failure — dead letters shows empty state */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  // --- Sort users ---
  const handleSort = useCallback(
    (column: string) => {
      setSortDirection((prev) =>
        sortColumn === column ? (prev === 'asc' ? 'desc' : 'asc') : 'asc',
      );
      setSortColumn(column);
    },
    [sortColumn],
  );

  const sortedUsers = [...users].sort((a, b) => {
    const dir = sortDirection === 'asc' ? 1 : -1;

    if (sortColumn === 'available') {
      const sumA = Object.values(a.balances.tokens).reduce((s, e) => s + e.available, 0);
      const sumB = Object.values(b.balances.tokens).reduce((s, e) => s + e.available, 0);
      return (sumA - sumB) * dir;
    }
    if (sortColumn === 'reserved') {
      const sumA = Object.values(a.balances.tokens).reduce((s, e) => s + e.reserved, 0);
      const sumB = Object.values(b.balances.tokens).reduce((s, e) => s + e.reserved, 0);
      return (sumA - sumB) * dir;
    }

    const valA = a[sortColumn as keyof ManagedUser];
    const valB = b[sortColumn as keyof ManagedUser];
    if (typeof valA === 'string' && typeof valB === 'string') {
      return valA.localeCompare(valB) * dir;
    }
    if (typeof valA === 'number' && typeof valB === 'number') {
      return (valA - valB) * dir;
    }
    if (typeof valA === 'boolean' && typeof valB === 'boolean') {
      return (Number(valA) - Number(valB)) * dir;
    }
    if (valA === null && valB === null) return 0;
    if (valA === null) return -1 * dir;
    if (valB === null) return 1 * dir;
    return 0;
  });

  function getUserAvailable(user: ManagedUser): string {
    const entries = Object.entries(user.balances.tokens).filter(
      ([, e]) => e.available > 0,
    );
    if (entries.length === 0) return '0.0';
    return entries.map(([token, e]) => `${fmt(e.available)} ${token}`).join(', ');
  }

  function getUserReserved(user: ManagedUser): string {
    const entries = Object.entries(user.balances.tokens).filter(
      ([, e]) => e.reserved > 0,
    );
    if (entries.length === 0) return '--';
    return entries.map(([token, e]) => `${fmt(e.reserved)} ${token}`).join(', ');
  }

  // --- Run reconciliation ---
  const handleReconciliation = useCallback(async () => {
    setReconRunning(true);
    setReconMessage(null);
    setReconResult(null);

    try {
      const res = await authFetch('/api/admin/reconcile', { method: 'POST' });
      const body = await res.json();

      if (res.status === 501) {
        setReconMessage(
          (body as { message?: string; error?: string }).message ??
            (body as { error?: string }).error ??
            'Not implemented',
        );
      } else if (!res.ok) {
        setReconMessage(
          (body as { error?: string }).error ?? `Reconciliation failed (${res.status})`,
        );
      } else {
        // Real result — display the structured data
        setReconResult(body as ReconciliationResult);
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'forbidden') return;
      setReconMessage(err instanceof Error ? err.message : 'Reconciliation request failed');
    } finally {
      setReconRunning(false);
    }
  }, [authFetch]);

  // --- Refund dead letter ---
  const handleRefund = useCallback(
    async (transactionId: string) => {
      try {
        const res = await authFetch('/api/admin/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactionId }),
        });
        const body = await res.json();

        if (res.status === 501) {
          setRefundMessages((prev) => ({
            ...prev,
            [transactionId]: (body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? 'Not implemented',
          }));
        } else if (!res.ok) {
          setRefundMessages((prev) => ({
            ...prev,
            [transactionId]: (body as { error?: string }).error ?? `Refund failed (${res.status})`,
          }));
        } else {
          setRefundMessages((prev) => ({
            ...prev,
            [transactionId]: 'Refund processed successfully.',
          }));
          toast('Refund processed');
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'forbidden') return;
        setRefundMessages((prev) => ({
          ...prev,
          [transactionId]: err instanceof Error ? err.message : 'Refund request failed',
        }));
      }
    },
    [authFetch, toast],
  );

  // --- Withdraw fees ---
  const handleWithdrawFees = useCallback(() => {
    setWithdrawFeesOpen(true);
  }, []);

  const submitWithdrawFees = useCallback(async () => {
    const amount = Number(withdrawFeesAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Enter a valid amount greater than 0');
      return;
    }
    setWithdrawFeesLoading(true);
    try {
      const res = await authFetch('/api/admin/withdraw-fees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          token: withdrawFeesToken,
          // Only send `to` if the user typed one — env var override is the default
          ...(withdrawFeesTo ? { to: withdrawFeesTo } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error ?? `Withdrawal failed (${res.status})`,
        );
      }
      const result = body as {
        withdrawn: number;
        token: string;
        to: string;
        transactionId: string;
      };
      toast(`Withdrew ${result.withdrawn} ${result.token} to ${result.to}`);
      setWithdrawFeesOpen(false);
      setWithdrawFeesAmount('');
      setWithdrawFeesTo('');
      // Refresh overview to show new operator balance
      const overviewRes = await authFetch('/api/admin/overview');
      if (overviewRes.ok) {
        const data: OverviewResponse = await overviewRes.json();
        setOverview(data);
        setOperatorBalances(deriveOperatorBalances(data.operator));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Fee withdrawal failed: ${message}`);
    } finally {
      setWithdrawFeesLoading(false);
    }
  }, [withdrawFeesAmount, withdrawFeesTo, withdrawFeesToken, authFetch, toast]);

  // --- Sort indicator ---
  const sortArrow = (column: string) => {
    if (sortColumn !== column) return null;
    return (
      <span className="ml-1 text-brand">
        {sortDirection === 'asc' ? '\u25B2' : '\u25BC'}
      </span>
    );
  };

  // --- Loading state ---
  if (loading) {
    return <AdminSkeleton />;
  }

  // --- Permission denied state ---
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-md rounded-xl border border-destructive/30 bg-destructive/10 p-8 text-center">
          <p className="font-heading text-lg text-destructive">Access Denied</p>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem('lazylotto:sessionToken');
              localStorage.removeItem('lazylotto:accountId');
              window.location.href = '/auth';
            }}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Return to Login
          </button>
        </div>
      </div>
    );
  }

  const hasDeadLetters = overview ? overview.deadLetterCount > 0 : false;

  // --- Admin Dashboard ---
  return (
    <div className="w-full px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        {/* ---- Top Bar ---- */}
        <header className="mb-8">
          <h1 className="font-heading text-2xl text-foreground">
            Agent Administration
          </h1>
        </header>

        {/* ---- Overview Banner ---- */}
        {overview && (
          <div className="mb-6 rounded-xl bg-secondary/30 p-6">
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <div>
                <p className="font-heading text-3xl text-brand">
                  {overview.users.active}
                </p>
                <p className="mt-1 text-sm text-muted">
                  Active Users ({overview.users.total} total)
                </p>
              </div>
              <div>
                <p className="font-heading text-3xl text-brand">
                  {summariseTokenMap(overview.balances.totalDeposited)}
                </p>
                <p className="mt-1 text-sm text-muted">Total Deposited</p>
              </div>
              <div>
                <p className="font-heading text-3xl text-brand">
                  {summariseTokenMap(overview.operator.totalRakeCollected)}
                </p>
                <p className="mt-1 text-sm text-muted">Operator Rake</p>
              </div>
              <div>
                <p className="font-heading text-3xl text-brand">
                  {fmt(overview.operator.totalGasSpent, 2)} hbar
                </p>
                <p className="mt-1 text-sm text-muted">Gas Spent</p>
              </div>
            </div>
          </div>
        )}

        {/* ---- Users Table ---- */}
        <div className="mb-6 rounded-xl border border-secondary p-6 shadow">
          <h2 className="mb-4 font-heading text-lg text-foreground">
            Managed Users
          </h2>

          {sortedUsers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-secondary bg-secondary/50 text-left">
                    <th
                      className="cursor-pointer px-3 py-3 font-medium text-muted hover:text-foreground"
                      onClick={() => handleSort('hederaAccountId')}
                    >
                      Account ID{sortArrow('hederaAccountId')}
                    </th>
                    <th className="px-3 py-3 font-medium text-muted">EOA</th>
                    <th
                      className="cursor-pointer px-3 py-3 font-medium text-muted hover:text-foreground"
                      onClick={() => handleSort('strategyName')}
                    >
                      Strategy{sortArrow('strategyName')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-right font-medium text-muted hover:text-foreground"
                      onClick={() => handleSort('rakePercent')}
                    >
                      Rake %{sortArrow('rakePercent')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-right font-medium text-muted hover:text-foreground"
                      onClick={() => handleSort('available')}
                    >
                      Available{sortArrow('available')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-right font-medium text-muted hover:text-foreground"
                      onClick={() => handleSort('reserved')}
                    >
                      Reserved{sortArrow('reserved')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 font-medium text-muted hover:text-foreground"
                      onClick={() => handleSort('lastPlayedAt')}
                    >
                      Last Played{sortArrow('lastPlayedAt')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-center font-medium text-muted hover:text-foreground"
                      onClick={() => handleSort('active')}
                    >
                      Status{sortArrow('active')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedUsers.map((u) => (
                    <tr
                      key={u.userId}
                      className="border-b border-secondary transition-colors hover:bg-secondary/30"
                    >
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-foreground">
                        {u.hederaAccountId}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted">
                        {u.eoaAddress}
                      </td>
                      <td className="px-3 py-3">
                        <span className="rounded bg-secondary px-2 py-0.5 text-xs text-muted">
                          {u.strategyName}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-foreground">
                        {u.rakePercent}%
                      </td>
                      <td className="px-3 py-3 text-right font-medium text-brand">
                        {getUserAvailable(u)}
                      </td>
                      <td className="px-3 py-3 text-right text-foreground">
                        {getUserReserved(u)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted">
                        {u.lastPlayedAt ?? 'Never'}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            u.active
                              ? 'bg-success/20 text-success'
                              : 'bg-destructive/20 text-destructive'
                          }`}
                        >
                          {u.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No users registered yet.</p>
          )}
        </div>

        {/* ---- Bottom Row: Dead Letters + Reconciliation ---- */}
        <div className="mb-6 grid gap-6 lg:grid-cols-2">

          {/* ---- Dead Letters Card ---- */}
          <div
            className={`rounded-xl border p-6 shadow ${
              hasDeadLetters
                ? 'border-l-4 border-destructive'
                : 'border-secondary'
            }`}
          >
            <h2 className="mb-4 font-heading text-lg text-foreground">
              Unprocessed Deposits
              {overview && overview.deadLetterCount > 0 && (
                <span className="ml-2 rounded-full bg-destructive/20 px-2 py-0.5 text-xs text-destructive">
                  {overview.deadLetterCount}
                </span>
              )}
            </h2>

            {deadLetters.length > 0 ? (
              <div className="space-y-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-secondary bg-secondary/50 text-left">
                      <th className="px-3 py-3 font-medium text-muted">Transaction ID</th>
                      <th className="px-3 py-3 font-medium text-muted">Timestamp</th>
                      <th className="px-3 py-3 font-medium text-muted">Error</th>
                      <th className="px-3 py-3 font-medium text-muted" />
                    </tr>
                  </thead>
                  <tbody>
                    {deadLetters.map((dl) => (
                      <tr key={dl.transactionId} className="border-b border-secondary">
                        <td className="px-3 py-3 font-mono text-xs text-foreground">
                          {dl.transactionId}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-muted">
                          {dl.timestamp}
                        </td>
                        <td className="px-3 py-3 text-destructive">
                          {dl.error}
                        </td>
                        <td className="px-3 py-3">
                          <button
                            type="button"
                            onClick={() => void handleRefund(dl.transactionId)}
                            className="rounded-md border border-secondary px-3 py-1.5 text-xs text-muted transition-colors hover:border-brand hover:text-brand"
                          >
                            Refund
                          </button>
                          {refundMessages[dl.transactionId] && (
                            <div className="mt-2 rounded bg-secondary px-2 py-1 text-xs text-muted">
                              {refundMessages[dl.transactionId]}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-lg bg-success/10 px-4 py-3">
                <p className="text-sm text-success">
                  No dead letters -- all deposits processed successfully.
                </p>
              </div>
            )}
          </div>

          {/* ---- Reconciliation Card (collapsible) ---- */}
          <div className="rounded-xl border border-secondary p-6 shadow">
            <button
              type="button"
              onClick={() => setReconOpen((prev) => !prev)}
              className="mb-0 flex w-full items-center justify-between text-left"
            >
              <h2 className="font-heading text-lg text-foreground">
                Balance Reconciliation
              </h2>
              <span className="text-sm text-muted">
                {reconOpen ? '\u25B2' : '\u25BC'}
              </span>
            </button>

            {reconOpen && (
              <div className="mt-4">
                <div className="mb-4 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => void handleReconciliation()}
                    disabled={reconRunning}
                    className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {reconRunning ? 'Running...' : 'Run Reconciliation'}
                  </button>
                </div>

                {reconResult ? (
                  <div className="space-y-4">
                    {/* Solvency status */}
                    <div className={`rounded-lg border px-4 py-3 ${
                      reconResult.solvent
                        ? 'border-success/30 bg-success/10'
                        : 'border-destructive/30 bg-destructive/10'
                    }`}>
                      <p className={`text-sm font-semibold ${
                        reconResult.solvent ? 'text-success' : 'text-destructive'
                      }`}>
                        {reconResult.solvent ? '✓ Solvent' : '✗ Insolvent'}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        Checked at {new Date(reconResult.timestamp).toLocaleString()}
                      </p>
                    </div>

                    {/* Per-token deltas table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-secondary text-left">
                            <th className="px-3 py-2 font-medium text-muted">Token</th>
                            <th className="px-3 py-2 text-right font-medium text-muted">On-chain</th>
                            <th className="px-3 py-2 text-right font-medium text-muted">Ledger</th>
                            <th className="px-3 py-2 text-right font-medium text-muted">Raw Δ</th>
                            <th className="px-3 py-2 text-right font-medium text-muted">Adjusted Δ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from(new Set([
                            ...Object.keys(reconResult.onChain),
                            ...Object.keys(reconResult.ledgerTotal),
                          ])).map((token) => {
                            const adjusted = reconResult.adjustedDelta[token] ?? 0;
                            const isShortfall = adjusted < -0.01;
                            const isSurplus = adjusted > 0.01;
                            return (
                              <tr key={token} className="border-b border-secondary/30">
                                <td className="px-3 py-2 font-mono text-xs text-foreground">
                                  {token}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
                                  {(reconResult.onChain[token] ?? 0).toFixed(4)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
                                  {(reconResult.ledgerTotal[token] ?? 0).toFixed(4)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs text-muted">
                                  {(reconResult.delta[token] ?? 0).toFixed(4)}
                                </td>
                                <td className={`px-3 py-2 text-right font-mono text-xs font-semibold ${
                                  isShortfall ? 'text-destructive' : isSurplus ? 'text-success' : 'text-muted'
                                }`}>
                                  {adjusted >= 0 ? '+' : ''}
                                  {adjusted.toFixed(4)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Network fees breakdown */}
                    <div className="rounded-lg bg-secondary/30 px-4 py-3 text-xs text-muted">
                      <p>
                        Mirror node fees: <span className="text-foreground font-mono">
                          {reconResult.actualNetworkFeesHbar.toFixed(4)} HBAR
                        </span>
                      </p>
                      <p>
                        Tracked gas: <span className="text-foreground font-mono">
                          {reconResult.trackedGasHbar.toFixed(4)} HBAR
                        </span>
                      </p>
                      <p>
                        Untracked fees (HBAR delta adjustment): <span className="text-foreground font-mono">
                          {reconResult.untrackedFeesHbar.toFixed(4)} HBAR
                        </span>
                      </p>
                    </div>

                    {/* Warnings */}
                    {reconResult.warnings.length > 0 && (
                      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
                        <p className="mb-2 text-xs font-semibold text-destructive">Warnings</p>
                        <ul className="space-y-1 text-xs text-destructive">
                          {reconResult.warnings.map((w, i) => (
                            <li key={i}>• {w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : reconMessage ? (
                  <div className="rounded-lg bg-secondary px-4 py-3">
                    <p className="text-sm text-muted">{reconMessage}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted">
                    Click &quot;Run Reconciliation&quot; to compare on-chain balances against
                    the internal ledger and verify solvency.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ---- Operator Balance Card (collapsible) ---- */}
        <div className="rounded-xl border border-secondary p-6 shadow">
          <button
            type="button"
            onClick={() => setOperatorOpen((prev) => !prev)}
            className="flex w-full items-center justify-between text-left"
          >
            <h2 className="font-heading text-lg text-foreground">
              Operator Balance
            </h2>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleWithdrawFees();
                }}
                className="rounded-md bg-brand px-4 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
              >
                Withdraw Fees
              </button>
              <span className="text-sm text-muted">
                {operatorOpen ? '\u25B2' : '\u25BC'}
              </span>
            </div>
          </button>

          {operatorOpen && (
            <div className="mt-4">
              {operatorBalances.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-secondary bg-secondary/50 text-left">
                        <th className="px-4 py-3 font-medium text-muted">Token</th>
                        <th className="px-4 py-3 text-right font-medium text-muted">Rake Collected</th>
                        <th className="px-4 py-3 text-right font-medium text-muted">Gas Spent</th>
                        <th className="px-4 py-3 text-right font-medium text-muted">Net Profit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {operatorBalances.map((ob) => (
                        <tr key={ob.token} className="border-b border-secondary">
                          <td className="px-4 py-3">
                            <span className="font-medium text-foreground">{ob.token}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-brand">
                            {fmt(ob.rakeCollected)}
                          </td>
                          <td className="px-4 py-3 text-right text-foreground">
                            {fmt(ob.gasSpent, 2)}
                          </td>
                          <td className={`px-4 py-3 text-right font-medium ${
                            ob.netProfit < 0 ? 'text-destructive' : 'text-success'
                          }`}>
                            {ob.netProfit < 0 ? '' : '+'}{fmt(ob.netProfit, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted">No operator balance data available.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Withdraw Fees modal ─────────────────────────────── */}
      {withdrawFeesOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !withdrawFeesLoading && setWithdrawFeesOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-secondary bg-background p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 font-heading text-lg text-foreground">
              Withdraw Operator Fees
            </h3>
            <p className="mb-5 text-xs text-muted">
              Sends accumulated rake from the agent wallet to the operator
              withdrawal address. If <code className="font-mono">OPERATOR_WITHDRAW_ADDRESS</code>{' '}
              is set in the environment, it overrides the recipient field below.
            </p>

            <div className="mb-4">
              <label htmlFor="wf-token" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                Token
              </label>
              <select
                id="wf-token"
                value={withdrawFeesToken}
                onChange={(e) => setWithdrawFeesToken(e.target.value as 'HBAR' | 'LAZY')}
                disabled={withdrawFeesLoading}
                className="w-full rounded-lg border border-secondary bg-secondary/30 px-4 py-2.5 text-sm text-foreground focus:border-brand focus:outline-none disabled:opacity-50"
              >
                <option value="HBAR">HBAR</option>
                <option value="LAZY">LAZY</option>
              </select>
            </div>

            <div className="mb-4">
              <label htmlFor="wf-amount" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                Amount
              </label>
              <input
                id="wf-amount"
                type="number"
                min="0"
                step="any"
                value={withdrawFeesAmount}
                onChange={(e) => setWithdrawFeesAmount(e.target.value)}
                disabled={withdrawFeesLoading}
                placeholder="0.00"
                className="w-full rounded-lg border border-secondary bg-secondary/30 px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-brand focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="mb-5">
              <label htmlFor="wf-to" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                Recipient (optional — env var overrides)
              </label>
              <input
                id="wf-to"
                type="text"
                value={withdrawFeesTo}
                onChange={(e) => setWithdrawFeesTo(e.target.value)}
                disabled={withdrawFeesLoading}
                placeholder="0.0.XXXXXX"
                className="w-full rounded-lg border border-secondary bg-secondary/30 px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-brand focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setWithdrawFeesOpen(false)}
                disabled={withdrawFeesLoading}
                className="flex-1 rounded-lg border border-secondary px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitWithdrawFees}
                disabled={withdrawFeesLoading || !withdrawFeesAmount}
                className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {withdrawFeesLoading ? 'Withdrawing…' : 'Confirm Withdraw'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
