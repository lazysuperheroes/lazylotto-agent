'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '../components/Toast';
import {
  PrizeNftCard,
  type PrizeNftRef,
  type EnrichedPrizeNft,
} from '../components/PrizeNftCard';
import { useNftEnrichment } from '../components/useNftEnrichment';

// ---------------------------------------------------------------------------
// Types -- mapped to real API response shapes
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

interface StatusResponse {
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
  agentWallet?: string;
}

interface PrizeDetail {
  fungibleAmount?: number;
  fungibleToken?: string;
  nftCount?: number;
  /** Raw NFT refs captured at win time — enriched lazily on the client. */
  nfts?: PrizeNftRef[];
}

interface PoolResult {
  poolId: number;
  poolName: string;
  entriesBought: number;
  amountSpent: number;
  rolled: boolean;
  wins: number;
  prizeDetails: PrizeDetail[];
}

interface PlaySession {
  sessionId: string;
  userId: string;
  timestamp: string;
  strategyName: string;
  strategyVersion: string;
  boostBps: number;
  poolsEvaluated: number;
  poolsPlayed: number;
  poolResults: PoolResult[];
  totalSpent: number;
  totalWins: number;
  totalPrizeValue: number;
  prizesByToken: Record<string, number>;
  prizesTransferred: boolean;
  gasCostHbar: number;
  amountReserved: number;
  amountSettled: number;
  amountReleased: number;
}

interface HistoryResponse {
  userId: string;
  sessions: PlaySession[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskToken(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}${'*'.repeat(8)}${token.slice(-4)}`;
}

function tokenSymbol(tokenKey: string): string {
  if (tokenKey.toLowerCase() === 'hbar') return 'HBAR';
  return tokenKey;
}

function tokenAbbrev(tokenKey: string): string {
  if (tokenKey.toLowerCase() === 'hbar') return 'HB';
  const sym = tokenSymbol(tokenKey);
  return sym.slice(0, 2).toUpperCase();
}

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

// ---------------------------------------------------------------------------
// Skeleton — structural placeholder shown while the first payload loads.
// Mirrors the real dashboard layout so the page doesn't reflow on arrival.
// ---------------------------------------------------------------------------

function SkeletonBox({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-secondary/50 ${className}`} />;
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:px-8">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-2">
        <SkeletonBox className="h-8 w-48" />
        <SkeletonBox className="h-4 w-64" />
      </div>

      {/* Two-column row: balance + deposit */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Balance card skeleton */}
        <div className="rounded-xl border border-secondary p-6 shadow">
          <SkeletonBox className="mb-4 h-5 w-32" />
          <SkeletonBox className="mb-2 h-8 w-40" />
          <div className="mt-4 space-y-2">
            <SkeletonBox className="h-4 w-full" />
            <SkeletonBox className="h-4 w-3/4" />
            <SkeletonBox className="h-4 w-2/3" />
          </div>
        </div>

        {/* Deposit card skeleton */}
        <div className="rounded-xl border border-secondary p-6 shadow">
          <SkeletonBox className="mb-4 h-5 w-32" />
          <SkeletonBox className="mb-3 h-3 w-full" />
          <div className="space-y-4">
            <div>
              <SkeletonBox className="mb-1.5 h-3 w-24" />
              <SkeletonBox className="h-10 w-full" />
            </div>
            <div>
              <SkeletonBox className="mb-1.5 h-3 w-24" />
              <SkeletonBox className="h-10 w-full" />
            </div>
          </div>
        </div>

        {/* Play history skeleton (full width) */}
        <div className="rounded-xl border border-secondary p-6 shadow lg:col-span-2">
          <SkeletonBox className="mb-4 h-5 w-32" />
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-secondary p-3">
                <div className="mb-2 flex items-center justify-between">
                  <SkeletonBox className="h-4 w-32" />
                  <SkeletonBox className="h-4 w-16" />
                </div>
                <div className="flex gap-2">
                  <SkeletonBox className="h-6 w-20" />
                  <SkeletonBox className="h-6 w-20" />
                  <SkeletonBox className="h-6 w-20" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [storedAccountId, setStoredAccountId] = useState<string | null>(null);
  // Per-section loading states so balance/deposit and history render independently
  const [statusLoading, setStatusLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notRegistered, setNotRegistered] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [lockLoading, setLockLoading] = useState(false);
  const [lockConfirming, setLockConfirming] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [depositsChecking, setDepositsChecking] = useState(false);

  // Self-serve register + withdraw state
  const [registerLoading, setRegisterLoading] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawToken, setWithdrawToken] = useState('hbar');
  const [withdrawLoading, setWithdrawLoading] = useState(false);

  // Stuck deposits (dead letters) belonging to this user
  interface UserDeadLetter {
    transactionId: string;
    timestamp: string;
    error: string;
    sender?: string;
    memo?: string;
  }
  const [deadLetters, setDeadLetters] = useState<UserDeadLetter[]>([]);

  // Public agent stats (for trust panel)
  interface PublicStats {
    agentName: string;
    network: string;
    agentWallet: string | null;
    users: { total: number; active: number };
    rake: { defaultPercent: number };
    tvl: Record<string, number>;
    hcs20TopicId: string | null;
  }
  const [publicStats, setPublicStats] = useState<PublicStats | null>(null);

  // Overall "still loading something" flag for the full-page skeleton
  const loading = statusLoading && historyLoading;

  // Extract raw NFT refs from all sessions for lazy enrichment.
  // The hook dedupes internally by ${hederaId}!${serial} so duplicates are fine.
  const rawNftRefs = useMemo((): PrizeNftRef[] => {
    const refs: PrizeNftRef[] = [];
    for (const session of sessions) {
      for (const pr of session.poolResults) {
        for (const pd of pr.prizeDetails) {
          if (pd.nfts) refs.push(...pd.nfts);
        }
      }
    }
    return refs;
  }, [sessions]);

  const {
    data: enrichedMap,
    loading: enrichmentLoading,
    error: enrichmentError,
    retry: retryEnrichment,
  } = useNftEnrichment(rawNftRefs);

  // Set page title
  useEffect(() => {
    document.title = 'Dashboard | LazyLotto Agent';
  }, []);

  // Check for auth token on mount, then fetch data independently
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    setSessionToken(token);
    setStoredAccountId(localStorage.getItem('lazylotto:accountId'));

    if (!token) {
      setStatusLoading(false);
      setHistoryLoading(false);
      return;
    }

    const headers = { Authorization: `Bearer ${token}` };

    // Fire status + history in parallel but treat them as independent.
    // Each section renders as soon as its own fetch resolves — history
    // no longer waits for status (and vice versa).
    void (async () => {
      try {
        const res = await fetch('/api/user/status', { headers });
        if (res.status === 401) {
          localStorage.removeItem('lazylotto:sessionToken');
          localStorage.removeItem('lazylotto:accountId');
          localStorage.removeItem('lazylotto:tier');
          router.replace('/auth?expired=1');
          return;
        }
        if (res.status === 404) {
          // User authenticated but not registered as a player
          setNotRegistered(true);
          setHistoryLoading(false); // nothing to load
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `Status API returned ${res.status}`,
          );
        }
        const data: StatusResponse = await res.json();
        setStatus(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setStatusLoading(false);
      }
    })();

    void (async () => {
      try {
        const res = await fetch('/api/user/history', { headers });
        if (res.status === 401) {
          localStorage.removeItem('lazylotto:sessionToken');
          localStorage.removeItem('lazylotto:accountId');
          localStorage.removeItem('lazylotto:tier');
          router.replace('/auth?expired=1');
          return;
        }
        if (res.status === 404) {
          // Not registered — history empty, handled by the status branch
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `History API returned ${res.status}`,
          );
        }
        const data: HistoryResponse = await res.json();
        setSessions(data.sessions ?? []);
      } catch (err) {
        // History failure shouldn't break the whole dashboard — log to console
        // and let the empty state render.
        console.warn('[dashboard] history fetch failed:', err);
      } finally {
        setHistoryLoading(false);
      }
    })();

    // Background trust stats fetch — public, no auth needed
    void (async () => {
      try {
        const res = await fetch('/api/public/stats');
        if (!res.ok) return;
        const data = (await res.json()) as PublicStats;
        setPublicStats(data);
      } catch {
        /* silent */
      }
    })();

    // Background dead-letter check — surfaces stuck deposits to the user.
    // Failure is silent, this is purely informational.
    void (async () => {
      try {
        const res = await fetch('/api/user/dead-letters', { headers });
        if (!res.ok) return;
        const data = (await res.json()) as { deadLetters?: UserDeadLetter[] };
        if (data.deadLetters && data.deadLetters.length > 0) {
          setDeadLetters(data.deadLetters);
        }
      } catch {
        /* silent */
      }
    })();

    // Background deposit check — fire-and-forget, updates balance in place.
    // Runs in parallel with status/history so it never blocks initial paint.
    void (async () => {
      setDepositsChecking(true);
      try {
        const res = await fetch('/api/user/check-deposits', {
          method: 'POST',
          headers,
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          processed?: number;
          balances?: StatusResponse['balances'];
          lastPlayedAt?: string | null;
        };
        if (data.processed && data.processed > 0 && data.balances) {
          // Patch balance + lastPlayedAt into the current status without
          // refetching the whole thing
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  balances: data.balances!,
                  lastPlayedAt: data.lastPlayedAt ?? prev.lastPlayedAt,
                }
              : prev,
          );
        }
      } catch {
        /* Silent failure — user can refresh manually */
      } finally {
        setDepositsChecking(false);
      }
    })();
  }, []);

  const handleCopy = useCallback(
    (text: string, label?: string) => {
      void navigator.clipboard.writeText(text);
      toast(label ? `${label} copied` : 'Copied to clipboard');
    },
    [toast],
  );

  const handleLock = useCallback(async () => {
    if (!sessionToken) return;
    setLockLoading(true);
    try {
      const res = await fetch('/api/auth/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      });
      if (res.status === 401) {
        localStorage.removeItem('lazylotto:sessionToken');
        localStorage.removeItem('lazylotto:accountId');
        localStorage.removeItem('lazylotto:tier');
        router.replace('/auth?expired=1');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Lock failed (${res.status})`,
        );
      }
      // Mark locked in localStorage so the AuthFlow already-auth state shows it
      localStorage.setItem('lazylotto:locked', 'true');
      localStorage.removeItem('lazylotto:expiresAt');
      toast('API key locked — now permanent');
      setLockConfirming(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Lock failed: ${message}`, { variant: 'error' });
    } finally {
      setLockLoading(false);
    }
  }, [router, sessionToken, toast]);

  // Self-serve registration from the not-registered empty state
  const handleRegister = useCallback(async () => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
      return;
    }
    setRegisterLoading(true);
    try {
      const res = await fetch('/api/user/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ strategy: 'balanced' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Registration failed (${res.status})`,
        );
      }
      // Reload the dashboard so the now-registered state renders
      toast('Registered successfully');
      window.location.reload();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Registration failed: ${message}`, { variant: 'error' });
      setError(message);
    } finally {
      setRegisterLoading(false);
    }
  }, [router, toast]);

  // Self-serve withdrawal
  const handleWithdraw = useCallback(async () => {
    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Enter a valid amount greater than 0', { variant: 'error' });
      return;
    }
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
      return;
    }
    setWithdrawLoading(true);
    try {
      const res = await fetch('/api/user/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount, token: withdrawToken }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error ?? `Withdrawal failed (${res.status})`,
        );
      }
      const { record, balances } = body as {
        record: { transactionId: string; amount: number };
        balances?: StatusResponse['balances'];
      };
      toast(`Withdrew ${record.amount} ${withdrawToken.toUpperCase()}`);
      // Update balance in place
      if (balances) {
        setStatus((prev) => (prev ? { ...prev, balances } : prev));
      }
      setWithdrawOpen(false);
      setWithdrawAmount('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Withdrawal failed: ${message}`, { variant: 'error' });
    } finally {
      setWithdrawLoading(false);
    }
  }, [router, withdrawAmount, withdrawToken, toast]);

  const handleRevoke = useCallback(async () => {
    if (!sessionToken) return;
    setRevokeLoading(true);
    try {
      const res = await fetch('/api/auth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      });
      if (!res.ok) {
        console.warn('Revoke returned non-OK status:', res.status);
      }
    } catch (err: unknown) {
      console.warn('Revoke request failed:', err);
    } finally {
      localStorage.removeItem('lazylotto:sessionToken');
      localStorage.removeItem('lazylotto:accountId');
      localStorage.removeItem('lazylotto:tier');
      localStorage.removeItem('lazylotto:expiresAt');
      localStorage.removeItem('lazylotto:locked');
      // Full reload intentional — clears all React state after revoke
      window.location.href = '/auth';
    }
  }, [sessionToken]);

  // --- Derived performance data ---
  const perfSummary = useMemo(() => {
    if (sessions.length === 0) return null;

    const totalWinSessions = sessions.filter((s) => s.totalWins > 0).length;
    const totalSpentAll = sessions.reduce((sum, s) => sum + s.totalSpent, 0);
    const totalWonAll = sessions.reduce((sum, s) => sum + s.totalPrizeValue, 0);
    const net = totalWonAll - totalSpentAll;

    // Find primary token: most common token in spending (heuristic: use the
    // token key with the highest total deposited, or fall back to HBAR)
    const tokenSpendCounts: Record<string, number> = {};
    for (const s of sessions) {
      for (const pr of s.poolResults) {
        // Pool results don't carry token key directly; fall back to status balances
        // We use the balance entries to determine the primary token
      }
    }
    // Simpler approach: use the first balance token or HBAR
    let primaryToken = 'HBAR';
    if (status) {
      const entries = Object.entries(status.balances.tokens);
      if (entries.length > 0) {
        // Pick the token with the highest totalDeposited
        let maxDeposited = -1;
        for (const [key, entry] of entries) {
          if (entry.totalDeposited > maxDeposited) {
            maxDeposited = entry.totalDeposited;
            primaryToken = tokenSymbol(key);
          }
        }
      }
    }
    // Clean up unused variable
    void tokenSpendCounts;

    return { totalWinSessions, totalSpentAll, totalWonAll, net, primaryToken };
  }, [sessions, status]);

  // --- Last session trend ---
  const lastSessionTrend = useMemo(() => {
    if (sessions.length === 0 || !status?.lastPlayedAt) return null;
    const last = sessions[0]; // sessions are assumed newest-first
    if (!last) return null;
    const lastNet = last.totalPrizeValue - last.totalSpent;
    if (lastNet > 0) return 'up' as const;
    if (lastNet < 0) return 'down' as const;
    return 'flat' as const;
  }, [sessions, status]);

  // --- Loading state ---
  // Show full-page skeleton while the critical section (status/balance) is
  // still loading. Once status resolves, the dashboard renders; the play
  // history section has its own inline skeleton if it's still in-flight.
  if (statusLoading && !notRegistered) {
    return <DashboardSkeleton />;
  }

  // --- No auth token ---
  if (!sessionToken) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-secondary p-8 text-center shadow-lg">
          <h1 className="mb-3 font-heading text-xl text-foreground">
            Authentication Required
          </h1>
          <p className="mb-6 text-sm text-muted">
            Please authenticate with your Hedera wallet to access your dashboard.
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

  // --- Not registered state ---
  if (notRegistered) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-secondary p-8 text-center shadow-lg">
          <h1 className="mb-3 font-heading text-xl text-foreground">
            Welcome, {storedAccountId ?? 'Explorer'}
          </h1>
          <p className="mb-6 text-sm text-muted">
            You&apos;re signed in but haven&apos;t registered as a player yet.
            One click and you&apos;ll get a deposit memo so you can fund your
            account and start playing.
          </p>
          <button
            type="button"
            onClick={handleRegister}
            disabled={registerLoading}
            className="inline-block rounded-lg bg-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {registerLoading ? 'Registering…' : 'Register Now'}
          </button>
          <p className="mt-4 text-xs text-muted">
            You&apos;ll be using the <span className="text-foreground">balanced</span> strategy by default.
            You can switch later via Claude Desktop.
          </p>
        </div>
      </div>
    );
  }

  // --- Error state ---
  if (error && !status) {
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

  // Build balance rows
  const balanceEntries = status
    ? Object.entries(status.balances.tokens)
    : [];

  const totalDeposited = balanceEntries
    .map(([key, entry]) => `${formatAmount(entry.totalDeposited)} ${tokenSymbol(key)}`)
    .join(', ') || '--';
  const totalRakePaid = balanceEntries
    .map(([key, entry]) => `${formatAmount(entry.totalRake)} ${tokenSymbol(key)}`)
    .filter((s) => !s.startsWith('0'))
    .join(', ') || '--';

  const agentWallet = status?.agentWallet ?? '';

  // Sessions to display (capped at 10 unless expanded)
  const displayedSessions = showAll ? sessions : sessions.slice(0, 10);

  // --- Dashboard ---
  return (
    <div className="w-full px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        {/* ---- Top Bar ---- */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="font-heading text-2xl text-foreground">
            Dashboard
          </h1>

          {status && (
            <span className="rounded bg-brand px-2 py-0.5 text-xs font-semibold text-background">
              {status.strategyName}
            </span>
          )}
        </header>

        {/* ---- Hero Performance Summary ---- */}
        {perfSummary && (
          <p className="mb-8 text-lg text-muted">
            You&apos;ve played {perfSummary.totalSpentAll > 0 ? sessions.length : 0} session{sessions.length !== 1 ? 's' : ''}, won{' '}
            <span className="text-brand">{perfSummary.totalWinSessions}</span>{' '}
            time{perfSummary.totalWinSessions !== 1 ? 's' : ''}, and are{' '}
            <span className={perfSummary.net >= 0 ? 'text-success' : 'text-destructive'}>
              {perfSummary.net >= 0 ? 'up' : 'down'} {formatAmount(Math.abs(perfSummary.net))} {perfSummary.primaryToken}
            </span>.
          </p>
        )}

        {/* Non-fatal error banner */}
        {error && status && (
          <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ---- Cards Grid ---- */}
        <div className="grid gap-6 lg:grid-cols-2">

          {/* ---- Balance Card ---- */}
          <div className="rounded-xl bg-gradient-to-br from-secondary/30 to-transparent p-6 shadow">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="font-heading text-lg text-foreground">
                Available Balance
              </h2>
              {lastSessionTrend && (
                <span
                  className={`text-sm ${
                    lastSessionTrend === 'up'
                      ? 'text-success'
                      : lastSessionTrend === 'down'
                        ? 'text-destructive'
                        : 'text-muted'
                  }`}
                  title={
                    lastSessionTrend === 'up'
                      ? 'Last session was profitable'
                      : lastSessionTrend === 'down'
                        ? 'Last session was a loss'
                        : 'Last session broke even'
                  }
                >
                  {lastSessionTrend === 'up' ? '\u2191' : lastSessionTrend === 'down' ? '\u2193' : '\u2014'}
                </span>
              )}
            </div>
            <p className="mb-4 text-xs text-muted">
              Your current token balances held by the agent. Available funds can be used for lottery entries.
              {depositsChecking && (
                <span className="ml-2 inline-flex items-center gap-1 text-brand">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                  Checking for new deposits…
                </span>
              )}
            </p>

            {status && (
              <div className="space-y-4">
                <div className="space-y-3">
                  {balanceEntries.length > 0 ? (
                    balanceEntries.map(([tokenKey, entry]) => (
                      <div
                        key={tokenKey}
                        className="flex items-center justify-between rounded-lg bg-secondary/50 px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/20 text-xs font-semibold text-brand">
                            {tokenAbbrev(tokenKey)}
                          </span>
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              {tokenSymbol(tokenKey)}
                            </p>
                            <p className="text-xs text-muted">{tokenKey}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-heading text-2xl text-brand">
                            {formatAmount(entry.available)}
                          </p>
                          {entry.reserved > 0 && (
                            <p className="text-xs text-muted">
                              {formatAmount(entry.reserved)} reserved
                            </p>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted">
                      No token balances yet. Deposit tokens to get started.
                    </p>
                  )}
                </div>

                <div className="border-t border-secondary pt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Total Deposited</span>
                    <span className="text-foreground">{totalDeposited}</span>
                  </div>
                  <div className="mt-2 flex justify-between text-sm">
                    <span className="text-muted">Total Rake Paid</span>
                    <span className="text-foreground">{totalRakePaid}</span>
                  </div>
                  <div className="mt-2 flex justify-between text-sm">
                    <span className="text-muted">Rake Rate</span>
                    <span className="text-foreground">{status.rakePercent}%</span>
                  </div>
                </div>

                {/* Withdraw button */}
                {balanceEntries.some(([, e]) => e.available > 0) && (
                  <button
                    type="button"
                    onClick={() => setWithdrawOpen(true)}
                    className="w-full rounded-lg border border-brand bg-brand/10 px-4 py-2.5 text-sm font-semibold text-brand transition-colors hover:bg-brand/20"
                  >
                    Withdraw Funds
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ---- Deposit Info Card ---- */}
          <div className="rounded-xl border border-secondary p-6 shadow">
            <h2 className="mb-1 font-heading text-lg text-foreground">
              Fund Your Account
            </h2>
            <p className="mb-4 text-xs text-muted">
              Send tokens to the agent wallet with your unique deposit memo to credit your account.
            </p>

            {status && (
              <div className="space-y-5">
                {agentWallet && (
                  <div>
                    <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                      Agent Wallet
                    </label>
                    <div className="flex items-center gap-2 rounded-lg border border-secondary bg-[#111113] px-4 py-3">
                      <code className="flex-1 break-all font-mono text-sm text-brand">
                        {agentWallet}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopy(agentWallet, 'Agent wallet')}
                        className="shrink-0 rounded-md border border-secondary px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}

                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                    Deposit Memo
                  </label>
                  <div className="flex items-center gap-2 rounded-lg border border-secondary bg-[#111113] px-4 py-3">
                    <code className="flex-1 break-all font-mono text-sm text-brand">
                      {status.depositMemo}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopy(status.depositMemo, 'Deposit memo')}
                      className="shrink-0 rounded-md border border-secondary px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <p className="rounded-lg bg-brand/10 px-4 py-3 text-xs text-brand">
                  Important: Always include the deposit memo when sending tokens.
                  Transfers without the correct memo cannot be automatically credited.
                </p>

                {/* Wallet-specific instructions */}
                <details className="rounded-lg bg-secondary/30 px-4 py-3 text-xs text-muted">
                  <summary className="cursor-pointer text-foreground">
                    How do I add the memo in my wallet?
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div>
                      <p className="font-semibold text-foreground">HashPack</p>
                      <p>
                        On the Send screen, tap <span className="text-foreground">Advanced</span> →
                        paste the memo into the <span className="text-foreground">Memo</span> field
                        before confirming.
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">Blade</p>
                      <p>
                        On the Send screen, expand <span className="text-foreground">Optional Fields</span> and
                        paste the memo into the <span className="text-foreground">Memo</span> field
                        before confirming.
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">Other wallets</p>
                      <p>
                        Look for a <span className="text-foreground">Memo</span> or
                        <span className="text-foreground"> Note</span> field on the send screen.
                        It&apos;s often hidden under an &quot;Advanced&quot; or &quot;Optional&quot; toggle.
                      </p>
                    </div>
                  </div>
                </details>
              </div>
            )}
          </div>

          {/* ---- Stuck deposits (dead letters) ---- */}
          {deadLetters.length > 0 && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 shadow lg:col-span-2">
              <h2 className="mb-1 font-heading text-lg text-destructive">
                Stuck Deposits
              </h2>
              <p className="mb-4 text-xs text-muted">
                {deadLetters.length === 1 ? 'A deposit' : 'These deposits'} from your wallet
                couldn&apos;t be credited automatically. The funds are still in the agent
                wallet — contact the operator with the transaction ID below to request
                a refund.
              </p>
              <div className="space-y-2">
                {deadLetters.map((dl) => {
                  const network = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_HEDERA_NETWORK) || 'testnet';
                  const hashscanUrl = network === 'mainnet'
                    ? `https://hashscan.io/mainnet/transaction/${dl.transactionId}`
                    : `https://hashscan.io/${network}/transaction/${dl.transactionId}`;
                  return (
                    <div key={dl.transactionId} className="rounded-lg bg-secondary/30 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <code className="break-all font-mono text-xs text-destructive">
                          {dl.transactionId}
                        </code>
                        <a
                          href={hashscanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 rounded border border-destructive/40 px-2 py-1 text-[10px] font-semibold text-destructive transition-colors hover:bg-destructive/10"
                        >
                          HashScan
                        </a>
                      </div>
                      <p className="mt-1.5 text-xs text-muted">
                        {dl.error}
                      </p>
                      {dl.memo && (
                        <p className="mt-0.5 text-[10px] text-muted">
                          Memo: <code className="font-mono">{dl.memo || '(none)'}</code>
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ---- Play History (full width) ---- */}
          <div className="lg:col-span-2">
            <h2 className="mb-1 font-heading text-lg text-foreground">
              Play History
            </h2>
            <p className="mb-4 text-xs text-muted">
              Your lottery play history. Each entry represents one agent play session across one or more pools.
            </p>

            {/* NFT enrichment error banner */}
            {enrichmentError && rawNftRefs.length > 0 && (
              <div className="mb-4 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
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

            {/* ---- Total P&L Summary ---- */}
            {perfSummary && (
              <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                <span>Total spent: {formatAmount(perfSummary.totalSpentAll)} {perfSummary.primaryToken}</span>
                <span className="hidden sm:inline">|</span>
                <span>Total won: {formatAmount(perfSummary.totalWonAll)} {perfSummary.primaryToken}</span>
                <span className="hidden sm:inline">|</span>
                <span>
                  Net:{' '}
                  <span className={perfSummary.net >= 0 ? 'text-success' : 'text-destructive'}>
                    {perfSummary.net >= 0 ? '+' : ''}{formatAmount(perfSummary.net)} {perfSummary.primaryToken}
                  </span>
                </span>
              </div>
            )}

            {/* ---- Timeline ---- */}
            {historyLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="rounded-lg border border-secondary p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <SkeletonBox className="h-4 w-32" />
                      <SkeletonBox className="h-4 w-16" />
                    </div>
                    <div className="flex gap-2">
                      <SkeletonBox className="h-6 w-20" />
                      <SkeletonBox className="h-6 w-20" />
                      <SkeletonBox className="h-6 w-20" />
                    </div>
                  </div>
                ))}
              </div>
            ) : sessions.length > 0 ? (
              <>
                <div className="space-y-4">
                  {displayedSessions.map((s) => {
                    const isWin = s.totalWins > 0;
                    return (
                      <div
                        key={s.sessionId}
                        className={`relative rounded-lg border ${
                          isWin ? 'border-brand/30 bg-brand/5' : 'border-secondary'
                        } p-4 pl-6`}
                      >
                        {/* Left accent bar for wins */}
                        {isWin && (
                          <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg bg-brand" />
                        )}

                        {/* Header row: date + net result */}
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-muted">
                            {formatTimestamp(s.timestamp)}
                          </span>
                          <span
                            className={`font-heading text-sm ${
                              isWin ? 'text-brand' : 'text-muted'
                            }`}
                          >
                            {isWin
                              ? `+${formatAmount(s.totalPrizeValue)} won`
                              : `${formatAmount(s.totalSpent)} spent`}
                          </span>
                        </div>

                        {/* Pool badges */}
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {s.poolResults.map((pr) => (
                            <span
                              key={pr.poolId}
                              className="rounded bg-secondary px-2 py-0.5 text-xs text-muted"
                            >
                              {pr.poolName}
                            </span>
                          ))}
                        </div>

                        {/* Stats row */}
                        <div className="flex gap-4 text-xs text-muted">
                          <span>
                            {s.poolResults.reduce(
                              (sum, pr) => sum + pr.entriesBought,
                              0,
                            )}{' '}
                            entries
                          </span>
                          <span>{formatAmount(s.totalSpent)} spent</span>
                          {isWin && s.totalWins > 0 && (
                            <span className="text-success">
                              {s.totalWins} win{s.totalWins > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>

                        {/* Prize details for winning sessions */}
                        {isWin &&
                          s.poolResults.some(
                            (pr) => pr.prizeDetails.length > 0,
                          ) && (
                            <div className="mt-2 space-y-2">
                              {/* Fungible prizes — compact inline summary */}
                              {(() => {
                                const fungibleParts: string[] = [];
                                for (const pr of s.poolResults) {
                                  for (const prize of pr.prizeDetails) {
                                    if (prize.fungibleAmount) {
                                      fungibleParts.push(
                                        `${prize.fungibleAmount} ${prize.fungibleToken ?? '?'}`,
                                      );
                                    }
                                  }
                                }
                                return fungibleParts.length > 0 ? (
                                  <div className="rounded bg-brand/10 px-3 py-2 text-xs text-brand">
                                    {fungibleParts.join(' + ')}
                                  </div>
                                ) : null;
                              })()}

                              {/* NFT prizes — raw first, enriched in background */}
                              {(() => {
                                const rawNfts = s.poolResults
                                  .flatMap((pr) => pr.prizeDetails)
                                  .flatMap((pd) => pd.nfts ?? []);
                                if (rawNfts.length === 0) return null;
                                return (
                                  <div className="flex flex-wrap gap-2">
                                    {rawNfts.map((raw) => {
                                      const key = `${raw.hederaId}!${raw.serial}`;
                                      const enriched = enrichedMap.get(key);
                                      return (
                                        <PrizeNftCard
                                          key={key}
                                          raw={raw}
                                          enriched={enriched}
                                          loading={!enriched && enrichmentLoading}
                                        />
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                      </div>
                    );
                  })}
                </div>

                {/* Show older sessions button */}
                {sessions.length > 10 && !showAll && (
                  <div className="mt-4 text-center">
                    <button
                      type="button"
                      onClick={() => setShowAll(true)}
                      className="text-sm text-primary transition-colors hover:text-primary/80"
                    >
                      Show older sessions ({sessions.length - 10} more)
                    </button>
                  </div>
                )}
                {showAll && sessions.length > 10 && (
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
                  No sessions yet. Ask Claude to play a lottery session for you, or deposit funds to get started.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── About this agent — trust panel ─────────────────── */}
        {publicStats && (
          <div className="mt-8 rounded-xl border border-secondary p-6 shadow">
            <h2 className="mb-4 font-heading text-sm uppercase tracking-wider text-muted">
              About This Agent
            </h2>
            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <p className="text-xs text-muted">Network</p>
                <p className="font-semibold text-foreground capitalize">
                  {publicStats.network}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted">Active Users</p>
                <p className="font-semibold text-foreground">
                  {publicStats.users.active}
                  <span className="ml-1 text-xs text-muted">
                    of {publicStats.users.total}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-xs text-muted">Rake Rate</p>
                <p className="font-semibold text-foreground">
                  {publicStats.rake.defaultPercent}%
                </p>
              </div>
              <div>
                <p className="text-xs text-muted">Total Held</p>
                <p className="font-semibold text-foreground">
                  {Object.entries(publicStats.tvl)
                    .slice(0, 2)
                    .map(
                      ([k, v]) =>
                        `${formatAmount(v)} ${tokenSymbol(k)}`,
                    )
                    .join(' + ') || '—'}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-secondary pt-4 text-xs text-muted">
              {publicStats.agentWallet && (
                <a
                  href={`https://hashscan.io/${publicStats.network === 'mainnet' ? 'mainnet' : publicStats.network}/account/${publicStats.agentWallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline"
                >
                  Agent wallet on HashScan ↗
                </a>
              )}
              {publicStats.hcs20TopicId && (
                <a
                  href={`https://hashscan.io/${publicStats.network === 'mainnet' ? 'mainnet' : publicStats.network}/topic/${publicStats.hcs20TopicId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline"
                >
                  HCS-20 audit trail ↗
                </a>
              )}
              <a
                href="/audit"
                className="text-brand hover:underline"
              >
                On-chain audit page →
              </a>
            </div>
          </div>
        )}

        {/* ---- Session Section (compact, demoted) ---- */}
        <div className="border-t border-secondary mt-8 pt-6">
          <h2 className="mb-3 font-heading text-sm text-foreground">
            Session
          </h2>

          <div className="flex flex-wrap items-center gap-3">
            <code className="font-mono text-sm text-muted">
              {maskToken(sessionToken)}
            </code>

            <button
              type="button"
              onClick={() => handleCopy(sessionToken, 'Session token')}
              className="shrink-0 rounded-md border border-secondary px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
            >
              Copy
            </button>

            {lockConfirming ? (
              <>
                <span className="text-xs text-muted">
                  Make this token permanent (never expires, can&apos;t be auto-revoked)?
                </span>
                <button
                  type="button"
                  onClick={() => void handleLock()}
                  disabled={lockLoading}
                  className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {lockLoading ? 'Locking…' : 'Confirm — Make Permanent'}
                </button>
                <button
                  type="button"
                  onClick={() => setLockConfirming(false)}
                  disabled={lockLoading}
                  className="text-xs text-muted underline transition-colors hover:text-foreground"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setLockConfirming(true)}
                  className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90"
                  title="Make this token permanent — never expires, can't be revoked"
                >
                  Lock API Key
                </button>

                <button
                  type="button"
                  onClick={() => void handleRevoke()}
                  disabled={revokeLoading}
                  className="rounded-md border border-destructive/50 px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  {revokeLoading ? 'Revoking…' : 'Revoke & Re-authenticate'}
                </button>
              </>
            )}
          </div>

          {status && (
            <p className="mt-2 text-xs text-muted">
              Registered {formatTimestamp(status.registeredAt)}.
              {status.lastPlayedAt
                ? ` Last played ${formatTimestamp(status.lastPlayedAt)}.`
                : ' No play sessions yet.'}
            </p>
          )}
        </div>
      </div>

      {/* ── Withdraw modal ───────────────────────────────────── */}
      {withdrawOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !withdrawLoading && setWithdrawOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-secondary bg-background p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 font-heading text-lg text-foreground">
              Withdraw Funds
            </h3>
            <p className="mb-5 text-xs text-muted">
              Funds will be sent to your registered Hedera account.
            </p>

            <div className="mb-4">
              <label htmlFor="withdraw-token" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                Token
              </label>
              <select
                id="withdraw-token"
                value={withdrawToken}
                onChange={(e) => setWithdrawToken(e.target.value)}
                disabled={withdrawLoading}
                className="w-full rounded-lg border border-secondary bg-secondary/30 px-4 py-2.5 text-sm text-foreground focus:border-brand focus:outline-none disabled:opacity-50"
              >
                {balanceEntries.map(([key, entry]) => (
                  <option key={key} value={key}>
                    {tokenSymbol(key)} (available: {formatAmount(entry.available)})
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-5">
              <label htmlFor="withdraw-amount" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                Amount
              </label>
              <input
                id="withdraw-amount"
                type="number"
                min="0"
                step="any"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                disabled={withdrawLoading}
                placeholder="0.00"
                className="w-full rounded-lg border border-secondary bg-secondary/30 px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-brand focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setWithdrawOpen(false)}
                disabled={withdrawLoading}
                className="flex-1 rounded-lg border border-secondary px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleWithdraw}
                disabled={withdrawLoading || !withdrawAmount}
                className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {withdrawLoading ? 'Withdrawing…' : 'Confirm Withdraw'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
