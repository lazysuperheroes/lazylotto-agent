'use client';

import { useState } from 'react';
import { CharacterMascot } from './CharacterMascot';
import { GoldConfetti } from '../components/GoldConfetti';
import type { LshCharacter } from '../lib/characters';

// ---------------------------------------------------------------------------
// CompleteView — post-sign-in success state with progressive disclosure
// ---------------------------------------------------------------------------
//
// Replaces a ~400-line tangle of two branches (returning user vs new user)
// that each inlined a copy of the same machinery — success header, Claude
// connection URL + copy button, JSON config toggle, "how to connect" step
// guide, example commands, session management (lock/disconnect), dashboard
// CTA. The only real difference was whether the new-user branch wrapped
// the URL block in a three-step guide.
//
// The critique:
//   "First-time users get overwhelmed; returning users get a slightly
//    different version of the same overwhelm. The complete-state UX is
//    doing too much teaching at the wrong moment."
//
// Fix: ONE view. Primary CTA is always "Go to Dashboard". The Claude
// integration (URL, copy, JSON config, step guide, example commands)
// lives behind a "Connect to Claude AI? Show how →" disclosure that
// starts collapsed. Users who want the MCP flow click once to expand;
// users who just want to use the dashboard aren't blocked by a
// 6-paragraph integration tour.
//
// Returning users get the same view — they've seen all this before
// and don't need the teaching material shoved back in their face.
// The disclosure remembers its expanded state for THIS session via
// a simple useState (not localStorage — we don't want a user who
// expanded it once to always see the expanded form).
//
// Shared sub-components extracted:
//   - SuccessHeader     (mascot + h2 + accountId chip)
//   - ClaudeIntegration (URL + copy + JSON toggle + instructions + commands)
//   - SessionManagement (lock/disconnect controls)

interface CompleteViewProps {
  character: LshCharacter;
  successTagline: string;
  rerollCharacter: () => void;
  accountId: string;
  /** True when the user just re-authenticated (had a prior session). */
  isReturning: boolean;
  /** Full URL with ?key= suffix for MCP client config. */
  connectionUrl: string;
  /** JSON blob for Claude Desktop config. */
  claudeConfig: string;
  /** ISO timestamp of session expiry, or empty string if locked/unknown. */
  expiresAt: string;
  /** True when the session token has been locked (permanent). */
  locked: boolean;
  /** True when the user is actively confirming the lock action. */
  lockConfirming: boolean;
  setLockConfirming: (value: boolean) => void;
  /** True while the lock request is in flight. */
  locking: boolean;
  /** Fires the lock API call. */
  onLock: () => void | Promise<void>;
  /** Tears down the session and returns to /auth. */
  onDisconnect: () => void;
  /** Copies text to clipboard + fires the confirmation toast. */
  onCopy: (text: string, label?: string) => void | Promise<void>;
  /** Dashboard/admin redirect target. */
  ctaTarget: string;
  /** Label for the primary CTA ("Go to Dashboard" / "Go to Admin"). */
  ctaLabel: string;
  /** Navigates to the CTA target. */
  onPrimaryAction: () => void;
}

// ── Shared sub-components ──────────────────────────────────────

function SuccessHeader({
  character,
  successTagline,
  rerollCharacter,
  accountId,
  isReturning,
}: {
  character: LshCharacter;
  successTagline: string;
  rerollCharacter: () => void;
  accountId: string;
  isReturning: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <CharacterMascot
        key={character.name}
        character={character}
        size="sm"
        line={successTagline}
        onReroll={rerollCharacter}
      />
      <h2 className="font-heading text-xl text-success">
        {isReturning ? 'Re-authenticated' : 'Authenticated'}
      </h2>
      {/* Sharp-cornered bordered chip to match the dashboard's account
          identity block + the AuthFlow already-auth treatment. Previous
          rounded-full pill shape broke the sharp-corner vocabulary the
          rest of the app commits to. Only the status dot stays circular
          (2×2 indicator dots should be round). */}
      <span className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-3 py-2 text-sm text-foreground">
        <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
        <code className="font-mono">{accountId}</code>
      </span>
    </div>
  );
}

function ClaudeIntegration({
  connectionUrl,
  claudeConfig,
  onCopy,
}: {
  connectionUrl: string;
  claudeConfig: string;
  onCopy: (text: string, label?: string) => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [showJsonConfig, setShowJsonConfig] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <p className="type-caption">
        Paste this URL into Claude AI or Claude Desktop as a custom MCP
        connector. The agent handles everything — pool selection,
        entries, prize transfer.
      </p>

      {/* Connection URL */}
      <div className="border-2 border-secondary bg-[var(--color-panel)] px-4 py-3">
        <p className="break-all font-mono text-sm text-brand">{connectionUrl}</p>
      </div>

      <button
        type="button"
        onClick={async () => {
          await onCopy(connectionUrl, 'Connection URL');
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="btn-primary-sm w-full"
      >
        {copied ? (
          <>
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            Copied!
          </>
        ) : (
          'Copy Connection URL'
        )}
      </button>

      {/* Claude Desktop config toggle */}
      <button
        type="button"
        onClick={() => setShowJsonConfig((prev) => !prev)}
        className="text-left text-xs text-brand underline transition-colors hover:text-brand/80"
      >
        {showJsonConfig ? 'Hide Claude Desktop config' : 'Show Claude Desktop config (JSON)'}
      </button>
      {showJsonConfig && (
        <div className="relative border-2 border-secondary bg-[var(--color-panel)] p-4">
          <pre className="break-all whitespace-pre-wrap font-mono text-xs text-brand">
            {claudeConfig}
          </pre>
          <button
            type="button"
            onClick={() => void onCopy(claudeConfig, 'Claude config')}
            className="absolute right-2 top-2 rounded border border-secondary px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            Copy
          </button>
        </div>
      )}

      {/* How to connect — compact, no numbered steps */}
      <div className="border-l-2 border-brand/40 bg-brand/5 px-4 py-3 type-caption">
        <p className="mb-2 font-semibold text-foreground">How to connect</p>
        <ul className="flex flex-col gap-1.5">
          <li className="flex gap-2">
            <span className="text-brand/60" aria-hidden="true">
              •
            </span>
            <span>
              Claude AI: Settings → Integrations → Add custom MCP → paste URL
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand/60" aria-hidden="true">
              •
            </span>
            <span>
              Claude Desktop: Settings → MCP Servers → Add → paste URL or config
            </span>
          </li>
        </ul>
      </div>

      {/* Example commands — compact chips, no section header */}
      <div className="flex flex-wrap gap-2" aria-label="Example commands">
        {[
          'Register me for LazyLotto',
          'Show my deposit info',
          'Play a lottery session',
          'Check my balance',
        ].map((cmd) => (
          <button
            key={cmd}
            type="button"
            onClick={() => void onCopy(cmd, 'Command')}
            className="cursor-pointer border border-secondary bg-[var(--color-panel)] px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:border-brand hover:text-brand"
            title="Click to copy"
            aria-label={`Copy command: ${cmd}`}
          >
            {cmd}
          </button>
        ))}
      </div>
    </div>
  );
}

function SessionManagement({
  locked,
  lockConfirming,
  setLockConfirming,
  locking,
  onLock,
  onDisconnect,
  expiresAt,
}: {
  locked: boolean;
  lockConfirming: boolean;
  setLockConfirming: (value: boolean) => void;
  locking: boolean;
  onLock: () => void | Promise<void>;
  onDisconnect: () => void;
  expiresAt: string;
}) {
  const relativeExpiry = expiresAt
    ? (() => {
        const diff = new Date(expiresAt).getTime() - Date.now();
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        if (days > 1) return `in ${days} days`;
        const hours = Math.floor(diff / (1000 * 60 * 60));
        if (hours > 1) return `in ${hours} hours`;
        return 'soon';
      })()
    : '';

  if (locked) {
    return (
      <p className="text-center text-sm text-muted">
        API key is permanent.{' '}
        <button
          type="button"
          onClick={onDisconnect}
          className="text-muted underline transition-colors hover:text-foreground"
        >
          Disconnect
        </button>
      </p>
    );
  }

  if (lockConfirming) {
    return (
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-xs text-muted">
          A permanent key never expires. If compromised, re-authenticate here to
          revoke it.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void onLock()}
            disabled={locking}
            className="btn-primary-sm"
          >
            {locking ? 'Locking…' : 'Confirm — Make Permanent'}
          </button>
          <button
            type="button"
            onClick={() => setLockConfirming(false)}
            className="text-xs text-muted underline transition-colors hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <p className="text-center text-sm text-muted">
      {expiresAt ? `Session expires ${relativeExpiry}. ` : ''}
      <button
        type="button"
        onClick={() => setLockConfirming(true)}
        className="text-brand underline transition-colors hover:text-brand/80"
      >
        Make permanent
      </button>
      {' or '}
      <button
        type="button"
        onClick={onDisconnect}
        className="text-muted underline transition-colors hover:text-foreground"
      >
        Disconnect
      </button>
    </p>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function CompleteView(props: CompleteViewProps) {
  const [showClaudeIntegration, setShowClaudeIntegration] = useState(false);

  return (
    <div className="relative flex flex-col gap-6">
      {/* Gold confetti celebration */}
      <GoldConfetti />

      <SuccessHeader
        character={props.character}
        successTagline={props.successTagline}
        rerollCharacter={props.rerollCharacter}
        accountId={props.accountId}
        isReturning={props.isReturning}
      />

      {/* Primary CTA — always first, always unambiguous. Returning users
          and first-time users alike see "Go to Dashboard" as the obvious
          next step. The MCP integration guide is NOT part of the primary
          path; users who don't need Claude integration should never see it. */}
      <button
        type="button"
        onClick={props.onPrimaryAction}
        className="btn-primary-sm w-full"
      >
        {props.ctaLabel} →
      </button>

      {/* Claude AI integration — collapsed by default. Expanding it reveals
          the connection URL, copy button, JSON config toggle, how-to-connect
          guide, and example commands — all the machinery that used to be
          shoved in the user's face. The disclosure puts the user in charge
          of whether they want the teaching content. */}
      <div className="border-t border-secondary/40 pt-5">
        <button
          type="button"
          onClick={() => setShowClaudeIntegration((v) => !v)}
          aria-expanded={showClaudeIntegration}
          aria-controls="claude-integration-panel"
          className="flex w-full items-center justify-between text-sm text-brand transition-colors hover:text-foreground"
        >
          <span className="font-semibold">
            {showClaudeIntegration
              ? 'Hide Claude integration'
              : 'Connect to Claude AI? Show how →'}
          </span>
          <span
            className={`font-pixel text-[10px] transition-transform ${
              showClaudeIntegration ? 'rotate-90' : ''
            }`}
            aria-hidden="true"
          >
            ▸
          </span>
        </button>
        {showClaudeIntegration && (
          <div id="claude-integration-panel" className="mt-4">
            <ClaudeIntegration
              connectionUrl={props.connectionUrl}
              claudeConfig={props.claudeConfig}
              onCopy={props.onCopy}
            />
          </div>
        )}
      </div>

      <SessionManagement
        locked={props.locked}
        lockConfirming={props.lockConfirming}
        setLockConfirming={props.setLockConfirming}
        locking={props.locking}
        onLock={props.onLock}
        onDisconnect={props.onDisconnect}
        expiresAt={props.expiresAt}
      />
    </div>
  );
}
