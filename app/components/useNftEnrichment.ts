'use client';

/**
 * useNftEnrichment — client hook for lazy NFT prize enrichment.
 *
 * Progressive enhancement pattern:
 *
 *   1. Components render NFT cards immediately with raw { token, hederaId, serial }
 *      from the fast-path history/audit response.
 *   2. This hook hydrates a cached enrichment map from sessionStorage (SWR)
 *      so repeat page visits render enriched cards instantly.
 *   3. In parallel, it fires POST /api/user/enrich-nfts in the background for
 *      any refs not already resolved.
 *   4. When the response arrives, the map grows. Components upgrade in place.
 *   5. If enrichment fails, the hook surfaces an error + retry function and
 *      leaves any previously-resolved entries intact (no flicker).
 *
 * Design invariants:
 *   - Never resets resolved entries to empty — once an NFT is enriched it stays.
 *   - Dedupes refs by `${hederaId}!${serial}` so duplicates cost nothing.
 *   - Empty ref lists don't trigger fetches or state changes.
 *   - sessionStorage cache is keyed by the sorted ref set hash; different pages
 *     with different NFT sets get independent cache entries but overlapping
 *     NFTs share resolutions automatically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrizeNftRef, EnrichedPrizeNft } from './PrizeNftCard';

interface EnrichmentState {
  data: Map<string, EnrichedPrizeNft>;
  loading: boolean;
  error: string | null;
}

export interface UseNftEnrichmentResult extends EnrichmentState {
  /** Manually retry a failed enrichment. Safe to call anytime. */
  retry: () => void;
}

function keyFor(hederaId: string, serial: number): string {
  return `${hederaId}!${serial}`;
}

// ── SessionStorage cache (per browser tab) ─────────────────────

const SESSION_CACHE_KEY = 'lazylotto:nft-enrichment-cache';

function loadCacheFromSession(): Map<string, EnrichedPrizeNft> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.sessionStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return new Map();
    const entries = JSON.parse(raw) as Array<[string, EnrichedPrizeNft]>;
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveCacheToSession(cache: Map<string, EnrichedPrizeNft>): void {
  if (typeof window === 'undefined') return;
  try {
    const entries = Array.from(cache.entries());
    window.sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded or disabled — fail silently
  }
}

// ── Hook ───────────────────────────────────────────────────────

export function useNftEnrichment(refs: PrizeNftRef[]): UseNftEnrichmentResult {
  // Dedupe refs by key; empty array if nothing valid
  const uniqueRefs = useMemo(() => {
    const seen = new Map<string, PrizeNftRef>();
    for (const r of refs) {
      if (!r || !r.hederaId || r.serial == null) continue;
      seen.set(keyFor(r.hederaId, r.serial), r);
    }
    return Array.from(seen.values());
  }, [refs]);

  // Stable dep key — only triggers re-fetch when the set of refs changes
  const depKey = useMemo(
    () => uniqueRefs.map((r) => keyFor(r.hederaId, r.serial)).sort().join('|'),
    [uniqueRefs],
  );

  // Initialize state from sessionStorage so repeat visits show enriched
  // cards instantly. The useRef keeps the initial map stable across renders.
  const initialCacheRef = useRef<Map<string, EnrichedPrizeNft> | null>(null);
  if (initialCacheRef.current === null) {
    initialCacheRef.current = loadCacheFromSession();
  }

  const [state, setState] = useState<EnrichmentState>(() => ({
    data: initialCacheRef.current ?? new Map(),
    loading: false,
    error: null,
  }));

  // Track fetch attempts for manual retry
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  useEffect(() => {
    if (uniqueRefs.length === 0) {
      // Don't wipe the existing data — just mark as not loading.
      // An empty ref list means "nothing to enrich right now", not
      // "discard what you had". Prevents flicker on re-renders.
      setState((prev) => ({ ...prev, loading: false, error: null }));
      return;
    }

    // Figure out which refs still need to be fetched.
    // Anything already in state.data (from sessionStorage or previous fetch)
    // doesn't need to be re-resolved.
    const needed: PrizeNftRef[] = [];
    for (const r of uniqueRefs) {
      if (!state.data.has(keyFor(r.hederaId, r.serial))) {
        needed.push(r);
      }
    }

    // All refs already cached — nothing to do
    if (needed.length === 0) {
      setState((prev) => ({ ...prev, loading: false, error: null }));
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const run = async () => {
      try {
        const token =
          typeof window !== 'undefined'
            ? window.localStorage.getItem('lazylotto:sessionToken')
            : null;
        if (!token) {
          setState((prev) => ({ ...prev, loading: false, error: 'Not authenticated' }));
          return;
        }

        const res = await fetch('/api/user/enrich-nfts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ refs: needed }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Enrichment failed (${res.status}): ${body.slice(0, 120)}`);
        }

        const body = (await res.json()) as { enriched?: EnrichedPrizeNft[] };
        if (cancelled) return;

        setState((prev) => {
          // Merge new enrichments into the existing map (don't replace)
          const merged = new Map(prev.data);
          for (const e of body.enriched ?? []) {
            merged.set(keyFor(e.hederaId, e.serial), e);
          }
          // Persist to sessionStorage so next page visit is instant
          saveCacheToSession(merged);
          return { data: merged, loading: false, error: null };
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[useNftEnrichment]', message);
        // Keep existing data — only surface the error for the refs that failed
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, retryNonce]);

  return { data: state.data, loading: state.loading, error: state.error, retry };
}
