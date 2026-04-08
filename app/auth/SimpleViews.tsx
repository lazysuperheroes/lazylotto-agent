'use client';

import Image from 'next/image';
import { CharacterMascot } from './CharacterMascot';
import { LoadingMascot } from '../components/LoadingMascot';
import { networkLabel, pickRandom, type Network } from './walletConnect';
import type { LshCharacter } from '../lib/characters';

// ---------------------------------------------------------------------------
// Simple AuthFlow views
// ---------------------------------------------------------------------------
//
// Three small render branches extracted from AuthFlow during the L2 split.
// Each is a pure presentational component that takes a handful of props
// — no hooks, no state. The big CompleteView remains inline in
// AuthFlow.tsx because it needs ~20 props (mcpUrl, sessionToken, lock
// state, the lock/disconnect handlers, ...) and the prop-drilling cost
// would dwarf the readability win. Treating that as a future task.
//
// Pulling these three out gets the ComicPanel render block down from
// six deeply-nested branches to three local + one inline (CompleteView)
// + the already-extracted CharacterMascot + the always-on loading
// spinner. Diff-friendly when adjusting any single state's UI.

// ── LandingView ─────────────────────────────────────────────────

export interface LandingViewProps {
  network: Network;
  character: LshCharacter;
  rerollCharacter: () => void;
  onConnect: () => void;
}

export function LandingView({
  network,
  character,
  rerollCharacter,
  onConnect,
}: LandingViewProps) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <Image
        src="https://docs.lazysuperheroes.com/logo.svg"
        alt="LazyLotto"
        width={240}
        height={80}
        className="h-20 w-auto"
        priority
        unoptimized
      />

      <div className="flex items-center gap-2">
        <h1 className="font-heading text-2xl text-foreground">
          LazyLotto Agent
        </h1>
        <span className="rounded bg-brand px-2 py-0.5 text-xs text-background">
          {networkLabel(network)}
        </span>
      </div>

      {/* Character mascot with shimmer placeholder */}
      <CharacterMascot
        key={character.name}
        character={character}
        size="lg"
        line={pickRandom(character.taglines)}
        onReroll={rerollCharacter}
      />

      <p className="text-sm text-muted">
        Sign a message to prove wallet ownership and receive your MCP
        connection credentials. No transaction is submitted and no funds
        are spent.
      </p>

      <button
        type="button"
        onClick={onConnect}
        className="btn-primary-sm w-full"
      >
        Connect Wallet
      </button>

      <p className="text-sm text-muted">
        Supports HashPack, Blade, and other Hedera wallets via
        WalletConnect.
      </p>
    </div>
  );
}

// ── ConnectingView ──────────────────────────────────────────────

export interface ConnectingViewProps {
  /** 'connecting' = pre-signature, 'signing' = signature request in flight. */
  phase: 'connecting' | 'signing';
  accountId: string;
}

export function ConnectingView({ phase, accountId }: ConnectingViewProps) {
  // Two phase pools — connecting is "nudging the wallet awake",
  // signing is "waiting for you to confirm". Both use the shared
  // LoadingMascot so the character is the loading indicator
  // instead of a generic spinner. The copy is product-specific,
  // not AI-filler ("Herding pixels" et al).
  const phaseLines =
    phase === 'connecting'
      ? [
          'Waking your wallet up…',
          'Shaking hands with your wallet…',
          'Talking to your wallet…',
        ]
      : [
          'Waiting on your signature…',
          'One signature, please — approve in your wallet.',
          'Your wallet is asking — tap approve when you see it.',
        ];

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <Image
        src="https://docs.lazysuperheroes.com/logo.svg"
        alt="LazyLotto"
        width={240}
        height={80}
        className="h-20 w-auto"
        priority
        unoptimized
      />

      {accountId && (
        // Sharp-cornered bordered chip matching the dashboard +
        // AuthFlow already-auth treatment. See CompleteView for the
        // rationale on dropping rounded-full pill shapes.
        <span className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-3 py-2 text-sm text-foreground">
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
          <code className="font-mono">{accountId}</code>
        </span>
      )}

      {/* LoadingMascot absorbs the previous spinner + phase text +
          "Please approve" help line into one character-voiced
          moment. The line pool is phase-aware so 'connecting' and
          'signing' get different copy, but the shape stays the same. */}
      <LoadingMascot lines={phaseLines} />
    </div>
  );
}

// ── ErrorView ───────────────────────────────────────────────────

export interface ErrorViewProps {
  error: string;
  onRetry: () => void;
}

export function ErrorView({ error, onRetry }: ErrorViewProps) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <Image
        src="https://docs.lazysuperheroes.com/logo.svg"
        alt="LazyLotto"
        width={240}
        height={80}
        className="h-20 w-auto"
        priority
        unoptimized
      />

      <p className="type-body text-destructive">{error}</p>

      <button type="button" onClick={onRetry} className="btn-ghost-sm">
        Try again
      </button>
    </div>
  );
}
