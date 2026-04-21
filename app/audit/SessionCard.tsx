'use client';

/**
 * SessionCard — single v2 NormalizedSession rendered as an expandable
 * audit card.
 *
 * The face shows the operator's signed close-message claim (or the v1
 * totals via the reader's fallback); clicking expands to show open +
 * per-pool detail + warnings if any.
 *
 * Extracted from app/audit/page.tsx on 2026-04-21 so the component
 * can be tested in isolation with RTL. All the pure formatting logic
 * (statusLabel, statusBadgeClasses, formatByToken, prizeTransferLabel,
 * formatTimestamp) lives in ./helpers — this file only handles the
 * stateful expand/collapse + JSX.
 *
 * Status badge colours:
 *   closed_success  → brand gold (won) or success green (played)
 *   closed_aborted  → destructive red
 *   in_flight       → info blue
 *   orphaned        → destructive red
 *   corrupt         → destructive red with uppercase CORRUPT label
 */

import { useState } from 'react';
import type { V2NormalizedSession } from './types';
import {
  formatAmount,
  formatByToken,
  formatTimestamp,
  prizeTransferLabel,
  statusBadgeClasses,
  statusLabel,
} from './helpers';

export interface SessionCardProps {
  session: V2NormalizedSession;
  /** HashScan link to the HCS-20 topic (optional — shown when expanded). */
  explorerUrl?: string;
}

export function SessionCard({ session, explorerUrl }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isWin = session.totalWins > 0;

  return (
    <div className="border border-l-4 border-secondary border-l-brand bg-[var(--color-panel)]">
      {/* Card face — the always-visible summary */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left p-4 transition-colors hover:bg-brand/5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${statusBadgeClasses(session.status)}`}>
                {statusLabel(session.status)}
              </span>
              <span className="text-xs text-muted">
                {session.openedAt ? formatTimestamp(session.openedAt) : '—'}
              </span>
              {session.strategy && (
                <span className="text-xs text-muted">· {session.strategy}</span>
              )}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="text-foreground">
                Spent{' '}
                <span className="num-tabular text-info">
                  {/* Per-token spend (HBAR for native, 0.0.X for FTs).
                      Multi-token sessions render as "X HBAR + Y LAZY"
                      so the cross-token sum (session.totalSpent) is
                      never shown unlabeled. Falls back to a bare
                      formatAmount for the edge case where the reader
                      produced totalSpent but no per-token breakdown
                      (shouldn't happen for v2, but v1 fallback sets
                      totalSpentByToken={HBAR: totalSpent}). */}
                  {Object.keys(session.totalSpentByToken).length > 0
                    ? formatByToken(session.totalSpentByToken)
                    : `${formatAmount(session.totalSpent)} HBAR`}
                </span>
              </span>
              {isWin && (
                <span className="text-foreground">
                  Won{' '}
                  <span className="num-tabular text-brand">
                    {Object.keys(session.totalPrizeValueByToken).length > 0
                      ? `+${formatByToken(session.totalPrizeValueByToken)}`
                      : `+${formatAmount(session.totalPrizeValue)} HBAR`}
                  </span>
                  {session.totalNftCount > 0 && (
                    <span className="ml-1 text-muted">+ {session.totalNftCount} NFT{session.totalNftCount === 1 ? '' : 's'}</span>
                  )}
                </span>
              )}
              <span className="text-xs text-muted">
                {session.pools.length} pool{session.pools.length === 1 ? '' : 's'}
              </span>
            </div>
            {/* Prize transfer status (the field that would have made
                the 668 HBAR stuck-prize incident self-explanatory) */}
            {session.prizeTransfer && (
              <p className={`mt-1 text-xs ${prizeTransferLabel(session.prizeTransfer.status).className}`}>
                Prize delivery: {prizeTransferLabel(session.prizeTransfer.status).text}
                {session.prizeTransfer.txId && (
                  <span className="ml-1 type-caption-sm font-mono text-muted">
                    {session.prizeTransfer.txId}
                  </span>
                )}
              </p>
            )}
            {/* Warnings (corrupt sessions, mismatches) */}
            {session.warnings.length > 0 && (
              <ul className="mt-1 space-y-0.5 type-caption-sm text-destructive">
                {session.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
          </div>
          <span className="text-xs text-muted shrink-0">
            {expanded ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {/* Expanded detail — only mounted when open */}
      {expanded && (
        <div className="border-t border-secondary px-4 py-3 text-xs text-muted space-y-3">
          {/* Open metadata */}
          <div>
            <p className="text-foreground/60 mb-1">Session opened</p>
            <p className="font-mono break-all">{session.sessionId}</p>
            <p>
              User: <code className="font-mono">{session.user}</code>
              {session.agent && (
                <span className="ml-2">
                  Agent: <code className="font-mono">{session.agent}</code>
                </span>
              )}
            </p>
            {session.openedAt && (
              <p>Opened: {formatTimestamp(session.openedAt)}</p>
            )}
            {session.closedAt && (
              <p>Closed: {formatTimestamp(session.closedAt)}</p>
            )}
            <p>
              Sequence: #{session.firstSeq}
              {session.lastSeq !== session.firstSeq && ` – #${session.lastSeq}`}
              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 text-brand hover:underline"
                >
                  View topic on HashScan ↗
                </a>
              )}
            </p>
          </div>

          {/* Per-pool breakdown */}
          {session.pools.length > 0 && (
            <div>
              <p className="text-foreground/60 mb-1">Pools played</p>
              <div className="space-y-1.5">
                {session.pools.map((pool) => (
                  <div key={pool.seq} className="flex items-center justify-between gap-2 border-l-2 border-secondary px-2 py-1">
                    <div>
                      <span className="text-foreground/80">Pool #{pool.poolId}</span>
                      <span className="ml-2">{pool.entries} entries</span>
                      <span className="ml-2 text-info">{formatAmount(pool.spent)} {pool.spentToken}</span>
                    </div>
                    {pool.wins > 0 && (
                      <div className="text-right">
                        <span className="text-brand">{pool.wins} win{pool.wins === 1 ? '' : 's'}</span>
                        {pool.prizes.length > 0 && (
                          <div className="text-[10px] text-muted">
                            {pool.prizes.map((p, i) => {
                              if (p.t === 'ft') {
                                return <span key={i} className="ml-1">+{formatAmount(p.amt)} {p.tk}</span>;
                              }
                              return <span key={i} className="ml-1">+{p.ser.length} {p.sym} NFT{p.ser.length === 1 ? '' : 's'} (#{p.ser.join(', #')})</span>;
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Close: prize transfer details */}
          {session.prizeTransfer && (
            <div>
              <p className="text-foreground/60 mb-1">Prize delivery</p>
              <p className={prizeTransferLabel(session.prizeTransfer.status).className}>
                {prizeTransferLabel(session.prizeTransfer.status).text}
              </p>
              {session.prizeTransfer.txId && (
                <p className="font-mono break-all text-[10px]">{session.prizeTransfer.txId}</p>
              )}
              {session.prizeTransfer.attempts != null && (
                <p>Attempts: {session.prizeTransfer.attempts}{session.prizeTransfer.gasUsed != null && ` · Gas: ${session.prizeTransfer.gasUsed.toLocaleString()}`}</p>
              )}
              {session.prizeTransfer.lastError && (
                <p className="text-destructive">Error: {session.prizeTransfer.lastError}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
