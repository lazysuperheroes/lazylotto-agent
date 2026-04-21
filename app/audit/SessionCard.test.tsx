/**
 * SessionCard — RTL component tests.
 *
 * The per-token spent/won rendering and the "Played" status label
 * were the two biggest UX regressions we closed on 2026-04-21. This
 * test file locks them in at the render level (the helpers tests
 * already cover the pure-function side).
 *
 * Coverage:
 *   - closed_success session renders the "Played" badge (not "Closed")
 *   - HBAR-only session shows "30 HBAR" not a bare "30"
 *   - Multi-token session shows "30 HBAR + 5 LAZY" (no cross-token sum)
 *   - Zero-win session omits the "Won" column
 *   - NFT-count annotation appears when totalNftCount > 0
 *   - Prize transfer status line renders with the right wording
 *   - Warnings render with the warning emoji prefix
 *   - Expand/collapse toggles the detail panel (aria-expanded flips)
 *   - Per-pool breakdown shows spent + wins + prizes when expanded
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { SessionCard } from './SessionCard';
import type { V2NormalizedSession } from './types';

afterEach(() => cleanup());

// Minimal session shape factory — keeps each test readable by only
// naming the fields that matter for that assertion. Defaults describe
// a typical single-pool, single-token, zero-win closed session so the
// happy path renders cleanly without further setup.
function makeSession(overrides: Partial<V2NormalizedSession> = {}): V2NormalizedSession {
  return {
    sessionId: 'c25f21d6-775f-4d5a-a388-742cd6136397',
    user: '0.0.2119',
    agent: '0.0.8456987',
    status: 'closed_success',
    strategy: 'balanced',
    boostBps: 0,
    openedAt: '2026-04-21T15:59:00.000Z',
    closedAt: '2026-04-21T15:59:30.000Z',
    pools: [
      { poolId: 4, seq: 1, entries: 2, spent: 15, spentToken: 'HBAR', wins: 0, prizes: [], ts: '2026-04-21T15:59:10.000Z' },
      { poolId: 5, seq: 2, entries: 2, spent: 15, spentToken: 'HBAR', wins: 0, prizes: [], ts: '2026-04-21T15:59:20.000Z' },
    ],
    totalSpent: 30,
    totalSpentByToken: { HBAR: 30 },
    totalWins: 0,
    totalPrizeValue: 0,
    totalPrizeValueByToken: {},
    totalNftCount: 0,
    prizeTransfer: { status: 'skipped' },
    warnings: [],
    firstSeq: 64,
    lastSeq: 67,
    ...overrides,
  };
}

describe('SessionCard status badge', () => {
  it('renders "Played" for closed_success (not "Closed")', () => {
    render(<SessionCard session={makeSession({ status: 'closed_success' })} />);
    expect(screen.getByText('Played')).toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  });

  it('renders "Aborted" for closed_aborted', () => {
    render(<SessionCard session={makeSession({ status: 'closed_aborted' })} />);
    expect(screen.getByText('Aborted')).toBeInTheDocument();
  });

  it('renders "CORRUPT" in uppercase for corrupt sessions', () => {
    render(<SessionCard session={makeSession({ status: 'corrupt' })} />);
    expect(screen.getByText('CORRUPT')).toBeInTheDocument();
  });
});

describe('SessionCard per-token Spent display', () => {
  it('renders "30 HBAR" for HBAR-only sessions (never a bare "30")', () => {
    render(<SessionCard session={makeSession({ totalSpentByToken: { HBAR: 30 } })} />);
    // "Spent" label and "30 HBAR" value are adjacent — match the value.
    expect(screen.getByText('30 HBAR')).toBeInTheDocument();
  });

  it('renders "30 HBAR + 5 LAZY" for mixed-token sessions', () => {
    render(
      <SessionCard
        session={makeSession({
          totalSpentByToken: { HBAR: 30, LAZY: 5 },
          totalSpent: 35,
        })}
      />,
    );
    expect(screen.getByText('30 HBAR + 5 LAZY')).toBeInTheDocument();
  });

  it('drops zero-value token buckets from the Spent line', () => {
    render(
      <SessionCard
        session={makeSession({
          totalSpentByToken: { HBAR: 30, LAZY: 0 },
        })}
      />,
    );
    expect(screen.getByText('30 HBAR')).toBeInTheDocument();
    expect(screen.queryByText(/LAZY/)).not.toBeInTheDocument();
  });

  it('falls back to "{total} HBAR" when totalSpentByToken is empty', () => {
    // Edge case: reader produced totalSpent but no per-token map
    // (shouldn't happen for v2, but v1 fallback path). Card should
    // still show a labelled amount rather than a bare number.
    render(
      <SessionCard
        session={makeSession({ totalSpent: 30, totalSpentByToken: {} })}
      />,
    );
    expect(screen.getByText('30 HBAR')).toBeInTheDocument();
  });
});

describe('SessionCard Won column', () => {
  it('hides the Won column for zero-win sessions', () => {
    render(<SessionCard session={makeSession({ totalWins: 0 })} />);
    expect(screen.queryByText(/^Won /)).not.toBeInTheDocument();
  });

  it('renders "+17.5 HBAR" when the session won fungible prizes', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 2,
          totalPrizeValue: 17.5,
          totalPrizeValueByToken: { HBAR: 17.5 },
        })}
      />,
    );
    expect(screen.getByText('+17.5 HBAR')).toBeInTheDocument();
  });

  it('joins multiple prize tokens with " + "', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 3,
          totalPrizeValue: 15,
          totalPrizeValueByToken: { HBAR: 10, LAZY: 5 },
        })}
      />,
    );
    expect(screen.getByText('+10 HBAR + 5 LAZY')).toBeInTheDocument();
  });

  it('appends NFT count annotation when totalNftCount > 0', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 1,
          totalPrizeValue: 0,
          totalPrizeValueByToken: {},
          totalNftCount: 2,
        })}
      />,
    );
    expect(screen.getByText(/2 NFTs/)).toBeInTheDocument();
  });

  it('uses singular "NFT" when totalNftCount is 1', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 1,
          totalNftCount: 1,
          totalPrizeValue: 0,
          totalPrizeValueByToken: {},
        })}
      />,
    );
    expect(screen.getByText(/^\+\s*1 NFT$/)).toBeInTheDocument();
  });
});

describe('SessionCard prize transfer status', () => {
  it('labels skipped as "Nothing to deliver"', () => {
    render(<SessionCard session={makeSession({ prizeTransfer: { status: 'skipped' } })} />);
    expect(screen.getByText(/Nothing to deliver/)).toBeInTheDocument();
  });

  it('labels succeeded as "Delivered to your wallet"', () => {
    render(
      <SessionCard
        session={makeSession({
          prizeTransfer: { status: 'succeeded', txId: '0.0.8456987@1775622515.5645332' },
        })}
      />,
    );
    expect(screen.getByText(/Delivered to your wallet/)).toBeInTheDocument();
    // The tx id appears twice (card face + expanded section) — just check at least one
    expect(screen.getAllByText('0.0.8456987@1775622515.5645332').length).toBeGreaterThan(0);
  });

  it('labels failed with destructive wording', () => {
    render(
      <SessionCard
        session={makeSession({
          prizeTransfer: { status: 'failed', lastError: 'INSUFFICIENT_GAS' },
        })}
      />,
    );
    expect(screen.getByText(/Delivery failed/)).toBeInTheDocument();
  });

  it('omits the prize transfer line when prizeTransfer is undefined', () => {
    render(<SessionCard session={makeSession({ prizeTransfer: undefined })} />);
    expect(screen.queryByText(/Prize delivery:/)).not.toBeInTheDocument();
  });
});

describe('SessionCard warnings', () => {
  it('renders each warning with a warning prefix', () => {
    render(
      <SessionCard
        session={makeSession({
          warnings: [
            'v1 legacy session — wins not tracked on chain (this is a pre-migration session)',
            'poolsRoot mismatch',
          ],
        })}
      />,
    );
    expect(screen.getByText(/v1 legacy session/)).toBeInTheDocument();
    expect(screen.getByText(/poolsRoot mismatch/)).toBeInTheDocument();
    // Both items should have the warning emoji (⚠) prefix
    const warningText = screen.getAllByText(/⚠/);
    expect(warningText.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SessionCard expand/collapse', () => {
  it('starts collapsed (aria-expanded=false)', () => {
    render(<SessionCard session={makeSession()} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands on click and shows the detail panel', () => {
    render(<SessionCard session={makeSession()} />);
    const toggle = screen.getByRole('button');
    // Detail-section text not visible before click
    expect(screen.queryByText('Session opened')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Session opened')).toBeInTheDocument();
    expect(screen.getByText('Pools played')).toBeInTheDocument();
  });

  it('shows per-pool breakdown with spent + spentToken when expanded', () => {
    render(
      <SessionCard
        session={makeSession({
          pools: [
            {
              poolId: 7,
              seq: 1,
              entries: 3,
              spent: 25,
              spentToken: 'HBAR',
              wins: 1,
              prizes: [{ t: 'ft', tk: 'HBAR', amt: 10 }],
              ts: '2026-04-21T15:59:10.000Z',
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Pool #7')).toBeInTheDocument();
    expect(screen.getByText('3 entries')).toBeInTheDocument();
    expect(screen.getByText('25 HBAR')).toBeInTheDocument();
    expect(screen.getByText('1 win')).toBeInTheDocument();
    expect(screen.getByText('+10 HBAR')).toBeInTheDocument();
  });

  it('renders NFT prize details with serial list when expanded', () => {
    render(
      <SessionCard
        session={makeSession({
          totalWins: 1,
          totalNftCount: 2,
          pools: [
            {
              poolId: 3,
              seq: 1,
              entries: 1,
              spent: 5,
              spentToken: 'HBAR',
              wins: 1,
              prizes: [{ t: 'nft', tk: '0.0.123', sym: 'LSH', ser: [42, 99] }],
              ts: '2026-04-21T15:59:10.000Z',
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText(/\+2 LSH NFTs/)).toBeInTheDocument();
    // Serials listed with "#" prefix each
    expect(screen.getByText(/#42, #99/)).toBeInTheDocument();
  });

  it('shows the HashScan explorer link when explorerUrl is provided and expanded', () => {
    render(
      <SessionCard
        session={makeSession()}
        explorerUrl="https://hashscan.io/testnet/topic/0.0.8499866"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    const link = screen.getByRole('link', { name: /HashScan/ });
    expect(link).toHaveAttribute('href', 'https://hashscan.io/testnet/topic/0.0.8499866');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
