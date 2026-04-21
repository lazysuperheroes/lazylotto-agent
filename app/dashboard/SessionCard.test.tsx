/**
 * Dashboard SessionCard — RTL component tests.
 *
 * Locks in the per-token display invariants that shipped on
 * 2026-04-21. Every numeric should carry a token tag; NFT-only wins
 * should render as "NFT won" (not a bare "0 won"); legacy records
 * without spentByToken should fall back to { HBAR: totalSpent }.
 *
 * Coverage:
 *   - Zero-win session shows "N HBAR spent" (text-muted, no CTA)
 *   - Winning session shows "N HBAR won" + "claim on dApp" subtitle
 *   - Multi-token win joins with " + " and skips zero-value buckets
 *   - NFT-only win renders "NFT won" instead of "0 won"
 *   - Legacy record (no spentByToken) falls back to { HBAR: totalSpent }
 *   - Stats row SPENT matches the header readout (no divergent display)
 *   - Pool badges render one per pool
 *   - Fungible prize row renders when any prize has a fungibleAmount
 *   - NFT prize cards are hidden when there are no NFT refs
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { SessionCard } from './SessionCard';
import type { PlaySession } from './types';
import type { EnrichedPrizeNft } from '../components/PrizeNftCard';

afterEach(() => cleanup());

const emptyEnrichedMap = new Map<string, EnrichedPrizeNft>();

function makeSession(overrides: Partial<PlaySession> = {}): PlaySession {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    timestamp: '2026-04-21T15:59:00.000Z',
    strategyName: 'balanced',
    strategyVersion: '1.0.0',
    boostBps: 0,
    poolsEvaluated: 4,
    poolsPlayed: 2,
    poolResults: [
      {
        poolId: 4,
        poolName: 'POOL #4 HARD MODE',
        entriesBought: 2,
        amountSpent: 15,
        rolled: true,
        wins: 0,
        prizeDetails: [],
      },
      {
        poolId: 5,
        poolName: 'EASY STREET',
        entriesBought: 2,
        amountSpent: 15,
        rolled: true,
        wins: 0,
        prizeDetails: [],
      },
    ],
    totalSpent: 30,
    spentByToken: { HBAR: 30 },
    totalWins: 0,
    totalPrizeValue: 0,
    prizesByToken: {},
    prizesTransferred: false,
    gasCostHbar: 0,
    amountReserved: 30,
    amountSettled: 30,
    amountReleased: 0,
    ...overrides,
  };
}

describe('Dashboard SessionCard — losing session', () => {
  it('renders "30 HBAR spent" in the header for a zero-win session', () => {
    render(
      <SessionCard
        session={makeSession()}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText('30 HBAR spent')).toBeInTheDocument();
  });

  it('does NOT show the "claim on dApp" subtitle for a losing session', () => {
    render(
      <SessionCard
        session={makeSession()}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.queryByText(/claim on dApp/i)).not.toBeInTheDocument();
  });

  it('shows every pool name as a chip', () => {
    render(
      <SessionCard
        session={makeSession()}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText('POOL #4 HARD MODE')).toBeInTheDocument();
    expect(screen.getByText('EASY STREET')).toBeInTheDocument();
  });

  it('stats row Entries counts pool entriesBought', () => {
    // 2 + 2 = 4 entries across the two pools. Stats row shows it next
    // to the "Entries" small-caps label.
    const { container } = render(
      <SessionCard
        session={makeSession()}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    // Find the Entries cell via its label-caps span and check the
    // adjacent numeric value. Using the raw DOM because RTL's
    // getByText would match both "Entries" and the numeric.
    const statsRow = container.querySelector('.flex-wrap.gap-x-5');
    expect(statsRow).toBeTruthy();
    expect(within(statsRow as HTMLElement).getByText('4')).toBeInTheDocument();
  });

  it('stats row Spent matches the header readout (no divergence)', () => {
    render(
      <SessionCard
        session={makeSession({ spentByToken: { HBAR: 30 } })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    // Header shows "30 HBAR spent", stats shows "30 HBAR" — both
    // derived from the same spentParts string.
    const matches = screen.getAllByText(/30 HBAR/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Dashboard SessionCard — winning session', () => {
  it('renders "17.5 HBAR won" for a fungible HBAR win', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 2,
          totalPrizeValue: 17.5,
          prizesByToken: { HBAR: 17.5 },
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText('17.5 HBAR won')).toBeInTheDocument();
  });

  it('shows the "claim on dApp" subtitle on winning sessions', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 1,
          totalPrizeValue: 5,
          prizesByToken: { HBAR: 5 },
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText(/claim on dApp/i)).toBeInTheDocument();
  });

  it('joins multi-token wins with " + "', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 2,
          totalPrizeValue: 15,
          prizesByToken: { HBAR: 10, LAZY: 5 },
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText('10 HBAR + 5 LAZY won')).toBeInTheDocument();
  });

  it('drops zero-value buckets from the won line', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 1,
          totalPrizeValue: 10,
          prizesByToken: { HBAR: 10, LAZY: 0 },
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText('10 HBAR won')).toBeInTheDocument();
    expect(screen.queryByText(/LAZY/)).not.toBeInTheDocument();
  });

  it('renders "NFT won" for NFT-only wins (not "0 won")', () => {
    // The regression this locks in: a session where totalWins > 0 but
    // totalPrizeValue === 0 (because wins were all NFTs) used to
    // render "0 won" in the header, which reads as a loss. Now it
    // says "NFT won" so the user knows something was won even though
    // there's no fungible amount to display.
    render(
      <SessionCard
        session={makeSession({
          totalWins: 1,
          totalPrizeValue: 0,
          prizesByToken: {},
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText('NFT won')).toBeInTheDocument();
    expect(screen.queryByText('0 won')).not.toBeInTheDocument();
  });

  it('shows the Wins stat on the stats row', () => {
    const { container } = render(
      <SessionCard
        session={makeSession({
          totalWins: 3,
          totalPrizeValue: 17.5,
          prizesByToken: { HBAR: 17.5 },
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    const statsRow = container.querySelector('.flex-wrap.gap-x-5');
    expect(statsRow).toBeTruthy();
    expect(within(statsRow as HTMLElement).getByText('3')).toBeInTheDocument();
  });
});

describe('Dashboard SessionCard — legacy record fallback', () => {
  it('synthesizes { HBAR: totalSpent } when spentByToken is missing', () => {
    // Pre-v2 records (persisted before 2026-04-21) lack spentByToken.
    // The card should still render a clean "44 HBAR spent" — no bare
    // number leak, no undefined access.
    const legacy = makeSession({
      totalSpent: 44,
      spentByToken: undefined,
    });
    render(
      <SessionCard
        session={legacy}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.getByText('44 HBAR spent')).toBeInTheDocument();
  });

  it('handles totalSpent === 0 without crashing (phantom 0-entry sessions)', () => {
    // The 5 Apr 10:45 phantom session in the local store (legitimate
    // session-open that bailed before any pool qualified) has 0 spend.
    // Render should still succeed with "0 HBAR spent".
    render(
      <SessionCard
        session={makeSession({
          totalSpent: 0,
          spentByToken: undefined,
          poolResults: [],
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    // When spentMap has a 0 bucket, parts is empty, so fallback kicks
    // in and renders the "0 HBAR spent" form.
    expect(screen.getByText('0 HBAR spent')).toBeInTheDocument();
  });
});

describe('Dashboard SessionCard — fungible prize row', () => {
  it('renders the "Prizes" row when any pool has a fungibleAmount', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 2,
          totalPrizeValue: 17.5,
          prizesByToken: { HBAR: 17.5 },
          poolResults: [
            {
              poolId: 1,
              poolName: 'Pool A',
              entriesBought: 4,
              amountSpent: 20,
              rolled: true,
              wins: 2,
              prizeDetails: [
                { fungibleAmount: 7.5, fungibleToken: 'HBAR' },
                { fungibleAmount: 10, fungibleToken: 'HBAR' },
              ],
            },
          ],
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    // Prizes row preserves each prize separately, not an aggregate.
    // "7.5 HBAR + 10 HBAR" matches what users saw in the screenshot.
    expect(screen.getByText('Prizes')).toBeInTheDocument();
    expect(screen.getByText('7.5 HBAR + 10 HBAR')).toBeInTheDocument();
  });

  it('omits the Prizes row when all prizes are NFT-only', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 1,
          totalPrizeValue: 0,
          prizesByToken: {},
          poolResults: [
            {
              poolId: 1,
              poolName: 'Pool A',
              entriesBought: 1,
              amountSpent: 5,
              rolled: true,
              wins: 1,
              prizeDetails: [
                {
                  nftCount: 1,
                  nfts: [{ token: 'LSH', hederaId: '0.0.123', serial: 42 }],
                },
              ],
            },
          ],
        })}
        enrichedMap={emptyEnrichedMap}
        enrichmentLoading={false}
      />,
    );
    expect(screen.queryByText('Prizes')).not.toBeInTheDocument();
  });
});
