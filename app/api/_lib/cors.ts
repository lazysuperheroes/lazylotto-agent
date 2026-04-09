/**
 * Shared CORS helpers — central source of truth for allowed origins.
 *
 * AUTH_PAGE_ORIGIN may be a single origin or a comma-separated list.
 *
 * Security posture:
 *   - Production with a valid allow list → that list is the truth
 *   - Production with wildcard '*' → rejected (fail closed), treated as empty
 *   - Production with EMPTY/unset → fail closed to "no cross-origin allowed"
 *     (same-origin requests still work because browsers don't send an
 *     Origin header for those). Logs a loud warning at boot so the
 *     operator sees it in Vercel function logs and knows to fix it.
 *   - Development with empty → wildcard '*' for convenience
 *
 * ── Why we no longer throw at module load ──────────────────────
 *
 * Previously, `getAllowList` threw during module initialization if
 * AUTH_PAGE_ORIGIN was unset in production. That produces a NICE
 * fail-closed posture in theory, but in practice it was a catastrophic
 * failure mode: every API route imports this module transitively via
 * `_lib/auth`, so a missing env var on a cold-start Lambda instance
 * caused Next.js to serve its generic HTML /500 page on EVERY
 * request to EVERY route — and because the throw was at module-init,
 * the route's own try/catch and the withStore wrapper couldn't see
 * it. The failure was opaque in both the client network tab and
 * the Vercel function logs.
 *
 * Fail-closed is still the goal, but "crash the entire API" is the
 * wrong way to achieve it. The new behavior:
 *   1. Module loads successfully with an empty allow list
 *   2. A boot warning fires exactly once per process in production
 *      so the operator gets a loud signal in Vercel logs
 *   3. Per-request `isOriginAllowed()` returns false for cross-origin
 *      callers — same fail-closed result, graceful failure mode
 *   4. Same-origin requests (browser sends no Origin header) still
 *      work, so the dashboard on the same domain keeps functioning
 *      even with a misconfigured env var
 *
 * The actual Allow-Origin header echoed to a request is the first
 * matching entry from the allow list, never the literal env value
 * — so "https://a.com,https://b.com" sends back the matching origin
 * only, never both.
 */

function parseAllowList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Lazy-evaluated allow list. Computed once per process lifetime and
// cached. Never throws — an empty list means "fail closed" which
// per-request checks enforce via isOriginAllowed.
let cachedAllowList: string[] | null = null;
let bootWarned = false;

function getAllowList(): string[] {
  if (cachedAllowList !== null) return cachedAllowList;

  const raw = process.env.AUTH_PAGE_ORIGIN ?? '';
  const parsed = parseAllowList(raw);

  // Treat wildcard '*' as misconfigured in production. Strip it so the
  // per-request check falls through to the empty-list fail-closed path.
  // In dev we keep the wildcard for convenience.
  const isProd =
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== 'phase-production-build';
  const filtered =
    isProd && parsed.includes('*') ? parsed.filter((o) => o !== '*') : parsed;

  if (isProd && filtered.length === 0 && !bootWarned) {
    console.warn(
      '[CORS] AUTH_PAGE_ORIGIN is not set (or is only "*") in production. ' +
      'Cross-origin requests will be rejected by isOriginAllowed(). ' +
      'Same-origin requests still work. Set AUTH_PAGE_ORIGIN to a ' +
      'comma-separated list of allowed origins (e.g. ' +
      '"https://testnet-agent.lazysuperheroes.com") to enable cross-origin.',
    );
    bootWarned = true;
  }

  // In dev only, fall back to wildcard for convenience. In prod the
  // list stays empty and per-request checks fail closed.
  if (filtered.length === 0 && !isProd) {
    cachedAllowList = ['*'];
  } else {
    cachedAllowList = filtered;
  }

  return cachedAllowList;
}

/**
 * Choose the Access-Control-Allow-Origin value to echo back for a request.
 */
function originFor(request: Request): string {
  const list = getAllowList();
  if (list.includes('*')) return '*';

  const requestOrigin = request.headers.get('origin');
  if (requestOrigin && list.includes(requestOrigin)) {
    return requestOrigin;
  }

  return list[0] ?? '';
}

/**
 * Build CORS headers for a specific request.
 * Use this in route handlers when you want exact-match behavior.
 */
export function corsHeadersFor(request: Request, methods = 'GET, POST, OPTIONS'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': originFor(request),
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Vary': 'Origin',
  };
}

/**
 * Static CORS headers — used in module-level constants.
 *
 * The allow list is computed lazily on first access via getAllowList(),
 * which short-circuits during `next build` (NEXT_PHASE check) so the
 * production validation only fires when actually serving requests.
 */
export function staticCorsHeaders(methods = 'GET, POST, OPTIONS'): Record<string, string> {
  const list = getAllowList();
  const allowOrigin = list.includes('*') ? '*' : (list[0] ?? '');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Vary': 'Origin',
  };
}

/** True if the request's Origin header is in the allow list. */
export function isOriginAllowed(request: Request): boolean {
  const list = getAllowList();
  if (list.includes('*')) return true;
  const requestOrigin = request.headers.get('origin');
  if (!requestOrigin) return true; // non-browser caller
  return list.includes(requestOrigin);
}
