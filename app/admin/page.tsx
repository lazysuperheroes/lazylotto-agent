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

  const [reconRunning, setReconRunning] = useState(false);
  const [reconMessage, setReconMessage] = useState<string | null>(null);
  const [reconOpen, setReconOpen] = useState(false);

  const [operatorOpen, setOperatorOpen] = useState(false);

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

    async function loadDashboard() {
      try {
        const [overviewRes, usersRes, dlRes] = await Promise.all([
          authFetch('/api/admin/overview'),
          authFetch('/api/admin/users'),
          authFetch('/api/admin/dead-letters'),
        ]);

        if (cancelled) return;

        if (!overviewRes.ok || !usersRes.ok || !dlRes.ok) {
          const failedRes = [overviewRes, usersRes, dlRes].find((r) => !r.ok);
          const body = failedRes ? await failedRes.json().catch(() => ({})) : {};
          setError((body as { error?: string }).error ?? `Request failed with status ${failedRes?.status}`);
          setLoading(false);
          return;
        }

        const overviewData: OverviewResponse = await overviewRes.json();
        const usersData: UsersResponse = await usersRes.json();
        const dlData: DeadLettersResponse = await dlRes.json();

        if (cancelled) return;

        setOverview(overviewData);
        setUsers(usersData.users);
        setDeadLetters(dlData.deadLetters);
        setOperatorBalances(deriveOperatorBalances(overviewData.operator));
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.message === 'forbidden') return;
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
        setLoading(false);
      }
    }

    void loadDashboard();
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

    try {
      const res = await authFetch('/api/admin/reconcile', { method: 'POST' });
      const body = await res.json();

      if (res.status === 501) {
        setReconMessage((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? 'Not implemented');
      } else if (!res.ok) {
        setReconMessage((body as { error?: string }).error ?? `Reconciliation failed (${res.status})`);
      } else {
        setReconMessage('Reconciliation completed successfully.');
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
    alert(
      'Fee withdrawal requires CLI access with a live Hedera client.\n\n' +
        'Use: npm run dev:http and call POST /api/admin/withdraw-fees on the HTTP server.',
    );
  }, []);

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

                {reconMessage ? (
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
    </div>
  );
}
