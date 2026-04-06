/**
 * Backwards-compatible re-export. The implementation lives in
 * `src/lib/locks.ts` so it can be shared between CLI code (refund,
 * MultiUserAgent) and Next.js API routes. Kept here so existing imports
 * from `../_lib/locks` continue to work without a churny rename.
 */

export {
  acquireUserLock,
  releaseUserLock,
  acquireOperatorLock,
  releaseOperatorLock,
} from '~/lib/locks';
