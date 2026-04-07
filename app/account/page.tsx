'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '../components/Toast';
import { ComicPanel } from '../components/ComicPanel';
import { SkeletonBox } from '../components/SkeletonBox';

// ---------------------------------------------------------------------------
// /account — the "everything that's not the lottery" page
// ---------------------------------------------------------------------------
//
// Holds the surfaces that used to clutter the dashboard and aren't part
// of the core "play / withdraw" loop:
//
//   - Profile: account ID, registered date, last played
//   - Stuck deposits: dead-letter queue with refund actions
//   - Session token: copy / lock-permanent / revoke-and-resign
//   - Trust & proof: HashScan + HCS-20 + on-chain audit links
//
// The dashboard now does ONE thing — show the pot and let you play it.
// Anything that's accessed once a month or after a payment incident
// belongs here instead.

interface TokenBalanceEntry {
  available: number;
  reserved: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalRake: number;
}

interface StatusResponse {
  userId: string;
  hederaAccountId: string;
  eoaAddress: string;
  depositMemo: string;
  strategyName: string;
  strategyVersion: string;
  rakePercent: number;
  balances: { tokens: Record<string, TokenBalanceEntry> };
  active: boolean;
  registeredAt: string;
  lastPlayedAt: string | null;
  agentWallet?: string;
}

interface UserDeadLetter {
  transactionId: string;
  timestamp: string;
  error: string;
  sender?: string;
  memo?: string;
}

interface PublicStats {
  agentName: string;
  network: string;
  agentWallet: string | null;
  hcs20TopicId: string | null;
}

function maskToken(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}${'*'.repeat(8)}${token.slice(-4)}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function AccountPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [deadLetters, setDeadLetters] = useState<UserDeadLetter[]>([]);
  const [publicStats, setPublicStats] = useState<PublicStats | null>(null);
  const [lockLoading, setLockLoading] = useState(false);
  const [lockConfirming, setLockConfirming] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);

  // Support target — same env-driven config the dashboard uses for
  // the stuck-deposit "Contact Support" buttons.
  const supportUrl = (() => {
    const raw =
      typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SUPPORT_URL
        ? process.env.NEXT_PUBLIC_SUPPORT_URL.trim()
        : '';
    if (!raw) return null;
    if (/^(https?:|mailto:)/i.test(raw)) return raw;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return `mailto:${raw}`;
    return raw;
  })();
  const supportIsMailto = supportUrl?.startsWith('mailto:') ?? false;

  const buildSupportLink = useCallback(
    (transactionId?: string) => {
      if (!supportUrl) return null;
      if (!supportIsMailto || !transactionId) return supportUrl;
      const subject = encodeURIComponent(
        `LazyLotto stuck deposit refund — ${transactionId}`,
      );
      const body = encodeURIComponent(
        `Hi,\n\nI have a stuck deposit on LazyLotto.\n\n` +
          `Transaction ID: ${transactionId}\n\n` +
          `Please process a refund when you get a chance.\n\nThanks`,
      );
      const sep = supportUrl.includes('?') ? '&' : '?';
      return `${supportUrl}${sep}subject=${subject}&body=${body}`;
    },
    [supportUrl, supportIsMailto],
  );

  useEffect(() => {
    document.title = 'Account | LazyLotto Agent';
  }, []);

  // Fetch all the data this page needs in parallel
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    setSessionToken(token);
    if (!token) {
      router.replace('/auth');
      return;
    }
    const headers = { Authorization: `Bearer ${token}` };

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
        if (res.ok) {
          const data: StatusResponse = await res.json();
          setStatus(data);
        }
      } catch {
        /* silent — page still renders the bits we have */
      } finally {
        setStatusLoading(false);
      }
    })();

    void (async () => {
      try {
        const res = await fetch('/api/user/dead-letters', { headers });
        if (!res.ok) return;
        const data = (await res.json()) as { deadLetters?: UserDeadLetter[] };
        if (data.deadLetters) setDeadLetters(data.deadLetters);
      } catch {
        /* silent */
      }
    })();

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
  }, [router]);

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
      router.replace('/auth');
    }
  }, [sessionToken, router]);

  if (!sessionToken && !statusLoading) {
    // While the redirect lands, render nothing rather than a flash.
    return null;
  }

  const network =
    publicStats?.network ??
    (typeof process !== 'undefined' &&
    process.env?.NEXT_PUBLIC_HEDERA_NETWORK
      ? process.env.NEXT_PUBLIC_HEDERA_NETWORK
      : 'testnet');
  const networkPath = network === 'mainnet' ? 'mainnet' : network;

  return (
    <div className="relative w-full px-4 py-10 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        {/* ---- Header ---- */}
        <header className="mb-10">
          <p className="label-caps-lg mb-2">Settings & support</p>
          <h1 className="display-lg text-foreground">Account</h1>
        </header>

        <div className="space-y-10">
          {/* ---- Profile ──────────────────────────────────────
              Identity card. Account ID, registered, last played,
              strategy. Calm muted ComicPanel, no halftone — this
              is reference info, not a hero moment. */}
          <ComicPanel label="PROFILE" tone="muted" halftone="none">
            <div className="px-6 py-6">
              {statusLoading ? (
                <div className="space-y-3" aria-label="Loading profile">
                  <SkeletonBox className="h-4 w-48" />
                  <SkeletonBox className="h-4 w-64" />
                  <SkeletonBox className="h-4 w-56" />
                </div>
              ) : status ? (
                <dl
                  aria-label="Account profile"
                  className="grid gap-x-8 gap-y-4 sm:grid-cols-2"
                >
                  <div>
                    <dt className="label-caps mb-1">Hedera account</dt>
                    <dd className="font-mono text-sm text-foreground">
                      {status.hederaAccountId}
                    </dd>
                  </div>
                  <div>
                    <dt className="label-caps mb-1">Strategy</dt>
                    <dd className="text-sm text-foreground">
                      {status.strategyName}{' '}
                      <span className="text-muted">
                        ({status.strategyVersion})
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="label-caps mb-1">Registered</dt>
                    <dd className="text-sm text-foreground">
                      {formatTimestamp(status.registeredAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="label-caps mb-1">Last played</dt>
                    <dd className="text-sm text-foreground">
                      {status.lastPlayedAt
                        ? formatTimestamp(status.lastPlayedAt)
                        : 'Never'}
                    </dd>
                  </div>
                  <div>
                    <dt className="label-caps mb-1">Rake</dt>
                    <dd className="text-sm text-foreground">
                      {status.rakePercent}%
                    </dd>
                  </div>
                  <div>
                    <dt className="label-caps mb-1">Status</dt>
                    <dd className="text-sm text-foreground">
                      {status.active ? 'Active' : 'Inactive'}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="type-body text-muted">
                  Profile temporarily unavailable.
                </p>
              )}
            </div>
          </ComicPanel>

          {/* ---- Stuck deposits ──────────────────────────────
              Only rendered when there are actual stuck deposits.
              Full prominence here (destructive ComicPanel) since
              this page is where users come specifically to deal
              with payment incidents. */}
          {deadLetters.length > 0 && (
            <ComicPanel label="STUCK" tone="destructive" halftone="none">
              {/* Header — corner sticker says "STUCK", heading restates
                  the count, body explains the situation. The previous
                  version had three stacked labels (sticker + kicker +
                  heading) for the same state; the kicker is gone. The
                  body copy was bumped from type-caption to type-body
                  because users hitting this panel are stressed and
                  need clear instruction, not 12px footnote text. */}
              <div className="border-b-2 border-destructive/40 px-6 py-5">
                <h2 className="heading-1 mb-3 text-foreground">
                  {deadLetters.length === 1
                    ? '1 deposit needs attention'
                    : `${deadLetters.length} deposits need attention`}
                </h2>
                <p className="type-body text-muted">
                  {deadLetters.length === 1 ? 'A deposit' : 'These deposits'}{' '}
                  from your wallet couldn&apos;t be credited automatically.
                  The funds are still in the agent wallet.{' '}
                  {supportUrl
                    ? supportIsMailto
                      ? 'Click Contact Support on a row below — the transaction ID will be prefilled.'
                      : 'Click Contact Support on a row below to reach the operator.'
                    : 'Contact the operator with the transaction ID to request a refund.'}
                </p>
              </div>
              <ul className="divide-y divide-destructive/20">
                {deadLetters.map((dl) => {
                  const hashscanUrl = `https://hashscan.io/${networkPath}/transaction/${dl.transactionId}`;
                  const rowSupportUrl = buildSupportLink(dl.transactionId);
                  return (
                    <li key={dl.transactionId} className="px-6 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <code className="break-all font-mono text-xs text-destructive">
                          {dl.transactionId}
                        </code>
                        <div className="flex shrink-0 items-center gap-2">
                          {rowSupportUrl && (
                            <a
                              href={rowSupportUrl}
                              target={
                                supportIsMailto ? undefined : '_blank'
                              }
                              rel={
                                supportIsMailto
                                  ? undefined
                                  : 'noopener noreferrer'
                              }
                              className="border-2 border-destructive bg-destructive/20 px-3 py-1.5 label-caps-destructive transition-colors hover:bg-destructive/40"
                            >
                              Contact support
                            </a>
                          )}
                          <a
                            href={hashscanUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="border border-destructive/40 px-3 py-1.5 label-caps-destructive transition-colors hover:bg-destructive/10"
                          >
                            HashScan ↗
                          </a>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-muted">{dl.error}</p>
                      {dl.memo && (
                        <p className="mt-1 text-[10px] text-muted">
                          <span className="label-caps mr-2">Memo</span>
                          <code className="font-mono">{dl.memo}</code>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ComicPanel>
          )}

          {/* ---- Session token ──────────────────────────────
              Lock-permanent + revoke + copy. Muted ComicPanel —
              this is settings, not a hero moment. */}
          <ComicPanel label="SESSION" tone="muted" halftone="none">
            <div className="px-6 py-6">
              <h2 className="heading-1 mb-2 text-foreground">API session</h2>
              <p className="type-caption mb-5">
                Use this token as a Bearer header to call the agent over MCP
                from Claude Desktop or any other client. Lock it to make it
                permanent (never expires), or revoke to invalidate immediately.
              </p>

              <div className="mb-4 flex flex-wrap items-center gap-3">
                <code className="font-mono text-sm text-foreground">
                  {sessionToken ? maskToken(sessionToken) : '—'}
                </code>
                <button
                  type="button"
                  onClick={() =>
                    sessionToken && handleCopy(sessionToken, 'Session token')
                  }
                  disabled={!sessionToken}
                  className="border border-secondary px-3 py-1.5 label-caps transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                >
                  Copy
                </button>
              </div>

              {lockConfirming ? (
                <div className="border-2 border-brand/40 bg-brand/5 p-4">
                  <p className="type-body mb-3 text-foreground">
                    Make this token <strong>permanent</strong>? It will never
                    expire and can&apos;t be auto-revoked. Use this if you want
                    to wire it into a long-running script or MCP client.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void handleLock()}
                      disabled={lockLoading}
                      className="btn-primary-sm"
                    >
                      {lockLoading ? 'Locking…' : 'Confirm — make permanent'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setLockConfirming(false)}
                      disabled={lockLoading}
                      className="btn-ghost-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setLockConfirming(true)}
                    className="btn-primary-sm"
                    aria-label="Make this token permanent"
                  >
                    Lock API key
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRevoke()}
                    disabled={revokeLoading}
                    className="btn-ghost-sm-destructive"
                  >
                    {revokeLoading ? 'Revoking…' : 'Revoke & re-authenticate'}
                  </button>
                </div>
              )}
            </div>
          </ComicPanel>

          {/* ---- Trust & proof ──────────────────────────────
              Same proof-of-operation links the dashboard used to
              show in its footer. Belongs here next to the rest of
              the meta surfaces. */}
          {publicStats && (
            <ComicPanel label="PROOF" tone="muted" halftone="none">
              <div className="px-6 py-6">
                <h2 className="heading-1 mb-2 text-foreground">
                  Verify on-chain
                </h2>
                <p className="type-caption mb-5">
                  Every action this agent takes is publicly verifiable. Inspect
                  the agent wallet on HashScan, read the HCS-20 audit trail, or
                  browse our on-chain audit page.
                </p>
                <div className="flex flex-wrap gap-3">
                  {publicStats.agentWallet && (
                    <a
                      href={`https://hashscan.io/${networkPath}/account/${publicStats.agentWallet}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-2 font-pixel text-[9px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
                    >
                      Agent wallet <span aria-hidden="true">↗</span>
                    </a>
                  )}
                  {publicStats.hcs20TopicId && (
                    <a
                      href={`https://hashscan.io/${networkPath}/topic/${publicStats.hcs20TopicId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-2 font-pixel text-[9px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
                    >
                      HCS-20 trail <span aria-hidden="true">↗</span>
                    </a>
                  )}
                  <a
                    href="/audit"
                    className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-2 font-pixel text-[9px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
                  >
                    On-chain log <span aria-hidden="true">→</span>
                  </a>
                </div>
              </div>
            </ComicPanel>
          )}
        </div>
      </div>
    </div>
  );
}
