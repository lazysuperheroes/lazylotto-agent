/**
 * withStore — route wrapper that guarantees store.flush() runs before
 * the response is returned to the client AND that no error escapes the
 * wrapper to Vercel's runtime.
 *
 * Two responsibilities:
 *
 * 1. **Flush guarantee.** RedisStore uses a fire-and-forget write-
 *    through cache: mutations update the in-memory cache synchronously
 *    and enqueue an async Redis write in a `pending[]` array. If the
 *    Vercel Lambda freezes immediately after `return response`, pending
 *    writes can be silently dropped. We await `store.flush()` between
 *    the handler logic and the response return.
 *
 * 2. **Last-resort error catch.** If the inner handler throws (or any
 *    code path inside a route's try/catch escapes — e.g. an error
 *    inside a catch block), we don't want Vercel to serve its generic
 *    /500 HTML page. We catch everything, log the full stack trace
 *    via console.error (which surfaces in Vercel function logs), and
 *    return a JSON response with the error message so the client gets
 *    something parseable instead of an HTML wall.
 *
 *    This was added after we spent hours diagnosing a tools/call 500
 *    that was hitting Vercel's /500 page instead of our route's
 *    catch — turns out the inner SDK was throwing in a path the
 *    route's try/catch didn't cover. With this wrapper in place, the
 *    next time something escapes we get a real error message in the
 *    response body, not generic HTML.
 *
 * Usage:
 *   export const POST = withStore(async (request) => {
 *     // your existing handler body
 *     return NextResponse.json({ ok: true });
 *   });
 *
 * Non-mutating GET handlers don't need this — they can call getStore()
 * directly. (But they're free to use it for the error catch alone.)
 */

import { NextResponse } from 'next/server';
import { getStore } from './store';
import { staticCorsHeaders } from './cors';
import { assertProductionRedis } from '~/auth/redis';

const FALLBACK_CORS = staticCorsHeaders('GET, POST, DELETE, OPTIONS');

type RouteHandler = (request: Request) => Promise<Response | NextResponse>;

export function withStore(handler: RouteHandler): RouteHandler {
  return async (request: Request) => {
    // F3: refuse to serve any request in production without Upstash configured.
    // Throws PRODUCTION_REDIS_REQUIRED — the catch below converts it to 503
    // with a clear message in the response body and a stack trace in
    // Vercel function logs. We choose 503 rather than 500 because the
    // condition is a misconfiguration, not a code bug — the deploy is
    // unhealthy until Upstash creds are added.
    try {
      assertProductionRedis();
    } catch (err) {
      console.error('[withStore] production-redis preflight failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: message },
        {
          status: 503,
          headers: { ...FALLBACK_CORS, 'Content-Type': 'application/json' },
        },
      );
    }

    let response: Response | NextResponse | undefined;
    let caught: unknown;
    try {
      response = await handler(request);
    } catch (err) {
      // Log the FULL stack so it shows up in Vercel function logs.
      // The serialized JSON in the response body has the message;
      // the stack lives in the logs for the operator to grab from
      // the Vercel dashboard.
      console.error('[withStore] uncaught handler error:', err);
      caught = err;
    } finally {
      // Flush even if the handler threw — any writes it made before
      // the throw still need to land in Redis.
      try {
        const store = await getStore();
        await store.flush();
      } catch (flushErr) {
        console.warn('[withStore] flush failed:', flushErr);
      }
    }
    if (response) return response;
    // We caught an error from the handler. Return a JSON response
    // with the message instead of letting the throw propagate to
    // Vercel's /500 HTML page.
    const message =
      caught instanceof Error ? caught.message : String(caught);
    const stack = caught instanceof Error ? caught.stack : undefined;
    return NextResponse.json(
      {
        error: message,
        // Stack only in non-production for safety. Production gets
        // just the message — operators can grep Vercel logs for the
        // full trace via console.error above.
        ...(process.env.NODE_ENV !== 'production' && stack
          ? { stack }
          : {}),
      },
      {
        status: 500,
        headers: { ...FALLBACK_CORS, 'Content-Type': 'application/json' },
      },
    );
  };
}
