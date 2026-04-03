'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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
// Character mascots — each with taglines (landing) and success lines
// ---------------------------------------------------------------------------

const IPFS_BASE = 'https://lazysuperheroes.myfilebase.com/ipfs/QmXsG47eDFSwCA4Kpii3XGidHScbsApdAvPnF4aMTpi7KD';
// Filebase image optimization: resize to 256px, contain aspect ratio, auto format, sharpen
const IMG_OPTS = '?img-width=256&img-height=256&img-fit=contain&img-format=auto&img-sharpen=1';

const LSH_CHARACTERS = [
  // Gen 1 — Lazy Superheroes (Male)
  {
    name: 'Aadan',
    img: `${IPFS_BASE}/Aadan.png${IMG_OPTS}`,
    taglines: ['Aadan is ready. Are you?', 'Aadan says: fortune favours the bold.', 'Aadan has a good feeling about this.'],
    successLines: ["Aadan says: you're in! Let's roll.", 'Aadan approves. Welcome aboard.', 'Nice one. Aadan knew you had it in you.'],
  },
  {
    name: 'Jazz',
    img: `${IPFS_BASE}/Jazz.png${IMG_OPTS}`,
    taglines: ['Jazz says: let the good times roll.', 'Jazz is tuned in and ready.', 'Jazz has the rhythm of luck.'],
    successLines: ["Jazz says: you're in! Let's roll.", 'Jazz approves. Time to play.', 'Welcome to the LazyVerse, courtesy of Jazz.'],
  },
  {
    name: 'Gordo',
    img: `${IPFS_BASE}/Gordo.png${IMG_OPTS}`,
    taglines: ["Gordo's got a feeling about this one.", 'Gordo never backs down from a bet.', 'Gordo says: go big or go home.'],
    successLines: ["Gordo says: you're in! Let's roll.", 'Gordo approves. Time to play.', "Welcome to the big leagues, courtesy of Gordo."],
  },
  {
    name: 'Korgg',
    img: `${IPFS_BASE}/Korgg.png${IMG_OPTS}`,
    taglines: ['Korgg smash... those lottery odds.', 'Korgg is ready to rumble.', 'Korgg sees victory on the horizon.'],
    successLines: ["Korgg says: you're in! Let's roll.", 'Korgg approves. Time to smash.', 'Welcome to the LazyVerse, courtesy of Korgg.'],
  },
  {
    name: 'Nobody',
    img: `${IPFS_BASE}/Nobody.png${IMG_OPTS}`,
    taglines: ['Nobody does it better.', 'Nobody sees all. Nobody knows all.', 'Nobody is watching your back.'],
    successLines: ["Nobody says: you're in! Let's roll.", 'Nobody approves. Silently.', 'Welcome aboard. Nobody saw a thing.'],
  },
  {
    name: 'Kjell',
    img: `${IPFS_BASE}/Kjell.png${IMG_OPTS}`,
    taglines: ['The HBARBarian is feeling lucky.', 'Kjell sharpens his axe for fortune.', 'Kjell charges into the fray.'],
    successLines: ["Kjell says: you're in! Let's roll.", 'The HBARBarian approves. Onward.', 'Welcome to Valhalla, courtesy of Kjell.'],
  },
  {
    name: 'Crawford',
    img: `${IPFS_BASE}/Crawford.png${IMG_OPTS}`,
    taglines: ['Crawford always plays it cool.', 'Crawford has the odds figured out.', 'Crawford says: trust the process.'],
    successLines: ["Crawford says: you're in! Let's roll.", 'Crawford approves. Smooth move.', 'Welcome to the LazyVerse, courtesy of Crawford.'],
  },
  // Gen 1 — Lazy Superheroes (Female)
  {
    name: 'Ginnie Delice',
    img: `${IPFS_BASE}/Ginnie-Delice.png${IMG_OPTS}`,
    taglines: ['Ginnie says: fortune favours the bold.', 'Ginnie has a trick up her sleeve.', 'Ginnie Delice is feeling generous.'],
    successLines: ["Ginnie says: you're in! Let's roll.", 'Ginnie approves. Deliciously.', 'Welcome to the LazyVerse, courtesy of Ginnie.'],
  },
  {
    name: 'Tina Ingvild',
    img: `${IPFS_BASE}/Tina-Ingvild.png${IMG_OPTS}`,
    taglines: ['The Red Queen demands a win.', 'Tina Ingvild has spoken.', 'Tina commands fortune to her side.'],
    successLines: ["Tina says: you're in! Let's roll.", 'The Red Queen approves. Bow.', 'Welcome to the court, courtesy of Tina.'],
  },
  {
    name: 'Virginia Lor',
    img: `${IPFS_BASE}/Virginia-Lor.png${IMG_OPTS}`,
    taglines: ['Virginia feels the odds shifting.', 'Virginia Lor knows the way.', 'Virginia whispers: the stars align.'],
    successLines: ["Virginia says: you're in! Let's roll.", 'Virginia approves. Gracefully.', 'Welcome to the LazyVerse, courtesy of Virginia.'],
  },
  {
    name: 'Kanna Setsuko',
    img: `${IPFS_BASE}/Kanna-Setsuko.png${IMG_OPTS}`,
    taglines: ["Kanna's psychic sense says: play now.", 'Kanna sees a jackpot in your future.', 'Kanna Setsuko reads fortune in your favour.'],
    successLines: ["Kanna says: you're in! Let's roll.", 'Kanna approves. It was foreseen.', 'Welcome to the LazyVerse, courtesy of Kanna.'],
  },
  // Gen 2 — Lazy Super Villains
  {
    name: 'Mala',
    img: `${IPFS_BASE}/Mala.jpg${IMG_OPTS}`,
    taglines: ['Even villains need a lucky break.', 'Mala plots a winning streak.', 'Mala says: chaos breeds opportunity.'],
    successLines: ["Mala says: you're in! Let's roll.", 'Mala approves. Wickedly.', 'Welcome to the dark side, courtesy of Mala.'],
  },
  {
    name: 'Soul',
    img: `${IPFS_BASE}/Soul.jpg${IMG_OPTS}`,
    taglines: ["Soul's roar echoes: it's game time.", 'Soul demands a worthy opponent.', 'Soul hungers for victory.'],
    successLines: ["Soul says: you're in! Let's roll.", 'Soul approves. With a roar.', 'Welcome to the hunt, courtesy of Soul.'],
  },
  {
    name: 'Blood',
    img: `${IPFS_BASE}/Blood.jpg${IMG_OPTS}`,
    taglines: ['Blood thirsts for a jackpot.', 'Blood says: the night is young.', 'Blood senses fortune in the air.'],
    successLines: ["Blood says: you're in! Let's roll.", 'Blood approves. Darkly.', 'Welcome to the shadows, courtesy of Blood.'],
  },
  {
    name: 'E-Xterm',
    img: `${IPFS_BASE}/E-Xterm.jpg${IMG_OPTS}`,
    taglines: ['E-Xterm has calculated the optimal play.', 'E-Xterm says: probability is on our side.', 'E-Xterm runs the numbers. Looking good.'],
    successLines: ["E-Xterm says: you're in! Let's roll.", 'E-Xterm approves. Statistically sound.', 'Welcome to the matrix, courtesy of E-Xterm.'],
  },
  {
    name: 'Gabriel',
    img: `${IPFS_BASE}/Gabriel.jpg${IMG_OPTS}`,
    taglines: ['The Cobrastra strikes at fortune.', 'Gabriel coils, ready to strike.', 'Gabriel says: the serpent sees all.'],
    successLines: ["Gabriel says: you're in! Let's roll.", 'The Cobrastra approves. Ssslick.', 'Welcome to the nest, courtesy of Gabriel.'],
  },
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

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// Confetti celebration (gold particles on auth success)
// ---------------------------------------------------------------------------

function GoldConfetti() {
  const particles = Array.from({ length: 24 }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    delay: `${Math.random() * 0.6}s`,
    duration: `${1.2 + Math.random() * 1.0}s`,
    color: Math.random() > 0.3 ? '#e5a800' : Math.random() > 0.5 ? '#fafafa' : '#3b82f6',
    size: `${4 + Math.random() * 4}px`,
    rotation: `${Math.random() * 360}deg`,
  }));

  return (
    <div className="confetti-container">
      {particles.map((p) => (
        <div
          key={p.id}
          className="confetti-particle"
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.duration,
            backgroundColor: p.color,
            width: p.size,
            height: p.size,
            transform: `rotate(${p.rotation})`,
          }}
        />
      ))}
    </div>
  );
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
  const [lockConfirming, setLockConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showJsonConfig, setShowJsonConfig] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // ----- Persistent character mascot -----
  const [characterIdx, setCharacterIdx] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const stored = localStorage.getItem('lazylotto:characterIdx');
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed < LSH_CHARACTERS.length) return parsed;
    }
    const idx = Math.floor(Math.random() * LSH_CHARACTERS.length);
    localStorage.setItem('lazylotto:characterIdx', String(idx));
    return idx;
  });

  const character = LSH_CHARACTERS[characterIdx];

  const rerollCharacter = useCallback(() => {
    const newIdx = Math.floor(Math.random() * LSH_CHARACTERS.length);
    setCharacterIdx(newIdx);
    localStorage.setItem('lazylotto:characterIdx', String(newIdx));
  }, []);

  const dappConnector = useRef<DAppConnector | null>(null);
  const network = useRef<Network>('testnet');

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
        expiresAt: string;
      };

      // 5. Store to localStorage
      localStorage.setItem('lazylotto:sessionToken', verified.sessionToken);
      localStorage.setItem('lazylotto:accountId', acctId);

      // Store the connection URL so already-auth state can show it later
      const fullUrl = `${verified.mcpUrl}?key=${verified.sessionToken}`;
      localStorage.setItem('lazylotto:mcpUrl', fullUrl);
      if (verified.expiresAt) localStorage.setItem('lazylotto:expiresAt', verified.expiresAt);

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
    localStorage.removeItem('lazylotto:sessionToken');
    localStorage.removeItem('lazylotto:accountId');
    localStorage.removeItem('lazylotto:mcpUrl');
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
    localStorage.removeItem('lazylotto:sessionToken');
    localStorage.removeItem('lazylotto:accountId');
    localStorage.removeItem('lazylotto:mcpUrl');
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

  // ======================================================================
  // Shared: Character mascot block (used in multiple states)
  // ======================================================================

  const CharacterMascot = useCallback(
    ({ size = 'lg', line }: { size?: 'sm' | 'lg'; line?: string }) => {
      const dim = size === 'lg' ? 'h-32 w-32' : 'h-20 w-20';
      return (
        <div className="animate-fade-scale-in flex flex-col items-center gap-2">
          <div className="relative">
            <div className={`relative ${dim} overflow-hidden rounded-xl bg-secondary animate-pulse`}>
              <img
                src={character.img}
                alt={character.name}
                className="h-full w-full object-contain"
                onLoad={(e) => {
                  (e.target as HTMLImageElement).parentElement?.classList.remove('animate-pulse', 'bg-secondary');
                }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
            <button
              type="button"
              onClick={rerollCharacter}
              className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs transition-colors hover:bg-brand/20"
              title="Change mascot"
            >
              🎲
            </button>
          </div>
          {line && (
            <p className="text-sm font-medium text-brand">{line}</p>
          )}
        </div>
      );
    },
    [character, rerollCharacter],
  );

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
          {status === 'already-auth' && (() => {
            const savedUrl = typeof window !== 'undefined'
              ? localStorage.getItem('lazylotto:mcpUrl') ?? ''
              : '';
            const isLocked = typeof window !== 'undefined' && localStorage.getItem('lazylotto:locked') === 'true';
            const savedExpiry = typeof window !== 'undefined' ? localStorage.getItem('lazylotto:expiresAt') : null;
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
                <CharacterMascot size="sm" line={pickRandom(character.successLines)} />

                <h1 className="font-heading text-2xl text-foreground">
                  Welcome back
                </h1>

                <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm text-foreground">
                  <span className="h-2 w-2 rounded-full bg-success" />
                  {storedAccountId}
                </span>

                {/* Session status info */}
                <div className="w-full rounded-lg bg-secondary/30 px-4 py-3 text-sm text-muted">
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

                {/* If URL shown */}
                {showUrl && savedUrl && (
                  <div className="w-full">
                    <div className="rounded-lg border border-secondary bg-[#111113] px-4 py-3">
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
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-secondary py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
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
                  </div>
                )}

                {/* Primary CTA */}
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="w-full rounded-lg bg-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-primary/90"
                >
                  Go to Dashboard
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
                  <span className="text-muted/30">&middot;</span>
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
              <CharacterMascot size="lg" line={pickRandom(character.taglines)} />

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
                    <CharacterMascot size="sm" line={successTagline} />

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
                    <div className="rounded-lg border border-secondary bg-[#111113] px-4 py-3">
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
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 font-semibold text-white transition-colors hover:bg-primary/90"
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
                        <div className="relative rounded-lg border border-secondary bg-[#111113] p-4">
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
                            className="rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-brand/80 disabled:opacity-50"
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
                    onClick={() => router.push('/dashboard')}
                    className="w-full rounded-lg bg-primary py-3 font-semibold text-white transition-colors hover:bg-primary/90"
                  >
                    Go to Dashboard
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
                <CharacterMascot size="sm" line={successTagline} />

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
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
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
                    <div className="rounded-lg border border-secondary bg-[#111113] px-4 py-3">
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
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 font-semibold text-white transition-colors hover:bg-primary/90"
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
                        <div className="relative rounded-lg border border-secondary bg-[#111113] p-4">
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
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
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
                        <span className="text-muted/60">&#8226;</span>
                        <span>Claude AI: Settings &rarr; Integrations &rarr; Add custom MCP &rarr; paste URL</span>
                      </li>
                      <li className="flex gap-2">
                        <span className="text-muted/60">&#8226;</span>
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
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
                      3
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    <h3 className="text-sm font-semibold text-foreground">
                      Start playing
                    </h3>
                    <p className="text-sm text-muted">
                      Once connected, try these commands:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {[
                        'Register me for LazyLotto',
                        'Show my deposit info',
                        'What pools are available?',
                        'Play a lottery session',
                        'Check my balance',
                        'Withdraw 10 HBAR',
                      ].map((cmd) => (
                        <button
                          key={cmd}
                          type="button"
                          onClick={() => void handleCopy(cmd, 'Command')}
                          className="cursor-pointer rounded bg-secondary/50 px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary hover:text-brand"
                          title="Click to copy"
                        >
                          {cmd}
                        </button>
                      ))}
                    </div>
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
                        className="rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-brand/80 disabled:opacity-50"
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
                onClick={() => router.push('/dashboard')}
                className="w-full rounded-lg bg-primary py-3 font-semibold text-white transition-colors hover:bg-primary/90"
              >
                Go to Dashboard
              </button>
            </div>
            );
          })()}

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
