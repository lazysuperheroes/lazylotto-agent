'use client';

import { useState, useEffect, useCallback } from 'react';
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

interface PoolResult {
  poolId: number;
  poolName: string;
  entriesBought: number;
  amountSpent: number;
  rolled: boolean;
  wins: number;
  prizeDetails: { fungibleAmount?: number; fungibleToken?: string; nftCount?: number }[];
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
// Component
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { toast } = useToast();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [lockLoading, setLockLoading] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);

  // Set page title
  useEffect(() => {
    document.title = 'My Dashboard | LazyLotto Agent';
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

  // --- Dashboard ---
  return (
    <div className="w-full px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        {/* ---- Top Bar ---- */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="font-heading text-2xl text-foreground">
            My Dashboard
          </h1>

          {status && (
            <span className="rounded bg-brand px-2 py-0.5 text-xs font-semibold text-background">
              {status.strategyName}
            </span>
          )}
        </header>

        {/* Non-fatal error banner */}
        {error && status && (
          <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ---- Cards Grid ---- */}
        <div className="grid gap-6 lg:grid-cols-2">

          {/* ---- Balance Card ---- */}
          <div className="rounded-xl border border-secondary p-6 shadow">
            <h2 className="mb-1 font-heading text-lg text-foreground">
              Available Balance
            </h2>
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
                          <p className="font-heading text-lg text-brand">
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
                <p className="text-sm text-muted">
                  Send tokens to the agent wallet below. Include the deposit memo
                  so the agent can credit your account automatically.
                </p>

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

          {/* ---- Play History Card (full width) ---- */}
          <div className="rounded-xl border border-secondary p-6 shadow lg:col-span-2">
            <h2 className="mb-1 font-heading text-lg text-foreground">
              Recent Sessions
            </h2>
            <p className="mb-4 text-xs text-muted">
              Your lottery play history. Each row represents one agent play session across one or more pools.
            </p>

            {sessions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-secondary bg-secondary/50 text-left">
                      <th className="px-4 py-3 font-medium text-muted">Date</th>
                      <th className="px-4 py-3 font-medium text-muted">Pools</th>
                      <th className="px-4 py-3 text-right font-medium text-muted">Entries</th>
                      <th className="px-4 py-3 text-right font-medium text-muted">Spent</th>
                      <th className="px-4 py-3 text-right font-medium text-muted">Wins</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const totalEntries = s.poolResults.reduce(
                        (sum, pr) => sum + pr.entriesBought,
                        0,
                      );
                      const poolNames = s.poolResults.map((pr) => pr.poolName);

                      return (
                        <tr
                          key={s.sessionId}
                          className="border-b border-secondary transition-colors hover:bg-secondary/30"
                        >
                          <td className="whitespace-nowrap px-4 py-3 text-foreground">
                            {formatTimestamp(s.timestamp)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              {poolNames.map((pool) => (
                                <span
                                  key={pool}
                                  className="rounded bg-secondary px-2 py-0.5 text-xs text-muted"
                                >
                                  {pool}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right text-foreground">
                            {totalEntries}
                          </td>
                          <td className="px-4 py-3 text-right text-foreground">
                            {formatAmount(s.totalSpent)}
                          </td>
                          <td
                            className={`px-4 py-3 text-right font-medium ${
                              s.totalWins > 0 ? 'text-success' : 'text-muted'
                            }`}
                          >
                            {s.totalWins > 0 ? formatAmount(s.totalWins) : '--'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-lg bg-secondary/30 px-5 py-6 text-center">
                <p className="text-sm text-muted">
                  No sessions yet. Ask Claude to play a lottery session for you, or deposit funds to get started.
                </p>
              </div>
            )}
          </div>

          {/* ---- Session Card (full width) ---- */}
          <div className="rounded-xl border border-secondary p-6 shadow lg:col-span-2">
            <h2 className="mb-1 font-heading text-lg text-foreground">
              Your Session
            </h2>
            <p className="mb-4 text-xs text-muted">
              Your active API session. Lock the key to make it permanent, or revoke to end it.
            </p>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
                  Session Token
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-secondary bg-[#111113] px-4 py-3">
                  <code className="flex-1 font-mono text-sm text-muted">
                    {maskToken(sessionToken)}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopy(sessionToken, 'Session token')}
                    className="shrink-0 rounded-md border border-secondary px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
                  >
                    Copy
                  </button>
                </div>
              </div>

              {status && (
                <p className="text-sm text-muted">
                  Account registered{' '}
                  {formatTimestamp(status.registeredAt)}.
                  {status.lastPlayedAt
                    ? ` Last played ${formatTimestamp(status.lastPlayedAt)}.`
                    : ' No play sessions yet.'}
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleLock()}
                  disabled={lockLoading}
                  className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {lockLoading ? 'Locking...' : 'Lock API Key'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRevoke()}
                  disabled={revokeLoading}
                  className="rounded-md border border-destructive/50 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  {revokeLoading ? 'Revoking...' : 'Revoke & Re-authenticate'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
