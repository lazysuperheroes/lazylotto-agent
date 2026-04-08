'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { LedgerId } from '@hashgraph/sdk';
import { DAppConnector } from '@hashgraph/hedera-wallet-connect/dist/lib/dapp';
import {
  HederaJsonRpcMethod,
  HederaSessionEvent,
} from '@hashgraph/hedera-wallet-connect/dist/lib/shared';
import Image from 'next/image';
import { useToast } from '../components/Toast';
import { GoldConfetti } from '../components/GoldConfetti';
import { ComicPanel } from '../components/ComicPanel';
import { CharacterMascot } from './CharacterMascot';
import {
  LSH_CHARACTERS,
  loadOrPickCharacterIdx,
  persistCharacterIdx,
  randomCharacterIdx,
} from '../lib/characters';
import { clearSession } from '../lib/session';
import {
  CHAIN_IDS,
  PROJECT_IDS,
  getNetworkFromUrl,
  networkLabel,
  pickRandom,
  type Network,
} from './walletConnect';
import { ConnectingView, ErrorView, LandingView } from './SimpleViews';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthStatus =
  | 'loading'
  | 'already-auth'
  | 'landing'
  | 'connecting'
  | 'signing'
  | 'complete'
  | 'error';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuthFlow() {
  const router = useRouter();
  const { toast } = useToast();

  // ----- state -----
  // All localStorage-derived values are kept in state and populated in
  // useEffects so SSR-rendered HTML matches client hydration.
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [accountId, setAccountId] = useState<string>('');
  const [storedAccountId, setStoredAccountId] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [mcpUrl, setMcpUrl] = useState<string>('');
  const [savedMcpUrl, setSavedMcpUrl] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [savedExpiry, setSavedExpiry] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockConfirming, setLockConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showJsonConfig, setShowJsonConfig] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [tier, setTier] = useState<string>('');

  // ----- Persistent character mascot -----
  // Start with a deterministic 0 during SSR so the rendered HTML
  // matches the client's first paint, then rehydrate from localStorage
  // in the mount useEffect below.
  const [characterIdx, setCharacterIdx] = useState<number>(0);

  useEffect(() => {
    setCharacterIdx(loadOrPickCharacterIdx());
  }, []);

  const character = LSH_CHARACTERS[characterIdx]!;

  const rerollCharacter = useCallback(() => {
    const newIdx = randomCharacterIdx();
    setCharacterIdx(newIdx);
    persistCharacterIdx(newIdx);
  }, []);

  const dappConnector = useRef<DAppConnector | null>(null);
  const network = useRef<Network>('testnet');

  // ----- Check localStorage on mount -----
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    const acctId = localStorage.getItem('lazylotto:accountId');
    if (token && acctId) {
      // Check if the stored expiry has already passed — if so, treat as
      // logged out so the user re-authenticates instead of seeing a stale
      // "Welcome back" with an unusable token.
      const expiry = localStorage.getItem('lazylotto:expiresAt');
      const isLockedSession = localStorage.getItem('lazylotto:locked') === 'true';
      if (!isLockedSession && expiry) {
        const expiresAtMs = new Date(expiry).getTime();
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
          // Expired — purge and show landing with a hint
          clearSession();
          toast('Your session expired — please re-authenticate');
          setStatus('landing');
          return;
        }
      }

      setStoredAccountId(acctId);
      setSessionToken(token);
      setMcpUrl(localStorage.getItem('lazylotto:mcpUrl')?.split('?')[0] ?? '');
      setSavedMcpUrl(localStorage.getItem('lazylotto:mcpUrl') ?? '');
      setSavedExpiry(expiry);
      setLocked(isLockedSession);
      setTier(localStorage.getItem('lazylotto:tier') ?? '');
      setStatus('already-auth');
    } else {
      // Check for expired hint from a redirect
      const params = new URLSearchParams(window.location.search);
      if (params.get('expired') === '1') {
        toast('Your session expired — please re-authenticate');
      }
      setStatus('landing');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived values for the CTA — read from state, not localStorage
  const isAdminTier = tier === 'admin' || tier === 'operator';
  const ctaTarget = isAdminTier ? '/admin' : '/dashboard';
  const ctaLabel = isAdminTier ? 'Go to Admin' : 'Go to Dashboard';

  // ----- WalletConnect init -----
  const initWalletConnect = useCallback(async () => {
    const net = getNetworkFromUrl();
    network.current = net;

    const metadata = {
      name: `LazyLotto Agent (${networkLabel(net)})`,
      description: 'Authenticate with the LazyLotto Agent',
      icons: ['https://docs.lazysuperheroes.com/favicon.svg'],
      url: window.location.origin,
    };

    const connector = new DAppConnector(
      metadata,
      LedgerId.fromString(net),
      PROJECT_IDS[net],
      Object.values(HederaJsonRpcMethod),
      [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
      [CHAIN_IDS[net]],
    );

    try {
      await connector.init({ logger: 'debug' });
    } catch (initError) {
      console.warn(
        '[AuthFlow] Init failed (likely stale session), clearing and retrying:',
        initError,
      );
      try {
        await connector.disconnectAll?.();
      } catch {
        /* ignore disconnect errors */
      }
      await connector.init({ logger: 'debug' });
    }

    dappConnector.current = connector;
  }, []);

  useEffect(() => {
    void initWalletConnect();
    return () => {
      // disconnectAll() rejects with "no active session/pairing" when
      // the user is unmounting AuthFlow without ever having paired
      // (e.g. navigating /auth → /dashboard after an existing session
      // was picked up from localStorage without re-pairing). The `void`
      // operator only discards the return value — it does NOT catch
      // promise rejections — so the rejected promise becomes an
      // unhandled rejection and Next.js dev overlay screams.
      //
      // Wrap in an IIFE with `await` inside a try/catch so the
      // rejection is caught properly. No action needed on failure —
      // this cleanup is best-effort.
      void (async () => {
        try {
          await dappConnector.current?.disconnectAll?.();
        } catch {
          /* no active pairing on unmount — expected */
        }
      })();
    };
  }, [initWalletConnect]);

  // ----- Connect wallet -----
  const connectWallet = useCallback(async (): Promise<string> => {
    const connector = dappConnector.current;
    if (!connector) throw new Error('WalletConnect not initialized');

    await connector.openModal();

    const signer = connector.signers[0];
    if (!signer) throw new Error('No signer returned after connection');

    const acctId = signer.getAccountId().toString();
    if (!acctId) throw new Error('Wallet did not return an account ID');

    return acctId;
  }, []);

  // ----- Full auth flow -----
  const handleAuth = useCallback(async () => {
    setError('');

    // Detect returning user before clearing session
    const hadPreviousSession = !!localStorage.getItem('lazylotto:sessionToken');
    setIsReturning(hadPreviousSession);

    try {
      // 1. Connect wallet
      setStatus('connecting');
      const acctId = await connectWallet();
      setAccountId(acctId);

      // 2. Request challenge
      setStatus('signing');
      const challengeRes = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: acctId }),
      });

      if (!challengeRes.ok) {
        const body = await challengeRes.text();
        throw new Error(`Challenge request failed: ${body}`);
      }

      const { challengeId, message } = (await challengeRes.json()) as {
        challengeId: string;
        message: string;
      };

      // 3. Sign challenge with wallet
      const connector = dappConnector.current;
      if (!connector) throw new Error('WalletConnect not initialized');

      const signerAccountId = `hedera:${network.current}:${acctId}`;
      const signResult = await connector.signMessage({
        signerAccountId,
        message,
      });

      const r = signResult as unknown as Record<string, unknown>;
      const signatureMapBase64 =
        ((r.result as Record<string, unknown>)?.signatureMap as
          | string
          | undefined) ?? (r.signatureMap as string | undefined);

      if (!signatureMapBase64) {
        console.error(
          '[AuthFlow] signMessage result:',
          JSON.stringify(signResult),
        );
        throw new Error('Wallet did not return a signatureMap');
      }

      // 4. Verify signature
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId,
          accountId: acctId,
          signatureMapBase64,
        }),
      });

      if (!verifyRes.ok) {
        const body = await verifyRes.text();
        throw new Error(`Verification failed: ${body}`);
      }

      const verified = (await verifyRes.json()) as {
        sessionToken: string;
        mcpUrl: string;
        tier: string;
        expiresAt: string;
      };

      // 5. Store to localStorage
      localStorage.setItem('lazylotto:sessionToken', verified.sessionToken);
      localStorage.setItem('lazylotto:accountId', acctId);
      localStorage.setItem('lazylotto:tier', verified.tier);

      // Store the connection URL so already-auth state can show it later
      const fullUrl = `${verified.mcpUrl}?key=${verified.sessionToken}`;
      localStorage.setItem('lazylotto:mcpUrl', fullUrl);
      if (verified.expiresAt) localStorage.setItem('lazylotto:expiresAt', verified.expiresAt);

      // 6. Complete — also update tier state so the post-verify CTA renders
      // the correct destination without reading localStorage during render.
      setSessionToken(verified.sessionToken);
      setMcpUrl(verified.mcpUrl);
      setExpiresAt(verified.expiresAt);
      setTier(verified.tier);
      setStatus('complete');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);

      if (
        message.includes('reject') ||
        message.includes('denied') ||
        message.includes('cancel') ||
        message.includes('User rejected') ||
        message.includes('declined')
      ) {
        setError('Wallet signature was rejected. Please try again.');
      } else {
        setError(message);
      }

      setStatus('error');
    }
  }, [connectWallet]);

  // ----- Copy to clipboard -----
  const handleCopy = useCallback(
    async (text: string, label?: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(label ? `${label} copied` : 'Copied to clipboard');
      } catch {
        /* clipboard not available */
      }
    },
    [toast],
  );

  // ----- Lock API key -----
  const handleLock = useCallback(async () => {
    if (!sessionToken || locked || locking) return;
    setLocking(true);

    try {
      const res = await fetch('/api/auth/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Lock failed: ${body}`);
      }

      setLocked(true);
      setExpiresAt('');
      setLockConfirming(false);
      localStorage.setItem('lazylotto:locked', 'true');
      localStorage.removeItem('lazylotto:expiresAt');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLocking(false);
    }
  }, [sessionToken, locked, locking]);

  // ----- Re-authenticate (clear stored session) -----
  const handleReauthenticate = useCallback(() => {
    clearSession();
    setStoredAccountId('');
    setShowUrl(false);
    setStatus('landing');
  }, []);

  // ----- Disconnect -----
  const handleDisconnect = useCallback(() => {
    try {
      void dappConnector.current?.disconnectAll?.();
    } catch {
      /* ignore */
    }
    clearSession();
    setStatus('landing');
    setAccountId('');
    setSessionToken('');
    setError('');
    setMcpUrl('');
    setExpiresAt('');
    setLocked(false);
    setLocking(false);
    setLockConfirming(false);
    setShowUrl(false);
  }, []);

  // ----- Claude Desktop JSON config -----
  const claudeConfig = sessionToken
    ? JSON.stringify(
        {
          mcpServers: {
            'lazylotto-agent': {
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${sessionToken}`,
              },
            },
          },
        },
        null,
        2,
      )
    : '';

  // ----- Computed values -----
  const net = typeof window !== 'undefined' ? getNetworkFromUrl() : 'testnet';
  const isConnecting = status === 'connecting' || status === 'signing';

  // CharacterMascot is now its own component (app/auth/CharacterMascot.tsx)
  // with state-based loading shimmer and error fallback. We pass character
  // through as a prop and key it on character.name so React remounts
  // — and the loading state resets — when the user rerolls.

  // ======================================================================
  // RENDER
  // ======================================================================

  return (
    <div className="flex flex-1 items-start justify-center px-4 pt-16 lg:pt-24">
      <div className="w-full max-w-xl">
        <ComicPanel
          label={status === 'already-auth' ? 'WELCOME BACK' : 'ISSUE #00'}
          tone={status === 'error' ? 'destructive' : 'gold'}
          halftone={status === 'already-auth' ? 'none' : 'dense'}
        >
          <div className="p-8">
          {/* ---- LOADING ---- */}
          {status === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-brand" />
            </div>
          )}

          {/* ---- ALREADY AUTHENTICATED ---- */}
          {status === 'already-auth' && (() => {
            // All values from state — no localStorage reads in render
            const savedUrl = savedMcpUrl;
            const isLocked = locked;
            const expiryLabel = isLocked
              ? 'permanent'
              : savedExpiry
                ? (() => {
                    const days = Math.floor((new Date(savedExpiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    return days > 1 ? `expires in ${days} days` : days === 1 ? 'expires tomorrow' : 'expiring soon';
                  })()
                : 'active';

            return (
              <div className="flex flex-col items-center gap-6 text-center">
                {/* Character mascot (persistent) */}
                <CharacterMascot
                  key={character.name}
                  character={character}
                  size="sm"
                  line={pickRandom(character.successLines)}
                  onReroll={rerollCharacter}
                />

                <h1 className="font-heading text-2xl text-foreground">
                  Welcome back
                </h1>

                <span className="inline-flex items-center gap-2 border-2 border-secondary bg-[var(--color-panel)] px-4 py-2 text-sm text-foreground">
                  <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
                  <code className="font-mono">{storedAccountId}</code>
                </span>

                {/* Session status info */}
                <div className="w-full border-l-2 border-brand/40 bg-brand/5 px-4 py-3 type-caption">
                  Your key is <span className={isLocked ? 'text-brand' : 'text-foreground'}>{expiryLabel}</span>.
                  {savedUrl && !showUrl && (
                    <>
                      {' '}Need your connection URL?{' '}
                      <button
                        type="button"
                        onClick={() => setShowUrl(true)}
                        className="text-brand underline transition-colors hover:text-brand/80"
                      >
                        Show URL
                      </button>
                    </>
                  )}
                </div>

                {/* Connection details (expanded) */}
                {showUrl && savedUrl && (
                  <div className="w-full flex flex-col gap-4">
                    {/* Connection URL */}
                    <div className="border-2 border-secondary bg-[var(--color-panel)] px-4 py-3">
                      <p className="break-all font-mono text-sm text-brand">
                        {savedUrl}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await handleCopy(savedUrl, 'Connection URL');
                        setCopiedUrl(true);
                        setTimeout(() => setCopiedUrl(false), 2000);
                      }}
                      className="flex w-full items-center justify-center gap-2 border-2 border-secondary py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-brand hover:text-brand"
                    >
                      {copiedUrl ? (
                        <>
                          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
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
                        <pre className="break-all font-mono text-xs text-brand whitespace-pre-wrap">
                          {claudeConfig}
                        </pre>
                        <button
                          type="button"
                          onClick={() => void handleCopy(claudeConfig, 'Claude config')}
                          className="absolute right-2 top-2 rounded border border-secondary px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
                        >
                          Copy
                        </button>
                      </div>
                    )}

                    {/* How to connect */}
                    <div className="border-l-2 border-brand/40 bg-brand/5 px-4 py-3 type-caption">
                      <p className="mb-2 font-semibold text-foreground">How to connect</p>
                      <ul className="flex flex-col gap-1.5">
                        <li className="flex gap-2">
                          <span className="text-brand/60" aria-hidden="true">&#8226;</span>
                          <span>Claude AI: Settings &rarr; Integrations &rarr; Add custom MCP &rarr; paste URL</span>
                        </li>
                        <li className="flex gap-2">
                          <span className="text-brand/60" aria-hidden="true">&#8226;</span>
                          <span>Claude Desktop: Settings &rarr; MCP Servers &rarr; Add &rarr; paste URL or config</span>
                        </li>
                      </ul>
                    </div>

                    {/* Example commands */}
                    <div className="border-l-2 border-brand/40 bg-brand/5 px-4 py-3 type-caption">
                      <p className="mb-2 font-semibold text-foreground">Try saying</p>
                      <div className="flex flex-wrap gap-2">
                        {[
                          'Register me for LazyLotto',
                          'Show my deposit info',
                          'Play a lottery session',
                          'Check my balance',
                        ].map((cmd) => (
                          <button
                            key={cmd}
                            type="button"
                            onClick={() => void handleCopy(cmd, 'Command')}
                            className="cursor-pointer border border-secondary bg-[var(--color-panel)] px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:border-brand hover:text-brand"
                            title="Click to copy"
                          >
                            {cmd}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Primary CTA */}
                <button
                  type="button"
                  onClick={() => router.push(ctaTarget)}
                  className="btn-primary-sm w-full"
                >
                  {ctaLabel}
                </button>

                {/* Secondary actions */}
                <div className="flex items-center gap-4 text-sm">
                  <button
                    type="button"
                    onClick={handleReauthenticate}
                    className="text-muted underline transition-colors hover:text-foreground"
                  >
                    Re-authenticate
                  </button>
                  <span className="text-brand/40" aria-hidden="true">&middot;</span>
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    className="text-muted underline transition-colors hover:text-foreground"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ---- LANDING ---- */}
          {status === 'landing' && (
            <LandingView
              network={net}
              character={character}
              rerollCharacter={rerollCharacter}
              onConnect={() => void handleAuth()}
            />
          )}

          {/* ---- CONNECTING / SIGNING ---- */}
          {isConnecting && (
            <ConnectingView
              phase={status === 'connecting' ? 'connecting' : 'signing'}
              accountId={accountId}
            />
          )}

          {/* ---- COMPLETE ---- */}
          {status === 'complete' && (() => {
            const connectionUrl = `${mcpUrl}?key=${sessionToken}`;
            const successTagline = pickRandom(character.successLines);

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

            // --- Returning user: compact view ---
            if (isReturning) {
              return (
                <div className="relative flex flex-col gap-8">
                  {/* Gold confetti celebration */}
                  <GoldConfetti />

                  {/* Success header */}
                  <div className="flex flex-col items-center gap-4 text-center">
                    <CharacterMascot
                  key={character.name}
                  character={character}
                  size="sm"
                  line={successTagline}
                  onReroll={rerollCharacter}
                />

                    <h2 className="font-heading text-xl text-success">
                      Re-authenticated
                    </h2>

                    <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm text-foreground">
                      <span className="h-2 w-2 rounded-full bg-success" />
                      {accountId}
                    </span>
                  </div>

                  {/* Key status */}
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-sm text-foreground">
                      Your new key is ready.
                    </p>
                    <p className="text-sm text-muted">
                      Your previous key has been revoked.
                    </p>
                  </div>

                  {/* Connection URL */}
                  <div className="flex flex-col gap-3">
                    <div className="border-2 border-secondary bg-[var(--color-panel)] px-4 py-3">
                      <p className="break-all font-mono text-sm text-brand">
                        {connectionUrl}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await handleCopy(connectionUrl, 'Connection URL');
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="btn-primary-sm w-full"
                    >
                      {copied ? (
                        <>
                          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          Copied!
                        </>
                      ) : (
                        'Copy Connection URL'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowJsonConfig((prev) => !prev)}
                      className="text-left text-xs text-brand underline transition-colors hover:text-brand/80"
                    >
                      {showJsonConfig ? 'Hide Claude Desktop config' : 'Show Claude Desktop config (JSON)'}
                    </button>
                    {showJsonConfig && (
                      <div className="flex flex-col gap-2">
                        <div className="relative border-2 border-secondary bg-[var(--color-panel)] p-4">
                          <pre className="break-all font-mono text-xs text-brand whitespace-pre-wrap">
                            {claudeConfig}
                          </pre>
                          <button
                            type="button"
                            onClick={() => void handleCopy(claudeConfig, 'Claude config')}
                            className="absolute right-2 top-2 rounded border border-secondary px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Session management (compact) */}
                  <div className="text-center text-sm text-muted">
                    {locked ? (
                      <span>
                        API key is permanent.{' '}
                        <button
                          type="button"
                          onClick={handleDisconnect}
                          className="text-muted underline transition-colors hover:text-foreground"
                        >
                          Disconnect
                        </button>
                      </span>
                    ) : lockConfirming ? (
                      <div className="flex flex-col items-center gap-2">
                        <p className="text-xs text-muted">
                          A permanent key never expires. If compromised, re-authenticate here to revoke it.
                        </p>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => void handleLock()}
                            disabled={locking}
                            className="btn-primary-sm"
                          >
                            {locking ? 'Locking...' : 'Confirm — Make Permanent'}
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
                    ) : (
                      <span>
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
                          onClick={handleDisconnect}
                          className="text-muted underline transition-colors hover:text-foreground"
                        >
                          Disconnect
                        </button>
                      </span>
                    )}
                  </div>

                  {/* Go to Dashboard */}
                  <button
                    type="button"
                    onClick={() => router.push(ctaTarget)}
                    className="btn-primary-sm w-full"
                  >
                    {ctaLabel}
                  </button>
                </div>
              );
            }

            // --- New user: full three-step guide ---
            return (
            <div className="relative flex flex-col gap-8">
              {/* Gold confetti celebration */}
              <GoldConfetti />

              {/* SECTION 1: Success header */}
              <div className="flex flex-col items-center gap-4 text-center">
                <CharacterMascot
                  key={character.name}
                  character={character}
                  size="sm"
                  line={successTagline}
                  onReroll={rerollCharacter}
                />

                <h2 className="font-heading text-xl text-success">
                  Authenticated
                </h2>

                <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm text-foreground">
                  <span className="h-2 w-2 rounded-full bg-success" />
                  {accountId}
                </span>
              </div>

              {/* SECTION 2: Connect to Claude — step guide */}
              <div className="flex flex-col gap-6">

                {/* Step 1: Copy connection URL */}
                <div className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="flex h-7 w-7 items-center justify-center border-2 border-brand bg-brand/10 font-pixel text-[9px] text-brand">
                      1
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    <h3 className="text-sm font-semibold text-foreground">
                      Copy your connection URL
                    </h3>
                    <p className="text-sm text-muted">
                      This URL connects Claude to your LazyLotto Agent. Use it in
                      Claude AI, Claude Desktop, or any MCP-compatible client.
                    </p>
                    <div className="border-2 border-secondary bg-[var(--color-panel)] px-4 py-3">
                      <p className="break-all font-mono text-sm text-brand">
                        {connectionUrl}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await handleCopy(connectionUrl, 'Connection URL');
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="btn-primary-sm w-full"
                    >
                      {copied ? (
                        <>
                          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          Copied!
                        </>
                      ) : (
                        'Copy Connection URL'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowJsonConfig((prev) => !prev)}
                      className="text-left text-xs text-brand underline transition-colors hover:text-brand/80"
                    >
                      {showJsonConfig ? 'Hide Claude Desktop config' : 'Show Claude Desktop config (JSON)'}
                    </button>
                    {showJsonConfig && (
                      <div className="flex flex-col gap-2">
                        <div className="relative border-2 border-secondary bg-[var(--color-panel)] p-4">
                          <pre className="break-all font-mono text-xs text-brand whitespace-pre-wrap">
                            {claudeConfig}
                          </pre>
                          <button
                            type="button"
                            onClick={() => void handleCopy(claudeConfig, 'Claude config')}
                            className="absolute right-2 top-2 rounded border border-secondary px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Step 2: Add to Claude */}
                <div className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="flex h-7 w-7 items-center justify-center border-2 border-brand bg-brand/10 font-pixel text-[9px] text-brand">
                      2
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    <h3 className="text-sm font-semibold text-foreground">
                      Add to Claude
                    </h3>
                    <p className="text-sm text-muted">
                      Paste the URL as a custom MCP connector in Claude AI or
                      Claude Desktop.
                    </p>
                    <ul className="flex flex-col gap-1.5 text-sm text-muted">
                      <li className="flex gap-2">
                        <span className="text-brand/60" aria-hidden="true">&#8226;</span>
                        <span>Claude AI: Settings &rarr; Integrations &rarr; Add custom MCP &rarr; paste URL</span>
                      </li>
                      <li className="flex gap-2">
                        <span className="text-brand/60" aria-hidden="true">&#8226;</span>
                        <span>Claude Desktop: Settings &rarr; MCP Servers &rarr; Add &rarr; paste config</span>
                      </li>
                    </ul>
                    <p className="text-sm">
                      <a
                        href="https://claude.ai"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand underline transition-colors hover:text-brand/80"
                      >
                        Don&apos;t have Claude? Get it at claude.ai
                      </a>
                    </p>
                  </div>
                </div>

                {/* Step 3: Start playing */}
                <div className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="flex h-7 w-7 items-center justify-center border-2 border-brand bg-brand/10 font-pixel text-[9px] text-brand">
                      3
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    <h3 className="text-sm font-semibold text-foreground">
                      Start playing
                    </h3>
                    <p className="text-sm text-muted" id="example-commands-label">
                      Once connected, try these commands:
                    </p>
                    <ul
                      aria-labelledby="example-commands-label"
                      className="flex flex-wrap gap-2 list-none p-0 m-0"
                    >
                      {[
                        'Register me for LazyLotto',
                        'Show my deposit info',
                        'What pools are available?',
                        'Play a lottery session',
                        'Check my balance',
                        'Withdraw 10 HBAR',
                      ].map((cmd) => (
                        <li key={cmd}>
                          <button
                            type="button"
                            onClick={() => void handleCopy(cmd, 'Command')}
                            className="cursor-pointer border border-secondary bg-[var(--color-panel)] px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:border-brand hover:text-brand"
                            aria-label={`Copy command: ${cmd}`}
                          >
                            {cmd}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted">
                      The agent handles everything -- pool selection, entries, prize transfer.
                    </p>
                  </div>
                </div>
              </div>

              {/* SECTION 3: Session management (compact) */}
              <div className="text-center text-sm text-muted">
                {locked ? (
                  <span>
                    API key is permanent.{' '}
                    <button
                      type="button"
                      onClick={handleDisconnect}
                      className="text-muted underline transition-colors hover:text-foreground"
                    >
                      Disconnect
                    </button>
                  </span>
                ) : lockConfirming ? (
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-xs text-muted">
                      A permanent key never expires. If compromised, re-authenticate here to revoke it.
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void handleLock()}
                        disabled={locking}
                        className="btn-primary-sm"
                      >
                        {locking ? 'Locking...' : 'Confirm — Make Permanent'}
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
                ) : (
                  <span>
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
                      onClick={handleDisconnect}
                      className="text-muted underline transition-colors hover:text-foreground"
                    >
                      Disconnect
                    </button>
                  </span>
                )}
              </div>

              {/* SECTION 4: Go to Dashboard */}
              <button
                type="button"
                onClick={() => router.push(ctaTarget)}
                className="btn-primary-sm w-full"
              >
                {ctaLabel}
              </button>
            </div>
            );
          })()}

          {/* ---- ERROR ---- */}
          {status === 'error' && (
            <ErrorView
              error={error}
              onRetry={() => {
                setError('');
                setStatus('landing');
              }}
            />
          )}
          </div>
        </ComicPanel>
      </div>
    </div>
  );
}
