'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '../components/Toast';
import { ComicPanel } from '../components/ComicPanel';
import { SkeletonBox } from '../components/SkeletonBox';
import { clearSession } from '../lib/session';
import { useTheme, type ThemePreference } from '../lib/theme';
import { ThemePreviewMini } from '../components/ThemePreviewMini';
import { StrategySwitcher, type StrategyName } from './StrategySwitcher';

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
  const [theme, setTheme] = useTheme();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  // True when the auth token is valid but the user has no player profile
  // (admin-only accounts who never registered as a player). The profile
  // section then renders a "no player profile" panel with the localStorage
  // identity instead of going blank.
  const [notRegistered, setNotRegistered] = useState(false);
  // Snapshot of localStorage so the profile section has SOMETHING to show
  // for admin-only / not-registered users. Reads happen in a mount effect
  // to keep SSR deterministic.
  const [storedAccountId, setStoredAccountId] = useState<string | null>(null);
  const [storedTier, setStoredTier] = useState<string | null>(null);
  const [deadLetters, setDeadLetters] = useState<UserDeadLetter[]>([]);
  const [publicStats, setPublicStats] = useState<PublicStats | null>(null);
  const [lockLoading, setLockLoading] = useState(false);
  const [lockConfirming, setLockConfirming] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [strategyLoading, setStrategyLoading] = useState(false);

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
    setStoredAccountId(localStorage.getItem('lazylotto:accountId'));
    setStoredTier(localStorage.getItem('lazylotto:tier'));
    if (!token) {
      router.replace('/auth');
      return;
    }
    const headers = { Authorization: `Bearer ${token}` };

    void (async () => {
      try {
        const res = await fetch('/api/user/status', { headers });
        if (res.status === 401) {
          clearSession();
          router.replace('/auth?expired=1');
          return;
        }
        if (res.status === 404) {
          // Authenticated but no player profile — common for admin-only
          // accounts that never registered as players. Surface as a
          // distinct state so the profile section can render the
          // localStorage identity + an explanation, instead of going
          // blank. The previous version silently swallowed the 404 and
          // the profile card just showed nothing.
          setNotRegistered(true);
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
        clearSession();
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

  const handleStrategyChange = useCallback(
    async (newStrategy: StrategyName) => {
      if (!sessionToken || !status) return;
      if (newStrategy === status.strategyName) return; // no-op
      setStrategyLoading(true);
      try {
        const res = await fetch('/api/user/strategy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ strategy: newStrategy }),
        });
        if (res.status === 401) {
          clearSession();
          router.replace('/auth?expired=1');
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ??
              `Strategy update failed (${res.status})`,
          );
        }
        const data = (await res.json()) as {
          status: string;
          strategyName: string;
          strategyVersion: string;
        };
        // Optimistically update the local status snapshot so the UI
        // reflects the new strategy without a refetch.
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                strategyName: data.strategyName,
                strategyVersion: data.strategyVersion,
              }
            : prev,
        );
        toast(`Strategy changed to ${data.strategyName}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        toast(`Strategy update failed: ${message}`, { variant: 'error' });
      } finally {
        setStrategyLoading(false);
      }
    },
    [router, sessionToken, status, toast],
  );

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
      clearSession();
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
        {/* ---- Header ----
            "Settings, support & proof" makes stuck-deposit support
            discoverable BEFORE the user has a crisis — most users
            won't recognize "settings" alone hides the refund flow
            and the on-chain trust links. */}
        <header className="mb-10">
          <p className="label-caps-lg mb-2">Settings, support &amp; proof</p>
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

                  {/* Strategy picker — spans both columns so the
                      three radio cards lay out horizontally on desktop
                      and stack on mobile. Extracted to ./StrategySwitcher
                      on 2026-04-22 for isolated RTL testing. */}
                  <div className="sm:col-span-2">
                    <dt className="label-caps mb-2">Strategy</dt>
                    <dd>
                      <StrategySwitcher
                        value={status.strategyName as StrategyName}
                        version={status.strategyVersion}
                        loading={strategyLoading}
                        onChange={(v) => void handleStrategyChange(v)}
                      />
                    </dd>
                  </div>
                </dl>
              ) : notRegistered ? (
                // Authenticated but no player profile. Common case: an
                // operator/admin who never registered as a player. Show
                // what we know from localStorage + a friendly explanation
                // + a link to /dashboard where they can register if they
                // want to also play.
                <dl
                  aria-label="Account profile"
                  className="grid gap-x-8 gap-y-4 sm:grid-cols-2"
                >
                  <div>
                    <dt className="label-caps mb-1">Hedera account</dt>
                    <dd className="font-mono text-sm text-foreground">
                      {storedAccountId ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="label-caps mb-1">Tier</dt>
                    <dd className="text-sm capitalize text-foreground">
                      {storedTier ?? 'user'}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="label-caps mb-1">Player profile</dt>
                    <dd className="text-sm text-muted">
                      Not registered as a player.{' '}
                      <a
                        href="/dashboard"
                        className="text-brand transition-colors hover:text-foreground"
                      >
                        Register on the dashboard
                      </a>{' '}
                      if you want to play with this account.
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

          {/* ---- Preferences ──────────────────────────────────
              Display toggle between the full comic vocabulary
              ("Comic" — halftone textures, hard neo-brutalist
              shadows, full mascot-wake) and a subdued variant
              ("Calm" — flat tints, softer shadows, quieter
              mascot presence). Same palette, same typography,
              same components — just different intensity. The
              setting persists in localStorage and applies
              instantly via data-theme on <html>. */}
          <ComicPanel tone="muted" halftone="none">
            <div className="px-6 py-6">
              <h2 className="heading-1 mb-2 text-foreground">Display</h2>
              <p className="type-caption mb-5">
                Choose how loud the LazyLotto vocabulary is. The product
                works the same either way — this is just the volume.
              </p>
              <fieldset>
                <legend className="sr-only">Display mode</legend>
                <div
                  role="radiogroup"
                  aria-label="Display mode"
                  className="grid gap-3 sm:grid-cols-2"
                >
                  {(
                    [
                      {
                        value: 'comic',
                        label: 'Comic',
                        blurb:
                          'Full brand. Halftone, hard shadows, mascot in your face. The default.',
                      },
                      {
                        value: 'calm',
                        label: 'Calm',
                        blurb:
                          'Same brand, quieter. Flat panels, softer shadows, subdued motion.',
                      },
                    ] as const
                  ).map((opt) => {
                    const isSelected = theme === opt.value;
                    return (
                      <label
                        key={opt.value}
                        className={`group relative flex cursor-pointer flex-col gap-1.5 border-2 bg-[var(--color-panel)] px-3 pt-3 pb-4 transition-colors ${
                          isSelected
                            ? 'border-brand bg-brand/5'
                            : 'border-secondary hover:border-brand/60'
                        }`}
                      >
                        <input
                          type="radio"
                          name="theme"
                          value={opt.value}
                          checked={isSelected}
                          onChange={() => setTheme(opt.value as ThemePreference)}
                          className="sr-only"
                        />
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-3 w-3 border-2 ${
                              isSelected
                                ? 'border-brand bg-brand'
                                : 'border-secondary'
                            }`}
                            aria-hidden="true"
                          />
                          <span className="font-heading text-sm font-extrabold uppercase tracking-wider text-foreground">
                            {opt.label}
                          </span>
                        </div>
                        <p className="type-caption">{opt.blurb}</p>
                        {/* Live mini-preview of the mode — renders a tiny
                            hero-panel sample with the treatment the option
                            represents, regardless of the current root
                            theme. Lets users see the difference before
                            committing. */}
                        <ThemePreviewMini variant={opt.value} />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
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
                      className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-2 font-pixel text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
                    >
                      Agent wallet <span aria-hidden="true">↗</span>
                    </a>
                  )}
                  {publicStats.hcs20TopicId && (
                    <a
                      href={`https://hashscan.io/${networkPath}/topic/${publicStats.hcs20TopicId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-2 font-pixel text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
                    >
                      HCS-20 trail <span aria-hidden="true">↗</span>
                    </a>
                  )}
                  <a
                    href="/audit"
                    className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-2 font-pixel text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
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
