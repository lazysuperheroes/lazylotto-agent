/**
 * Operator-paging helper for the worst-case state during a receipt-uncertain
 * catch: the on-chain action MAY have landed, AND the dead-letter
 * write that's supposed to anchor the recovery just failed.
 *
 * Without an external page (Slack / Discord webhook), the operator
 * has no way to know they need to manually reconstruct the recovery
 * state — the held reserve / claim sits invisibly until the TTL
 * expires and silently double-spends on retry.
 *
 * Reuses the existing `RECONCILE_FAILURE_WEBHOOK_URL` env, so
 * operators only configure one alert path.
 */

import { logger } from './logger.js';

export interface EscalateUncertainDlInput {
  kind:
    | 'refund_uncertain'
    | 'withdrawal_uncertain'
    | 'operator_fee_withdraw_uncertain'
    | 'play_uncertain';
  /** The submitted on-chain tx whose status is unknown. */
  uncertainTxId: string;
  /** Affected userId (omit for operator-fee). */
  userId?: string;
  /** The original error that prevented dead-letter write. */
  cause: unknown;
}

export async function escalateUncertainDlFailure(
  input: EscalateUncertainDlInput,
): Promise<void> {
  const url = process.env.RECONCILE_FAILURE_WEBHOOK_URL;
  if (!url) return;

  const rawCauseMsg =
    input.cause instanceof Error
      ? input.cause.message
      : String(input.cause);

  // F5 (2026-05-06 audit I-13): neutralize Discord-style group
  // mentions in the cause message. Discord webhooks accept
  // `@everyone`/`@here` even in `{ text }` payloads unless
  // `allowed_mentions` is set; an attacker who can influence the
  // cause string (via mirror response, request-body echo, etc.)
  // would otherwise ping the whole alert channel. Insert a
  // zero-width joiner between `@` and `everyone`/`here`/`<role>`
  // so the literal still reads but Discord doesn't expand it.
  const causeMsg = rawCauseMsg.replace(
    /@(everyone|here|[!&]?\d+)/g,
    '@​$1',
  );

  // Slack + Discord both accept `{ text }` shape. Plain text avoids
  // formatting injection. `allowed_mentions: { parse: [] }` is
  // Discord-specific belt-and-braces (Slack ignores it).
  const text =
    `:rotating_light: LazyLotto: ${input.kind} dead-letter write FAILED. ` +
    `On-chain tx ${input.uncertainTxId} status is UNKNOWN and the ` +
    `recovery anchor was lost. ` +
    (input.userId ? `User: ${input.userId}. ` : '') +
    `Cause: ${causeMsg}. ` +
    `Manual triage required — verify the tx on the mirror node and ` +
    `reconstruct the dead-letter row by hand.`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    // Last resort — log it. There is nothing left to escalate to.
    logger.error('escalateUncertainDlFailure: webhook fire failed', {
      component: 'Escalation',
      event: 'uncertain_dl_escalation_webhook_failed',
      kind: input.kind,
      uncertainTxId: input.uncertainTxId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
