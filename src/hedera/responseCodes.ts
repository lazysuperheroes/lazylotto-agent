/**
 * Whitelist of Hedera mirror-node `result` strings that represent a
 * CONFIRMED on-chain failure. The verifiers (`verifyUncertainRefunds`,
 * `verifyUncertainWithdrawals`, etc.) use this to decide whether a
 * non-`SUCCESS` result is safe to treat as confirmed-failure (release
 * the held claim / reserve) or whether it might be a transient state
 * we don't recognise (treat as NOT_FOUND so the next reconcile pass
 * re-checks).
 *
 * Audit finding H8: previously the dispatch was
 * `tx.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED'`. Any unexpected
 * mirror response — `'OK'`, `'UNKNOWN'`, `'PENDING'`, a typo, or a
 * future-introduced lag-state code — would be treated as confirmed
 * failure. With the held claim released, a retry would run; if the
 * original tx actually landed, the retry double-spends.
 *
 * Source: `hedera-protobufs` ResponseCodeEnum. We list only codes
 * that mean the transaction reached consensus and reverted (or was
 * rejected with finality). Anything not on this list defaults to
 * NOT_FOUND.
 *
 * Conservative principle: false NOT_FOUND just delays resolution;
 * false FAILED double-spends. Prefer NOT_FOUND when in doubt.
 */
export const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  // Insufficient funds / fees on the payer or sender side
  'INSUFFICIENT_TX_FEE',
  'INSUFFICIENT_PAYER_BALANCE',
  'INSUFFICIENT_ACCOUNT_BALANCE',
  'INSUFFICIENT_TOKEN_BALANCE',
  'INSUFFICIENT_GAS',

  // Contract execution failures
  'CONTRACT_REVERT_EXECUTED',
  'CONTRACT_EXECUTION_EXCEPTION',
  'INVALID_SOLIDITY_ADDRESS',
  'INVALID_CONTRACT_ID',

  // Account / token state failures
  'INVALID_ACCOUNT_ID',
  'INVALID_TOKEN_ID',
  'TOKEN_NOT_ASSOCIATED_TO_ACCOUNT',
  'ACCOUNT_FROZEN_FOR_TOKEN',
  'ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN',
  'TOKEN_IS_PAUSED',
  'TOKEN_IS_DELETED',
  'ACCOUNT_DELETED',
  'INVALID_RECEIVING_NODE_ACCOUNT',
  'INVALID_PAYER_SIGNATURE',
  'INVALID_SIGNATURE',
  'KEY_REQUIRED',
  'PAYER_ACCOUNT_NOT_FOUND',

  // Tx lifecycle failures
  'TRANSACTION_EXPIRED',
  'INVALID_TRANSACTION_START',
  'INVALID_TRANSACTION_DURATION',
  'TRANSACTION_OVERSIZE',
  'INVALID_NODE_ACCOUNT',
  'TRANSACTION_HAS_UNKNOWN_FIELDS',
  'DUPLICATE_TRANSACTION',

  // Authorisation / permissions
  'AUTHORIZATION_FAILED',
  'BUSY',
  'NOT_SUPPORTED',
  'INVALID_TRANSACTION_BODY',
  'INVALID_TRANSACTION',

  // Crypto-specific
  'INVALID_TRANSFER_ACCOUNT_AMOUNTS',
  'INVALID_ACCOUNT_AMOUNTS',
  'ACCOUNT_REPEATED_IN_ACCOUNT_AMOUNTS',
  'TRANSFERS_NOT_ZERO_SUM_FOR_TOKEN',
  'NEGATIVE_ALLOWANCE_AMOUNT',
  'INVALID_ALLOWANCE_OWNER_ID',
  'AMOUNT_LESS_THAN_MIN',

  // Contract-storage failures
  'INVALID_FILE_ID',
  'INVALID_TOKEN_DECIMALS',
  'INVALID_TOKEN_BURN_AMOUNT',
]);

/**
 * Three-way classifier for a mirror-node `result` field. Used by every
 * `verifyUncertain*` function in src/custodial/uncertainTxVerification.ts
 * and src/hedera/refund.ts so the dispatch is consistent.
 */
export type MirrorResult = 'SUCCESS' | 'FAILED' | 'NOT_FOUND';

export function classifyMirrorResult(rawResult: string | undefined): MirrorResult {
  if (rawResult === 'SUCCESS') return 'SUCCESS';
  if (rawResult && KNOWN_FAILURE_CODES.has(rawResult)) return 'FAILED';
  // Conservative default: unknown, lag-state, or empty → re-check next pass.
  return 'NOT_FOUND';
}
