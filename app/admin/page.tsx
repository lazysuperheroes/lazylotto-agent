'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '../components/Toast';
import { Modal } from '../components/Modal';
import { ComicPanel } from '../components/ComicPanel';
import { SkeletonBox } from '../components/SkeletonBox';

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

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Never';
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
// SkeletonBox itself lives in components/SkeletonBox.tsx — shared across
// dashboard, account, audit, and admin so the placeholder treatment is
// the same everywhere.
// ---------------------------------------------------------------------------

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
          <div key={i} className="border-2 border-secondary bg-[var(--color-panel)] p-4">
            <SkeletonBox className="mb-2 h-3 w-24" />
            <SkeletonBox className="h-7 w-32" />
          </div>
        ))}
      </div>

      {/* Managed Users table */}
      <div className="mb-6 border-2 border-secondary bg-[var(--color-panel)] p-6">
        <SkeletonBox className="mb-4 h-5 w-32" />
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <SkeletonBox className="h-4 w-24" />
              <SkeletonBox className="h-4 w-32" />
              <SkeletonBox className="h-4 w-20" />
              <SkeletonBox className="h-4 w-24" />
              <SkeletonBox className="h-6 w-16" />
            </div>
          ))}
        </div>
      </div>

      {/* Two-column row: Dead letters + Reconciliation */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="border-2 border-secondary bg-[var(--color-panel)] p-6">
          <SkeletonBox className="mb-4 h-5 w-40" />
          <SkeletonBox className="h-12 w-full" />
        </div>
        <div className="border-2 border-secondary bg-[var(--color-panel)] p-6">
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
  const router = useRouter();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [operatorBalances, setOperatorBalances] = useState<OperatorBalanceRow[]>([]);

  // Monitoring panel state — daily aggregates from /api/admin/monitoring.
  // The endpoint walks the HCS-20 audit topic and bins events by UTC
  // day, so this is a "real-ish-time" view of activity without
  // requiring a snapshot table.
  interface MonitoringDay {
    date: string;
    deposits: { count: number; totalHbar: number };
    plays: { count: number; totalHbar: number };
    wins: { count: number; totalHbar: number; nftCount: number };
    activeUsers: number;
  }
  interface MonitoringResponse {
    days: MonitoringDay[];
    summary: {
      totalDays: number;
      activeUsersLast7d: number;
      activeUsersLast30d: number;
      depositVelocity7d: number;
      playVelocity7d: number;
    } | null;
  }
  const [monitoring, setMonitoring] = useState<MonitoringResponse | null>(null);
  const [monitoringLoading, setMonitoringLoading] = useState(false);

  // Reconciliation state
  interface SchemaVersionReport {
    current: number;
    users: Record<number, number>;
    operator: number;
    allAtCurrent: boolean;
  }
  interface ReconciliationResult {
    timestamp: string;
    onChain: Record<string, number>;
    ledgerTotal: Record<string, number>;
    actualNetworkFeesHbar: number;
    trackedGasHbar: number;
    untrackedFeesHbar: number;
    delta: Record<string, number>;
    adjustedDelta: Record<string, number>;
    /**
     * Display symbols keyed by token ID. "hbar" → "HBAR",
     * "0.0.6011249" → "LAZY", etc. Populated server-side from the
     * token registry. Falls back to the raw token ID if mirror node
     * lookup fails. Optional in case an old reconcile response is
     * cached without it — render fall back to raw ID then.
     */
    symbols?: Record<string, string>;
    solvent: boolean;
    warnings: string[];
    /**
     * Schema version divergence report. Surfaces which records are
     * behind the current schema version. v0 = legacy/unstamped (pre
     * PR4), v1 = current. Operators can run the migrate-schema
     * endpoint to clear drift; until then v0 records remain readable
     * because v0 and v1 are structurally identical.
     */
    schema?: SchemaVersionReport;
  }
  const [reconRunning, setReconRunning] = useState(false);
  const [reconMessage, setReconMessage] = useState<string | null>(null);
  const [reconResult, setReconResult] = useState<ReconciliationResult | null>(null);
  const [reconOpen, setReconOpen] = useState(false);
  // Schema migration state — driven by the Schema Status section's
  // "Migrate to current" button which posts to /api/admin/migrate-schema
  // and refreshes the recon result on success.
  const [migrateLoading, setMigrateLoading] = useState(false);

  const [operatorOpen, setOperatorOpen] = useState(false);

  // Withdraw fees modal state
  const [withdrawFeesOpen, setWithdrawFeesOpen] = useState(false);
  const [withdrawFeesAmount, setWithdrawFeesAmount] = useState('');
  const [withdrawFeesTo, setWithdrawFeesTo] = useState('');
  const [withdrawFeesToken, setWithdrawFeesToken] = useState<'HBAR' | 'LAZY'>('HBAR');
  const [withdrawFeesLoading, setWithdrawFeesLoading] = useState(false);

  // Kill switch state
  interface KillSwitchState {
    enabled: boolean;
    reason?: string;
    enabledAt?: string;
    enabledBy?: string;
  }
  const [killSwitch, setKillSwitch] = useState<KillSwitchState | null>(null);
  const [killSwitchLoading, setKillSwitchLoading] = useState(false);
  const [killSwitchModalOpen, setKillSwitchModalOpen] = useState(false);
  const [killSwitchReason, setKillSwitchReason] = useState('');

  const [sortColumn, setSortColumn] = useState<string>('hederaAccountId');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Set page title
  useEffect(() => {
    document.title = 'Administration | LazyLotto Agent';
  }, []);

  // ------------------------------------------------------------------
  // Auth-aware fetch helper
  // ------------------------------------------------------------------
  //
  // Pure: injects the Authorization header, handles 401 (universally
  // fatal — no valid session means nothing on this page can work, so
  // we redirect to /auth immediately), and returns the response for
  // every other status. The caller decides what to do with 403/404/5xx
  // because each call site has different criticality:
  //
  //   - /api/admin/overview: critical path. 403 = page denied.
  //   - /api/admin/users / dead-letters / killswitch (GET): optional.
  //     403 = silent skip, the corresponding card just doesn't render.
  //   - mutation handlers (refund / withdraw-fees / killswitch POST):
  //     403 = toast on the affected action, leave the rest of the page
  //     working.
  //
  // The previous version set a global `error` state on any 403 and
  // threw 'forbidden', which meant ANY parallel admin call returning
  // 403 tipped the whole page into the denied state — even when other
  // calls were succeeding. That was the killswitch-tier-mismatch bug
  // hidden in plain sight.
  const authFetch = useCallback(
    async (url: string, options?: RequestInit): Promise<Response> => {
      const token = localStorage.getItem('lazylotto:sessionToken');
      if (!token) {
        router.replace('/auth');
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
        router.replace('/auth?expired=1');
        return new Promise(() => {});
      }

      return res;
    },
    [router],
  );

  // ------------------------------------------------------------------
  // Load data on mount
  // ------------------------------------------------------------------
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
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
        if (res.status === 403) {
          // Critical-path 403: the user authenticated but doesn't have
          // admin tier. The whole page can't render meaningfully without
          // overview data, so set the global error and let the denied
          // state render. Other parallel calls (users, killswitch, etc)
          // are now allowed to fail independently without tripping this.
          setError('Insufficient permissions. Admin access required.');
          return;
        }
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

    void (async () => {
      try {
        const res = await authFetch('/api/admin/killswitch');
        if (cancelled || !res.ok) return;
        const data: KillSwitchState = await res.json();
        if (cancelled) return;
        setKillSwitch(data);
      } catch {
        /* silent failure — kill switch card just won't render */
      }
    })();

    // Monitoring panel — pulls daily aggregates from the audit
    // topic. Slower than the other fetches (mirror node walk) so
    // it's the lowest-priority and renders independently. Failure
    // is silent — the panel just doesn't appear.
    void (async () => {
      setMonitoringLoading(true);
      try {
        const res = await authFetch('/api/admin/monitoring');
        if (cancelled || !res.ok) return;
        const data: MonitoringResponse = await res.json();
        if (cancelled) return;
        setMonitoring(data);
      } catch {
        /* silent — monitoring panel just won't render */
      } finally {
        if (!cancelled) setMonitoringLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authFetch, router]);

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

      if (res.status === 403) {
        setReconMessage('Insufficient permissions for reconciliation.');
      } else if (res.status === 501) {
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
      setReconMessage(err instanceof Error ? err.message : 'Reconciliation request failed');
    } finally {
      setReconRunning(false);
    }
  }, [authFetch]);

  // --- Migrate schema ---
  // Re-stamps every user record + the operator state with the current
  // schemaVersion. Idempotent: safe to run when there's no drift, just
  // returns "0 migrated". Re-runs reconciliation on success so the
  // Schema Status section updates inline without a manual refresh.
  const handleMigrateSchema = useCallback(async () => {
    setMigrateLoading(true);
    try {
      const res = await authFetch('/api/admin/migrate-schema', {
        method: 'POST',
      });
      if (res.status === 403) {
        toast('Migration failed: insufficient permissions', { variant: 'error' });
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(
          `Migration failed: ${(body as { error?: string }).error ?? res.status}`,
          { variant: 'error' },
        );
        return;
      }
      const result = body as {
        usersMigrated: number;
        usersBehindBefore: number;
        operatorMigrated: boolean;
      };
      const usersWord = result.usersMigrated === 1 ? 'record' : 'records';
      toast(
        `Migrated ${result.usersMigrated} user ${usersWord} + operator state`,
      );
      // Re-run reconciliation so the Schema Status section reflects
      // the post-migration state without a manual click.
      await handleReconciliation();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Migration request failed';
      toast(`Migration failed: ${message}`, { variant: 'error' });
    } finally {
      setMigrateLoading(false);
    }
  }, [authFetch, toast, handleReconciliation]);

  // --- Refund dead letter ---
  // Feedback flows through toast() (success/error variants) for parity
  // with the Play/Withdraw UX. Also removes the dead-letter row from
  // the in-memory list on success so the table updates immediately.
  const handleRefund = useCallback(
    async (transactionId: string) => {
      try {
        const res = await authFetch('/api/admin/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactionId }),
        });

        if (res.status === 403) {
          toast('Refund failed: insufficient permissions', { variant: 'error' });
          return;
        }

        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          const message =
            (body as { error?: string }).error ??
            `Refund failed (${res.status})`;
          toast(`Refund failed: ${message}`, { variant: 'error' });
          return;
        }

        toast(`Refund processed for ${transactionId}`);
        setDeadLetters((prev) =>
          prev.filter((dl) => dl.transactionId !== transactionId),
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Refund request failed';
        toast(`Refund failed: ${message}`, { variant: 'error' });
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
      toast('Enter a valid amount greater than 0', { variant: 'error' });
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
      if (res.status === 403) {
        throw new Error('Insufficient permissions for fee withdrawal');
      }
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
      toast(`Fee withdrawal failed: ${message}`, { variant: 'error' });
    } finally {
      setWithdrawFeesLoading(false);
    }
  }, [withdrawFeesAmount, withdrawFeesTo, withdrawFeesToken, authFetch, toast]);

  // --- Kill switch ---
  // Opens the reason-prompt modal. Submission happens in submitEnableKillSwitch
  // below so the UX matches the rest of the app (branded modal, focus trap,
  // Escape to cancel) rather than the unstyled, untrappable window.prompt.
  const handleEnableKillSwitch = useCallback(() => {
    setKillSwitchReason('');
    setKillSwitchModalOpen(true);
  }, []);

  const submitEnableKillSwitch = useCallback(async () => {
    const reason = killSwitchReason.trim();
    if (!reason) {
      toast('Reason is required', { variant: 'error' });
      return;
    }
    setKillSwitchLoading(true);
    try {
      const res = await authFetch('/api/admin/killswitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.status === 403) {
        throw new Error('Insufficient permissions to engage kill switch');
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error ?? `Failed (${res.status})`,
        );
      }
      setKillSwitch(body as KillSwitchState);
      toast('Kill switch ENABLED — new plays and registrations blocked');
      setKillSwitchModalOpen(false);
      setKillSwitchReason('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Kill switch enable failed: ${message}`, { variant: 'error' });
    } finally {
      setKillSwitchLoading(false);
    }
  }, [authFetch, killSwitchReason, toast]);

  const handleDisableKillSwitch = useCallback(async () => {
    setKillSwitchLoading(true);
    try {
      const res = await authFetch('/api/admin/killswitch', { method: 'DELETE' });
      if (res.status === 403) {
        throw new Error('Insufficient permissions to disable kill switch');
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error ?? `Failed (${res.status})`,
        );
      }
      setKillSwitch({ enabled: false });
      toast('Kill switch disabled — operations resumed');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Kill switch disable failed: ${message}`, { variant: 'error' });
    } finally {
      setKillSwitchLoading(false);
    }
  }, [authFetch, toast]);

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
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <ComicPanel label="DENIED" tone="destructive" halftone="none">
            <div className="p-8 text-center">
              <p className="label-caps-destructive mb-3">Access denied</p>
              <h1 className="display-md mb-3 text-foreground">
                Operator only
              </h1>
              <p className="type-body prose-width mx-auto mb-6 text-muted">
                {error}
              </p>
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem('lazylotto:sessionToken');
                  localStorage.removeItem('lazylotto:accountId');
                  localStorage.removeItem('lazylotto:tier');
                  localStorage.removeItem('lazylotto:expiresAt');
                  localStorage.removeItem('lazylotto:locked');
                  router.replace('/auth');
                }}
                className="btn-primary-sm"
              >
                Return to login
              </button>
            </div>
          </ComicPanel>
        </div>
      </div>
    );
  }

  const hasDeadLetters = overview ? overview.deadLetterCount > 0 : false;

  // --- Admin Dashboard ---
  return (
    <div className="w-full px-4 py-10 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        {/* ---- Top Bar ──────────────────────────────────────
            Admin header mirrors the dashboard header but with the
            calm, deliberate tone the brief prescribes for operator
            surfaces — no mascot, no gold flourish, just a clear
            chapter title. */}
        <header className="mb-10">
          <p className="label-caps-lg mb-2">Operator view</p>
          <h1 className="display-md text-foreground">Agent Administration</h1>
        </header>

        {/* ---- Kill Switch ──────────────────────────────────
            Always visible at the top of the admin page. Tone flips
            from muted (normal ops) to destructive (engaged) so the
            operator can't miss the state at a glance. */}
        {killSwitch && (
          <div className="mb-8">
            <ComicPanel
              label={killSwitch.enabled ? 'ENGAGED' : 'STANDBY'}
              tone={killSwitch.enabled ? 'destructive' : 'muted'}
              halftone="none"
            >
              <div className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        killSwitch.enabled ? 'bg-destructive' : 'bg-success'
                      }`}
                    />
                    <p className="label-caps">Kill switch</p>
                    <p
                      className={`heading-2 uppercase tracking-wider ${
                        killSwitch.enabled ? 'text-destructive' : 'text-success'
                      }`}
                    >
                      {killSwitch.enabled ? 'Engaged' : 'Standby'}
                    </p>
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    {killSwitch.enabled
                      ? 'New plays and registrations are blocked. Withdrawals and reads remain available.'
                      : 'Operations are running normally. Engage to pause new plays and registrations during an incident.'}
                  </p>
                  {killSwitch.enabled && killSwitch.reason && (
                    <p className="mt-2 border-l-2 border-destructive bg-background/40 px-3 py-2 text-xs text-foreground">
                      <span className="label-caps mr-2">Reason</span>
                      <span className="font-mono">{killSwitch.reason}</span>
                      {killSwitch.enabledBy && (
                        <>
                          {' '}
                          <span className="label-caps mx-1">by</span>
                          <span className="font-mono text-muted">{killSwitch.enabledBy}</span>
                        </>
                      )}
                      {killSwitch.enabledAt && (
                        <>
                          {' '}
                          <span className="label-caps mx-1">at</span>
                          <span className="font-mono text-muted">
                            {formatTimestamp(killSwitch.enabledAt)}
                          </span>
                        </>
                      )}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (killSwitch.enabled) void handleDisableKillSwitch();
                    else void handleEnableKillSwitch();
                  }}
                  disabled={killSwitchLoading}
                  className={`shrink-0 border-2 px-4 py-2 font-pixel text-[10px] uppercase tracking-wider transition-colors disabled:opacity-50 ${
                    killSwitch.enabled
                      ? 'border-success bg-success text-background hover:opacity-90'
                      : 'border-destructive bg-destructive text-foreground hover:opacity-90'
                  }`}
                >
                  {killSwitchLoading ? '...' : killSwitch.enabled ? 'Disengage' : 'Engage'}
                </button>
              </div>
            </ComicPanel>
          </div>
        )}

        {/* ---- Overview Banner ──────────────────────────────
            Operator stats at the top — gold tone because these ARE
            real user data (actual counts, actual amounts), per the
            design reference "if showing real user data, a prominent
            metric can work". Four tiles in a clean grid with
            small-caps labels. */}
        {overview && (
          <div className="mb-8">
            <ComicPanel label="OVERVIEW" tone="muted" halftone="none">
              <div className="grid grid-cols-2 gap-0 divide-x divide-y divide-secondary md:grid-cols-4 md:divide-y-0">
                <div className="p-6">
                  <p className="label-caps mb-2">Active users</p>
                  <p className="num-tabular heading-1 text-foreground">
                    {overview.users.active}
                  </p>
                  <p className="type-caption mt-1">
                    of {overview.users.total} total
                  </p>
                </div>
                <div className="p-6">
                  <p className="label-caps mb-2">Deposited</p>
                  <p className="num-tabular heading-1 text-foreground">
                    {summariseTokenMap(overview.balances.totalDeposited)}
                  </p>
                </div>
                <div className="p-6">
                  <p className="label-caps mb-2">Operator rake</p>
                  <p className="num-tabular heading-1 text-foreground">
                    {summariseTokenMap(overview.operator.totalRakeCollected)}
                  </p>
                </div>
                <div className="p-6">
                  <p className="label-caps mb-2">Gas spent</p>
                  <p className="num-tabular heading-1 text-foreground">
                    {fmt(overview.operator.totalGasSpent, 2)}{' '}
                    <span className="type-caption text-muted">HBAR</span>
                  </p>
                </div>
              </div>
            </ComicPanel>
          </div>
        )}

        {/* ---- Users Table ──────────────────────────────────
            Managed users wrapped in a calm muted-tone ComicPanel.
            Table itself keeps the existing density — admin tables
            need information bandwidth, not decorative spacing. */}
        <div className="mb-8">
          <ComicPanel label="USERS" tone="muted" halftone="none">
            <div className="border-b border-secondary px-5 py-4">
              <p className="label-caps-lg mb-1">Managed users</p>
              <p className="type-caption">
                Click a column to sort. Columns scroll horizontally on narrow viewports.
              </p>
            </div>
          {sortedUsers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead>
                  <tr className="border-b border-secondary bg-secondary/50 text-left">
                    <th
                      className="cursor-pointer px-3 py-3 label-caps hover:text-foreground"
                      onClick={() => handleSort('hederaAccountId')}
                    >
                      Account ID{sortArrow('hederaAccountId')}
                    </th>
                    <th className="px-3 py-3 label-caps">EOA</th>
                    <th
                      className="cursor-pointer px-3 py-3 label-caps hover:text-foreground"
                      onClick={() => handleSort('strategyName')}
                    >
                      Strategy{sortArrow('strategyName')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-right label-caps hover:text-foreground"
                      onClick={() => handleSort('rakePercent')}
                    >
                      Rake %{sortArrow('rakePercent')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-right label-caps hover:text-foreground"
                      onClick={() => handleSort('available')}
                    >
                      Available{sortArrow('available')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-right label-caps hover:text-foreground"
                      onClick={() => handleSort('reserved')}
                    >
                      Reserved{sortArrow('reserved')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 label-caps hover:text-foreground"
                      onClick={() => handleSort('lastPlayedAt')}
                    >
                      Last Played{sortArrow('lastPlayedAt')}
                    </th>
                    <th
                      className="cursor-pointer px-3 py-3 text-center label-caps hover:text-foreground"
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
                        <span className="border border-secondary bg-[var(--color-panel)] px-2 py-0.5 text-xs text-muted">
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
                        {formatTimestamp(u.lastPlayedAt)}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span
                          className={`inline-block border px-2 py-0.5 text-xs ${
                            u.active
                              ? 'border-success/60 bg-success/10 text-success'
                              : 'border-destructive/60 bg-destructive/10 text-destructive'
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
            <p className="px-5 py-8 text-center text-sm text-muted">
              No users registered yet.
            </p>
          )}
          </ComicPanel>
        </div>

        {/* ---- Bottom Row: Dead Letters + Reconciliation ──── */}
        <div className="mb-8 grid gap-6 lg:grid-cols-2">

          {/* ---- Dead Letters Card ─────────────────────────
              Tone flips from muted (clean state) to destructive
              (has dead letters) so the operator sees it at a glance. */}
          <ComicPanel
            label={hasDeadLetters ? 'UNPROCESSED' : 'CLEAN'}
            tone={hasDeadLetters ? 'destructive' : 'muted'}
            halftone="none"
          >
            <div className="flex items-center justify-between border-b border-secondary px-5 py-4">
              <p className="label-caps">Unprocessed deposits</p>
              {overview && overview.deadLetterCount > 0 && (
                <span className="border border-destructive bg-destructive/10 px-2 py-0.5 font-pixel text-[9px] uppercase tracking-wider text-destructive">
                  {overview.deadLetterCount} stuck
                </span>
              )}
            </div>

            {deadLetters.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-secondary text-left">
                      <th className="px-5 py-3 label-caps">Transaction ID</th>
                      <th className="px-5 py-3 label-caps">Timestamp</th>
                      <th className="px-5 py-3 label-caps">Error</th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-secondary">
                    {deadLetters.map((dl) => (
                      <tr key={dl.transactionId} className="transition-colors hover:bg-secondary/20">
                        <td className="px-5 py-3 font-mono text-xs text-foreground">
                          {dl.transactionId}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-xs text-muted">
                          {formatTimestamp(dl.timestamp)}
                        </td>
                        <td className="px-5 py-3 text-xs text-destructive">
                          {dl.error}
                        </td>
                        <td className="px-5 py-3">
                          <button
                            type="button"
                            onClick={() => void handleRefund(dl.transactionId)}
                            className="border border-secondary px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted transition-colors hover:border-brand hover:text-brand"
                          >
                            Refund
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-5 py-6 text-center">
                <p className="font-pixel text-[10px] uppercase tracking-wider text-success">
                  ✓ All clear
                </p>
                <p className="mt-1 text-xs text-muted">
                  All deposits processed successfully.
                </p>
              </div>
            )}
          </ComicPanel>

          {/* ---- Monitoring Panel ─────────────────────────
              Daily aggregates from /api/admin/monitoring which
              walks the HCS-20 audit topic and bins events by
              UTC day. Shows velocity (deposits/plays per day),
              active user counts, and a 14-day activity strip.
              Lightweight — no snapshot tables, just real-ish-
              time read of the audit topic.
              -- */}
          {monitoring && monitoring.summary && monitoring.days.length > 0 && (
            <ComicPanel label="MONITORING" tone="muted" halftone="none">
              <div className="px-5 py-5">
                {/* Top row: rolling summary stats */}
                <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div>
                    <p className="label-caps mb-1">Active 7d</p>
                    <p className="num-tabular type-body text-foreground">
                      {monitoring.summary.activeUsersLast7d}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps mb-1">Active 30d</p>
                    <p className="num-tabular type-body text-foreground">
                      {monitoring.summary.activeUsersLast30d}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps mb-1">Deposits/day (7d avg)</p>
                    <p className="num-tabular type-body text-success">
                      {monitoring.summary.depositVelocity7d}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps mb-1">Plays/day (7d avg)</p>
                    <p className="num-tabular type-body text-info">
                      {monitoring.summary.playVelocity7d}
                    </p>
                  </div>
                </div>

                {/* Last 14 days table */}
                <div>
                  <p className="label-caps mb-2">Last 14 days</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-secondary text-left text-muted">
                          <th className="px-2 py-1.5 label-caps">Date</th>
                          <th className="px-2 py-1.5 label-caps text-right">Deposits</th>
                          <th className="px-2 py-1.5 label-caps text-right">+HBAR</th>
                          <th className="px-2 py-1.5 label-caps text-right">Plays</th>
                          <th className="px-2 py-1.5 label-caps text-right">−HBAR</th>
                          <th className="px-2 py-1.5 label-caps text-right">Wins</th>
                          <th className="px-2 py-1.5 label-caps text-right">Active</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monitoring.days.slice(-14).reverse().map((day) => (
                          <tr key={day.date} className="border-b border-secondary/30">
                            <td className="px-2 py-1 font-mono text-foreground/80">{day.date}</td>
                            <td className="px-2 py-1 text-right num-tabular text-success">
                              {day.deposits.count || ''}
                            </td>
                            <td className="px-2 py-1 text-right num-tabular text-success">
                              {day.deposits.totalHbar > 0 ? `+${day.deposits.totalHbar}` : ''}
                            </td>
                            <td className="px-2 py-1 text-right num-tabular text-info">
                              {day.plays.count || ''}
                            </td>
                            <td className="px-2 py-1 text-right num-tabular text-info">
                              {day.plays.totalHbar > 0 ? `−${day.plays.totalHbar}` : ''}
                            </td>
                            <td className="px-2 py-1 text-right num-tabular text-brand">
                              {day.wins.count || ''}
                              {day.wins.nftCount > 0 && (
                                <span className="text-[10px] text-muted/60"> +{day.wins.nftCount}n</span>
                              )}
                            </td>
                            <td className="px-2 py-1 text-right num-tabular text-foreground">
                              {day.activeUsers || ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-[11px] italic text-muted/60">
                    Data sourced from the HCS-20 audit topic. Cached for 60s.
                    Days with no activity are omitted.
                  </p>
                </div>
              </div>
            </ComicPanel>
          )}
          {monitoring === null && monitoringLoading && (
            <ComicPanel label="MONITORING" tone="muted" halftone="none">
              <div className="px-5 py-5">
                <p className="text-xs text-muted">
                  Loading daily aggregates from the audit topic…
                </p>
              </div>
            </ComicPanel>
          )}

          {/* ---- Reconciliation Card (collapsible) ─────── */}
          <ComicPanel label="RECONCILE" tone="muted" halftone="none">
            <button
              type="button"
              onClick={() => setReconOpen((prev) => !prev)}
              className="flex w-full items-center justify-between px-5 py-4 text-left"
            >
              <div>
                <p className="label-caps-lg mb-1">Balance reconciliation</p>
                <p className="heading-2 text-foreground">
                  Compare on-chain vs ledger
                </p>
              </div>
              <span
                className={`font-pixel text-[10px] text-brand transition-transform ${
                  reconOpen ? 'rotate-90' : ''
                }`}
                aria-hidden="true"
              >
                ▸
              </span>
            </button>

            {reconOpen && (
              <div className="border-t border-secondary px-5 pb-5 pt-4">
                <div className="mb-4 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => void handleReconciliation()}
                    disabled={reconRunning}
                    className="btn-ghost-sm-brand"
                  >
                    {reconRunning ? 'Running…' : 'Run reconciliation'}
                  </button>
                </div>

                {reconResult ? (
                  <div className="space-y-4">
                    {/* Solvency status */}
                    <div className={`border-l-2 px-4 py-3 ${
                      reconResult.solvent
                        ? 'border-success bg-success/10'
                        : 'border-destructive bg-destructive/10'
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
                            <th className="px-3 py-2 label-caps">Token</th>
                            <th className="px-3 py-2 text-right label-caps">On-chain</th>
                            <th className="px-3 py-2 text-right label-caps">Ledger</th>
                            <th className="px-3 py-2 text-right label-caps">Raw Δ</th>
                            <th className="px-3 py-2 text-right label-caps">Adjusted Δ</th>
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
                            // Symbol from server-side enrichment. Falls
                            // back to the raw token ID if the registry
                            // didn't know about it (mirror node lookup
                            // failed during reconcile).
                            const symbol = reconResult.symbols?.[token] ?? token;
                            const isHbar = token === 'hbar';
                            return (
                              <tr key={token} className="border-b border-secondary/30">
                                <td className="px-3 py-2 text-xs">
                                  <div className="font-semibold text-foreground">
                                    {symbol}
                                  </div>
                                  {!isHbar && symbol !== token && (
                                    <div className="font-mono text-[10px] text-muted">
                                      {token}
                                    </div>
                                  )}
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
                    <div className="border border-secondary bg-[var(--color-panel)] px-4 py-3 text-xs text-muted">
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

                    {/* Warnings — real concerns only (insolvency,
                        unaccounted, fee fetch failures, queued ledger
                        adjustments). Schema drift is no longer mixed
                        in here; it has its own informational section
                        below so the destructive panel reflects actual
                        actionable problems. */}
                    {reconResult.warnings.length > 0 && (
                      <div className="border-l-2 border-destructive bg-destructive/10 px-4 py-3">
                        <p className="label-caps-destructive mb-2">Warnings</p>
                        <ul className="space-y-1 text-xs text-destructive">
                          {reconResult.warnings.map((w, i) => (
                            <li key={i}>• {w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Schema status — informational section, separate
                        from warnings. Shows which records are at the
                        current schema version vs behind, plus a one-
                        click migration button when drift exists.
                        Calm/muted tone because it's not an alarm —
                        v0 (legacy/unstamped) and v1 are structurally
                        identical, drift just means some records were
                        written before the schemaVersion field existed.
                        Active users converge naturally; the migration
                        button re-stamps inactive ones. */}
                    {reconResult.schema && (
                      <div
                        className={`border-l-2 px-4 py-3 ${
                          reconResult.schema.allAtCurrent
                            ? 'border-success bg-success/5'
                            : 'border-brand bg-brand/5'
                        }`}
                      >
                        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
                          <p className="label-caps">Schema status</p>
                          {!reconResult.schema.allAtCurrent && (
                            <button
                              type="button"
                              onClick={() => void handleMigrateSchema()}
                              disabled={migrateLoading || reconRunning}
                              className="border border-brand bg-brand/10 px-3 py-1 font-pixel text-[9px] uppercase tracking-wider text-brand transition-colors hover:bg-brand hover:text-background disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {migrateLoading
                                ? 'Migrating…'
                                : `Migrate to v${reconResult.schema.current}`}
                            </button>
                          )}
                        </div>
                        {reconResult.schema.allAtCurrent ? (
                          <p className="text-xs text-success">
                            ✓ All records at v{reconResult.schema.current}
                          </p>
                        ) : (
                          <div className="space-y-1 text-xs text-muted">
                            <p>
                              Current version:{' '}
                              <span className="text-foreground font-mono">
                                v{reconResult.schema.current}
                              </span>
                            </p>
                            <p>
                              Users:{' '}
                              {Object.entries(reconResult.schema.users).map(
                                ([v, count], i, arr) => (
                                  <span key={v}>
                                    <span className="font-mono text-foreground">
                                      {count}
                                    </span>{' '}
                                    at v{v}
                                    {i < arr.length - 1 ? ', ' : ''}
                                  </span>
                                ),
                              )}
                            </p>
                            <p>
                              Operator:{' '}
                              <span className="font-mono text-foreground">
                                v{reconResult.schema.operator}
                              </span>
                            </p>
                            <p className="mt-2 text-[11px] italic">
                              Records written before the schemaVersion
                              field existed are counted as v0. v0 and v
                              {reconResult.schema.current} are
                              structurally identical — migration just
                              re-stamps the field so the drift report
                              clears. Safe to run anytime; idempotent.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : reconMessage ? (
                  <div className="border border-secondary bg-[var(--color-panel)] px-4 py-3">
                    <p className="text-xs text-muted">{reconMessage}</p>
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    Click <span className="font-semibold text-brand">Run Reconciliation</span> to compare
                    on-chain balances against the internal ledger and verify solvency.
                  </p>
                )}
              </div>
            )}
          </ComicPanel>
        </div>

        {/* ---- Operator Balance Card (collapsible) ─────── */}
        <ComicPanel label="OPERATOR" tone="muted" halftone="none">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <button
              type="button"
              onClick={() => setOperatorOpen((prev) => !prev)}
              aria-expanded={operatorOpen}
              aria-controls="operator-balance-body"
              className="group flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span
                className={`font-pixel text-[10px] text-brand transition-transform ${
                  operatorOpen ? 'rotate-90' : ''
                }`}
                aria-hidden="true"
              >
                ▸
              </span>
              <div className="min-w-0">
                <p className="label-caps-lg mb-1">Operator balance</p>
                <p className="heading-2 text-foreground">
                  Accumulated rake, gas, and net profit
                </p>
              </div>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleWithdrawFees();
              }}
              className="btn-primary-sm shrink-0"
            >
              Withdraw fees
            </button>
          </div>

          <div
            id="operator-balance-body"
            className="collapsible-grid"
            data-open={operatorOpen ? 'true' : 'false'}
          >
            <div className="collapsible-inner">
              {operatorBalances.length > 0 ? (
                <div className="overflow-x-auto border-t border-brand/20">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-secondary text-left">
                        <th className="px-5 py-3 label-caps">Token</th>
                        <th className="px-5 py-3 text-right label-caps">Rake Collected</th>
                        <th className="px-5 py-3 text-right label-caps">Gas Spent</th>
                        <th className="px-5 py-3 text-right label-caps">Net Profit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-secondary">
                      {operatorBalances.map((ob) => (
                        <tr key={ob.token} className="transition-colors hover:bg-secondary/20">
                          <td className="px-5 py-3">
                            <span className="font-mono text-xs text-foreground">{ob.token}</span>
                          </td>
                          <td className="num-tabular px-5 py-3 text-right font-medium text-brand">
                            {fmt(ob.rakeCollected)}
                          </td>
                          <td className="num-tabular px-5 py-3 text-right text-foreground">
                            {fmt(ob.gasSpent, 2)}
                          </td>
                          <td className={`num-tabular px-5 py-3 text-right font-medium ${
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
                <p className="border-t border-brand/20 px-5 py-6 text-center text-xs text-muted">
                  No operator balance data available.
                </p>
              )}
            </div>
          </div>
        </ComicPanel>
      </div>

      {/* ── Withdraw Fees modal ─────────────────────────────── */}
      <Modal
        open={withdrawFeesOpen}
        onClose={() => setWithdrawFeesOpen(false)}
        locked={withdrawFeesLoading}
        title="Withdraw Operator Fees"
        description="Sends accumulated rake from the agent wallet to the operator withdrawal address. If OPERATOR_WITHDRAW_ADDRESS is set in the environment, it overrides the recipient field below."
      >
        <div className="mb-4">
          <label htmlFor="wf-token" className="label-caps mb-2 block">
            Token
          </label>
          <select
            id="wf-token"
            value={withdrawFeesToken}
            onChange={(e) => setWithdrawFeesToken(e.target.value as 'HBAR' | 'LAZY')}
            disabled={withdrawFeesLoading}
            className="w-full border-2 border-secondary bg-[var(--color-panel)] px-4 py-3 text-sm text-foreground transition-colors focus:border-brand disabled:opacity-50"
          >
            <option value="HBAR">HBAR</option>
            <option value="LAZY">LAZY</option>
          </select>
        </div>

        <div className="mb-4">
          <label htmlFor="wf-amount" className="label-caps mb-2 block">
            Amount
          </label>
          <input
            id="wf-amount"
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            autoComplete="off"
            value={withdrawFeesAmount}
            onChange={(e) => setWithdrawFeesAmount(e.target.value)}
            disabled={withdrawFeesLoading}
            placeholder="0.00"
            className="w-full border-2 border-secondary bg-[var(--color-panel)] px-4 py-3 text-sm text-foreground placeholder:text-muted transition-colors focus:border-brand disabled:opacity-50"
          />
        </div>

        <div className="mb-5">
          <label htmlFor="wf-to" className="label-caps mb-2 block">
            Recipient (optional — env var overrides)
          </label>
          <input
            id="wf-to"
            type="text"
            autoComplete="off"
            value={withdrawFeesTo}
            onChange={(e) => setWithdrawFeesTo(e.target.value)}
            disabled={withdrawFeesLoading}
            placeholder="0.0.XXXXXX"
            className="w-full border-2 border-secondary bg-[var(--color-panel)] px-4 py-3 text-sm text-foreground placeholder:text-muted transition-colors focus:border-brand disabled:opacity-50"
          />
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setWithdrawFeesOpen(false)}
            disabled={withdrawFeesLoading}
            className="btn-ghost-sm flex-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submitWithdrawFees}
            disabled={withdrawFeesLoading || !withdrawFeesAmount}
            className="btn-primary-sm flex-1"
          >
            {withdrawFeesLoading ? 'Withdrawing…' : 'Confirm withdraw'}
          </button>
        </div>
      </Modal>

      {/* ── Kill Switch reason modal ────────────────────────── */}
      <Modal
        open={killSwitchModalOpen}
        onClose={() => setKillSwitchModalOpen(false)}
        locked={killSwitchLoading}
        title="Engage Kill Switch"
        description="This will immediately block new plays and new registrations. Withdrawals, deregistration, and reads will stay working. Users will see the reason below on the dashboard."
      >
        <div className="mb-5">
          <label htmlFor="ks-reason" className="label-caps mb-2 block">
            Reason (shown to users)
          </label>
          <textarea
            id="ks-reason"
            value={killSwitchReason}
            onChange={(e) => setKillSwitchReason(e.target.value.slice(0, 200))}
            disabled={killSwitchLoading}
            rows={3}
            maxLength={200}
            autoComplete="off"
            placeholder="e.g. Emergency maintenance — investigating a dApp contract issue"
            className="w-full border-2 border-secondary bg-[var(--color-panel)] px-4 py-3 text-sm text-foreground placeholder:text-muted transition-colors focus:border-brand disabled:opacity-50"
          />
          <p className="mt-1 text-right text-[10px] text-muted">
            {killSwitchReason.length} / 200
          </p>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setKillSwitchModalOpen(false)}
            disabled={killSwitchLoading}
            className="btn-ghost-sm flex-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submitEnableKillSwitch}
            disabled={killSwitchLoading || !killSwitchReason.trim()}
            className="btn-ghost-sm-destructive flex-1"
          >
            {killSwitchLoading ? 'Engaging…' : 'Engage kill switch'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
