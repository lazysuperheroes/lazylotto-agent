'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useToast } from '../components/Toast';
import { ComicPanel } from '../components/ComicPanel';
import { SpeechBubble } from '../components/SpeechBubble';
import { ActionBurst } from '../components/ActionBurst';
import { GoldConfetti } from '../components/GoldConfetti';
import { TopUpModal } from '../components/TopUpModal';
import {
  PrizeNftCard,
  type PrizeNftRef,
} from '../components/PrizeNftCard';
import { CharacterMascot } from '../auth/CharacterMascot';
import { useNftEnrichment } from '../components/useNftEnrichment';
import {
  LSH_CHARACTERS,
  loadOrPickCharacterIdx,
  CHARACTER_CHANGE_EVENT,
  buildNarrativeHeadline,
  deriveAgentMood,
  type CharacterChangeDetail,
} from '../lib/characters';
import { useFreshness } from '../lib/useFreshness';
import { clearSession } from '../lib/session';
import {
  bumpVisitCount,
  markSpoken,
  shouldMascotSpeak,
} from '../lib/mascotRarity';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { HeroSkeleton, HistorySkeleton } from './skeletons';
import { WithdrawModal } from './WithdrawModal';
import {
  DAPP_CLAIM_URL,
  formatAmount,
  formatTimestamp,
  pickCharacterLine,
  tokenSymbol,
} from './helpers';
import type {
  HistoryResponse,
  PlaySession,
  PrizeStatusResponse,
  PublicStats,
  StatusResponse,
} from './types';

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------
//
// Most of the previously-inline machinery now lives in adjacent files
// (extracted during the #212 refactor):
//   - types.ts        → API response shapes
//   - helpers.ts      → formatters + character line state machine
//   - skeletons.tsx   → HeroSkeleton + HistorySkeleton
//   - WithdrawModal.tsx → the cash-out form
// What remains here is the page composition — fetch coordination,
// derived state, render — which is still substantial but no longer
// owns three layers of unrelated concerns at once.

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

  // Per-section "loaded at" timestamps for the freshness ribbon.
  // useFreshness() turns these into "Updated 3s ago" strings that
  // tick every 5s, so the user can tell at a glance how stale each
  // panel's data is. null → no data yet → no freshness shown.
  const [statusLoadedAt, setStatusLoadedAt] = useState<number | null>(null);
  const [historyLoadedAt, setHistoryLoadedAt] = useState<number | null>(null);
  const [prizeStatusLoadedAt, setPrizeStatusLoadedAt] = useState<number | null>(
    null,
  );
  const statusFreshness = useFreshness(statusLoadedAt);
  const historyFreshness = useFreshness(historyLoadedAt);
  const prizeFreshness = useFreshness(prizeStatusLoadedAt);

  // Ref on the Prize Claim panel — after a winning play we scroll the
  // panel into view so first-time winners discover where their prize
  // actually is (in the dApp contract, not the agent pot). Without
  // this scroll, the only signal is a 3.5s toast that may scroll
  // off-screen by the time the user looks down.
  const prizeClaimRef = useRef<HTMLDivElement>(null);

  // Self-serve register + withdraw + play state
  const [registerLoading, setRegisterLoading] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawToken, setWithdrawToken] = useState('hbar');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [playLoading, setPlayLoading] = useState(false);
  // Play session progress — milliseconds since handlePlay started.
  // Updated every 250ms while a play is in flight so the button can
  // show "elapsed" time and rotate through phase messages. Reset to
  // 0 when the play resolves. The user previously stared at a static
  // "Playing…" button for 5-15s with no signal that work was happening;
  // this gives them concrete time-based feedback. */
  const [playElapsedMs, setPlayElapsedMs] = useState(0);
  // Top-up modal — replaces the old in-page Fund Your Account
  // collapsible. Triggered from the hero metadata "Top up" link
  // (when funded) or the empty-state ribbon's Step 01 (when not).
  const [topUpOpen, setTopUpOpen] = useState(false);

  // Prize claim state — populated from /api/user/prize-status. Null
  // until first fetch resolves; { available: false } if the dApp MCP
  // query failed (we still render the dashboard, just without the
  // pending-claim panel). Refetched on mount and after every play.
  const [prizeStatus, setPrizeStatus] = useState<PrizeStatusResponse | null>(null);

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

  // Set page title + bump the visit counter that gates mascot rarity.
  // The counter drives shouldMascotSpeak() — early visits always show
  // the speech bubble so new users meet the character, later visits
  // go quiet until a 24h window elapses OR a functional moment
  // (play-in-flight, kill switch, pending claim) makes the bubble
  // load-bearing again. Bumped ONCE per mount, not per render.
  const [visitCount, setVisitCount] = useState(0);
  useEffect(() => {
    document.title = 'Dashboard | LazyLotto Agent';
    setVisitCount(bumpVisitCount());
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
          clearSession();
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
        setStatusLoadedAt(Date.now());
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

  // Prize claim fetch — extracted as its own callback so we can call it
  // on mount AND after every play (a winning play creates new pending
  // prizes that get reassigned to the user's EOA in phase 5). Soft-
  // fails: a dApp MCP timeout just leaves prizeStatus null, which the
  // panel reads as "claim status unavailable" without breaking the
  // rest of the dashboard.
  const loadPrizeStatus = useCallback(
    async (headers: { Authorization: string }) => {
      try {
        const res = await fetch('/api/user/prize-status', { headers });
        if (!res.ok) return;
        const data = (await res.json()) as PrizeStatusResponse;
        setPrizeStatus(data);
        setPrizeStatusLoadedAt(Date.now());
      } catch {
        /* silent — non-critical enrichment */
      }
    },
    [],
  );

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
    //
    // Prize-status is chained AFTER status because:
    //   1. Status hits Redis only (cheap, ~50-200ms warm)
    //   2. Prize-status hits the dApp MCP (slow, 1-2s cold)
    //   3. Both eventually want getAgentContext, so chaining them lets
    //      the getAgentContext init (if any) happen exactly once.
    // The Pending Claim panel renders nothing until prizeStatus loads,
    // so the deferred fetch doesn't visibly delay anything — the rest
    // of the dashboard is already painted by then.
    void (async () => {
      await loadStatus(headers);
      void loadPrizeStatus(headers);
    })();

    void (async () => {
      try {
        const res = await fetch('/api/user/history', { headers });
        if (res.status === 401) {
          clearSession();
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
        setHistoryLoadedAt(Date.now());
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
    //
    // Throttle: only fire if the last check was >30s ago. Without this
    // gate, every dashboard mount (Dashboard ↔ Account ↔ Audit nav)
    // burns through the /api/user/check-deposits rate limit (12/min) and
    // makes a slow mirror-node round-trip even when nothing has changed.
    // The manual "Check for deposits" button below ignores this gate, so
    // users can always force a refresh when they're actively waiting.
    const lastCheckMs = Number(
      localStorage.getItem('lazylotto:lastDepositCheck') ?? '0',
    );
    const elapsedSinceLastCheck = Date.now() - lastCheckMs;
    const DEPOSIT_CHECK_THROTTLE_MS = 30_000;
    if (elapsedSinceLastCheck >= DEPOSIT_CHECK_THROTTLE_MS) {
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
          // Record the timestamp regardless of whether anything was
          // processed — the gate is "did we check recently", not "did
          // we find new deposits".
          localStorage.setItem('lazylotto:lastDepositCheck', String(Date.now()));
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
    }
  }, [loadStatus, router]);

  // ── Quiet background refresh ────────────────────────────────
  //
  // The agent is (or will be) running autonomously on a schedule,
  // but the dashboard is a static snapshot — the user has to click
  // refresh to see updated data. This interval silently refetches
  // status + history every 60 seconds so the hero's "last run"
  // freshness ribbon and activity summary update without the user
  // having to do anything. The critique called this "smooth the
  // real-time hero" — it's not truly real-time (no websocket, no
  // server-push), but 60s tick cadence is enough for the agent
  // to FEEL alive rather than frozen.
  //
  // Runs only when the user is authenticated, has a registered
  // profile, and hasn't manually triggered a recent refresh (we
  // rely on the existing loadStatus + /history fetch paths which
  // update statusLoadedAt + historyLoadedAt on success).
  //
  // Only fires when document.visibilityState is 'visible' so we
  // don't hammer the API for users who left the tab open in the
  // background. Visibility change events re-trigger an immediate
  // refresh so the data is fresh the moment the user returns.
  const lastVisibilityRefreshRef = useRef(0);
  useEffect(() => {
    if (!sessionToken || notRegistered) return;
    const REFRESH_INTERVAL_MS = 60_000;
    const VISIBILITY_REFRESH_THROTTLE_MS = 30_000;

    const quietRefresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const token = localStorage.getItem('lazylotto:sessionToken');
      if (!token) return;
      const headers = { Authorization: `Bearer ${token}` };
      // Fire both in parallel — they're independent and both land
      // in their own state slots. Silent on failure — this is a
      // best-effort background poll, not a critical path.
      try {
        await loadStatus(headers);
      } catch {
        /* silent */
      }
      try {
        const res = await fetch('/api/user/history', { headers });
        if (res.ok) {
          const data = (await res.json()) as { sessions?: PlaySession[] };
          setSessions(data.sessions ?? []);
          setHistoryLoadedAt(Date.now());
        }
      } catch {
        /* silent */
      }
    };

    const interval = window.setInterval(quietRefresh, REFRESH_INTERVAL_MS);
    // Also refresh when the tab becomes visible again after being
    // hidden — users returning from another tab see fresh data
    // immediately instead of waiting for the next interval tick.
    //
    // THROTTLED: iOS Safari fires visibilitychange on keyboard
    // open/close, share-sheet dismiss, and several other transient
    // events. Without a throttle, a user typing into the Withdraw
    // modal's amount input would trigger 4-8 refreshes per
    // withdrawal session as the keyboard opens and closes. Skip
    // the refetch if it's fired within the last 30 seconds — the
    // 60s interval still catches genuine tab-return moments, and
    // the user's active flow isn't interrupted by background work.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastVisibilityRefreshRef.current < VISIBILITY_REFRESH_THROTTLE_MS) {
        return;
      }
      lastVisibilityRefreshRef.current = now;
      void quietRefresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sessionToken, notRegistered, loadStatus]);

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
      // Refresh the throttle timestamp so the next page-mount auto-check
      // doesn't run immediately on top of this manual check.
      localStorage.setItem('lazylotto:lastDepositCheck', String(Date.now()));
      // Bump the freshness ribbon — even if no new deposits arrived,
      // we just verified the data is current.
      setStatusLoadedAt(Date.now());
      const processed = data.processed ?? 0;
      if (processed > 0 && data.balances) {
        // Compute the per-token deposit diff so the toast can name the
        // amount and token. The user explicitly wants to see "Found
        // +50 HBAR" — generic "Found 1 new deposit" leaves them
        // wondering whether it was THEIR deposit or someone else's.
        // We compare totalDeposited fields between the previous status
        // snapshot and the new one. Multi-token diffs are joined with
        // " + " so a HBAR + LAZY pair shows as "+10 HBAR + 100 LAZY".
        const diffs: string[] = [];
        setStatus((prev) => {
          if (prev) {
            for (const [tokenKey, newEntry] of Object.entries(data.balances!.tokens)) {
              const oldEntry = prev.balances.tokens[tokenKey];
              const oldDeposited = oldEntry?.totalDeposited ?? 0;
              const delta = newEntry.totalDeposited - oldDeposited;
              if (delta > 0) {
                diffs.push(`+${formatAmount(delta)} ${tokenSymbol(tokenKey)}`);
              }
            }
          }
          return prev
            ? {
                ...prev,
                balances: data.balances!,
                lastPlayedAt: data.lastPlayedAt ?? prev.lastPlayedAt,
              }
            : prev;
        });
        // Use the diff message when we computed one, otherwise fall back
        // to the count (e.g. first-ever deposit on a fresh status snapshot
        // where there's no "previous" to diff against).
        if (diffs.length > 0) {
          toast(`Deposit confirmed: ${diffs.join(' + ')}`);
        } else {
          toast(
            processed === 1
              ? 'Found 1 new deposit'
              : `Found ${processed} new deposits`,
          );
        }
      } else {
        toast(
          'No new deposits yet — Hedera mirror nodes can lag a few seconds behind the actual transfer. Make sure you included the deposit memo and try again in a moment.',
          { variant: 'info' },
        );
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
        setStatusLoadedAt(Date.now());
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
    // Start the elapsed-time ticker. 250ms granularity is fine — the
    // user just needs to see the seconds counter increment so they
    // know time is moving. The interval is cleaned up in the finally
    // block (and a safety useEffect cleanup below in case unmount).
    setPlayElapsedMs(0);
    const playStartedAt = Date.now();
    const elapsedTicker = window.setInterval(() => {
      setPlayElapsedMs(Date.now() - playStartedAt);
    }, 250);
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
        // Toast tells the user where the prize is. The Pending Claim
        // panel below explains the agent-pot vs dApp-contract
        // distinction in detail; the toast is the immediate hint that
        // there's an action to take. The trailing arrow signals "look
        // down" — the panel will be scrolled into view momentarily.
        toast(`${label} ${session.totalWins} prize(s) — claim on the dApp ↓`);
        // Scroll the Pending Claim panel into view after the prize-status
        // refetch lands. Wait ~800ms so the dApp MCP query has a chance
        // to refresh first; otherwise the panel still shows stale state
        // when the user lands on it. Smooth scroll into the centre so
        // the panel becomes the visual focal point. First-time winners
        // need to discover that prizes live in the dApp contract, not
        // the agent pot — this is the moment they're paying attention.
        window.setTimeout(() => {
          prizeClaimRef.current?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        }, 800);
      } else {
        toast(
          `Played ${session.poolsPlayed} pool(s), no wins this round`,
          { variant: 'info' },
        );
      }

      // Update balance in place so the user sees the effect immediately
      if (balances) {
        setStatus((prev) => (prev ? { ...prev, balances } : prev));
        setStatusLoadedAt(Date.now());
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
            setHistoryLoadedAt(Date.now());
          }
        } catch {
          /* silent */
        }
      })();

      // Refetch pending prize status so a fresh win shows up in the
      // panel immediately. The contract reassigned the prize to the
      // user's EOA in phase 5, so the dApp MCP query will already
      // see it.
      void loadPrizeStatus({ Authorization: `Bearer ${token}` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Play failed: ${message}`, { variant: 'error' });
    } finally {
      window.clearInterval(elapsedTicker);
      setPlayElapsedMs(0);
      setPlayLoading(false);
    }
  }, [router, toast, loadPrizeStatus]);


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

  // ── Hero derivations hoisted above early returns ─────────────
  // These and the three hooks below USED to live after the
  // !sessionToken / notRegistered early returns. That's a Rules of
  // Hooks violation: when a user signs in (flipping sessionToken
  // from null to non-null) the render count of hooks changes
  // between renders, tripping React error #310. Hooks must run in
  // the same order on every render, so we hoist the hook calls —
  // and the derivations they depend on — above the early returns.
  // Non-hook derivations used only by the main JSX render path
  // stay below.
  const character = LSH_CHARACTERS[characterIdx] ?? LSH_CHARACTERS[0]!;
  const balanceEntries = status
    ? Object.entries(status.balances.tokens)
    : [];
  const hasPlayableBalance = balanceEntries.some(([, e]) => e.available > 0);
  const agentClosed = publicStats?.acceptingOperations === false;
  const isFirstRun =
    !!status && sessions.length === 0 && !hasPlayableBalance;
  const hasPendingClaim =
    !!prizeStatus && prizeStatus.available && prizeStatus.pending.count > 0;
  const latestSession = sessions[0];
  const lastPlayedAtMs = status?.lastPlayedAt
    ? new Date(status.lastPlayedAt).getTime()
    : null;

  // Mascot rarity: the character is mostly silent, speaking only at
  // MEANINGFUL moments. The narrative headline absorbs the functional
  // states (play-in-flight, agent-closed, pending-claim) so the bubble
  // is now reserved strictly for first-run teaching + the 24h
  // quiet-window welcome-back.
  const mascotShouldSpeak = shouldMascotSpeak({
    isFirstRun,
    visitCount,
  });
  const characterLine = mascotShouldSpeak
    ? pickCharacterLine(character, {
        status,
        playLoading,
        agentClosed,
        isFirstRun,
        hasPlayableBalance,
        sessionsLength: sessions.length,
        hasPendingClaim,
      })
    : '';

  // Stamp the speech moment once the bubble actually renders — gated
  // on the line being non-empty so a no-speak render doesn't burn the
  // quiet-window budget. Runs after paint, not during render.
  useEffect(() => {
    if (characterLine) {
      markSpoken();
    }
  }, [characterLine]);

  // Relative time of the last run — shown in the freshness ribbon
  // next to "updated 3s ago" so users see both the agent's activity
  // cadence AND when the dashboard was last refreshed.
  const lastRunFreshness = useFreshness(
    Number.isFinite(lastPlayedAtMs) ? lastPlayedAtMs : null,
  );

  // ── Narrative headline memoization ──────────────────────────
  //
  // Build the hero headline text ONCE per meaningful state change
  // instead of on every render. Previously the headline's IIFE ran
  // inside the JSX on every render, which meant the 5-second
  // freshness ribbon tick cascaded into a full headline rebuild
  // every 5s even though none of the headline's actual inputs had
  // changed.
  //
  // The `character.name` is known at build time for the text prefix
  // so we split it here too; the JSX layer just renders the
  // name in brand-gold + the rest in foreground.
  const narrativeHeadline = useMemo(() => {
    if (!status) return null;

    let headlineState:
      | 'first-run'
      | 'claim-pending'
      | 'ready'
      | 'playing'
      | 'closed'
      | 'has-history';
    if (playLoading) headlineState = 'playing';
    else if (agentClosed) headlineState = 'closed';
    // Pending-claim-without-agent-history takes priority over first-run:
    // if the user has wins sitting on the LazyLotto contract from
    // direct dApp plays, the "waiting on your first drop, friend"
    // headline is factually wrong. They're not a blank slate — they
    // have money waiting. The claim-pending branch acknowledges that
    // with a character-voiced nudge toward the dApp, while the rest
    // of the dashboard (deposit teaching, "no sessions yet" play log)
    // continues to reflect the agent-side reality.
    else if (isFirstRun && hasPendingClaim) headlineState = 'claim-pending';
    else if (isFirstRun) headlineState = 'first-run';
    // Edge case: lastPlayedAt is set but the sessions array hasn't
    // loaded yet (rare race during a fresh history fetch). Treat as
    // 'ready' so the headline doesn't fall into has-history with
    // no data.
    else if (hasPlayableBalance && sessions.length === 0) headlineState = 'ready';
    else headlineState = 'has-history';

    const mood = deriveAgentMood(sessions);
    const last = latestSession;
    const lastOutcome: 'win' | 'loss' | 'no-play' | undefined = last
      ? last.totalWins > 0
        ? 'win'
        : last.totalSpent > 0
          ? 'loss'
          : 'no-play'
      : undefined;

    // Primary won token — pick the first non-zero entry from
    // prizesByToken so HBAR + LAZY wins both render correctly.
    let lastWonToken = 'HBAR';
    let lastWonAmount = last?.totalPrizeValue ?? 0;
    if (last?.prizesByToken) {
      for (const [tok, amt] of Object.entries(last.prizesByToken)) {
        if (amt > 0) {
          lastWonToken = tok.toUpperCase();
          lastWonAmount = amt;
          break;
        }
      }
    }

    const headlineText = buildNarrativeHeadline({
      character,
      state: headlineState,
      lastOutcome,
      mood,
      lastWonAmount,
      lastWonToken,
      lastSpentAmount: last?.totalSpent,
      lastPoolsPlayed: last?.poolsPlayed,
      hasPendingClaim,
    });

    const namePrefix = character.name;
    const rest = headlineText.startsWith(namePrefix)
      ? headlineText.slice(namePrefix.length)
      : ` ${headlineText}`;

    return { namePrefix, rest };
  }, [
    status,
    playLoading,
    agentClosed,
    isFirstRun,
    hasPlayableBalance,
    sessions,
    latestSession,
    character,
    hasPendingClaim,
  ]);

  // --- Loading state ---
  // The dashboard no longer blocks on a full-page skeleton. We render the
  // shell immediately and each section paints its own skeleton until its
  // own fetch resolves. This means history shows up as soon as it lands
  // (typically before status, since it doesn't go through getAgentContext)
  // and the user gets an immediate sense that the page is alive.
  //
  // The auth wall and notRegistered wall remain full-page redirects below
  // — those are discrete states, not loading states.

  // --- No auth token ---
  if (!sessionToken) {
    // The previous version of this state was a generic muted "Sign in
    // required / Welcome back / Authenticate with your Hedera wallet"
    // card — indistinguishable from every crypto wallet auth gate. Now
    // the persistent mascot sits front and centre with a character-
    // voiced prompt, picked from the same roster the user will see
    // on /auth and everywhere else. The first-time visitor meets the
    // brand before they're even signed in. `character` is hoisted
    // above the early returns alongside the hook dependencies.
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <ComicPanel label="LOCKED" tone="muted" halftone="none">
            <div className="flex flex-col items-center gap-5 p-8 text-center">
              <CharacterMascot
                key={character.name}
                character={character}
                size="sm"
                line="You're not signed in. Tap Sign In and I'll start the engine."
              />
              <h1 className="display-md text-foreground">Welcome back</h1>
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

  // Balance row formatting for the detailed card below the hero.
  // `balanceEntries` itself is hoisted above the early returns
  // alongside the hook dependencies — see the hoisted block above.
  const totalDeposited = balanceEntries
    .map(([key, entry]) => `${formatAmount(entry.totalDeposited)} ${tokenSymbol(key)}`)
    .join(', ') || '--';
  const totalRakePaid = balanceEntries
    .map(([key, entry]) => `${formatAmount(entry.totalRake)} ${tokenSymbol(key)}`)
    .filter((s) => !s.startsWith('0'))
    .join(', ') || '--';

  const agentWallet = status?.agentWallet ?? '';

  // ── Primary/secondary token split ─────────────────────────────
  // The hero panel shows ONE huge balance number. We pick the token
  // with the highest `available` balance as the primary; any other
  // non-zero tokens are surfaced as secondary pills below. Multi-
  // token users still see everything, single-token users (the common
  // case) see one confident pot.
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

  // ── Play progress phase derivation ─────────────────────────
  // The /api/user/play POST takes 5-15s typically (deposit poll +
  // Hedera consensus + prize transfer). We can't get progress events
  // from a single POST, so we fake it with a time-based phase rotation
  // — the user gets a sense of "what's happening now" instead of a
  // static "Playing…" label that may not move for 10 seconds.
  //
  // Each phase has a button label. Time bands tuned from observation
  // of the actual play flow:
  //   0-2s   "Waking up the agent…"
  //   2-5s   "Picking pools…"
  //   5-10s  "Pulling the lever…"
  //   10-15s "Watching the wheels…"
  //   15s+   "Hedera consensus is happening…"
  // After 15s the last phase sticks. Worst case the user waits longer
  // than expected but at least they know it's a blockchain timing
  // issue, not a frozen UI.
  const PLAY_PHASES: { atMs: number; label: string }[] = [
    { atMs: 0, label: 'Waking up the agent…' },
    { atMs: 2000, label: 'Picking pools…' },
    { atMs: 5000, label: 'Pulling the lever…' },
    { atMs: 10000, label: 'Watching the wheels…' },
    { atMs: 15000, label: 'Hedera consensus is happening…' },
  ];
  const currentPlayPhase = (() => {
    if (!playLoading) return null;
    let phase = PLAY_PHASES[0]!;
    for (const p of PLAY_PHASES) {
      if (playElapsedMs >= p.atMs) phase = p;
    }
    return phase;
  })();
  const playElapsedSec = Math.floor(playElapsedMs / 1000);

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
          Sits at z-[60] — ABOVE the toast container's z-50 — so
          the celebration owns the moment and can't be occluded by
          a simultaneous toast. The toast still announces the win
          for screen readers via its own aria-live region. */}
      {winCelebration && (
        <div
          className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center"
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
        {/* Context chips row — stuck deposits alert on the left,
            account identity chip on the right. The "Dashboard" page
            title used to live here as an h1, but the narrative
            headline inside the hero panel below is the real page
            title now (see buildNarrativeHeadline). Having both
            violated WCAG 1.3.1 (duplicate h1). Dropping the title
            here also honours the watching-first framing — the user
            isn't here to read "Dashboard", they're here to see what
            the agent did. The sidebar still marks the active route.
            Plain div (not header) since this row is no longer the
            page banner — it's a row of supplementary chips. */}
        <div className="mb-10 flex flex-wrap items-center justify-end gap-4">
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
          {/* Account identity chip — READ-ONLY greeting, no longer a
              disconnect button. Previously the header had a
              clickable account chip that duplicated the Sidebar's
              Disconnect button: same action in two places, different
              affordances on mobile vs desktop, exactly the kind of
              drift the gap report flagged. The Sidebar is now the
              canonical disconnect site (persistent across every
              page), so the header chip becomes a simple greeting
              with no action. Hidden on mobile where the sidebar is
              the dominant identity surface anyway. */}
          {status?.hederaAccountId && (
            <div
              className="hidden items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-3 py-2 sm:inline-flex"
              aria-label={`Signed in as ${status.hederaAccountId}`}
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                aria-hidden="true"
              />
              <code className="font-mono text-xs text-foreground">
                {status.hederaAccountId.length > 14
                  ? `${status.hederaAccountId.slice(0, 7)}…${status.hederaAccountId.slice(-4)}`
                  : status.hederaAccountId}
              </code>
            </div>
          )}
        </div>

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

        {/* Non-fatal error banner — sharp corners + 2px border to
            match the rest of the comic vocabulary. Previously used
            rounded-lg from the pre-normalize era. */}
        {error && status && (
          <div
            role="alert"
            className="mb-6 border-2 border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
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

            Three states: loading (HeroSkeleton), loaded (the real
            ComicPanel), and error (handled by the inline error block
            below). Loading is independent of history loading so the
            two sections paint at their own pace.
            ══════════════════════════════════════════════════════════ */}
        {!status && statusLoading && <HeroSkeleton />}
        {status && (
          <ErrorBoundary label="Hero balance" onReset={retryStatus}>
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

              {/* Hero content — narrative-first hierarchy.
                  Old: display-xl number owned the eye and the speech
                  bubble floated decoratively below.
                  New: the ACTIVITY NARRATIVE is the hero focal moment.
                  Headline reads "{character} last ran {relative}" in
                  heading-1 scale, followed by a one-line session
                  summary. The balance becomes a supporting detail
                  inline below the headline, not a display-xl hero
                  number. This honours the watching-first framing:
                  the user is here to see what the agent did, not
                  stare at a balance. */}
              <div className="min-w-0">
                {/* Eyebrow row — deposits-checking pulse on the left
                    (only when active), freshness ribbon on the right.
                    NO aria-live on the wrapper: the freshness ribbon
                    inside ticks every 5s via useFreshness, and an
                    aria-atomic region here would make screen readers
                    re-announce "last run 1m ago updated 5s ago refresh"
                    every 5 seconds, forever. The only genuine live
                    status in this row is "Checking deposits", which
                    now carries its own scoped aria-live on the span
                    where it actually belongs.

                    Uses `ml-auto` on the freshness button instead of
                    `justify-between` + a placeholder empty span. When
                    only the button renders, it pushes itself to the
                    right via the auto margin. When both the pulse
                    and the button render, the button still sits at
                    the right. Same visual result, no dead-code span. */}
                <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2">
                  {depositsChecking && (
                    <span
                      className="label-caps-brand inline-flex items-center gap-1.5"
                      role="status"
                      aria-live="polite"
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand"
                        aria-hidden="true"
                      />
                      Checking deposits
                    </span>
                  )}
                  {/* Freshness ribbon — right-aligned via ml-auto so
                      it pushes to the end of the flex row regardless
                      of whether the deposits-checking pulse is
                      present. Not a live region — the info is
                      ambient, not a status announcement. Keyboard
                      users get it via normal tab-to-button +
                      title attribute. */}
                  {!depositsChecking && (statusFreshness || lastRunFreshness) && (
                    <button
                      type="button"
                      onClick={() => void handleCheckDeposits()}
                      className="label-caps ml-auto -m-2 p-2 text-muted underline-offset-2 transition-colors hover:text-brand hover:underline"
                      title="Click to re-check deposits and refresh balance"
                    >
                      {lastRunFreshness && (
                        <span className="mr-3">last run {lastRunFreshness}</span>
                      )}
                      {statusFreshness && <>updated {statusFreshness} · refresh</>}
                    </button>
                  )}
                </div>

                {/* ═══════════════════════════════════════════════
                    Narrative headline — THE hero focal moment.
                    ═══════════════════════════════════════════════
                    Built via buildNarrativeHeadline() from the
                    character's voice block + current state + mood
                    derived from the last 3 sessions. Each character
                    renders a state in their own vocabulary ("Gordo
                    bagged 150 HBAR — go grab it on the dApp, boss"
                    vs "Nobody quietly handled 5 pools"). The
                    freshness ribbon up top carries the absolute
                    timestamp so the headline can stay in voice
                    without prefixing a literal "2h ago."

                    The headline string is rendered with the character
                    name wrapped in a brand-gold span — we parse the
                    builder output by splitting on the known name
                    prefix so the visual treatment stays at the JSX
                    layer while the builder stays pure text. */}
                {/* Narrative headline is a heading, not a live region.
                    During a winning play, the play phase status +
                    win celebration overlay + win toast ALREADY announce
                    the event. Adding aria-live here meant screen readers
                    got 4 competing announcements in the same ~20s window
                    after a play. The h1 is still discoverable via normal
                    heading navigation; it just doesn't re-announce when
                    the underlying content updates. */}
                {narrativeHeadline && (
                  <h1 className="heading-1 mb-3 text-foreground">
                    <span className="text-brand">{narrativeHeadline.namePrefix}</span>
                    {narrativeHeadline.rest}
                  </h1>
                )}

                {/* Supporting balance line — demoted from display-xl
                    but with a thin brand-gold left border that acts as
                    a visual anchor. Eye can find the balance on a
                    second-pass scan without the line shouting. The
                    "Available" prefix is now foreground-tinted (not
                    muted) so it doesn't read as caption-level info —
                    it's a label, not a footnote. */}
                {(() => {
                  const displayReserved = primaryBalanceEntry?.[1].reserved ?? 0;
                  const displayToken = primaryBalanceEntry
                    ? tokenSymbol(primaryBalanceEntry[0])
                    : 'HBAR';
                  // Collected token parts for the one-line format:
                  // ["285 HBAR", "100 LAZY"] → "285 HBAR · 100 LAZY"
                  const tokenParts: string[] = [];
                  if (primaryBalanceEntry) {
                    tokenParts.push(
                      `${formatAmount(primaryBalanceEntry[1].available)} ${displayToken}`,
                    );
                  } else {
                    tokenParts.push(`0 HBAR`);
                  }
                  for (const [k, e] of secondaryBalanceEntries) {
                    if (e.available > 0) {
                      tokenParts.push(`${formatAmount(e.available)} ${tokenSymbol(k)}`);
                    }
                  }
                  return (
                    <p
                      className="num-tabular type-body-lg mb-5 border-l-2 border-brand/40 pl-3 text-brand"
                      aria-label={`Available balance: ${tokenParts.join(', ')}`}
                    >
                      <span className="label-caps mr-2 text-foreground">Available</span>
                      {tokenParts.join(' · ')}
                      {displayReserved > 0 && (
                        <span className="ml-3 type-caption">
                          ({formatAmount(displayReserved)} {displayToken} in play)
                        </span>
                      )}
                    </p>
                  );
                })()}

                {/* Character speech bubble — gated by mascot rarity.
                    Only renders at qualifying moments (play in flight,
                    agent closed, first run, pending claim, early
                    visits 1-3, or the 24h quiet window has elapsed).
                    The headline above already carries the character's
                    voice; the bubble is reserved for SPECIAL moments
                    when the character has something new to say. */}
                {characterLine && (
                  <SpeechBubble tailPosition="left" className="prose-width mb-6 ml-2">
                    <p className="type-body text-muted">
                      {characterLine}
                    </p>
                    <p className="label-caps-brand mt-3">
                      — {character.name}
                    </p>
                  </SpeechBubble>
                )}

                {/* ── Nudge the agent — watching-first framing ───────
                    The Play action is NOT the primary path (the agent
                    runs autonomously on a schedule, or via MCP calls
                    from Claude). These buttons are escape hatches for
                    users who want to nudge the agent manually — most
                    commonly mobile users without a Claude subscription
                    who don't have an MCP endpoint to talk to.
                    "Nudge the agent" frames the interaction gently —
                    the character is doing its thing, you're giving
                    it a poke. Previous "MANUAL OVERRIDES" phrasing
                    was industrial-control-panel cold; "Nudge" matches
                    the character-voiced hero above.

                    Both buttons carry inline SVG icons (refresh + arrow)
                    so they're visually distinctive from the generic
                    two-ghost-buttons pattern. Run now also hosts the
                    play progress as a background fill during a session —
                    the button IS the progress indicator. */}
                {hasPlayableBalance ? (
                  <div className="mt-6 border-t border-secondary/40 pt-5">
                    {/* Nudge label — plain label-caps (muted), not
                        label-caps-brand, to visually differentiate
                        from the first-run "Get started" label which
                        is brand-gold. The state transition from
                        funding → playing is subtle but visible:
                        first-run shouts the Get Started heading in
                        gold, funded state whispers Nudge in muted
                        caps because the action is now optional. */}
                    <p className="label-caps mb-3">Nudge the agent</p>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={handlePlay}
                        disabled={playLoading || agentClosed}
                        aria-disabled={playLoading || agentClosed ? 'true' : undefined}
                        aria-describedby={
                          agentClosed
                            ? 'agent-status-banner'
                            : playLoading
                              ? 'play-progress-status'
                              : undefined
                        }
                        className="btn-ghost-sm-brand relative overflow-hidden panel-shadow-sm"
                        title={
                          agentClosed
                            ? 'Agent is temporarily closed to new plays'
                            : 'Nudge the agent to run a session now'
                        }
                      >
                        {/* Progress fill — absolute, z-0, behind the
                            label. During a play, grows from 5% to 100%
                            via the same .play-progress-fill keyframe
                            that used to animate the bar below. After
                            12s data-overflow="true" swaps to the
                            continuous sweep. The button IS the progress. */}
                        {playLoading && (
                          <span
                            className="play-progress-bar absolute inset-0 h-full border-0"
                            data-overflow={playElapsedMs > 12000 ? 'true' : undefined}
                            aria-hidden="true"
                          >
                            <span className="play-progress-fill" />
                          </span>
                        )}
                        {/* SVG refresh icon — distinctive, non-generic */}
                        {!playLoading && (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="relative z-10"
                            aria-hidden="true"
                          >
                            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
                            <polyline points="13.5 2 13.5 5 10.5 5" />
                          </svg>
                        )}
                        <span className="relative z-10">
                          {playLoading && currentPlayPhase
                            ? currentPlayPhase.label
                            : 'Run now'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setWithdrawOpen(true)}
                        disabled={playLoading}
                        className="btn-ghost-sm panel-shadow-sm"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <line x1="3" y1="8" x2="13" y2="8" />
                          <polyline points="9 4 13 8 9 12" />
                        </svg>
                        Cash out
                      </button>
                    </div>

                    {/* Phase status — live announcement of what the
                        agent is doing. Kept as a screen-reader
                        status line even though the button now carries
                        the visual progress. Matches aria-describedby
                        on the Run now button. */}
                    {playLoading && (
                      <p
                        id="play-progress-status"
                        className="mt-3 font-pixel text-[10px] uppercase tracking-wider text-brand"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        {currentPlayPhase?.label}
                        <span className="ml-2 text-muted">
                          · {playElapsedSec}s elapsed
                        </span>
                      </p>
                    )}
                  </div>
                ) : (
                  // First-run state — character-driven teaching.
                  //
                  // The previous version used a three-step numbered
                  // ribbon (Fund → Play → Withdraw) which was
                  // structurally identical to every fintech
                  // onboarding stepper and didn't lean on the
                  // character system at all. Now the mascot is the
                  // primary teacher: the speech bubble above the
                  // hero headline carries the character's introLine,
                  // and this slot contains the ONE concrete action
                  // the user needs to take — send HBAR with their
                  // memo to the agent wallet.
                  //
                  // The deposit-detection throttle in the mount
                  // effect will auto-check every 30s, and the "Check
                  // for deposits" button inside TopUpModal lets
                  // users force an immediate refresh. When a deposit
                  // lands, the hero transitions to the funded state
                  // automatically on the next status refresh.
                  <div className="mt-6 border-t border-secondary/40 pt-5">
                    <p className="label-caps-brand mb-3">Get started</p>
                    <div className="space-y-4">
                      {/* Concrete inline action block — agent wallet
                          + deposit memo + copy buttons. Same data as
                          TopUpModal but rendered inline so first-run
                          users see the action AT the hero instead of
                          behind a modal. TopUpModal stays available
                          via the Top up link in the details strip
                          and the "Open top-up panel" button below. */}
                      <div className="border-2 border-brand/40 bg-brand/5 p-4">
                        <p className="label-caps mb-2 text-brand">
                          Send HBAR to this wallet
                        </p>
                        <div className="mb-3 flex items-center gap-2">
                          <code className="flex-1 break-all font-mono text-sm text-foreground">
                            {agentWallet || '—'}
                          </code>
                          {agentWallet && (
                            <button
                              type="button"
                              onClick={() => handleCopy(agentWallet, 'Agent wallet')}
                              className="shrink-0 border border-secondary px-2 py-1 label-caps transition-colors hover:border-brand hover:text-brand"
                            >
                              Copy
                            </button>
                          )}
                        </div>
                        <p className="label-caps mb-2 text-brand">
                          With this memo
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 break-all font-mono text-sm text-foreground">
                            {status?.depositMemo || '—'}
                          </code>
                          {status?.depositMemo && (
                            <button
                              type="button"
                              onClick={() =>
                                handleCopy(status.depositMemo, 'Deposit memo')
                              }
                              className="shrink-0 border border-secondary px-2 py-1 label-caps transition-colors hover:border-brand hover:text-brand"
                            >
                              Copy
                            </button>
                          )}
                        </div>
                      </div>

                      <p className="type-caption">
                        The memo is how the agent matches the deposit to
                        your account. Hedera mirror nodes can lag a few
                        seconds behind the actual transfer — you can force
                        a re-check anytime from the freshness ribbon above.{' '}
                        <button
                          type="button"
                          onClick={() => setTopUpOpen(true)}
                          className="text-brand underline-offset-2 hover:underline"
                        >
                          Open the full top-up panel
                        </button>{' '}
                        for wallet-specific instructions.
                      </p>

                      {/* What happens after — mental model breadcrumb.
                          The old 3-step stepper taught "Fund → Play →
                          Withdraw" at a glance. Replacing it with just
                          the Get Started block lost that structural
                          teaching. This line restores it in narrative
                          form: the user learns the loop from one
                          sentence instead of a numbered ribbon. */}
                      <p className="border-t border-secondary/40 pt-3 type-caption text-muted">
                        <span className="label-caps mr-2">What&apos;s next</span>
                        Once funded, the agent starts playing on its own
                        schedule. Wins land in the Pending Claim panel
                        below for you to collect on the dApp. You can
                        cash out your balance or manually nudge a play
                        anytime.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

          </ComicPanel>
          </ErrorBoundary>
        )}

        {/* ---- Agent details — inline narrative line ─────────
            Previously this was a four-metric grid (Strategy / Rake
            / Deposited / Rake paid) that had become the exact
            "SaaS metrics bar" anti-pattern I'd just removed from
            the hero. Collapsed to an inline caption-style line
            that reads like a footnote rather than a dashboard
            row. Same information, zero metric-grid shape.
            The Top up link is inline too, not a chip. */}
        {status && hasPlayableBalance && (
          <div className="mb-12 border-t border-secondary/40 pt-4 sm:px-2">
            <p className="type-caption num-tabular leading-relaxed">
              <span className="label-caps mr-2">Agent</span>
              <span className="text-foreground">{status.strategyName}</span>
              {' strategy · '}
              <span className="text-foreground">{status.rakePercent}%</span>
              {' rake · '}
              <span className="text-foreground">{totalDeposited}</span>
              {' deposited lifetime · '}
              <span className="text-foreground">{totalRakePaid}</span>
              {' paid in rake · '}
              <button
                type="button"
                onClick={() => setTopUpOpen(true)}
                className="text-brand underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                Top up ↗
              </button>
            </p>
            <p className="mt-1 type-caption text-muted">
              Rake covers gas and infrastructure. The agent plays autonomously on a schedule — you can also nudge it manually from the hero above.
            </p>
          </div>
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

          {/* ---- Pending Claim panel ───────────────────────────
               Shows prizes the user has won via the agent that are
               currently sitting in the LazyLotto contract waiting
               for them to claim from their EOA. Sourced from
               /api/user/prize-status which queries the dApp MCP.

               IMPORTANT user-education: prizes are NOT held in the
               agent's internal balance. The agent's hero pot is for
               funds the user has deposited for the agent to spend.
               When the user wins, the dApp contract reassigns the
               prize to their EOA, but no HBAR/tokens/NFTs actually
               move on Hedera until the user clicks Claim on the
               dApp themselves. This panel is the dashboard's
               primary place to make that distinction visible.

               Render rules:
                 - Hide entirely until prizeStatus is non-null
                 - If available=false, hide (soft failure)
                 - If pending count = 0 AND total claimed = 0, hide
                   (clean slate, no need to confuse with empty data)
                 - Otherwise render with pending front and centre,
                   claimed as a smaller historical readout
               --- */}
          {prizeStatus &&
            prizeStatus.available &&
            (prizeStatus.pending.count > 0 ||
              Object.keys(prizeStatus.claimed.byToken).length > 0 ||
              prizeStatus.claimed.nftCount > 0) && (
            <ErrorBoundary label="Pending claim">
            <div ref={prizeClaimRef}>
            <ComicPanel label="PRIZE CLAIM" halftone="none">
              <div className="px-5 pt-6 pb-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="mb-2 flex items-baseline gap-3">
                      <p className="label-caps-brand-lg">
                        Pending claim
                      </p>
                      {prizeFreshness && (
                        <span className="label-caps text-muted">
                          updated {prizeFreshness}
                        </span>
                      )}
                    </div>
                    <h2 className="heading-1 text-foreground">
                      {prizeStatus.pending.count > 0
                        ? 'Waiting for you on the dApp'
                        : 'Nothing to claim right now'}
                    </h2>
                    <p className="mt-2 max-w-prose text-sm text-muted">
                      Prizes from the agent are held by the LazyLotto
                      contract. Your agent pot above is your{' '}
                      <em>play money</em> — prizes never go into it.
                      To collect what you&apos;ve won, claim them on
                      the dApp with the same wallet you signed in
                      with.
                    </p>
                  </div>
                  {prizeStatus.pending.count > 0 && (
                    <a
                      href={DAPP_CLAIM_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-primary-sm shrink-0"
                    >
                      Claim on dApp →
                    </a>
                  )}
                </div>

                {/* Pending breakdown — only when there's actually
                    something pending. Tokens listed first, NFT
                    count after. */}
                {prizeStatus.pending.count > 0 && (
                  <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-brand/20 pt-4">
                    {Object.entries(prizeStatus.pending.byToken).map(
                      ([token, amount]) => (
                        <div key={token}>
                          <p className="label-caps mb-1">
                            {tokenSymbol(token)}
                          </p>
                          <p className="num-tabular type-body text-brand">
                            {formatAmount(amount)}
                          </p>
                        </div>
                      ),
                    )}
                    {prizeStatus.pending.nftCount > 0 && (
                      <div>
                        <p className="label-caps mb-1">NFTs</p>
                        <p className="num-tabular type-body text-brand">
                          {prizeStatus.pending.nftCount}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Claimed historical totals — derived from
                    (totalWon - pending), shown as a smaller second
                    row so users can see lifetime context. Only
                    rendered if there's anything claimed at all. */}
                {(Object.keys(prizeStatus.claimed.byToken).length > 0 ||
                  prizeStatus.claimed.nftCount > 0) && (
                  <div className="mt-4 border-t border-secondary/40 pt-3">
                    <p className="label-caps mb-1.5 text-muted">
                      Already claimed
                    </p>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                      {Object.entries(prizeStatus.claimed.byToken).map(
                        ([token, amount]) => (
                          <span key={token} className="num-tabular">
                            {formatAmount(amount)} {tokenSymbol(token)}
                          </span>
                        ),
                      )}
                      {prizeStatus.claimed.nftCount > 0 && (
                        <span className="num-tabular">
                          {prizeStatus.claimed.nftCount} NFT
                          {prizeStatus.claimed.nftCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </ComicPanel>
            </div>
            </ErrorBoundary>
          )}

          {/* ---- Play History — wrapped as a ComicPanel so the
               vocabulary carries from the hero to the rest of the
               page. Halftone "none" because it's data-dense and a
               textured background would compete with the rows. The
               "RECENT PLAYS" corner sticker echoes the ISSUE #001
               label on the hero so the two panels feel like a
               continuous run.

               FUTURE WORK (tracked in the design critique): once
               users accumulate ~50+ sessions, the log view becomes
               unwieldy and a SUMMARY view becomes more useful —
               cumulative spent/won/net over rolling windows (week,
               month, lifetime), win-rate sparklines, strategy-change
               markers, best/worst session callouts. The P&L strip
               at the top already computes totals across all sessions;
               a future pass would split this panel into a toggleable
               "Summary | Log" tab pair, with Summary as the default
               for users with >50 sessions. ---- */}
          <ErrorBoundary label="Recent plays">
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

            {/* ---- Header + narrative P&L ----
                The P&L strip used to be a three-metric grid (Spent /
                Won / Net) that was the last metric-grid anti-pattern
                left in the dashboard after the hero reform. Collapsed
                to a narrative sentence — same information, no grid
                shape. The net amount keeps its semantic colour
                (success/destructive) as an inline span so users can
                spot whether they're up or down at a glance.
                Future work: at >50 sessions, split this panel into
                a Summary / Log tab pair with cumulative rolling
                windows + win-rate sparklines (noted above the panel). */}
            <div className="px-5 pb-4 pt-6">
              <div className="mb-2 flex items-baseline gap-3">
                <p className="label-caps-lg">Play log</p>
                {historyFreshness && (
                  <span className="label-caps text-muted">
                    updated {historyFreshness}
                  </span>
                )}
              </div>
              <h2 className="heading-1 mb-3 text-foreground">
                Recent agent sessions
              </h2>
              {perfSummary && sessions.length > 0 && (
                <p className="type-body text-muted">
                  Across {sessions.length} session{sessions.length === 1 ? '' : 's'}:{' '}
                  spent{' '}
                  <span className="num-tabular text-foreground">
                    {formatAmount(perfSummary.totalSpentAll)} {perfSummary.primaryToken}
                  </span>
                  , won{' '}
                  <span className="num-tabular text-foreground">
                    {formatAmount(perfSummary.totalWonAll)} {perfSummary.primaryToken}
                  </span>
                  .{' '}
                  {perfSummary.net >= 0 ? (
                    <>
                      Up{' '}
                      <span className="num-tabular font-semibold text-success">
                        {formatAmount(perfSummary.net)} {perfSummary.primaryToken}
                      </span>
                      .
                    </>
                  ) : (
                    <>
                      Down{' '}
                      <span className="num-tabular font-semibold text-destructive">
                        {formatAmount(Math.abs(perfSummary.net))} {perfSummary.primaryToken}
                      </span>
                      .
                    </>
                  )}
                </p>
              )}
            </div>

            {/* ---- Timeline ---- */}
            <div className="border-t border-brand/20">
              {historyLoading ? (
                <HistorySkeleton />
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
                          {/* Header row: timestamp in pixel font + win/spent readout.
                              The "+X won" headline used to read like a balance credit,
                              which confused users into thinking the agent had received
                              the prize for them. Reframed: "X won" with no sign + a
                              "claim on dApp" subtitle so the user knows the prize is
                              waiting for them in the contract, not in their pot. */}
                          <div className="mb-2 flex items-start justify-between gap-3">
                            <span className="font-pixel text-[10px] uppercase tracking-wider text-muted">
                              {formatTimestamp(s.timestamp)}
                            </span>
                            <div className="flex flex-col items-end">
                              <span
                                className={`num-tabular heading-2 ${
                                  isWin ? 'text-brand' : 'text-muted'
                                }`}
                              >
                                {isWin
                                  ? `${formatAmount(s.totalPrizeValue)} won`
                                  : `${formatAmount(s.totalSpent)} spent`}
                              </span>
                              {isWin && (
                                <span className="font-pixel text-[10px] uppercase tracking-wider text-muted">
                                  claim on dApp
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Pool badges — sharp corners, pixel-font */}
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {s.poolResults.map((pr) => (
                              <span
                                key={pr.poolId}
                                className="border border-secondary bg-[var(--color-panel)] px-2 py-0.5 font-pixel text-[10px] uppercase tracking-wider text-muted"
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
          </ErrorBoundary>
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

      {/* ── Withdraw modal ─────────────────────────────────────
          Self-contained component (extracted to ./WithdrawModal.tsx
          during the #212 refactor). The dashboard owns the form
          state because the post-submit balance patch lives in
          handleWithdraw, not the modal. */}
      <WithdrawModal
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        status={status}
        withdrawToken={withdrawToken}
        setWithdrawToken={setWithdrawToken}
        withdrawAmount={withdrawAmount}
        setWithdrawAmount={setWithdrawAmount}
        withdrawLoading={withdrawLoading}
        onSubmit={handleWithdraw}
        balanceEntries={balanceEntries}
      />
    </div>
  );
}
