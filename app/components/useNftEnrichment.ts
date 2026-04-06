'use client';

/**
 * useNftEnrichment — client hook for lazy NFT prize enrichment.
 *
 * Takes a flat list of PrizeNftRef (the raw { token, hederaId, serial }
 * captured at win time) and fetches full display metadata in the background
 * via POST /api/user/enrich-nfts. Returns a Map keyed by "${hederaId}!${serial}"
 * along with loading and error state.
 *
 * The component renders its NFT cards with the raw refs immediately, passes
 * `loading` during the background fetch, then swaps in the enriched data as
 * it arrives. No blocking spinner — progressive enhancement.
 *
 * Deduplicates by key so passing the same NFT multiple times only costs
 * one lookup per unique NFT per page view.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PrizeNftRef, EnrichedPrizeNft } from './PrizeNftCard';

interface EnrichmentState {
  data: Map<string, EnrichedPrizeNft>;
  loading: boolean;
  error: string | null;
}

function keyFor(ref: PrizeNftRef): string {
  return `${ref.hederaId}!${ref.serial}`;
}

export function useNftEnrichment(refs: PrizeNftRef[]): EnrichmentState {
  // Dedupe refs by key so we don't fire duplicate requests
  const uniqueRefs = useMemo(() => {
    const seen = new Map<string, PrizeNftRef>();
    for (const r of refs) {
      if (!r || !r.hederaId || r.serial == null) continue;
      seen.set(keyFor(r), r);
    }
    return Array.from(seen.values());
  }, [refs]);

  // Stable key for the effect dependency — only re-runs if the set of refs changes
  const depKey = useMemo(
    () => uniqueRefs.map(keyFor).sort().join('|'),
    [uniqueRefs],
  );

  const [state, setState] = useState<EnrichmentState>({
    data: new Map(),
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (uniqueRefs.length === 0) {
      setState({ data: new Map(), loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const run = async () => {
      try {
        const token =
          typeof window !== 'undefined'
            ? localStorage.getItem('lazylotto:sessionToken')
            : null;
        if (!token) {
          setState({ data: new Map(), loading: false, error: 'Not authenticated' });
          return;
        }

        const res = await fetch('/api/user/enrich-nfts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ refs: uniqueRefs }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Enrichment failed (${res.status}): ${body.slice(0, 120)}`);
        }

        const body = (await res.json()) as { enriched?: EnrichedPrizeNft[] };
        if (cancelled) return;

        const map = new Map<string, EnrichedPrizeNft>();
        for (const e of body.enriched ?? []) {
          map.set(`${e.hederaId}!${e.serial}`, e);
        }

        setState({ data: map, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[useNftEnrichment]', message);
        setState({ data: new Map(), loading: false, error: message });
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);

  return state;
}
