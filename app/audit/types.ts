/**
 * Types used across the audit page + its testable helpers.
 *
 * Kept in their own file so helpers.ts can import without pulling in
 * the client-component surface of page.tsx (which would force the
 * helpers file to be 'use client' and fail in Node test context).
 */

export type V2SessionStatus =
  | 'closed_success'
  | 'closed_aborted'
  | 'in_flight'
  | 'orphaned'
  | 'corrupt';
