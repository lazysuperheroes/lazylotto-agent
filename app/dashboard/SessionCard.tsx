'use client';

/**
 * Dashboard SessionCard — one row in the "Recent agent sessions"
 * play log.
 *
 * Extracted from app/dashboard/page.tsx on 2026-04-21 so the
 * component can be tested in isolation with RTL. Prior to extraction
 * the render lived inline inside a 2000-line page component, which
 * made it effectively untestable.
 *
 * What it renders:
 *   - Timestamp in pixel font (left) + win/spent readout (right)
 *   - Pool-name chips
 *   - Stats row: entries count, per-token spend, win count
 *   - When the session won: fungible prize summary + NFT prize cards
 *     (the latter enriched via the parent's useNftEnrichment map)
 *
 * Key display invariants this component is responsible for:
 *   - Every numeric always carries a token tag ("30 HBAR spent", never
 *     bare "30"). Per-token spend uses spentByToken when present and
 *     falls back to { HBAR: totalSpent } for legacy v0/v1 records.
 *   - Wins use prizesByToken for multi-token joining; bare-number
 *     totalPrizeValue is the fallback. NFT-only wins (totalWins > 0
 *     but totalPrizeValue === 0) render as "NFT won" instead of the
 *     previous "0 won" which read as a loss.
 *   - The "claim on dApp" subtitle only shows on winning sessions so
 *     users know the prize is waiting for them in the contract, not
 *     in their agent balance.
 */

import type { PlaySession } from './types';
import { formatAmount, formatTimestamp } from './helpers';
import {
  PrizeNftCard,
  type EnrichedPrizeNft,
} from '../components/PrizeNftCard';

export interface SessionCardProps {
  session: PlaySession;
  /**
   * Map of enriched NFT metadata keyed by `${hederaId}!${serial}`.
   * The parent (`app/dashboard/page.tsx`) owns the enrichment state
   * via `useNftEnrichment` and passes the map down so all session
   * cards share one fetch pool rather than each firing their own.
   */
  enrichedMap: Map<string, EnrichedPrizeNft>;
  /** True while enrichment is in flight — drives PrizeNftCard loading state. */
  enrichmentLoading: boolean;
}

export function SessionCard({ session: s, enrichedMap, enrichmentLoading }: SessionCardProps) {
  const isWin = s.totalWins > 0;
  const entryCount = s.poolResults.reduce(
    (sum, pr) => sum + pr.entriesBought,
    0,
  );

  // Build a per-token win summary from prizesByToken (e.g. "7.5 HBAR
  // + 10 HBAR" or "5 LAZY") so the header never shows a bare,
  // unlabeled number. Falls back to totalPrizeValue + HBAR for the
  // edge case where prizesByToken is empty but totalPrizeValue is set
  // (legacy records). Empty/zero entries are filtered so a 0-HBAR
  // bucket doesn't leak into the display. NFT-only wins surface
  // through the "NFT won" fallback and the prize cards below.
  const winTokenParts: string[] = [];
  for (const [token, amount] of Object.entries(s.prizesByToken ?? {})) {
    if (!amount) continue;
    winTokenParts.push(`${formatAmount(amount)} ${token}`);
  }
  const wonDisplay = winTokenParts.length > 0
    ? `${winTokenParts.join(' + ')} won`
    : s.totalPrizeValue > 0
      ? `${formatAmount(s.totalPrizeValue)} HBAR won`
      : 'NFT won';

  // Per-token spend display (v2+). Legacy records (pre-2026-04-21)
  // don't carry spentByToken, so fall back to { HBAR: totalSpent } —
  // pre-v2 spend is HBAR-only by construction. Multi-token sessions
  // render as "30 HBAR + 5 LAZY spent".
  const spentParts: string[] = [];
  const spentMap = s.spentByToken ?? { HBAR: s.totalSpent };
  for (const [token, amount] of Object.entries(spentMap)) {
    if (!amount) continue;
    spentParts.push(`${formatAmount(amount)} ${token}`);
  }
  const spentDisplay = spentParts.length > 0
    ? `${spentParts.join(' + ')} spent`
    : '0 HBAR spent';

  return (
    <li
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
            {isWin ? wonDisplay : spentDisplay}
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
            {/* Reuses the per-token spent string built above so the
                stats row and the header readout never disagree about
                what was spent. */}
            {spentParts.length > 0
              ? spentParts.join(' + ')
              : `${formatAmount(s.totalSpent)} HBAR`}
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
}
