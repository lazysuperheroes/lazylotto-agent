'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '../components/Toast';

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

interface EnrichedPrizeNft {
  hederaId: string;
  serial: number;
  nftName: string;
  collection: string;
  niceName: string;
  showNiceName: boolean;
  verificationLevel: 'lazysuperheroes' | 'complete' | 'simple' | 'unverified';
  image: string;
  source: 'directus' | 'mirror' | 'fallback';
  tokenUrl: string;
  serialUrl: string;
}

interface PrizeDetail {
  fungibleAmount?: number;
  fungibleToken?: string;
  nftCount?: number;
  nfts?: { token: string; hederaId: string; serial: number }[];
  /** Populated server-side after enrichment from Directus + mirror node. */
  enrichedNfts?: EnrichedPrizeNft[];
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
// Verification badge — mirrors lazy-dapp-v3's VerificationBadge.tsx tiers
// ---------------------------------------------------------------------------

const VERIFICATION_BADGE: Record<
  EnrichedPrizeNft['verificationLevel'],
  { label: string; className: string; tooltip: string; icon: string }
> = {
  lazysuperheroes: {
    label: 'LSH Verified',
    className: 'bg-brand/20 text-brand border-brand/40',
    tooltip: 'Verified token, part of the Lazy Superheroes ecosystem',
    icon: '🛡',
  },
  complete: {
    label: 'Verified',
    className: 'bg-success/20 text-success border-success/40',
    tooltip: 'Known and fully verified token',
    icon: '🛡',
  },
  simple: {
    label: 'Known',
    className: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
    tooltip: 'Known token in the Hedera ecosystem but has not been verified',
    icon: 'ℹ',
  },
  unverified: {
    label: 'Unverified',
    className: 'bg-muted/20 text-muted border-muted/40',
    tooltip: 'This token has not been verified',
    icon: '?',
  },
};

function PrizeNftCard({ nft }: { nft: EnrichedPrizeNft }) {
  const badge = VERIFICATION_BADGE[nft.verificationLevel];
  // Nice-name rule: only show friendly name for verified tiers, else raw hederaId
  const displayCollection = nft.showNiceName
    ? nft.niceName
    : `${nft.hederaId.slice(0, 6)}…${nft.hederaId.slice(-4)}`;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-secondary bg-[#111113] p-2 pr-3">
      {/* Image (or placeholder) */}
      <a
        href={nft.serialUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="relative block h-14 w-14 shrink-0 overflow-hidden rounded bg-secondary"
        title={`View #${nft.serial} on HashScan`}
      >
        {nft.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={nft.image}
            alt={nft.nftName}
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-lg text-muted">
            ?
          </div>
        )}
      </a>

      {/* Details */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <a
          href={nft.serialUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-sm font-semibold text-foreground hover:text-brand"
          title={nft.nftName}
        >
          {nft.nftName}
        </a>
        <a
          href={nft.tokenUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-[11px] text-muted hover:text-foreground"
          title={nft.showNiceName ? `${nft.niceName} (${nft.hederaId})` : nft.hederaId}
        >
          {displayCollection}
        </a>
        <span
          className={`mt-0.5 inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}
          title={badge.tooltip}
        >
          <span>{badge.icon}</span>
          <span>{badge.label}</span>
        </span>
      </div>
    </div>
  );
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
// Component
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { toast } = useToast();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notRegistered, setNotRegistered] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [lockLoading, setLockLoading] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Set page title
  useEffect(() => {
    document.title = 'Dashboard | LazyLotto Agent';
  }, []);

  // Check for auth token on mount, then fetch data
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    setSessionToken(token);

    if (!token) {
      setLoading(false);
      return;
    }

    const headers = { Authorization: `Bearer ${token}` };

    Promise.all([
      fetch('/api/user/status', { headers }),
      fetch('/api/user/history', { headers }),
    ])
      .then(async ([statusRes, historyRes]) => {
        if (statusRes.status === 401 || historyRes.status === 401) {
          localStorage.removeItem('lazylotto:sessionToken');
          localStorage.removeItem('lazylotto:accountId');
          window.location.href = '/auth';
          return;
        }

        if (statusRes.status === 404) {
          // User authenticated but not registered as a player
          setNotRegistered(true);
          setLoading(false);
          return;
        }

        if (!statusRes.ok) {
          const body = await statusRes.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ??
              `Status API returned ${statusRes.status}`,
          );
        }

        if (!historyRes.ok) {
          const body = await historyRes.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ??
              `History API returned ${historyRes.status}`,
          );
        }

        const statusData: StatusResponse = await statusRes.json();
        const historyData: HistoryResponse = await historyRes.json();

        setStatus(statusData);
        setSessions(historyData.sessions ?? []);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      })
      .finally(() => {
        setLoading(false);
      });
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
        window.location.href = '/auth';
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Lock failed (${res.status})`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLockLoading(false);
    }
  }, [sessionToken]);

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
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
          <p className="text-sm text-muted">Loading your dashboard...</p>
        </div>
      </div>
    );
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
    const accountId = typeof window !== 'undefined' ? localStorage.getItem('lazylotto:accountId') : null;
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-secondary p-8 text-center shadow-lg">
          <h1 className="mb-3 font-heading text-xl text-foreground">
            Welcome, {accountId ?? 'Explorer'}
          </h1>
          <p className="mb-2 text-sm text-muted">
            You&apos;re authenticated but not yet registered as a player.
          </p>
          <p className="mb-6 text-sm text-muted">
            To get started, connect the LazyLotto Agent to your Claude Desktop
            using the MCP URL from the authentication page, then ask Claude to
            register you and deposit funds.
          </p>
          <a
            href="/auth"
            className="inline-block rounded-lg bg-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-primary/90"
          >
            Get Your MCP Connection
          </a>
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
              </div>
            )}
          </div>

          {/* ---- Play History (full width) ---- */}
          <div className="lg:col-span-2">
            <h2 className="mb-1 font-heading text-lg text-foreground">
              Play History
            </h2>
            <p className="mb-4 text-xs text-muted">
              Your lottery play history. Each entry represents one agent play session across one or more pools.
            </p>

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
            {sessions.length > 0 ? (
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

                              {/* NFT prizes — enriched cards */}
                              {(() => {
                                const enrichedNfts = s.poolResults
                                  .flatMap((pr) => pr.prizeDetails)
                                  .flatMap((pd) => pd.enrichedNfts ?? []);
                                if (enrichedNfts.length === 0) return null;
                                return (
                                  <div className="flex flex-wrap gap-2">
                                    {enrichedNfts.map((nft) => (
                                      <PrizeNftCard
                                        key={`${nft.hederaId}-${nft.serial}`}
                                        nft={nft}
                                      />
                                    ))}
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

            <button
              type="button"
              onClick={() => void handleLock()}
              disabled={lockLoading}
              className="rounded-md bg-brand px-4 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {lockLoading ? 'Locking...' : 'Lock API Key'}
            </button>

            <button
              type="button"
              onClick={() => void handleRevoke()}
              disabled={revokeLoading}
              className="rounded-md border border-destructive/50 px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {revokeLoading ? 'Revoking...' : 'Revoke & Re-authenticate'}
            </button>
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
    </div>
  );
}
