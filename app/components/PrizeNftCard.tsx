'use client';

/**
 * PrizeNftCard — progressive-enhancement NFT card.
 *
 * Three states:
 *   1. "raw"       — we only have { token, hederaId, serial } from the capture
 *                    at the moment of the win. Renders immediately with a
 *                    placeholder image + raw token symbol + HashScan link.
 *                    This is the default state when the page first loads.
 *   2. "loading"   — enrichment request is in-flight for this NFT. Renders
 *                    the raw card with a subtle shimmer over the image area
 *                    so the user knows something's still coming.
 *   3. "enriched"  — full EnrichedPrizeNft arrived from /api/user/enrich-nfts.
 *                    Shows real image, nftName, verification badge, niceName.
 *
 * Consumers pass the raw ref always, plus optionally the enriched record +
 * a loading flag. This keeps the component single-state-machine friendly.
 */

export interface PrizeNftRef {
  token: string;
  hederaId: string;
  serial: number;
}

export interface EnrichedPrizeNft {
  hederaId: string;
  serial: number;
  nftName: string;
  collection: string;
  niceName: string;
  showNiceName: boolean;
  verificationLevel: 'lazysuperheroes' | 'complete' | 'simple' | 'unverified';
  image: string;
  source: 'directus' | 'mirror' | 'fallback';
  tokenUrl: string;
  serialUrl: string;
}

// ── Verification badge mapping ──────────────────────────────────
// Mirrors lazy-dapp-v3's VerificationBadge.tsx tiers exactly so agent
// dashboards and the dApp stay visually aligned.

const VERIFICATION_BADGE: Record<
  EnrichedPrizeNft['verificationLevel'],
  { label: string; className: string; tooltip: string; icon: string }
> = {
  lazysuperheroes: {
    label: 'LSH Verified',
    className: 'bg-brand/20 text-brand border-brand/40',
    tooltip: 'Verified token, part of the Lazy Superheroes ecosystem',
    icon: '🛡',
  },
  complete: {
    label: 'Verified',
    className: 'bg-success/20 text-success border-success/40',
    tooltip: 'Known and fully verified token',
    icon: '🛡',
  },
  simple: {
    label: 'Known',
    className: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
    tooltip: 'Known token in the Hedera ecosystem but has not been verified',
    icon: 'ℹ',
  },
  unverified: {
    label: 'Unverified',
    className: 'bg-muted/20 text-muted border-muted/40',
    tooltip: 'This token has not been verified',
    icon: '?',
  },
};

// ── HashScan URL helpers (network-aware, client-side) ──────────

function getHashScanNetwork(): 'mainnet' | 'testnet' | 'previewnet' {
  // Read from NEXT_PUBLIC_HEDERA_NETWORK (injected at build) or default testnet
  const net =
    (typeof process !== 'undefined' &&
      process.env?.NEXT_PUBLIC_HEDERA_NETWORK?.toLowerCase()) ||
    'testnet';
  if (net === 'mainnet' || net === 'testnet' || net === 'previewnet') return net;
  return 'testnet';
}

function rawTokenUrl(hederaId: string): string {
  const net = getHashScanNetwork();
  const base = net === 'mainnet' ? 'https://hashscan.io/mainnet' : `https://hashscan.io/${net}`;
  return `${base}/token/${hederaId}`;
}

function rawSerialUrl(hederaId: string, serial: number): string {
  const net = getHashScanNetwork();
  const base = net === 'mainnet' ? 'https://hashscan.io/mainnet' : `https://hashscan.io/${net}`;
  return `${base}/token/${hederaId}/${serial}`;
}

// ── Card variants ───────────────────────────────────────────────

export type PrizeNftCardSize = 'compact' | 'regular';

export interface PrizeNftCardProps {
  raw: PrizeNftRef;
  /** When present, renders the enriched state. Overrides loading. */
  enriched?: EnrichedPrizeNft;
  /** When true (and no enriched), shows a loading shimmer over the image. */
  loading?: boolean;
  /** Layout size — compact for audit trail, regular for dashboard. */
  size?: PrizeNftCardSize;
}

export function PrizeNftCard({ raw, enriched, loading, size = 'regular' }: PrizeNftCardProps) {
  const isEnriched = Boolean(enriched);
  const badge = isEnriched ? VERIFICATION_BADGE[enriched!.verificationLevel] : null;

  // Display fields — enriched wins, falls back to raw values
  const nftName = enriched?.nftName ?? `${raw.token || 'NFT'} #${raw.serial}`;
  const showNiceName = enriched?.showNiceName ?? false;
  const displayCollection = showNiceName
    ? enriched!.niceName
    : `${raw.hederaId.slice(0, 6)}…${raw.hederaId.slice(-4)}`;

  const tokenUrl = enriched?.tokenUrl ?? rawTokenUrl(raw.hederaId);
  const serialUrl = enriched?.serialUrl ?? rawSerialUrl(raw.hederaId, raw.serial);
  const image = enriched?.image ?? '';

  const imageDim = size === 'compact' ? 'h-10 w-10' : 'h-14 w-14';
  const nameTextClass = size === 'compact' ? 'text-xs font-semibold' : 'text-sm font-semibold';
  const collectionTextClass = size === 'compact' ? 'text-[10px]' : 'text-[11px]';
  const containerClass =
    size === 'compact'
      ? 'flex items-center gap-2 rounded border border-secondary bg-[#111113] p-1.5 pr-2'
      : 'flex items-center gap-3 rounded-lg border border-secondary bg-[#111113] p-2 pr-3';

  return (
    <div className={containerClass}>
      {/* Image (or placeholder with shimmer if loading) */}
      <a
        href={serialUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`relative block ${imageDim} shrink-0 overflow-hidden rounded bg-secondary`}
        title={`View #${raw.serial} on HashScan`}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={nftName}
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center ${
              loading ? 'animate-pulse' : ''
            } ${size === 'compact' ? 'text-sm' : 'text-lg'} text-muted`}
          >
            ?
          </div>
        )}
      </a>

      {/* Details */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <a
          href={serialUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`truncate ${nameTextClass} text-foreground hover:text-brand`}
          title={nftName}
        >
          {nftName}
        </a>
        <span className="flex items-center gap-1">
          <a
            href={tokenUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`truncate ${collectionTextClass} text-muted hover:text-foreground`}
            title={
              isEnriched && showNiceName
                ? `${enriched!.niceName} (${raw.hederaId})`
                : raw.hederaId
            }
          >
            {displayCollection}
          </a>
          {badge && (
            <span
              className={`inline-flex items-center gap-0.5 rounded border px-1 py-[1px] text-[9px] font-semibold ${badge.className}`}
              title={badge.tooltip}
            >
              <span>{badge.icon}</span>
              {size !== 'compact' && <span>{badge.label}</span>}
            </span>
          )}
          {!isEnriched && loading && (
            <span
              className="inline-flex h-3 w-12 animate-pulse rounded bg-secondary/60"
              title="Loading details"
            />
          )}
        </span>
      </div>
    </div>
  );
}

