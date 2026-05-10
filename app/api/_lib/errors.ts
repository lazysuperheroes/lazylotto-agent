/**
 * R9-FG-13 / Phase-7 Cluster F: centralized error → API response
 * mapping for typed-sentinel errors thrown by the agent core.
 *
 * Pre-Phase-7 the admin/MCP/REST callers caught typed errors
 * (`RefundDuplicateError`, `InFlightClaimError`) generically and
 * returned `error: err.message` with status 500. The Phase-6
 * compile-time exhaustiveness baked into the `kind` discriminants
 * never reached the operator-facing UI. Same Refund 500 for "wait
 * 60s and retry" and "permanent ban — call SREM to unblock".
 *
 * This helper inspects the error and returns a structured payload:
 *   - `error`: human-readable message (existing contract).
 *   - `code`: machine-stable category ('REFUND_DUPLICATE',
 *             'CLAIM_IN_FLIGHT', etc.) for client branching.
 *   - `kind`: the discriminant from the typed error.
 *   - `retryable`: whether a retry might succeed (for in-progress
 *                  states) vs. requires admin intervention (for
 *                  permanent states).
 *   - `status`: the HTTP status code to use (409 for retryable
 *               duplicate, 422 for permanent, 503 for redis blip,
 *               500 for unknown).
 */

import { RefundDuplicateError } from '~/hedera/refund';
import { InFlightClaimError } from '~/custodial/MultiUserAgent';

export interface MappedErrorResponse {
  status: number;
  body: {
    error: string;
    code?: string;
    kind?: string;
    retryable?: boolean;
  };
}

export function mapErrorToResponse(err: unknown): MappedErrorResponse {
  if (err instanceof RefundDuplicateError) {
    // 'in-progress' is transient (sibling Lambda mid-flight); 422
    // for everything else (operator action required).
    const retryable = err.kind === 'in-progress';
    return {
      status: retryable ? 409 : 422,
      body: {
        error: err.message,
        code: 'REFUND_DUPLICATE',
        kind: err.kind,
        retryable,
      },
    };
  }
  if (err instanceof InFlightClaimError) {
    return {
      status: 409,
      body: {
        error: err.message,
        code: 'CLAIM_IN_FLIGHT',
        retryable: true,
      },
    };
  }
  return {
    status: 500,
    body: {
      error: err instanceof Error ? err.message : String(err),
    },
  };
}
