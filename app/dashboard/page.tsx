'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useToast } from '../components/Toast';
import { Modal } from '../components/Modal';
import { ComicPanel } from '../components/ComicPanel';
import { SpeechBubble } from '../components/SpeechBubble';
import { ActionBurst } from '../components/ActionBurst';
import { GoldConfetti } from '../components/GoldConfetti';
import { TopUpModal } from '../components/TopUpModal';
import { SkeletonBox } from '../components/SkeletonBox';
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
// SkeletonBox itself lives in components/SkeletonBox.tsx so /account can
// share the same placeholder treatment.
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:px-8">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-2">
        <SkeletonBox className="h-8 w-48" />
        <SkeletonBox className="h-4 w-64" />
      </div>

      {/* Hero panel skeleton — mirrors the brave-version layout
          (mascot + balance + speech bubble + PLAY) so the page
          doesn't reflow when status arrives. Sharp-corner panel
          with brand-gold border to match the real ComicPanel. */}
      <div className="mb-12 border-2 border-brand bg-[var(--color-panel)] panel-shadow">
        <div className="grid gap-6 p-6 sm:p-8 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
          <SkeletonBox className="mx-auto h-44 w-44 shrink-0 md:mx-0" />
          <div>
            <SkeletonBox className="mb-3 h-3 w-32" />
            <SkeletonBox className="mb-2 h-20 w-64" />
            <SkeletonBox className="mb-6 h-5 w-40" />
            <SkeletonBox className="h-16 w-full" />
          </div>
        </div>
      </div>

      {/* Recent Plays skeleton */}
      <div className="border-2 border-brand bg-[var(--color-panel)] panel-shadow">
        <div className="px-5 pt-6 pb-4">
          <SkeletonBox className="mb-2 h-3 w-24" />
          <SkeletonBox className="h-6 w-56" />
        </div>
        <div className="border-t border-brand/20">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-secondary/50 px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <SkeletonBox className="h-4 w-32" />
                <SkeletonBox className="h-4 w-20" />
              </div>
              <div className="flex gap-2">
                <SkeletonBox className="h-5 w-20" />
                <SkeletonBox className="h-5 w-20" />
                <SkeletonBox className="h-5 w-20" />
              </div>
            </div>
          ))}
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
  const [showAll, setShowAll] = useState(false);
  const [depositsChecking, setDepositsChecking] = useState(false);
  // Stuck deposit count — tiny badge in the dashboard header that links
  // to /account where the full list lives. Just the count, not the
  // entries themselves; we don't render details here anymore.
  const [stuckCount, setStuckCount] = useState(0);

  // Self-serve register + withdraw + play state
  const [registerLoading, setRegisterLoading] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawToken, setWithdrawToken] = useState('hbar');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [playLoading, setPlayLoading] = useState(false);
  // Top-up modal — replaces the old in-page Fund Your Account
  // collapsible. Triggered from the hero metadata "Top up" link
  // (when funded) or the empty-state ribbon's Step 01 (when not).
  const [topUpOpen, setTopUpOpen] = useState(false);

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

  // Check for auth token on mount, then fetch data independently.
  //
  // Mount-once guard: this effect should only run on first mount, not
  // when loadStatus / router references shift (which they do during
  // dev HMR or in tests). The previous incarnation had `[]` deps,
  // which silenced eslint-plugin-react-hooks but introduced a stale-
  // closure bug where the effect captured the initial loadStatus
  // forever. The fix: include the real deps so closures stay fresh,
  // and gate the body on a hasMounted ref so the work only happens
  // once even if the deps shift.
  const hasMounted = useRef(false);
  useEffect(() => {
    if (hasMounted.current) return;
    hasMounted.current = true;

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

    // Background dead-letter count — just the count, not the entries.
    // Full details live on /account; the dashboard surfaces a small
    // alert link in the header pointing there if any are present.
    void (async () => {
      try {
        const res = await fetch('/api/user/dead-letters', { headers });
        if (!res.ok) return;
        const data = (await res.json()) as {
          deadLetters?: { transactionId: string }[];
        };
        if (data.deadLetters && data.deadLetters.length > 0) {
          setStuckCount(data.deadLetters.length);
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
  }, [loadStatus, router]);

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
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <ComicPanel label="LOCKED" tone="muted" halftone="none">
            <div className="p-8 text-center">
              <p className="label-caps-lg mb-3">Sign in required</p>
              <h1 className="display-md mb-3 text-foreground">
                Welcome back
              </h1>
              <p className="type-body mb-6 text-muted">
                Authenticate with your Hedera wallet to open the dashboard.
              </p>
              <a
                href="/auth"
                className="inline-block border-2 border-brand bg-brand px-6 py-3 font-pixel text-[10px] uppercase tracking-wider text-background panel-shadow-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-ink)]"
              >
                Sign in →
              </a>
            </div>
          </ComicPanel>
        </div>
      </div>
    );
  }

  // --- Not registered state ---
  if (notRegistered) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <ComicPanel label="ISSUE #00" halftone="dense">
            <div className="p-8 text-center">
              <p className="label-caps-brand-lg mb-3">Welcome</p>
              <h1 className="display-md mb-3 text-foreground">
                {storedAccountId ?? 'Explorer'}
              </h1>
              <p className="type-body prose-width mx-auto mb-6 text-muted">
                You&apos;re signed in but haven&apos;t registered as a player
                yet. One click and you&apos;ll get a deposit memo so you can
                fund your account and start playing.
              </p>
              <button
                type="button"
                onClick={handleRegister}
                disabled={registerLoading}
                className="inline-block border-2 border-brand bg-brand px-6 py-3 font-pixel text-[10px] uppercase tracking-wider text-background panel-shadow-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {registerLoading ? 'Registering…' : 'Register now'}
              </button>
              <p className="type-caption mt-4">
                You&apos;ll be using the{' '}
                <span className="font-semibold text-foreground">balanced</span>{' '}
                strategy — a sensible default for new players.
              </p>
            </div>
          </ComicPanel>
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
        <header className="mb-10 flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="label-caps-lg mb-2">Your agent</p>
            <h1 className="display-lg text-foreground">Dashboard</h1>
          </div>

          {/* Stuck deposits alert — small destructive chip linking to
              /account where the full list and contact-support actions
              live. Only rendered when there's actually something stuck.
              The chip is a sentinel: present means "go look", absent
              means "everything's fine, no need to think about this." */}
          {stuckCount > 0 && (
            <Link
              href="/account"
              className="group inline-flex min-h-[44px] items-center gap-2 border-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/20"
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                aria-hidden="true"
              />
              <span className="label-caps-destructive">
                {stuckCount === 1
                  ? '1 stuck deposit'
                  : `${stuckCount} stuck deposits`}
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          )}
          {/* Account chip — shows the user's Hedera account ID and
              acts as the disconnect button. Standard dApp convention:
              your address is in the corner, click to sign out. No
              confirm dialog: signing back in is one click and the
              native window.confirm() is jarring against the comic
              vocabulary. The Sidebar Disconnect button uses the
              identical flow. */}
          {status?.hederaAccountId && (
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem('lazylotto:sessionToken');
                localStorage.removeItem('lazylotto:accountId');
                localStorage.removeItem('lazylotto:tier');
                localStorage.removeItem('lazylotto:expiresAt');
                localStorage.removeItem('lazylotto:locked');
                // router.replace (not push) so /dashboard isn't in the
                // back history — accidental disconnect can't be backed out.
                router.replace('/auth');
              }}
              aria-label={`Disconnect ${status.hederaAccountId}`}
              className="group hidden min-h-[44px] items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-3 py-2 transition-colors hover:border-destructive sm:inline-flex"
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
                  <Image
                    src={character.imgLarge}
                    alt={character.name}
                    width={176}
                    height={176}
                    className="block h-auto w-full select-none mascot-idle"
                    draggable={false}
                    priority
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
                {/* Character name removed from under the mascot — the
                    speech bubble cite line below is the more meaningful
                    placement. Two name labels was redundant. */}
              </div>

              {/* Hero content */}
              <div className="min-w-0">
                {/* Eyebrow row — single label + the optional checking-
                    deposits pulse. Strategy and rake percent moved into
                    the bottom metadata strip; they're reference info,
                    not hero-row context. The fewer chips above the
                    display number, the faster the eye reaches the pot. */}
                <div
                  className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <span className="label-caps-lg">Your agent</span>
                  {depositsChecking && (
                    <span className="label-caps-brand inline-flex items-center gap-1.5">
                      <span
                        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand"
                        aria-hidden="true"
                      />
                      Checking deposits
                    </span>
                  )}
                </div>

                {/* Display number — the hero moment. Always renders so
                    the hero feels committed instead of broken when the
                    user has no balance yet. Uses the formal .display-xl
                    scale utility — the ONE place in the app that uses
                    this size, no accidental duplication elsewhere.
                    "Pot" label stays the same in both states (instead of
                    "Empty" / "Pot") so the empty state reads as "the pot
                    is currently zero" rather than as an accusation. */}
                {(() => {
                  const displayAvailable = primaryBalanceEntry?.[1].available ?? 0;
                  const displayReserved = primaryBalanceEntry?.[1].reserved ?? 0;
                  const displayToken = primaryBalanceEntry
                    ? tokenSymbol(primaryBalanceEntry[0])
                    : 'HBAR';
                  const isEmpty = displayAvailable === 0 && displayReserved === 0;
                  return (
                    <div className="mb-2">
                      <p className="label-caps-lg mb-2">Pot</p>
                      <p
                        className={`display-xl ${
                          isEmpty ? 'text-muted/70' : 'text-brand'
                        }`}
                        aria-label={
                          isEmpty
                            ? `Pot is currently empty`
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
                      </p>
                      {/* Reserved-amount annotation moved to its own
                          line with an "(in play)" label so users don't
                          read it as part of the token symbol. Only
                          shown when something's actually reserved. */}
                      {displayReserved > 0 && (
                        <p className="type-caption num-tabular mt-2">
                          {formatAmount(displayReserved)} {displayToken}{' '}
                          <span className="label-caps ml-1">in play</span>
                        </p>
                      )}
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
                      className="btn-primary"
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
                  // Zero-balance state — the 3-step ribbon teaches the
                  // loop. Step 01 (Fund) is both active AND clickable —
                  // it opens the TopUpModal directly. Steps 02 + 03 are
                  // disabled previews so users see what's coming. No
                  // separate "↓ Start by funding below" arrow because
                  // the active button IS the call to action; an arrow
                  // pointing at a section that no longer exists would
                  // be a left-over teaching layer. One mechanism, not
                  // four. */}
                  <div className="mt-6 border-t-2 border-brand/30 pt-5">
                    <p className="label-caps-brand mb-3">The loop</p>
                    <ol className="flex items-center gap-1 sm:gap-3">
                      {[
                        {
                          n: '01',
                          label: 'Fund',
                          active: true,
                          onClick: () => setTopUpOpen(true),
                        },
                        { n: '02', label: 'Play', active: false },
                        { n: '03', label: 'Withdraw', active: false },
                      ].map((step, i, arr) => (
                        <li
                          key={step.n}
                          className="flex flex-1 items-center gap-1 sm:gap-3"
                        >
                          {step.active ? (
                            <button
                              type="button"
                              onClick={step.onClick}
                              aria-current="step"
                              aria-label={`Step ${step.n}: ${step.label} — open the top-up panel`}
                              className="group flex min-h-[44px] min-w-0 flex-1 items-center gap-2 border-2 border-brand bg-brand/10 px-3 py-2 panel-shadow-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-brand/20 hover:shadow-[6px_6px_0_0_var(--color-ink)]"
                            >
                              <span className="font-pixel text-[9px] text-brand">
                                {step.n}
                              </span>
                              <span className="font-heading text-sm font-extrabold uppercase tracking-wider text-foreground">
                                {step.label}
                              </span>
                              <span
                                className="ml-auto font-pixel text-[10px] text-brand transition-transform group-hover:translate-x-0.5"
                                aria-hidden="true"
                              >
                                →
                              </span>
                            </button>
                          ) : (
                            <div
                              aria-disabled="true"
                              className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 border-2 border-dashed border-secondary bg-[var(--color-panel)] px-3 py-2"
                            >
                              <span className="font-pixel text-[9px] text-muted/60">
                                {step.n}
                              </span>
                              <span className="font-heading text-sm font-extrabold uppercase tracking-wider text-muted">
                                {step.label}
                              </span>
                            </div>
                          )}
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
                  </div>
                )}
              </div>
            </div>

            {/* Metadata strip — runs across the bottom of the panel.
                Holds the reference info (strategy, rake percent,
                deposited, rake paid) plus the inline "Top up" action
                so users can add funds without leaving the page. The
                old Fund Your Account collapsible is gone — its
                content lives in TopUpModal now, which the link below
                opens. */}
            {status && hasPlayableBalance && (
              <div className="border-t-2 border-brand/30 px-6 py-4 sm:px-8">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div>
                    <p className="label-caps mb-0.5">Strategy</p>
                    <p className="text-sm text-foreground">
                      {status.strategyName}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps mb-0.5">Rake</p>
                    <p className="text-sm text-foreground num-tabular">
                      {status.rakePercent}%
                    </p>
                  </div>
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
                  <button
                    type="button"
                    onClick={() => setTopUpOpen(true)}
                    className="ml-auto inline-flex items-center gap-2 border-2 border-brand bg-brand/10 px-4 py-2 font-pixel text-[9px] uppercase tracking-wider text-brand transition-colors hover:bg-brand hover:text-background"
                  >
                    Top up <span aria-hidden="true">+</span>
                  </button>
                </div>
                <p className="mt-3 text-[11px] italic text-muted">
                  We take a rake to cover all gas and infrastructure costs.
                </p>
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
            Brave version: only Recent Plays. Fund Your Account is
            now a TopUpModal triggered from the hero metadata strip
            and the empty-state ribbon. Stuck deposits, the session
            token, and proof-of-operation links all live on /account.
            The dashboard does ONE thing — show the pot and let you
            play it. --- */}
        <div className="space-y-10">

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

        {/* ── Page footer ────────────────────────────────────
            One line: "Manage account →". Everything that used to
            live in the proof-of-operation footer (HashScan, HCS-20,
            audit) and the session card (token, lock, revoke) now
            lives on /account. The dashboard footer is just the
            doorway. */}
        <div className="mt-12 border-t border-brand/20 pt-5">
          <Link
            href="/account"
            className="group inline-flex items-center gap-2 font-pixel text-[10px] uppercase tracking-wider text-muted transition-colors hover:text-brand"
          >
            Manage account
            <span
              className="transition-transform group-hover:translate-x-1"
              aria-hidden="true"
            >
              →
            </span>
          </Link>
        </div>
      </div>

      {/* ── Top up modal ─────────────────────────────────────
          Fed by the hero metadata "Top up" button (when funded)
          and by Step 01 in the empty-state ribbon (when not).
          Holds the agent wallet, deposit memo, and wallet-specific
          instructions — same content the old in-page Fund Your
          Account collapsible used to show, just behind a focused
          modal so the dashboard hero owns the whole viewport. */}
      <TopUpModal
        open={topUpOpen}
        onClose={() => setTopUpOpen(false)}
        agentWallet={agentWallet}
        depositMemo={status?.depositMemo ?? ''}
        framingNote={
          !hasPlayableBalance
            ? 'Send any amount to get started — your first deposit funds Step 01.'
            : undefined
        }
        onCheckDeposits={() => void handleCheckDeposits()}
        checking={depositsChecking}
      />

      {/* ── Withdraw modal ───────────────────────────────────── */}
      <Modal
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        locked={withdrawLoading}
        title="Cash out"
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
              <div className="mb-5">
                <label htmlFor="withdraw-token" className="label-caps mb-2 block">
                  Token
                </label>
                <select
                  id="withdraw-token"
                  value={withdrawToken}
                  onChange={(e) => setWithdrawToken(e.target.value)}
                  disabled={withdrawLoading}
                  className="w-full border-2 border-secondary bg-[var(--color-panel)] px-4 py-3 text-sm text-foreground transition-colors focus:border-brand disabled:opacity-50"
                >
                  {balanceEntries.map(([key, entry]) => (
                    <option key={key} value={key}>
                      {tokenSymbol(key)} (available: {formatAmount(entry.available)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-3">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <label htmlFor="withdraw-amount" className="label-caps">
                    Amount
                  </label>
                  {/* Max button — fills in the full available balance,
                      respecting the daily velocity cap if one is set.
                      Standard dApp convention; reduces fat-finger
                      precision errors when withdrawing the full pot. */}
                  {(() => {
                    const entry = balanceEntries.find(([k]) => k === withdrawToken);
                    const available = entry?.[1].available ?? 0;
                    const cap = velocity?.remaining;
                    const maxAmount = cap != null ? Math.min(available, cap) : available;
                    if (maxAmount <= 0) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => setWithdrawAmount(String(maxAmount))}
                        disabled={withdrawLoading}
                        className="font-pixel text-[9px] uppercase tracking-wider text-brand transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        Max ({formatAmount(maxAmount)})
                      </button>
                    );
                  })()}
                </div>
                <input
                  id="withdraw-amount"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  autoComplete="off"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  disabled={withdrawLoading}
                  placeholder="0.00"
                  aria-invalid={overCap || undefined}
                  aria-describedby={velocity?.cap != null ? 'withdraw-velocity' : undefined}
                  className={`w-full border-2 px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted transition-colors disabled:opacity-50 ${
                    overCap
                      ? 'border-destructive bg-destructive/10 focus:border-destructive'
                      : 'border-secondary bg-[var(--color-panel)] focus:border-brand'
                  }`}
                />
              </div>

              {/* Daily velocity cap counter — shown only when a cap is set */}
              {velocity?.cap != null && (
                <p
                  id="withdraw-velocity"
                  className={`mb-5 type-caption ${overCap ? 'text-destructive' : ''}`}
                >
                  Daily limit: {formatAmount(velocity.usedToday)} /{' '}
                  {formatAmount(velocity.cap)} {tokenSymbol(withdrawToken)} used
                  {velocity.remaining != null && (
                    <>
                      {' '}
                      — <span className="text-foreground num-tabular">{formatAmount(velocity.remaining)}</span> remaining today
                    </>
                  )}
                </p>
              )}

              {overCap && (
                <p className="mb-5 border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-xs text-destructive">
                  Amount exceeds your remaining daily limit. Try a smaller
                  amount or wait for the 24-hour rolling window to refresh.
                </p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setWithdrawOpen(false)}
                  disabled={withdrawLoading}
                  className="btn-ghost-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleWithdraw}
                  disabled={withdrawLoading || !withdrawAmount || overCap}
                  className="btn-primary-sm"
                >
                  {withdrawLoading ? 'Withdrawing…' : 'Confirm withdraw'}
                </button>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}
