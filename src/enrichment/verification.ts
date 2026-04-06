/**
 * Token verification + nice-name overlay.
 *
 * Mirrors the dApp's pattern from
 * lazy-dapp-v3/src/services/core/checkVerification.ts — the Verification
 * Directus collection overlays on-chain mirror node data with human-curated
 * display names and a 4-tier trust level.
 *
 * Display rules (from the enrichment guide):
 *   - Only verified tiers (lazysuperheroes, complete) show niceName inline
 *   - simple / unverified show the raw 0.0.X so we don't imply legitimacy
 *   - Each tier gets a distinct badge visual on the consumer side
 */

export type VerificationLevel = 'lazysuperheroes' | 'complete' | 'simple' | 'unverified';

export interface VerificationInfo {
  /** Human-friendly name for the token (e.g. "Lazy Superheroes"). */
  niceName: string;
  /** Trust level — determines badge style on the frontend. */
  verificationLevel: VerificationLevel;
}

interface VerificationRow {
  environment?: string;
  type?: string;
  category?: string;
  value?: string;
  niceName?: string;
  url?: string;
  verificationLevel?: VerificationLevel;
}

// ── Directus config ─────────────────────────────────────────────

const DIRECTUS_URL = 'https://directus-production-62f4.up.railway.app';
const VERIFICATION_TABLE = process.env.VERIFICATION_TABLE ?? 'Verification';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Module-level cache ──────────────────────────────────────────
// Map<hederaId "0.0.X", VerificationInfo> for the current environment.
// Refreshed every 5 minutes per warm Lambda instance.

let verificationMap: Map<string, VerificationInfo> = new Map();
let lastFetchedAt = 0;
let inflight: Promise<void> | null = null;

function getEnvironment(): string {
  return (process.env.HEDERA_NETWORK ?? 'testnet').toLowerCase();
}

/**
 * Full fetch of the Verification table for the current environment.
 * Paginates 100 rows at a time.
 */
async function refreshVerificationMap(): Promise<void> {
  const environment = getEnvironment();
  const fresh = new Map<string, VerificationInfo>();

  let offset = 0;
  const pageSize = 100;
  const safetyCap = 50; // max 5000 rows

  for (let page = 0; page < safetyCap; page++) {
    const filter = encodeURIComponent(
      JSON.stringify({ environment: { _eq: environment } }),
    );
    const fields = 'value,niceName,verificationLevel,type';
    const url =
      `${DIRECTUS_URL}/items/${VERIFICATION_TABLE}` +
      `?filter=${filter}&fields=${fields}&limit=${pageSize}&offset=${offset}`;

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`[verification] refresh failed: ${res.status}`);
      return;
    }

    const body = (await res.json()) as { data?: VerificationRow[] };
    const rows = body.data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!row.value || !row.verificationLevel) continue;
      fresh.set(row.value, {
        niceName: row.niceName ?? row.value,
        verificationLevel: row.verificationLevel,
      });
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  verificationMap = fresh;
  lastFetchedAt = Date.now();
  console.log(`[verification] loaded ${fresh.size} entries for ${environment}`);
}

/**
 * Ensure the verification map is loaded and not stale.
 * Coalesces concurrent refreshes via the inflight promise.
 */
async function ensureFresh(): Promise<void> {
  const age = Date.now() - lastFetchedAt;
  if (age < REFRESH_INTERVAL_MS && verificationMap.size > 0) return;

  if (!inflight) {
    inflight = refreshVerificationMap().finally(() => {
      inflight = null;
    });
  }
  await inflight;
}

/**
 * Look up verification info for a single token ID.
 * Returns `unverified` with raw hederaId as niceName if not found.
 */
export async function getVerificationInfo(hederaId: string): Promise<VerificationInfo> {
  await ensureFresh();
  return (
    verificationMap.get(hederaId) ?? {
      niceName: hederaId,
      verificationLevel: 'unverified',
    }
  );
}

/**
 * Look up verification info for multiple token IDs in a single pass.
 * More efficient than calling getVerificationInfo in a loop.
 */
export async function getVerificationInfoBatch(
  hederaIds: string[],
): Promise<Map<string, VerificationInfo>> {
  await ensureFresh();
  const result = new Map<string, VerificationInfo>();
  for (const id of hederaIds) {
    result.set(
      id,
      verificationMap.get(id) ?? {
        niceName: id,
        verificationLevel: 'unverified',
      },
    );
  }
  return result;
}

/**
 * Determine whether a niceName should be displayed inline.
 * Rule: only verified tiers (lazysuperheroes, complete) show the friendly name.
 * simple/unverified fall back to the raw hederaId to avoid implying legitimacy.
 */
export function shouldShowNiceName(level: VerificationLevel): boolean {
  return level === 'lazysuperheroes' || level === 'complete';
}

/** Test helper. */
export function clearVerificationCache(): void {
  verificationMap = new Map();
  lastFetchedAt = 0;
  inflight = null;
}
