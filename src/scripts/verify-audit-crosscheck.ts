/**
 * R2-FG-3 / R2-FG-4: phantom-mint and phantom-burn cross-check helpers
 * for `verify-audit.ts`. Extracted as a separate module so unit tests
 * can import the validators without triggering `verify-audit.ts`'s
 * `main()` side-effect.
 *
 * Pure validators that compare HCS-20 mint/burn audit messages against
 * the corresponding on-chain transactions fetched from a Hedera mirror
 * node. Each call appends zero or more `AuditAlert`s to the supplied
 * accumulator. The MirrorTxCache + TokenDecimalsCache here also drive
 * the parallel-fetch / dedup behaviour that keeps cross-check cost
 * sub-linear on busy topics.
 */

export interface MirrorTransfer {
  account: string;
  amount: number;
}
export interface MirrorTokenTransfer {
  token_id: string;
  account: string;
  amount: number;
}
export interface MirrorTxResult {
  found: boolean;
  result?: string;
  /** Mirror format: `seconds.nanos` as a string. */
  consensusTimestamp?: string;
  transfers?: MirrorTransfer[];
  tokenTransfers?: MirrorTokenTransfer[];
  /** Set on transient/network errors so the caller can flag `unverified`. */
  error?: string;
}

export type AlertCategory =
  | 'phantom_mint'
  | 'phantom_mint_amount_mismatch'
  | 'phantom_mint_wrong_recipient'
  | 'phantom_mint_outflow'
  | 'phantom_mint_temporal'
  | 'phantom_burn'
  | 'phantom_burn_amount_mismatch'
  | 'phantom_burn_wrong_sender'
  | 'phantom_burn_inflow'
  | 'phantom_burn_pre_f18'
  | 'phantom_burn_temporal'
  | 'force_release'
  | 'force_release_override'
  | 'play_uncertain_success_pending_triage'
  | 'killswitch_enabled'
  | 'killswitch_disabled'
  | 'unverified';

export interface AuditAlert {
  severity: 'critical' | 'warning' | 'info';
  category: AlertCategory;
  message: string;
}

/**
 * Per-tx mirror node cache. Cross-check cost on large topics is
 * dominated by mirror round-trips; without dedup + parallelism the
 * verifier walks O(N) txs sequentially. With this cache repeat
 * fetches share a single promise and `warmMany` issues batches of
 * `concurrency` parallel requests.
 *
 * The `fetcher` argument is injectable so tests can stub mirror
 * responses without touching the network.
 */
export type MirrorFetcher = (txId: string) => Promise<MirrorTxResult>;

export class MirrorTxCache {
  private cache = new Map<string, Promise<MirrorTxResult>>();
  private hits = 0;

  constructor(private readonly fetcher: MirrorFetcher) {}

  fetch(txId: string): Promise<MirrorTxResult> {
    const existing = this.cache.get(txId);
    if (existing) {
      this.hits++;
      return existing;
    }
    const p = this.fetcher(txId);
    this.cache.set(txId, p);
    return p;
  }

  async warmMany(txIds: readonly string[], concurrency = 10): Promise<void> {
    const unique = Array.from(new Set(txIds));
    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      await Promise.all(batch.map((id) => this.fetch(id)));
    }
  }

  get cacheHits(): number {
    return this.hits;
  }
}

/**
 * Build a `MirrorFetcher` that hits a real mirror node base URL.
 */
export function realMirrorFetcher(mirrorBase: string): MirrorFetcher {
  return async (txId: string): Promise<MirrorTxResult> => {
    const url = `${mirrorBase}/transactions/${encodeURIComponent(txId)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 404) return { found: false };
      if (!res.ok) return { found: false, error: `mirror ${res.status}` };
      const body = (await res.json()) as {
        transactions?: Array<{
          result?: string;
          consensus_timestamp?: string;
          transfers?: MirrorTransfer[];
          token_transfers?: MirrorTokenTransfer[];
        }>;
      };
      const tx = body.transactions?.[0];
      if (!tx) return { found: false };
      return {
        found: true,
        result: tx.result,
        consensusTimestamp: tx.consensus_timestamp,
        transfers: tx.transfers ?? [],
        tokenTransfers: tx.token_transfers ?? [],
      };
    } catch (e) {
      return { found: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export type DecimalsLookup = (tokenId: string) => Promise<number | null>;

export class TokenDecimalsCache {
  private cache = new Map<string, Promise<number | null>>();

  constructor(private readonly fetcher: DecimalsLookup) {}

  get(tokenId: string): Promise<number | null> {
    const existing = this.cache.get(tokenId);
    if (existing) return existing;
    const p = this.fetcher(tokenId);
    this.cache.set(tokenId, p);
    return p;
  }
}

export function realDecimalsLookup(mirrorBase: string): DecimalsLookup {
  return async (tokenId: string): Promise<number | null> => {
    if (tokenId === 'HBAR') return 8;
    try {
      const res = await fetch(`${mirrorBase}/tokens/${encodeURIComponent(tokenId)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { decimals?: string | number };
      const dec = body.decimals;
      if (typeof dec === 'string') {
        const n = parseInt(dec, 10);
        return Number.isFinite(n) ? n : null;
      }
      if (typeof dec === 'number') return dec;
      return null;
    } catch {
      return null;
    }
  };
}

export function toBaseUnits(amt: number, decimals: number | null): number | null {
  if (decimals === null) return null;
  return Math.round(amt * Math.pow(10, decimals));
}

export function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

export function consensusToSeconds(ts: string | undefined): number | null {
  if (!ts) return null;
  const dot = ts.indexOf('.');
  const sec = dot < 0 ? Number(ts) : Number(ts.slice(0, dot));
  if (!Number.isFinite(sec)) return null;
  return sec;
}

export interface MintCrossCheckInput {
  sequence: number;
  timestamp: string;
  depositTxId: string;
  user: string;
  amount: number;
  token: string;
}

export async function validateMintCrossCheck(
  dep: MintCrossCheckInput,
  tx: MirrorTxResult,
  decimalsCache: TokenDecimalsCache,
  agentAccountId: string | null,
  alerts: AuditAlert[],
): Promise<void> {
  if (!tx.found) {
    if (tx.error) {
      alerts.push({
        severity: 'warning',
        category: 'unverified',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} cross-check failed: ${tx.error}`,
      });
      return;
    }
    alerts.push({
      severity: 'critical',
      category: 'phantom_mint',
      message:
        `seq=${dep.sequence} mint claims depositTxId=${dep.depositTxId} for ${dep.amount} ${dep.token} ` +
        `to user=${dep.user} but the mirror node has NO record of it (404). ` +
        `Possible phantom mint — operator must justify or auditor refuses to validate.`,
    });
    return;
  }

  if (tx.result !== 'SUCCESS') {
    alerts.push({
      severity: 'critical',
      category: 'phantom_mint',
      message:
        `seq=${dep.sequence} mint claims depositTxId=${dep.depositTxId} but the mirror result is ` +
        `'${tx.result ?? 'missing'}', not SUCCESS — the credit has no on-chain backing.`,
    });
    return;
  }

  const txSec = consensusToSeconds(tx.consensusTimestamp);
  const msgSec = Math.floor(Date.parse(dep.timestamp) / 1000);
  if (txSec !== null && Number.isFinite(msgSec)) {
    const drift = msgSec - txSec;
    if (drift < -60 || drift > 300) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_mint_temporal',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} consensus=${tx.consensusTimestamp} is ` +
          `outside the [-5min, +60s] window of the message at ${dep.timestamp} (drift=${drift}s). ` +
          `Either the operator stitched an old tx into a fresh mint or the audit message was delayed beyond ` +
          `the acceptance window.`,
      });
    }
  }

  if (dep.token === 'HBAR') {
    const expectedTinybars = Math.round(dep.amount * 1e8);
    const incoming = (tx.transfers ?? []).filter((t) => t.amount > 0);
    if (incoming.length === 0) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_mint_outflow',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} claims ${dep.amount} HBAR to ` +
          `${dep.user} but the on-chain tx has NO incoming HBAR transfer. ` +
          `Possible phantom credit (e.g. memo-only tx).`,
      });
      return;
    }
    const matchAmount = incoming.find((t) => approxEqual(t.amount, expectedTinybars));
    if (!matchAmount) {
      const sums = incoming.map((t) => `${t.account}=${t.amount}`).join(', ');
      alerts.push({
        severity: 'critical',
        category: 'phantom_mint_amount_mismatch',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} claims ${dep.amount} HBAR ` +
          `(${expectedTinybars} tinybars) but the on-chain tx had no incoming transfer of that size. ` +
          `Incoming: [${sums}].`,
      });
      return;
    }
    if (agentAccountId !== null && matchAmount.account !== agentAccountId) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_mint_wrong_recipient',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} delivered ${dep.amount} HBAR to ` +
          `${matchAmount.account}, NOT to the agent ${agentAccountId}. ` +
          `Topic claims a credit that didn't reach the custodian — operator must justify.`,
      });
    }
    return;
  }

  const decimals = await decimalsCache.get(dep.token);
  const expected = toBaseUnits(dep.amount, decimals);
  const tt = (tx.tokenTransfers ?? []).filter((t) => t.token_id === dep.token);
  if (tt.length === 0) {
    alerts.push({
      severity: 'critical',
      category: 'phantom_mint',
      message:
        `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} claims ${dep.amount} ${dep.token} ` +
        `but the on-chain tx has NO token_transfer for that token id.`,
    });
    return;
  }
  const incoming = tt.filter((t) => t.amount > 0);
  if (incoming.length === 0) {
    alerts.push({
      severity: 'critical',
      category: 'phantom_mint_outflow',
      message:
        `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} claims ${dep.amount} ${dep.token} ` +
        `but every on-chain token_transfer for ${dep.token} is an outflow.`,
    });
    return;
  }
  if (expected !== null) {
    const matchAmount = incoming.find((t) => approxEqual(t.amount, expected));
    if (!matchAmount) {
      const sums = incoming.map((t) => `${t.account}=${t.amount}`).join(', ');
      alerts.push({
        severity: 'critical',
        category: 'phantom_mint_amount_mismatch',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} claims ${dep.amount} ${dep.token} ` +
          `(${expected} base units) but the on-chain tx had no incoming transfer of that size. ` +
          `Incoming: [${sums}].`,
      });
      return;
    }
    if (agentAccountId !== null && matchAmount.account !== agentAccountId) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_mint_wrong_recipient',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} delivered ${dep.amount} ${dep.token} ` +
          `to ${matchAmount.account}, NOT to the agent ${agentAccountId}.`,
      });
    }
    return;
  }
  if (agentAccountId !== null) {
    const toAgent = incoming.find((t) => t.account === agentAccountId);
    if (!toAgent) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_mint_wrong_recipient',
        message:
          `seq=${dep.sequence} mint depositTxId=${dep.depositTxId} for ${dep.amount} ${dep.token} ` +
          `had no incoming token_transfer to the agent ${agentAccountId} (decimals unknown so the ` +
          `amount check is skipped, but the recipient check still applies).`,
      });
    }
  }
}

export interface BurnCrossCheckInput {
  sequence: number;
  timestamp: string;
  withdrawTxId: string;
  recipient: string | null;
  amount: number;
  token: string;
  kind: 'user_withdrawal' | 'operator_withdrawal';
}

export async function validateBurnCrossCheck(
  burn: BurnCrossCheckInput,
  tx: MirrorTxResult,
  decimalsCache: TokenDecimalsCache,
  agentAccountId: string | null,
  alerts: AuditAlert[],
): Promise<void> {
  if (!tx.found) {
    if (tx.error) {
      alerts.push({
        severity: 'warning',
        category: 'unverified',
        message:
          `seq=${burn.sequence} burn withdrawTxId=${burn.withdrawTxId} cross-check failed: ${tx.error}`,
      });
      return;
    }
    alerts.push({
      severity: 'critical',
      category: 'phantom_burn',
      message:
        `seq=${burn.sequence} ${burn.kind} claims withdrawTxId=${burn.withdrawTxId} for ${burn.amount} ` +
        `${burn.token}${burn.recipient ? ` to ${burn.recipient}` : ''} but the mirror node has NO record of it. ` +
        `Possible phantom burn — operator may have fabricated a debit.`,
    });
    return;
  }

  if (tx.result !== 'SUCCESS') {
    alerts.push({
      severity: 'critical',
      category: 'phantom_burn',
      message:
        `seq=${burn.sequence} ${burn.kind} claims withdrawTxId=${burn.withdrawTxId} but the mirror result is ` +
        `'${tx.result ?? 'missing'}', not SUCCESS — the debit has no on-chain backing.`,
    });
    return;
  }

  const txSec = consensusToSeconds(tx.consensusTimestamp);
  const msgSec = Math.floor(Date.parse(burn.timestamp) / 1000);
  if (txSec !== null && Number.isFinite(msgSec)) {
    const drift = msgSec - txSec;
    if (drift < -60 || drift > 300) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_burn_temporal',
        message:
          `seq=${burn.sequence} ${burn.kind} withdrawTxId=${burn.withdrawTxId} consensus=${tx.consensusTimestamp} ` +
          `is outside the [-5min, +60s] window of the burn message at ${burn.timestamp} (drift=${drift}s).`,
      });
    }
  }

  if (burn.token === 'HBAR') {
    const expectedTinybars = Math.round(burn.amount * 1e8);
    const transfers = tx.transfers ?? [];
    const outgoing = transfers.filter((t) => t.amount < 0);
    if (outgoing.length === 0) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_burn_inflow',
        message:
          `seq=${burn.sequence} ${burn.kind} claims withdrawTxId=${burn.withdrawTxId} for ${burn.amount} HBAR ` +
          `but the on-chain tx has NO outgoing HBAR transfer.`,
      });
      return;
    }
    const matchOutgoing = outgoing.find((t) => approxEqual(-t.amount, expectedTinybars));
    if (!matchOutgoing) {
      const sums = outgoing.map((t) => `${t.account}=${t.amount}`).join(', ');
      alerts.push({
        severity: 'critical',
        category: 'phantom_burn_amount_mismatch',
        message:
          `seq=${burn.sequence} ${burn.kind} claims ${burn.amount} HBAR (${expectedTinybars} tinybars) ` +
          `but the on-chain tx had no outgoing transfer of that size. Outgoing: [${sums}].`,
      });
      return;
    }
    if (agentAccountId !== null && matchOutgoing.account !== agentAccountId) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_burn_wrong_sender',
        message:
          `seq=${burn.sequence} ${burn.kind} debited ${burn.amount} HBAR from ${matchOutgoing.account}, ` +
          `NOT from the agent ${agentAccountId}. Topic claims a debit against an account the agent doesn't own.`,
      });
    }
    if (burn.kind === 'user_withdrawal' && burn.recipient) {
      const toUser = transfers.find(
        (t) => t.account === burn.recipient && approxEqual(t.amount, expectedTinybars),
      );
      if (!toUser) {
        alerts.push({
          severity: 'critical',
          category: 'phantom_burn',
          message:
            `seq=${burn.sequence} user_withdrawal claims ${burn.amount} HBAR went to ${burn.recipient} ` +
            `but the on-chain tx has no positive transfer of that size to that account.`,
        });
      }
    }
    return;
  }

  const decimals = await decimalsCache.get(burn.token);
  const expected = toBaseUnits(burn.amount, decimals);
  const tt = (tx.tokenTransfers ?? []).filter((t) => t.token_id === burn.token);
  if (tt.length === 0) {
    alerts.push({
      severity: 'critical',
      category: 'phantom_burn',
      message:
        `seq=${burn.sequence} ${burn.kind} claims ${burn.amount} ${burn.token} but the on-chain tx ` +
        `has NO token_transfer for that token id.`,
    });
    return;
  }
  const outgoing = tt.filter((t) => t.amount < 0);
  if (outgoing.length === 0) {
    alerts.push({
      severity: 'critical',
      category: 'phantom_burn_inflow',
      message:
        `seq=${burn.sequence} ${burn.kind} claims ${burn.amount} ${burn.token} debit but every ` +
        `on-chain token_transfer for ${burn.token} is an inflow.`,
    });
    return;
  }
  if (expected !== null) {
    const matchOutgoing = outgoing.find((t) => approxEqual(-t.amount, expected));
    if (!matchOutgoing) {
      const sums = outgoing.map((t) => `${t.account}=${t.amount}`).join(', ');
      alerts.push({
        severity: 'critical',
        category: 'phantom_burn_amount_mismatch',
        message:
          `seq=${burn.sequence} ${burn.kind} claims ${burn.amount} ${burn.token} (${expected} base units) ` +
          `but the on-chain tx had no outgoing token_transfer of that size. Outgoing: [${sums}].`,
      });
      return;
    }
    if (agentAccountId !== null && matchOutgoing.account !== agentAccountId) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_burn_wrong_sender',
        message:
          `seq=${burn.sequence} ${burn.kind} debited ${burn.amount} ${burn.token} from ${matchOutgoing.account}, ` +
          `NOT from the agent ${agentAccountId}.`,
      });
    }
    if (burn.kind === 'user_withdrawal' && burn.recipient) {
      const incoming = tt.filter((t) => t.amount > 0);
      const toUser = incoming.find(
        (t) => t.account === burn.recipient && approxEqual(t.amount, expected),
      );
      if (!toUser) {
        alerts.push({
          severity: 'critical',
          category: 'phantom_burn',
          message:
            `seq=${burn.sequence} user_withdrawal claims ${burn.amount} ${burn.token} went to ${burn.recipient} ` +
            `but the on-chain tx has no positive token_transfer of that size to that account.`,
        });
      }
    }
    return;
  }
  if (agentAccountId !== null) {
    const fromAgent = outgoing.find((t) => t.account === agentAccountId);
    if (!fromAgent) {
      alerts.push({
        severity: 'critical',
        category: 'phantom_burn_wrong_sender',
        message:
          `seq=${burn.sequence} ${burn.kind} for ${burn.amount} ${burn.token} had no outgoing ` +
          `token_transfer from the agent ${agentAccountId} (decimals unknown so the amount check is ` +
          `skipped, but the sender check still applies).`,
      });
    }
  }
}
