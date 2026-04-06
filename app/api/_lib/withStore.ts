/**
 * withStore — route wrapper that guarantees store.flush() runs before
 * the response is returned to the client.
 *
 * RedisStore uses a fire-and-forget write-through cache: mutations
 * update the in-memory cache synchronously and enqueue an async Redis
 * write in a `pending[]` array. If the Vercel Lambda freezes
 * immediately after `return response`, pending writes can be silently
 * dropped.
 *
 * Wrapping every mutating route with withStore() ensures flush() is
 * awaited between the handler logic and the response return, even if
 * the handler forgets to do it explicitly.
 *
 * Usage:
 *   export const POST = withStore(async (request) => {
 *     // your existing handler body
 *     return NextResponse.json({ ok: true });
 *   });
 *
 * Non-mutating GET handlers don't need this — they can call getStore()
 * directly.
 */

import type { NextResponse } from 'next/server';
import { getStore } from './store';

type RouteHandler = (request: Request) => Promise<Response | NextResponse>;

export function withStore(handler: RouteHandler): RouteHandler {
  return async (request: Request) => {
    let response: Response | NextResponse;
    try {
      response = await handler(request);
    } finally {
      // Flush even if the handler threw — we still want any writes it
      // made before the throw to land in Redis.
      try {
        const store = await getStore();
        await store.flush();
      } catch (err) {
        console.warn('[withStore] flush failed:', err);
      }
    }
    return response!;
  };
}
