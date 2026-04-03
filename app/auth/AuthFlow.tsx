'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { LedgerId } from '@hashgraph/sdk';
import { DAppConnector } from '@hashgraph/hedera-wallet-connect/dist/lib/dapp';
import {
  HederaJsonRpcMethod,
  HederaSessionEvent,
  HederaChainId,
} from '@hashgraph/hedera-wallet-connect/dist/lib/shared';
import { useToast } from '../components/Toast';

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

type Network = 'testnet' | 'mainnet';

const PROJECT_IDS: Record<Network, string> = {
  testnet: 'bd6270834787a8e7615806237172c87c',
  mainnet: '6c3697705aa0c2e8a49d81ed6f734219',
};

const CHAIN_IDS: Record<Network, string> = {
  testnet: HederaChainId.Testnet,
  mainnet: HederaChainId.Mainnet,
};

// ---------------------------------------------------------------------------
// Character mascots — each with a unique tagline
// ---------------------------------------------------------------------------

const IPFS_BASE = 'https://lazysuperheroes.myfilebase.com/ipfs/QmXsG47eDFSwCA4Kpii3XGidHScbsApdAvPnF4aMTpi7KD';

const LSH_CHARACTERS = [
  // Gen 1 — Lazy Superheroes (Male)
  { name: 'Aadan', img: `${IPFS_BASE}/Aadan.png?w=256&h=256`, tagline: 'Aadan is ready. Are you?' },
  { name: 'Jazz', img: `${IPFS_BASE}/Jazz.png?w=256&h=256`, tagline: 'Jazz says: let the good times roll.' },
  { name: 'Gordo', img: `${IPFS_BASE}/Gordo.png?w=256&h=256`, tagline: 'Gordo\'s got a feeling about this one.' },
  { name: 'Korgg', img: `${IPFS_BASE}/Korgg.png?w=256&h=256`, tagline: 'Korgg smash... those lottery odds.' },
  { name: 'Nobody', img: `${IPFS_BASE}/Nobody.png?w=256&h=256`, tagline: 'Nobody does it better.' },
  { name: 'Kjell', img: `${IPFS_BASE}/Kjell.png?w=256&h=256`, tagline: 'The HBARBarian is feeling lucky.' },
  { name: 'Crawford', img: `${IPFS_BASE}/Crawford.png?w=256&h=256`, tagline: 'Crawford always plays it cool.' },
  // Gen 1 — Lazy Superheroes (Female)
  { name: 'Ginnie Delice', img: `${IPFS_BASE}/Ginnie-Delice.png?w=256&h=256`, tagline: 'Ginnie says: fortune favours the bold.' },
  { name: 'Tina Ingvild', img: `${IPFS_BASE}/Tina-Ingvild.png?w=256&h=256`, tagline: 'The Red Queen demands a win.' },
  { name: 'Virginia Lor', img: `${IPFS_BASE}/Virginia-Lor.png?w=256&h=256`, tagline: 'Virginia feels the odds shifting.' },
  { name: 'Kanna Setsuko', img: `${IPFS_BASE}/Kanna-Setsuko.png?w=256&h=256`, tagline: 'Kanna\'s psychic sense says: play now.' },
  // Gen 2 — Lazy Super Villains
  { name: 'Mala', img: `${IPFS_BASE}/Mala.jpg?w=256&h=256`, tagline: 'Even villains need a lucky break.' },
  { name: 'Soul', img: `${IPFS_BASE}/Soul.jpg?w=256&h=256`, tagline: 'Soul\'s roar echoes: it\'s game time.' },
  { name: 'Blood', img: `${IPFS_BASE}/Blood.jpg?w=256&h=256`, tagline: 'Blood thirsts for a jackpot.' },
  { name: 'E-Xterm', img: `${IPFS_BASE}/E-Xterm.jpg?w=256&h=256`, tagline: 'E-Xterm has calculated the optimal play.' },
  { name: 'Gabriel', img: `${IPFS_BASE}/Gabriel.jpg?w=256&h=256`, tagline: 'The Cobrastra strikes at fortune.' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNetworkFromUrl(): Network {
  if (typeof window === 'undefined') return 'testnet';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('network')?.toLowerCase();
  if (raw === 'mainnet') return 'mainnet';
  return 'testnet';
}

function networkLabel(n: Network): string {
  return n === 'mainnet' ? 'Mainnet' : 'Testnet';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuthFlow() {
  const router = useRouter();
  const { toast } = useToast();

  // ----- state -----
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [accountId, setAccountId] = useState<string>('');
  const [storedAccountId, setStoredAccountId] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [mcpUrl, setMcpUrl] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [locked, setLocked] = useState(false);
  const [locking, setLocking] = useState(false);

  const dappConnector = useRef<DAppConnector | null>(null);
  const network = useRef<Network>('testnet');

  // Pick a random character once per mount
  const randomIdx = useMemo(() => Math.floor(Math.random() * LSH_CHARACTERS.length), []);
  const character = LSH_CHARACTERS[randomIdx];

  // ----- Check localStorage on mount -----
  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    const acctId = localStorage.getItem('lazylotto:accountId');
    if (token && acctId) {
      setStoredAccountId(acctId);
      setStatus('already-auth');
    } else {
      setStatus('landing');
    }
  }, []);

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
    console.log('[AuthFlow] DAppConnector initialized for', net);
  }, []);

  useEffect(() => {
    void initWalletConnect();
    return () => {
      try {
        void dappConnector.current?.disconnectAll?.();
      } catch {
        /* ignore */
      }
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
        expiresAt: string;
      };

      // 5. Store to localStorage
      localStorage.setItem('lazylotto:sessionToken', verified.sessionToken);
      localStorage.setItem('lazylotto:accountId', acctId);

      // 6. Complete
      setSessionToken(verified.sessionToken);
      setMcpUrl(verified.mcpUrl);
      setExpiresAt(verified.expiresAt);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLocking(false);
    }
  }, [sessionToken, locked, locking]);

  // ----- Re-authenticate (clear stored session) -----
  const handleReauthenticate = useCallback(() => {
    localStorage.removeItem('lazylotto:sessionToken');
    localStorage.removeItem('lazylotto:accountId');
    setStoredAccountId('');
    setStatus('landing');
  }, []);

  // ----- Disconnect -----
  const handleDisconnect = useCallback(() => {
    try {
      void dappConnector.current?.disconnectAll?.();
    } catch {
      /* ignore */
    }
    localStorage.removeItem('lazylotto:sessionToken');
    localStorage.removeItem('lazylotto:accountId');
    setStatus('landing');
    setAccountId('');
    setSessionToken('');
    setError('');
    setMcpUrl('');
    setExpiresAt('');
    setLocked(false);
    setLocking(false);
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

  // ======================================================================
  // RENDER
  // ======================================================================

  return (
    <div className="flex flex-1 items-start justify-center px-4 pt-16 lg:pt-24">
      <div className="w-full max-w-xl">
        <div className={`rounded-xl p-8 ${status === 'already-auth' ? '' : 'border border-secondary shadow-lg'}`}>
          {/* ---- LOADING ---- */}
          {status === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
            </div>
          )}

          {/* ---- ALREADY AUTHENTICATED ---- */}
          {status === 'already-auth' && (
            <div className="flex flex-col items-center gap-6 text-center">
              <h1 className="font-heading text-2xl text-foreground">
                Welcome back
              </h1>

              <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm text-foreground">
                <span className="h-2 w-2 rounded-full bg-success" />
                {storedAccountId}
              </span>

              <p className="text-sm text-muted">
                You are already authenticated. Head to your dashboard or
                re-authenticate with a different wallet.
              </p>

              <div className="flex w-full gap-3">
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="flex-1 rounded-lg bg-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-primary/90"
                >
                  Go to Dashboard
                </button>
                <button
                  type="button"
                  onClick={handleReauthenticate}
                  className="flex-1 rounded-lg border border-secondary px-6 py-3 text-foreground transition-colors hover:bg-secondary"
                >
                  Re-authenticate
                </button>
              </div>
            </div>
          )}

          {/* ---- LANDING ---- */}
          {status === 'landing' && (
            <div className="flex flex-col items-center gap-6 text-center">
              <img
                src="https://docs.lazysuperheroes.com/logo.svg"
                alt="LazyLotto"
                className="h-20"
              />

              <div className="flex items-center gap-2">
                <h1 className="font-heading text-2xl text-foreground">
                  LazyLotto Agent
                </h1>
                <span className="rounded bg-brand px-2 py-0.5 text-xs text-background">
                  {networkLabel(net)}
                </span>
              </div>

              {/* Character mascot with shimmer placeholder */}
              <div className="animate-fade-scale-in flex flex-col items-center gap-3">
                <div className="relative h-32 w-32 overflow-hidden rounded-xl bg-secondary animate-pulse">
                  <img
                    src={character.img}
                    alt={character.name}
                    className="h-full w-full object-contain"
                    onLoad={(e) => { (e.target as HTMLImageElement).parentElement?.classList.remove('animate-pulse', 'bg-secondary'); }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
                <p className="text-sm font-medium text-brand">
                  {character.tagline}
                </p>
              </div>

              <p className="text-sm text-muted">
                Sign a message to prove wallet ownership and receive your MCP
                connection credentials. No transaction is submitted and no funds
                are spent.
              </p>

              <button
                type="button"
                onClick={() => void handleAuth()}
                className="w-full rounded-lg bg-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-primary/90"
              >
                Connect Wallet
              </button>

              <p className="text-sm text-muted">
                Supports HashPack, Blade, and other Hedera wallets via
                WalletConnect.
              </p>
            </div>
          )}

          {/* ---- CONNECTING / SIGNING ---- */}
          {isConnecting && (
            <div className="flex flex-col items-center gap-6 text-center">
              <img
                src="https://docs.lazysuperheroes.com/logo.svg"
                alt="LazyLotto"
                className="h-20"
              />

              {accountId && (
                <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm text-foreground">
                  <span className="h-2 w-2 rounded-full bg-success" />
                  {accountId}
                </span>
              )}

              <div className="flex items-center gap-3">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
                <span className="text-sm text-foreground">
                  {status === 'connecting'
                    ? 'Connecting wallet...'
                    : 'Requesting signature...'}
                </span>
              </div>

              <p className="text-sm text-muted">
                Please approve the signing request in your wallet.
              </p>
            </div>
          )}

          {/* ---- COMPLETE ---- */}
          {status === 'complete' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col items-center gap-4 text-center">
                <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm text-foreground">
                  <span className="h-2 w-2 rounded-full bg-success" />
                  {accountId}
                </span>

                <h2 className="font-heading text-xl text-success">
                  Authenticated
                </h2>
              </div>

              {/* MCP URL */}
              <div className="flex flex-col gap-2">
                <label className="text-sm text-muted">
                  Your MCP connection URL:
                </label>
                <div className="relative rounded-lg border border-secondary bg-[#111113] p-4">
                  <p className="break-all pr-16 font-mono text-sm text-brand">
                    {mcpUrl}
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCopy(mcpUrl, 'MCP URL')}
                    className="absolute right-2 top-2 rounded border border-secondary px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
                  >
                    Copy
                  </button>
                </div>
              </div>

              {/* Claude Desktop config */}
              <div className="flex flex-col gap-2">
                <label className="text-sm text-muted">
                  Claude Desktop config:
                </label>
                <div className="relative rounded-lg border border-secondary bg-[#111113] p-4">
                  <pre className="break-all font-mono text-sm text-brand whitespace-pre-wrap">
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

              {/* Action buttons */}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => void handleLock()}
                  disabled={locked || locking}
                  className="flex-1 rounded-lg bg-brand py-2.5 font-semibold text-background transition-opacity disabled:opacity-50"
                >
                  {locked ? 'Locked' : locking ? 'Locking...' : 'Lock API Key'}
                </button>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="flex-1 rounded-lg border border-secondary py-2.5 text-foreground transition-colors hover:bg-secondary"
                >
                  Disconnect
                </button>
              </div>

              {/* Go to Dashboard */}
              <button
                type="button"
                onClick={() => router.push('/dashboard')}
                className="w-full rounded-lg bg-primary py-2.5 font-semibold text-white transition-colors hover:bg-primary/90"
              >
                Go to Dashboard
              </button>

              {/* Expiry info */}
              <p className="text-center text-sm text-muted">
                {locked
                  ? 'API key is permanent. Protect it carefully.'
                  : expiresAt
                    ? `Session expires ${new Date(expiresAt).toLocaleString()}`
                    : ''}
              </p>
            </div>
          )}

          {/* ---- ERROR ---- */}
          {status === 'error' && (
            <div className="flex flex-col items-center gap-6 text-center">
              <img
                src="https://docs.lazysuperheroes.com/logo.svg"
                alt="LazyLotto"
                className="h-20"
              />

              <p className="text-sm text-destructive">{error}</p>

              <button
                type="button"
                onClick={() => {
                  setError('');
                  setStatus('landing');
                }}
                className="rounded-lg border border-secondary px-6 py-2.5 text-foreground transition-colors hover:bg-secondary"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
