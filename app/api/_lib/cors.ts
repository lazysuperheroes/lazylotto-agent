/**
 * Shared CORS helpers — central source of truth for allowed origins.
 *
 * AUTH_PAGE_ORIGIN may be a single origin or a comma-separated list.
 * In production (NODE_ENV=production):
 *   - If unset, throws at module load (fail closed)
 *   - Wildcard '*' is rejected (fail closed)
 *
 * In development:
 *   - Falls back to '*' for convenience
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

// Lazy-evaluated allow list. We can't validate at module load because
// Next.js executes route modules during `next build` for page-data
// collection, BEFORE Vercel injects env vars. Validation happens on
// first request (production) and is cached.
let cachedAllowList: string[] | null = null;
let validated = false;

function getAllowList(): string[] {
  if (cachedAllowList !== null) return cachedAllowList;

  const raw = process.env.AUTH_PAGE_ORIGIN ?? '';
  cachedAllowList = parseAllowList(raw);

  // Validate once per process, only when actually serving requests
  // (NODE_ENV is production AND env var is missing/wildcard).
  // The build phase has NEXT_PHASE='phase-production-build' set;
  // we skip validation during the build itself.
  if (
    !validated &&
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    if (cachedAllowList.length === 0) {
      throw new Error(
        '[CORS] AUTH_PAGE_ORIGIN must be set in production. ' +
        'Set it to a comma-separated list of allowed origins.',
      );
    }
    if (cachedAllowList.includes('*')) {
      throw new Error(
        '[CORS] Wildcard "*" is not allowed for AUTH_PAGE_ORIGIN in production. ' +
        'Specify explicit origins instead.',
      );
    }
    validated = true;
  }

  // In dev (or during build), fall back to wildcard for convenience
  if (cachedAllowList.length === 0) {
    cachedAllowList = ['*'];
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
