'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '../components/Toast';
import { Modal } from '../components/Modal';
import { ComicPanel } from '../components/ComicPanel';
import { SpeechBubble } from '../components/SpeechBubble';
import { ActionBurst } from '../components/ActionBurst';
import { GoldConfetti } from '../components/GoldConfetti';
import {
  PrizeNftCard,
  type PrizeNftRef,
  type EnrichedPrizeNft,
} from '../components/PrizeNftCard';
import { useNftEnrichment } from '../components/useNftEnrichment';
import {
  LSH_CHARACTERS,
  loadOrPickCharacterIdx,
  pickLine,
  CHARACTER_CHANGE_EVENT,
  type CharacterChangeDetail,
} from '../lib/characters';

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

interface VelocityState {
  cap: number | null;
  usedToday: number;
  remaining: number | null;
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
  /** Per-token 24h withdrawal velocity counters (cap + used + remaining). */
  velocity?: Record<string, VelocityState>;
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
  // Persistent character mascot — shared with /auth via localStorage.
  // Starts at 0 for SSR determinism, rehydrated on mount.
  const [characterIdx, setCharacterIdx] = useState(0);
  // Win celebration overlay — populated when handlePlay returns wins,
  // auto-clears after 3.5s. The label is the action-burst text
  // ("WIN!", "BIG WIN!", etc.). Pointer-events-none so it never
  // blocks interaction.
  const [winCelebration, setWinCelebration] = useState<string | null>(null);
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

  // Self-serve register + withdraw + play state
  const [registerLoading, setRegisterLoading] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawToken, setWithdrawToken] = useState('hbar');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [playLoading, setPlayLoading] = useState(false);
  // Deposit card collapse — starts closed; auto-opens on mount if the
  // user has no balance (they need the info to fund). After that it's
  // user-controlled via the header toggle.
  const [depositCardOpen, setDepositCardOpen] = useState(false);
  const [depositCardAutoDecided, setDepositCardAutoDecided] = useState(false);

  // Stuck deposits (dead letters) belonging to this user
  interface UserDeadLetter {
    transactionId: string;
    timestamp: string;
    error: string;
    sender?: string;
    memo?: string;
  }
  const [deadLetters, setDeadLetters] = useState<UserDeadLetter[]>([]);

  // Public agent stats (for trust panel + operational status banner)
  interface PublicStats {
    agentName: string;
    network: string;
    agentWallet: string | null;
    users: { total: number; active: number };
    rake: { defaultPercent: number };
    tvl: Record<string, number>;
    hcs20TopicId: string | null;
    // Operational status — "open for business" / "temporarily closed"
    acceptingOperations?: boolean;
    statusMessage?: string;
    statusReason?: string | null;
  }
  const [publicStats, setPublicStats] = useState<PublicStats | null>(null);

  // Overall "still loading something" flag for the full-page skeleton
  const loading = statusLoading && historyLoading;

  // Support target for the dead-letter card and footer. Configurable via
  // NEXT_PUBLIC_SUPPORT_URL so the operator can point users at Discord,
  // a form, or an email address. Accepted formats:
  //   - https://... / http://...  → opens in a new tab
  //   - mailto:...                 → opens the user's mail client
  //   - bare email (foo@bar.com)   → normalized to mailto: automatically
  // Null when unset — the UI falls back to plain text.
  const supportUrl = useMemo(() => {
    const raw =
      typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SUPPORT_URL
        ? process.env.NEXT_PUBLIC_SUPPORT_URL.trim()
        : '';
    if (!raw) return null;
    // Already a proper URL scheme
    if (/^(https?:|mailto:)/i.test(raw)) return raw;
    // Bare email address — prepend mailto:
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return `mailto:${raw}`;
    // Anything else — best-effort pass-through
    return raw;
  }, []);
  const supportIsMailto = supportUrl?.startsWith('mailto:') ?? false;

  /**
   * Build a per-deposit support URL. For mailto targets we prefill the
   * subject + body with the stuck transaction ID so the user doesn't
   * have to copy-paste, and support can triage faster. For https
   * targets we return the raw URL — we can't prefill form fields on a
   * third-party site.
   */
  const buildSupportLink = useCallback(
    (transactionId?: string) => {
      if (!supportUrl) return null;
      if (!supportIsMailto || !transactionId) return supportUrl;
      const subject = encodeURIComponent(
        `LazyLotto stuck deposit refund — ${transactionId}`,
      );
      const body = encodeURIComponent(
        `Hi,\n\nI have a stuck deposit on LazyLotto.\n\n` +
          `Transaction ID: ${transactionId}\n` +
          `Account: ${storedAccountId ?? '(not signed in)'}\n\n` +
          `Please process a refund when you get a chance.\n\nThanks`,
      );
      // Append query params, respecting any existing ones the operator
      // may have set (mailto:foo@bar.com?cc=ops@bar.com etc).
      const sep = supportUrl.includes('?') ? '&' : '?';
      return `${supportUrl}${sep}subject=${subject}&body=${body}`;
    },
    [supportUrl, supportIsMailto, storedAccountId],
  );

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

  // Listen for mascot reroll from the sidebar. Same-tab CustomEvent —
  // the localStorage storage event doesn't fire for the tab that
  // performed the write, so we broadcast our own.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CharacterChangeDetail>).detail;
      if (typeof detail?.idx === 'number') {
        setCharacterIdx(detail.idx);
      }
    };
    window.addEventListener(CHARACTER_CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHARACTER_CHANGE_EVENT, handler);
  }, []);

  // ── Status fetch (mount + retry) ─────────────────────────────
  // Extracted from the mount useEffect so the user can retry a failed
  // /api/user/status load from an inline balance-card error state
  // without reloading the whole page. A status failure no longer
  // wipes the dashboard — history, deposits, and the trust panel
  // keep rendering independently.
  const loadStatus = useCallback(
    async (headers: { Authorization: string }) => {
      setStatusLoading(true);
      setError(null);
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
          setHistoryLoading(false);
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
    },
    [router],
  );

  const retryStatus = useCallback(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
      return;
    }
    void loadStatus({ Authorization: `Bearer ${token}` });
  }, [loadStatus, router]);

  // Check for auth token on mount, then fetch data independently
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    setSessionToken(token);
    setStoredAccountId(localStorage.getItem('lazylotto:accountId'));
    setCharacterIdx(loadOrPickCharacterIdx());

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
      await loadStatus(headers);
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

  // Manual "Check for deposits" trigger — lets the user nudge the
  // deposit watcher after they send HBAR from their wallet without
  // having to reload the whole page. Shares the depositsChecking
  // loading state with the mount-time background check so only one
  // spinner is ever visible.
  const handleCheckDeposits = useCallback(async () => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
      return;
    }
    if (depositsChecking) return; // already running
    setDepositsChecking(true);
    try {
      const res = await fetch('/api/user/check-deposits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Check failed (${res.status})`,
        );
      }
      const data = (await res.json()) as {
        processed?: number;
        balances?: StatusResponse['balances'];
        lastPlayedAt?: string | null;
      };
      const processed = data.processed ?? 0;
      if (processed > 0 && data.balances) {
        // Patch the status in place so the hero balance updates
        // immediately without a full refetch.
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                balances: data.balances!,
                lastPlayedAt: data.lastPlayedAt ?? prev.lastPlayedAt,
              }
            : prev,
        );
        toast(
          processed === 1
            ? 'Found 1 new deposit'
            : `Found ${processed} new deposits`,
        );
      } else {
        toast('No new deposits yet — try again in a few seconds', {
          variant: 'info',
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Check failed: ${message}`, { variant: 'error' });
    } finally {
      setDepositsChecking(false);
    }
  }, [depositsChecking, router, toast]);

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

  // Self-serve play session
  const handlePlay = useCallback(async () => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (!token) {
      router.replace('/auth');
      return;
    }
    setPlayLoading(true);
    try {
      const res = await fetch('/api/user/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) {
        // Kill switch engaged — use the operator's reason
        const reason = (body as { reason?: string }).reason;
        toast(
          reason
            ? `Agent temporarily closed: ${reason}`
            : 'Agent temporarily closed to new plays',
          { variant: 'info' },
        );
        return;
      }
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error ?? `Play failed (${res.status})`,
        );
      }
      const { session, balances } = body as {
        session: {
          totalWins: number;
          totalSpent: number;
          totalPrizeValue: number;
          poolsPlayed: number;
        };
        balances?: StatusResponse['balances'];
      };

      // Win celebration — fire the comic burst overlay when the session
      // returned actual wins. The label scales with the prize value
      // so a 10× spent prize gets "BIG WIN!" and a tiny one just gets
      // "WIN!". The overlay auto-clears after 3.5s via the setTimeout.
      if (session.totalWins > 0) {
        const ratio =
          session.totalSpent > 0
            ? session.totalPrizeValue / session.totalSpent
            : 0;
        const label =
          ratio >= 5
            ? 'JACKPOT!'
            : ratio >= 2
              ? 'BIG WIN!'
              : 'WIN!';
        setWinCelebration(label);
        window.setTimeout(() => setWinCelebration(null), 3500);
        toast(`${label} ${session.totalWins} win(s) across ${session.poolsPlayed} pool(s)`);
      } else {
        toast(
          `Played ${session.poolsPlayed} pool(s), no wins this round`,
          { variant: 'info' },
        );
      }

      // Update balance in place so the user sees the effect immediately
      if (balances) {
        setStatus((prev) => (prev ? { ...prev, balances } : prev));
      }
      // Refetch history so the new session shows up in the list. Fire
      // and forget — failure is silent; the session is already persisted.
      void (async () => {
        try {
          const hres = await fetch('/api/user/history', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (hres.ok) {
            const data = (await hres.json()) as { sessions?: PlaySession[] };
            setSessions(data.sessions ?? []);
          }
        } catch {
          /* silent */
        }
      })();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Play failed: ${message}`, { variant: 'error' });
    } finally {
      setPlayLoading(false);
    }
  }, [router, toast]);

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

  // Auto-open the deposit card once — on first status load, open it
  // iff the user has no balance yet. After that, the user controls it
  // manually via the header toggle. The `depositCardAutoDecided` flag
  // prevents this effect from re-running and clobbering a deliberate
  // user toggle when status refetches (e.g. after a play session).
  //
  // MUST live here — above the early returns — so React's Rules of
  // Hooks is satisfied (hooks must be called in the same order on
  // every render, regardless of which branch the component takes).
  // We compute hasBalance inline from `status` rather than referencing
  // the outer derivation, which is defined further down the function
  // body after the early-return block.
  useEffect(() => {
    if (!status || depositCardAutoDecided) return;
    const entries = Object.entries(status.balances.tokens);
    const hasBalance = entries.some(([, e]) => e.available > 0);
    setDepositCardOpen(!hasBalance);
    setDepositCardAutoDecided(true);
  }, [status, depositCardAutoDecided]);

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

  // Note: the old lastSessionTrend sparkline arrow was removed in the
  // /bolder pass — it was decorative and only reachable via a `title`
  // tooltip. Last-session feedback now belongs in a proper delta on
  // the play history row, not as an icon next to the hero balance.

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
        <div className="w-full max-w-md border-2 border-secondary p-8 text-center">
          <p className="label-caps-brand-lg mb-3">Sign in required</p>
          <h1 className="display-md mb-3 text-foreground">
            Authentication Required
          </h1>
          <p className="type-body mb-6 text-muted">
            Please authenticate with your Hedera wallet to access your dashboard.
          </p>
          <a
            href="/auth"
            className="inline-block border-2 border-brand bg-brand px-6 py-3 font-pixel text-[10px] uppercase tracking-wider text-background transition-opacity hover:opacity-90"
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
        <div className="w-full max-w-md border-2 border-brand bg-brand/5 p-8 text-center panel-shadow-sm">
          <p className="label-caps-brand-lg mb-3">Welcome</p>
          <h1 className="display-md mb-3 text-foreground">
            {storedAccountId ?? 'Explorer'}
          </h1>
          <p className="type-body mb-6 text-muted">
            You&apos;re signed in but haven&apos;t registered as a player yet.
            One click and you&apos;ll get a deposit memo so you can fund your
            account and start playing.
          </p>
          <button
            type="button"
            onClick={handleRegister}
            disabled={registerLoading}
            className="inline-block border-2 border-brand bg-brand px-6 py-3 font-pixel text-[10px] uppercase tracking-wider text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {registerLoading ? 'Registering…' : 'Register Now'}
          </button>
          <p className="type-caption mt-4">
            You&apos;ll be using the{' '}
            <span className="text-foreground font-semibold">balanced</span> strategy by
            default. You can change it later from the dashboard.
          </p>
        </div>
      </div>
    );
  }

  // NOTE: We no longer return a full-page error when /api/user/status
  // fails. The balance + deposit cards render an inline error state with
  // Retry below, and the rest of the dashboard (history, trust panel,
  // dead letters) continues to render independently. This means a
  // single transient Redis blip on status doesn't wipe the whole page.

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

  // ── Hero derivations ─────────────────────────────────────────
  // The hero panel shows ONE huge balance number. We pick the token
  // with the highest `available` balance as the primary; any other
  // non-zero tokens are surfaced as secondary pills below. Multi-
  // token users still see everything, single-token users (the common
  // case) see one confident pot.
  const character = LSH_CHARACTERS[characterIdx] ?? LSH_CHARACTERS[0]!;
  const primaryBalanceEntry = balanceEntries.reduce<
    [string, typeof balanceEntries[number][1]] | null
  >((best, current) => {
    if (!best) return current;
    return current[1].available > best[1].available ? current : best;
  }, null);
  const secondaryBalanceEntries = primaryBalanceEntry
    ? balanceEntries.filter(
        ([k, e]) => k !== primaryBalanceEntry[0] && (e.available > 0 || e.reserved > 0),
      )
    : [];
  const hasPlayableBalance = balanceEntries.some(([, e]) => e.available > 0);
  const agentClosed =
    publicStats?.acceptingOperations === false;
  // First-run = just registered, no balance, no plays. The mascot
  // teaches the loop in this state. As soon as the user funds, they
  // graduate to "ready" and the line changes to a nudge toward PLAY.
  // After the first play, they rotate through lazy quips. Kill
  // switch overrides everything.
  const isFirstRun =
    !!status && sessions.length === 0 && !hasPlayableBalance;
  // Pick a character line deterministically per session so the same
  // page refresh shows the same quip (but different sessions rotate).
  const characterLine = status
    ? agentClosed
      ? pickLine(character.nappingLines, status.userId)
      : isFirstRun
        ? pickLine(character.introLines, status.userId)
        : hasPlayableBalance && sessions.length === 0
          ? pickLine(character.readyLines, status.userId)
          : hasPlayableBalance
            ? pickLine(character.lazyLines, status.userId)
            : pickLine(character.taglines, status.userId)
    : '';

  // Sessions to display (capped at 10 unless expanded)
  const displayedSessions = showAll ? sessions : sessions.slice(0, 10);

  // --- Dashboard ---
  return (
    <div className="relative w-full px-4 py-10 sm:px-6 lg:px-10">
      {/* ─── Win celebration overlay ─────────────────────────
          Fixed-positioned, pointer-events:none, full-viewport.
          Renders the GoldConfetti rain plus a centred ActionBurst
          stamped with the win label ("WIN!", "BIG WIN!", "JACKPOT!").
          Auto-clears after 3.5s via the timeout in handlePlay.
          Sits at z-30 so it floats over the hero panel but below
          the toast container (z-50).  */}
      {winCelebration && (
        <div
          className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center"
          role="status"
          aria-live="polite"
        >
          <GoldConfetti count={36} />
          <div className="burst-stamp">
            <ActionBurst size={240} tone="brand">
              {winCelebration}
            </ActionBurst>
          </div>
          <span className="sr-only">{winCelebration}</span>
        </div>
      )}

      <div className="mx-auto max-w-6xl">
        {/* ---- Top Bar ──────────────────────────────────────
            Thin pixel-font header. Dropped the redundant network
            badge (the sidebar has a much bigger one now) and the
            strategy badge (it moved into the hero metadata row).
            The page title functions more like a chapter header on
            a comic book page than a dashboard nameplate. */}
        <header className="mb-10 flex items-baseline justify-between gap-4">
          <div>
            <p className="label-caps-lg mb-2">Your agent</p>
            <h1 className="display-lg text-foreground">Dashboard</h1>
          </div>
          {/* Account chip — shows the user's Hedera account ID and
              acts as the disconnect button. Standard dApp convention:
              your address is in the corner, click to sign out. */}
          {status?.hederaAccountId && (
            <button
              type="button"
              onClick={() => {
                if (
                  typeof window !== 'undefined' &&
                  window.confirm('Disconnect from this dashboard? You can sign back in anytime.')
                ) {
                  localStorage.removeItem('lazylotto:sessionToken');
                  localStorage.removeItem('lazylotto:accountId');
                  localStorage.removeItem('lazylotto:tier');
                  localStorage.removeItem('lazylotto:expiresAt');
                  localStorage.removeItem('lazylotto:locked');
                  // Full reload to clear React state across the app
                  window.location.href = '/auth';
                }
              }}
              title="Click to disconnect"
              className="group hidden items-center gap-2 border border-secondary bg-[var(--color-panel)] px-3 py-2 transition-colors hover:border-destructive sm:inline-flex"
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success transition-colors group-hover:bg-destructive"
                aria-hidden="true"
              />
              <code className="font-mono text-xs text-foreground">
                {status.hederaAccountId.length > 14
                  ? `${status.hederaAccountId.slice(0, 7)}…${status.hederaAccountId.slice(-4)}`
                  : status.hederaAccountId}
              </code>
              <span
                className="text-xs text-muted transition-colors group-hover:text-destructive"
                aria-hidden="true"
              >
                ↗
              </span>
              <span className="sr-only">Disconnect from this dashboard</span>
            </button>
          )}
        </header>

        {/* ---- Agent operational status ────────────────────
            Kill switch banner rendered as a destructive ComicPanel
            when the operator has paused operations. Same vocabulary
            as the rest of the page so it doesn't feel like an
            afterthought. */}
        {publicStats && publicStats.acceptingOperations === false && (
          <div className="mb-8">
            <ComicPanel
              label="AGENT CLOSED"
              tone="destructive"
              halftone="none"
            >
              <div
                id="agent-status-banner"
                role="status"
                aria-live="polite"
                className="flex items-start gap-3 p-5"
              >
                <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-destructive" />
                <div className="min-w-0 flex-1">
                  <p className="heading-2 text-foreground">
                    {publicStats.statusMessage ?? 'Agent temporarily closed'}
                  </p>
                  <p className="type-caption mt-1">
                    New plays and registrations are paused.
                    Your balance is safe and withdrawals remain available.
                  </p>
                  {publicStats.statusReason && (
                    <p className="mt-2 border-l-2 border-destructive bg-background/40 px-3 py-2 text-xs text-foreground">
                      <span className="label-caps mr-2">Reason</span>
                      <span className="font-mono">{publicStats.statusReason}</span>
                    </p>
                  )}
                </div>
              </div>
            </ComicPanel>
          </div>
        )}

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

        {/* ══════════════════════════════════════════════════════════
            HERO PANEL — the one confident moment on the dashboard.
            ═══════════════════════════════════════════════════════════
            Mascot + pot number + PLAY + withdraw link + metadata strip,
            all inside a single comic-book panel with halftone texture,
            brand-gold border, and an ISSUE #001 corner sticker.

            This block intentionally lives OUTSIDE the 2-col grid below,
            so it spans the full width of the page and becomes the
            unambiguous primary moment. Everything else (deposit card,
            stuck deposits, history, trust panel) demotes beneath it.
            ══════════════════════════════════════════════════════════ */}
        {status && (
          <ComicPanel label="ISSUE #001" halftone="dense" className="mb-12">
            <div className="grid gap-6 p-6 sm:p-8 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
              {/* Mascot slot — comic-panel frame matching the sidebar
                  for visual continuity. Border tone reflects state:
                  brand gold normally, destructive when the agent is
                  paused. Idle float animation breathes the mascot;
                  hover wake responds to gesture. When the kill switch
                  is engaged, an animated "Zzz" overlay floats up from
                  the top-right corner. */}
              <div className="mx-auto w-32 shrink-0 sm:w-40 md:mx-0 md:w-44">
                <div
                  className={`relative border-2 ${
                    agentClosed ? 'border-destructive' : 'border-brand'
                  } bg-[var(--color-panel)] p-2 panel-shadow-sm mascot-wake`}
                >
                  <img
                    src={character.imgLarge}
                    alt={character.name}
                    width={176}
                    height={176}
                    className="block h-auto w-full select-none mascot-idle"
                    draggable={false}
                  />
                  {/* Sleep "Zzz" indicator overlay — only shown when
                      the operator has paused the agent. Muted brand
                      tone rather than destructive red so it reads as
                      "napping" not "alarm". The destructive border on
                      the frame already carries the alarm signal. */}
                  {agentClosed && (
                    <span
                      className="absolute -right-2 -top-3 font-heading text-xl font-extrabold text-brand/70 sleep-z"
                      aria-hidden="true"
                    >
                      Z
                    </span>
                  )}
                </div>
                <p className="mt-2 text-center font-pixel text-[9px] uppercase tracking-wider text-brand">
                  {character.name}
                </p>
              </div>

              {/* Hero content */}
              <div className="min-w-0">
                {/* Metadata row — small caps lg for prominence */}
                <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2">
                  <span className="label-caps-lg">Your agent</span>
                  <span className="label-caps-brand-lg">
                    Strategy · {status.strategyName}
                  </span>
                  <span className="label-caps-lg">Rake {status.rakePercent}%</span>
                  {depositsChecking && (
                    <span className="label-caps-brand inline-flex items-center gap-1.5">
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                      Checking deposits
                    </span>
                  )}
                </div>

                {/* Display number — the hero moment. Always render, even
                    when the user has no token entries yet: show a muted
                    zero so the hero feels committed instead of broken.
                    Uses the formal .display-xl scale utility so the
                    hero balance is the ONE place in the app that uses
                    this size — no accidental duplication elsewhere. */}
                {(() => {
                  const displayAvailable = primaryBalanceEntry?.[1].available ?? 0;
                  const displayReserved = primaryBalanceEntry?.[1].reserved ?? 0;
                  const displayToken = primaryBalanceEntry
                    ? tokenSymbol(primaryBalanceEntry[0])
                    : 'HBAR';
                  const isEmpty = displayAvailable === 0 && displayReserved === 0;
                  return (
                    <div className="mb-2">
                      <p className="label-caps-lg mb-2">
                        {isEmpty ? 'Empty' : 'Pot'}
                      </p>
                      <p
                        className={`display-xl ${
                          isEmpty ? 'text-muted/40' : 'text-brand'
                        }`}
                        aria-label={
                          isEmpty
                            ? `Balance is empty`
                            : `Primary balance ${formatAmount(displayAvailable)} ${displayToken}`
                        }
                      >
                        {formatAmount(displayAvailable)}
                      </p>
                      <p
                        className={`heading-1 mt-2 ${
                          isEmpty ? 'text-muted/70' : 'text-foreground'
                        }`}
                      >
                        {displayToken}
                        {displayReserved > 0 && (
                          <span className="type-caption num-tabular ml-3 font-normal">
                            {formatAmount(displayReserved)} reserved
                          </span>
                        )}
                      </p>
                    </div>
                  );
                })()}

                {/* Secondary token pills — only shown when multi-token */}
                {secondaryBalanceEntries.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {secondaryBalanceEntries.map(([tokenKey, entry]) => (
                      <span
                        key={tokenKey}
                        className="label-caps border border-brand/30 px-2.5 py-1.5 text-muted"
                      >
                        <span className="text-foreground num-tabular">
                          {formatAmount(entry.available)}
                        </span>{' '}
                        {tokenSymbol(tokenKey)}
                      </span>
                    ))}
                  </div>
                )}

                {/* Character quip — comic-book speech bubble with a
                    left-pointing tail directed at the mascot. Speech
                    text is muted (overheard / quoted feel) so it sits
                    quietly under the display number rather than
                    competing with it for attention. The cite line
                    keeps the brand gold to mark the speaker. */}
                {characterLine && (
                  <SpeechBubble tailPosition="left" className="prose-width mt-6 ml-2">
                    <p className="type-body italic text-muted">
                      {characterLine}
                    </p>
                    <p className="label-caps-brand mt-3">
                      — {character.name}
                    </p>
                  </SpeechBubble>
                )}

                {/* ── Primary action: PLAY ─────────────────────────── */}
                {hasPlayableBalance ? (
                  <div className="mt-6">
                    <button
                      type="button"
                      onClick={handlePlay}
                      disabled={playLoading || agentClosed}
                      aria-disabled={playLoading || agentClosed ? 'true' : undefined}
                      aria-describedby={agentClosed ? 'agent-status-banner' : undefined}
                      className="group relative w-full bg-brand px-6 py-5 font-heading text-2xl font-extrabold uppercase tracking-[0.15em] text-background panel-shadow-sm transition-all duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-ink)] active:translate-x-0 active:translate-y-0 active:shadow-[2px_2px_0_0_var(--color-ink)] disabled:cursor-not-allowed disabled:bg-brand/50 disabled:text-background/70 disabled:panel-shadow-sm disabled:hover:translate-x-0 disabled:hover:translate-y-0 sm:text-3xl"
                      title={
                        agentClosed
                          ? 'Agent is temporarily closed to new plays'
                          : 'Run a play session now'
                      }
                    >
                      {playLoading ? 'Playing…' : 'Play'}
                    </button>
                    <p className="mt-3 text-center font-pixel text-[9px] uppercase tracking-wider text-muted">
                      Let the agent work. You can go back to doing nothing.
                    </p>
                    <div className="mt-4 flex justify-center">
                      <button
                        type="button"
                        onClick={() => setWithdrawOpen(true)}
                        className="label-caps transition-colors hover:text-brand"
                      >
                        ← Or withdraw funds
                      </button>
                    </div>
                  </div>
                ) : (
                  // Zero-balance state — show the inline 3-step ribbon
                  // that teaches the loop. Step 1 (Fund) is the active
                  // step since the user hasn't funded yet. The ribbon
                  // replaces the old dashed Step 1 block AND the
                  // separate top-of-page orientation strip — one
                  // welcome, one teaching moment, tied to the mascot.
                  <div className="mt-6 border-t-2 border-brand/30 pt-5">
                    <p className="label-caps-brand mb-3">The loop</p>
                    <ol className="flex items-center gap-1 sm:gap-3">
                      {[
                        { n: '01', label: 'Fund', active: true, done: false },
                        { n: '02', label: 'Play', active: false, done: false },
                        { n: '03', label: 'Withdraw', active: false, done: false },
                      ].map((step, i, arr) => (
                        <li
                          key={step.n}
                          className="flex flex-1 items-center gap-1 sm:gap-3"
                        >
                          <div
                            className={`flex min-w-0 flex-1 items-baseline gap-2 border-2 px-3 py-2 ${
                              step.active
                                ? 'border-brand bg-brand/10 panel-shadow-sm'
                                : 'border-secondary bg-[var(--color-panel)]'
                            }`}
                          >
                            <span
                              className={`font-pixel text-[9px] ${
                                step.active ? 'text-brand' : 'text-muted/60'
                              }`}
                            >
                              {step.n}
                            </span>
                            <span
                              className={`font-heading text-sm font-extrabold uppercase tracking-wider ${
                                step.active ? 'text-foreground' : 'text-muted'
                              }`}
                            >
                              {step.label}
                            </span>
                          </div>
                          {i < arr.length - 1 && (
                            <span
                              className="hidden font-pixel text-[10px] text-brand/40 sm:inline"
                              aria-hidden="true"
                            >
                              ▸
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                    <p className="label-caps-brand mt-3">
                      ↓ Start by funding below
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Metadata strip — runs across the bottom of the panel.
                Thin divider in brand gold to tie it to the panel border. */}
            {status && hasPlayableBalance && (
              <div className="border-t-2 border-brand/30 px-6 py-4 sm:px-8">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <div>
                    <p className="label-caps mb-0.5">Deposited</p>
                    <p className="text-sm text-foreground num-tabular">
                      {totalDeposited}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps mb-0.5">Rake paid</p>
                    <p className="text-sm text-foreground num-tabular">
                      {totalRakePaid}
                    </p>
                  </div>
                  <p className="ml-auto max-w-xs text-[11px] italic text-muted">
                    We take a rake to cover all gas and infrastructure costs.
                  </p>
                </div>
              </div>
            )}
          </ComicPanel>
        )}

        {/* Inline hero error — shown only when /api/user/status failed
            AND we have no stale hero data to render. History/trust/etc
            below continue to render independently. */}
        {!status && !statusLoading && error && (
          <ComicPanel label="ERROR" tone="destructive" halftone="none" className="mb-12">
            <div className="p-6">
              <p className="heading-1 mb-2 text-destructive">
                Balance temporarily unavailable
              </p>
              <p className="type-caption mb-4">{error}</p>
              <button
                type="button"
                onClick={retryStatus}
                disabled={statusLoading}
                className="border-2 border-destructive px-4 py-2 label-caps-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          </ComicPanel>
        )}

        {/* ---- Sections below the hero ────────────────────
            Flattened from a 2-col grid into a vertical stack since
            every child already spanned both columns. Generous gaps
            between distinct sections (space-y-10) give the page
            rhythm — hero breathes, fund card breathes, stuck
            deposits / history each land as their own beat. --- */}
        <div className="space-y-10">

          {/* ---- Fund Your Account — collapsible ──────────────
              Spans full width. Defaults open when the user has no
              balance (they need the deposit info to get started),
              collapses once they have funds (they're past this step).
              Header row has title + chevron toggle + persistent
              "Check for deposits" button that works in either state. */}
          <section className="border-2 border-secondary">
            {/* Clickable header — whole row toggles collapse except the
                refresh button which has its own click target. */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
              <button
                type="button"
                onClick={() => setDepositCardOpen((o) => !o)}
                aria-expanded={depositCardOpen}
                aria-controls="fund-your-account-body"
                className="group flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span
                  className={`inline-block font-pixel text-[10px] text-brand transition-transform ${
                    depositCardOpen ? 'rotate-90' : ''
                  }`}
                  aria-hidden="true"
                >
                  ▸
                </span>
                <div className="min-w-0">
                  <h2 className="heading-1 text-foreground">
                    Fund Your Account
                  </h2>
                  <p className="label-caps mt-1">
                    {depositCardOpen
                      ? 'Agent wallet & deposit memo'
                      : hasPlayableBalance
                        ? 'You\u2019re funded — tap to top up'
                        : 'Tap to see deposit instructions'}
                  </p>
                </div>
              </button>
              {/* Manual refresh — always visible so the user can nudge
                  the deposit watcher even while the card is collapsed. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleCheckDeposits();
                }}
                disabled={depositsChecking}
                className="shrink-0 inline-flex items-center gap-2 border-2 border-brand bg-brand/10 px-4 py-2 font-pixel text-[9px] uppercase tracking-wider text-brand transition-colors hover:bg-brand hover:text-background disabled:cursor-not-allowed disabled:opacity-50"
                aria-live="polite"
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full bg-brand ${
                    depositsChecking ? 'animate-pulse' : ''
                  }`}
                  aria-hidden="true"
                />
                {depositsChecking ? 'Checking…' : 'Check for deposits'}
              </button>
            </div>

            {/* Collapsible body — grid-template-rows transition so
                we're not animating layout props. */}
            <div
              id="fund-your-account-body"
              className="collapsible-grid"
              data-open={depositCardOpen ? 'true' : 'false'}
            >
              <div className="collapsible-inner">
                {status && (
                  <div className="space-y-5 border-t border-secondary px-6 py-5">
                    <p className="type-body prose-width text-muted">
                      Send HBAR or LAZY to the agent wallet below with your
                      unique deposit memo. Deposits usually arrive within ~10
                      seconds — hit{' '}
                      <span className="font-semibold text-brand">Check for deposits</span>{' '}
                      above to pull them in.
                    </p>

                    {agentWallet && (
                      <div>
                        <label className="label-caps mb-2 block">Agent Wallet</label>
                        <div className="flex items-center gap-2 border border-secondary bg-[var(--color-panel)] px-4 py-3">
                          <code className="flex-1 break-all font-mono text-sm text-brand">
                            {agentWallet}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy(agentWallet, 'Agent wallet')}
                            className="shrink-0 border border-secondary px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted transition-colors hover:border-brand hover:text-brand"
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="label-caps mb-2 block">Deposit Memo</label>
                      <div className="flex items-center gap-2 border border-secondary bg-[var(--color-panel)] px-4 py-3">
                        <code className="flex-1 break-all font-mono text-sm text-brand">
                          {status.depositMemo}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopy(status.depositMemo, 'Deposit memo')}
                          className="shrink-0 border border-secondary px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted transition-colors hover:border-brand hover:text-brand"
                        >
                          Copy
                        </button>
                      </div>
                    </div>

                    <p className="border-l-2 border-brand bg-brand/10 px-4 py-3 text-xs text-brand">
                      <span className="font-semibold">Important:</span> always include the
                      deposit memo when sending tokens. Transfers without the correct memo
                      cannot be automatically credited.
                    </p>

                    {/* Wallet-specific instructions */}
                    <details className="border border-secondary bg-[var(--color-panel)] px-4 py-3 text-xs text-muted">
                      <summary className="cursor-pointer font-pixel text-[10px] uppercase tracking-wider text-foreground">
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
            </div>
          </section>

          {/* ---- Stuck deposits (dead letters) ──────────────
              Only rendered when the user has actual stuck deposits.
              ComicPanel with destructive tone + halftone none (data-
              dense, not a hero moment). "STUCK" corner sticker so
              users can't miss it. */}
          {deadLetters.length > 0 && (
            <ComicPanel
              label="STUCK"
              tone="destructive"
              halftone="none"
            >
              <div className="border-b border-destructive/40 px-5 py-4">
                <p className="label-caps-brand mb-1 text-destructive">
                  Stuck deposits
                </p>
                <p className="text-xs text-muted">
                  {deadLetters.length === 1 ? 'A deposit' : 'These deposits'} from your
                  wallet couldn&apos;t be credited automatically. The funds are still
                  in the agent wallet.{' '}
                  {supportUrl
                    ? supportIsMailto
                      ? 'Click Contact Support on a row below to email the operator — the transaction ID will be prefilled for you.'
                      : 'Click Contact Support on a row below to reach the operator.'
                    : 'Contact the operator with the transaction ID below to request a refund.'}
                </p>
              </div>
              <ul className="divide-y divide-destructive/20">
                {deadLetters.map((dl) => {
                  const network =
                    (typeof process !== 'undefined' &&
                      process.env?.NEXT_PUBLIC_HEDERA_NETWORK) ||
                    'testnet';
                  const hashscanUrl =
                    network === 'mainnet'
                      ? `https://hashscan.io/mainnet/transaction/${dl.transactionId}`
                      : `https://hashscan.io/${network}/transaction/${dl.transactionId}`;
                  const rowSupportUrl = buildSupportLink(dl.transactionId);
                  return (
                    <li key={dl.transactionId} className="px-5 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <code className="break-all font-mono text-xs text-destructive">
                          {dl.transactionId}
                        </code>
                        <div className="flex shrink-0 items-center gap-2">
                          {rowSupportUrl && (
                            <a
                              href={rowSupportUrl}
                              target={supportIsMailto ? undefined : '_blank'}
                              rel={
                                supportIsMailto ? undefined : 'noopener noreferrer'
                              }
                              className="border-2 border-destructive bg-destructive/20 px-3 py-1.5 label-caps-destructive transition-colors hover:bg-destructive/40"
                            >
                              Contact Support
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
                          <code className="font-mono">{dl.memo || '(none)'}</code>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ComicPanel>
          )}

          {/* ---- Play History — wrapped as a ComicPanel so the
               vocabulary carries from the hero to the rest of the
               page. Halftone "none" because it's data-dense and a
               textured background would compete with the rows. The
               "RECENT PLAYS" corner sticker echoes the ISSUE #001
               label on the hero so the two panels feel like a
               continuous run. --- */}
          <ComicPanel label="RECENT PLAYS" halftone="none">
            {/* NFT enrichment error banner — toast-adjacent alert
                inside the panel header area */}
            {enrichmentError && rawNftRefs.length > 0 && (
              <div className="flex items-center justify-between border-b border-destructive/40 bg-destructive/10 px-5 py-3 text-xs">
                <span className="text-destructive">
                  Couldn&apos;t load NFT details. Your raw wins are shown below.
                </span>
                <button
                  type="button"
                  onClick={retryEnrichment}
                  className="shrink-0 border border-destructive/40 px-3 py-1 label-caps-destructive transition-colors hover:bg-destructive/20"
                >
                  Retry
                </button>
              </div>
            )}

            {/* ---- Header + P&L strip ---- */}
            <div className="flex flex-wrap items-end justify-between gap-4 px-5 pb-4 pt-6">
              <div>
                <p className="label-caps-lg mb-2">Play log</p>
                <h2 className="heading-1 text-foreground">
                  Recent agent sessions
                </h2>
              </div>
              {perfSummary && (
                <div className="flex flex-wrap items-end gap-5">
                  <div>
                    <p className="label-caps mb-1">Spent</p>
                    <p className="num-tabular type-body text-foreground">
                      {formatAmount(perfSummary.totalSpentAll)} {perfSummary.primaryToken}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps mb-1">Won</p>
                    <p className="num-tabular type-body text-foreground">
                      {formatAmount(perfSummary.totalWonAll)} {perfSummary.primaryToken}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps mb-1">Net</p>
                    <p
                      className={`num-tabular type-body font-semibold ${
                        perfSummary.net >= 0 ? 'text-success' : 'text-destructive'
                      }`}
                    >
                      {perfSummary.net >= 0 ? '+' : ''}
                      {formatAmount(perfSummary.net)} {perfSummary.primaryToken}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* ---- Timeline ---- */}
            <div className="border-t border-brand/20">
              {historyLoading ? (
                <div className="divide-y divide-secondary/50">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="px-5 py-4">
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
                  <ol className="divide-y divide-secondary/50">
                    {displayedSessions.map((s) => {
                      const isWin = s.totalWins > 0;
                      const entryCount = s.poolResults.reduce(
                        (sum, pr) => sum + pr.entriesBought,
                        0,
                      );
                      return (
                        <li
                          key={s.sessionId}
                          className={`relative border-l-[3px] px-5 py-4 transition-colors ${
                            isWin
                              ? 'border-brand bg-brand/5'
                              : 'border-transparent hover:border-brand/30 hover:bg-brand/5'
                          }`}
                        >
                          {/* Header row: timestamp in pixel font + win/spent readout */}
                          <div className="mb-2 flex items-start justify-between gap-3">
                            <span className="font-pixel text-[9px] uppercase tracking-wider text-muted">
                              {formatTimestamp(s.timestamp)}
                            </span>
                            <span
                              className={`num-tabular heading-2 ${
                                isWin ? 'text-brand' : 'text-muted'
                              }`}
                            >
                              {isWin
                                ? `+${formatAmount(s.totalPrizeValue)} won`
                                : `${formatAmount(s.totalSpent)} spent`}
                            </span>
                          </div>

                          {/* Pool badges — sharp corners, pixel-font */}
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {s.poolResults.map((pr) => (
                              <span
                                key={pr.poolId}
                                className="border border-secondary bg-[var(--color-panel)] px-2 py-0.5 font-pixel text-[8px] uppercase tracking-wider text-muted"
                              >
                                {pr.poolName}
                              </span>
                            ))}
                          </div>

                          {/* Stats row — small-caps labels */}
                          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                            <span className="text-muted">
                              <span className="label-caps mr-1.5">Entries</span>
                              <span className="num-tabular text-foreground">{entryCount}</span>
                            </span>
                            <span className="text-muted">
                              <span className="label-caps mr-1.5">Spent</span>
                              <span className="num-tabular text-foreground">
                                {formatAmount(s.totalSpent)}
                              </span>
                            </span>
                            {isWin && s.totalWins > 0 && (
                              <span className="text-muted">
                                <span className="label-caps mr-1.5">Wins</span>
                                <span className="num-tabular text-success">
                                  {s.totalWins}
                                </span>
                              </span>
                            )}
                          </div>

                          {/* Prize details for winning sessions */}
                          {isWin &&
                            s.poolResults.some(
                              (pr) => pr.prizeDetails.length > 0,
                            ) && (
                              <div className="mt-3 space-y-2">
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
                                    <div className="border-l-2 border-brand bg-brand/10 px-3 py-2 text-xs text-brand">
                                      <span className="label-caps mr-2">Prizes</span>
                                      <span className="num-tabular">{fungibleParts.join(' + ')}</span>
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
                        </li>
                      );
                    })}
                  </ol>

                  {/* Show older sessions button */}
                  {sessions.length > 10 && !showAll && (
                    <div className="border-t border-secondary/50 px-5 py-3 text-center">
                      <button
                        type="button"
                        onClick={() => setShowAll(true)}
                        className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand transition-colors hover:text-foreground"
                      >
                        Show older sessions ({sessions.length - 10} more) →
                      </button>
                    </div>
                  )}
                  {showAll && sessions.length > 10 && (
                    <div className="border-t border-secondary/50 px-5 py-3 text-center">
                      <button
                        type="button"
                        onClick={() => setShowAll(false)}
                        className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand transition-colors hover:text-foreground"
                      >
                        ← Show less
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="px-5 py-10 text-center">
                  {/* Copy adapts to the actual state — referencing Play Now
                      when it's available, pointing at funding when it's not,
                      acknowledging the pause when the kill switch is on. */}
                  <p className="font-pixel text-[10px] uppercase tracking-wider text-muted">
                    No sessions yet
                  </p>
                  <p className="mt-2 text-sm text-muted">
                    {agentClosed ? (
                      <>
                        The agent is{' '}
                        <span className="text-destructive">temporarily closed</span> —
                        check back once the operator resumes plays.
                      </>
                    ) : hasPlayableBalance ? (
                      <>
                        Hit <span className="font-semibold text-brand">Play</span> above
                        when you&apos;re ready.
                      </>
                    ) : (
                      <>Fund your agent above to start playing.</>
                    )}
                  </p>
                </div>
              )}
            </div>
          </ComicPanel>
        </div>

        {/* ── Proof of operation — compact footer bar ───────────
            Dropped the operator stats (TVL, active user count, rake
            rate — the last is already in the hero metadata strip).
            Users only care about the three links: they can verify
            the agent wallet on HashScan, read the HCS-20 audit trail,
            and browse our on-chain audit page. Styled as a single
            pixel-font imprint row — reads like the credits line on
            the back cover of a comic book. */}
        {publicStats && (
          <div className="mt-10 border-t-2 border-brand/20 pt-5">
            <p className="mb-3 font-pixel text-[9px] uppercase tracking-wider text-brand">
              Proof of operation
            </p>
            <div className="flex flex-wrap gap-3">
              {publicStats.agentWallet && (
                <a
                  href={`https://hashscan.io/${publicStats.network === 'mainnet' ? 'mainnet' : publicStats.network}/account/${publicStats.agentWallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 border border-secondary bg-[var(--color-panel)] px-3 py-2 font-pixel text-[9px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
                >
                  Agent wallet <span aria-hidden="true">↗</span>
                </a>
              )}
              {publicStats.hcs20TopicId && (
                <a
                  href={`https://hashscan.io/${publicStats.network === 'mainnet' ? 'mainnet' : publicStats.network}/topic/${publicStats.hcs20TopicId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 border border-secondary bg-[var(--color-panel)] px-3 py-2 font-pixel text-[9px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
                >
                  HCS-20 trail <span aria-hidden="true">↗</span>
                </a>
              )}
              <a
                href="/audit"
                className="inline-flex items-center gap-2 border border-secondary bg-[var(--color-panel)] px-3 py-2 font-pixel text-[9px] uppercase tracking-wider text-muted transition-colors hover:border-brand hover:text-brand"
              >
                On-chain log <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        )}

        {/* ---- Session Section (compact, demoted) ---- */}
        <div className="mt-10 border-t border-secondary/60 pt-6">
          <p className="label-caps mb-3">Session</p>

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
      <Modal
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        locked={withdrawLoading}
        title="Withdraw Funds"
        description="Funds will be sent to your registered Hedera account."
      >
        {(() => {
          // Per-token velocity state — shows "remaining today" counter
          // so users know the daily cap before they hit submit.
          const velocity = status?.velocity?.[withdrawToken];
          const amountNum = Number(withdrawAmount);
          const overCap =
            velocity?.remaining != null &&
            Number.isFinite(amountNum) &&
            amountNum > 0 &&
            amountNum > velocity.remaining;
          return (
            <>
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

              <div className="mb-2">
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
                  aria-invalid={overCap || undefined}
                  aria-describedby={velocity?.cap != null ? 'withdraw-velocity' : undefined}
                  className={`w-full rounded-lg border px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:outline-none disabled:opacity-50 ${
                    overCap
                      ? 'border-destructive bg-destructive/10 focus:border-destructive'
                      : 'border-secondary bg-secondary/30 focus:border-brand'
                  }`}
                />
              </div>

              {/* Daily velocity cap counter — shown only when a cap is set */}
              {velocity?.cap != null && (
                <p
                  id="withdraw-velocity"
                  className={`mb-5 text-xs ${overCap ? 'text-destructive' : 'text-muted'}`}
                >
                  Daily limit: {formatAmount(velocity.usedToday)} /{' '}
                  {formatAmount(velocity.cap)} {tokenSymbol(withdrawToken)} used
                  {velocity.remaining != null && (
                    <>
                      {' '}
                      — <span className="text-foreground">{formatAmount(velocity.remaining)}</span> remaining today
                    </>
                  )}
                </p>
              )}

              {overCap && (
                <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Amount exceeds your remaining daily limit. Try a smaller amount
                  or wait for the 24-hour rolling window to refresh.
                </p>
              )}

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
                  disabled={withdrawLoading || !withdrawAmount || overCap}
                  className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {withdrawLoading ? 'Withdrawing…' : 'Confirm Withdraw'}
                </button>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}
