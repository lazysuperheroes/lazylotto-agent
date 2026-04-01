import { Client } from '@hashgraph/sdk';
import type { Strategy } from '../config/strategy.js';
import { HEDERA_DEFAULTS } from '../config/defaults.js';
import { getWalletInfo, getOperatorAccountId } from '../hedera/wallet.js';
import {
  getTokenBalances,
  getNfts,
  getTokenAllowances,
  type TokenBalance,
  type NftInfo,
  type TokenAllowance,
} from '../hedera/mirror.js';
import { getDelegatedNfts, getSerialsDelegatedTo } from '../hedera/delegates.js';
import { hbarToNumber, tokenBalanceToNumber } from '../utils/format.js';

// MCP client is optional — loaded lazily to avoid blocking module init
async function tryGetUserState(
  accountId: string
): Promise<{ pendingPrizesCount: number; boost: number | { rawBps: number; percent: number } } | null> {
  try {
    const { getUserState } = await import('../mcp/client.js');
    return await getUserState(accountId);
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────

export interface AuditResult {
  timestamp: string;
  network: string;

  wallet: {
    accountId: string;
    hbar: number;
    lazy: number | null;
    tokenAssociations: { tokenId: string; balance: number; decimals: number }[];
    nfts: { tokenId: string; serial: number }[];
  };

  boost: {
    totalBps: number;
    percent: number;
  } | null;

  delegation: {
    registryContractId: string;
    delegatedTokens: { tokenId: string; serials: number[] }[];
    totalDelegatedSerials: number;
  } | null;

  approvals: {
    tokenAllowances: {
      tokenId: string;
      spender: string;
      amount: number;
      amountGranted: number;
    }[];
  };

  strategy: {
    name: string;
    description?: string;
    budget: Strategy['budget'];
    playStyle: {
      action: string;
      entriesPerBatch: number;
      transferToOwner: boolean;
      ownerAddress?: string;
    };
    schedule: Strategy['schedule'];
  };

  owner: {
    eoa: string | null;
    source: string;
    isSet: boolean;
  };

  prizes: {
    pendingCount: number;
  } | null;

  contracts: {
    lazyLotto: string | null;
    storage: string | null;
    gasStation: string | null;
    delegateRegistry: string | null;
    lazyToken: string | null;
    lshTokens: string[];
  };

  hol: {
    registered: boolean;
    uaid: string | null;
    profileTopicId: string | null;
    inboundTopicId: string | null;
  } | null;

  warnings: string[];
  recommendations: string[];
}

// ── Helpers ───────────────────────────────────────────────────

function env(key: string): string | null {
  return process.env[key] || null;
}

// ── AuditReport ───────────────────────────────────────────────

export class AuditReport {
  private client: Client;
  private strategy: Strategy;

  constructor(client: Client, strategy: Strategy) {
    this.client = client;
    this.strategy = strategy;
  }

  async generate(): Promise<AuditResult> {
    const warnings: string[] = [];
    const recommendations: string[] = [];

    const accountId = getOperatorAccountId(this.client);
    const network = env('HEDERA_NETWORK') ?? 'testnet';

    // ── Wallet ──────────────────────────────────────────────
    let hbar = 0;
    let lazy: number | null = null;
    let tokens: TokenBalance[] = [];
    let nfts: NftInfo[] = [];

    try {
      const info = await getWalletInfo(this.client);
      hbar = hbarToNumber(info.hbarBalance);
      tokens = await getTokenBalances(accountId);
      nfts = await getNfts(accountId);

      const lazyTokenId = env('LAZY_TOKEN_ID');
      if (lazyTokenId) {
        lazy = tokenBalanceToNumber(tokens, lazyTokenId);
      }
    } catch (e) {
      warnings.push(`Failed to query wallet: ${e instanceof Error ? e.message : e}`);
    }

    // Balance warnings
    if (hbar < 5) {
      warnings.push(`Low HBAR balance (${hbar.toFixed(2)}). Agent may fail on gas fees.`);
    }
    // Check reserves for each budgeted token
    for (const [tokenKey, tb] of Object.entries(this.strategy.budget.tokenBudgets)) {
      if (tokenKey === 'hbar' && hbar < tb.reserve) {
        warnings.push(`HBAR balance (${hbar.toFixed(2)}) is below reserve (${tb.reserve}).`);
      }
      if (lazy !== null && tokenKey === env('LAZY_TOKEN_ID') && lazy < tb.reserve) {
        warnings.push(`LAZY balance (${lazy}) is below reserve (${tb.reserve}).`);
      }
    }
    if (network === 'mainnet') {
      warnings.push('Running on MAINNET. Ensure agent wallet has limited funding.');
    }

    // ── User State (cached for boost + prizes) ───────────────
    const userState = await tryGetUserState(accountId);

    // ── Boost ───────────────────────────────────────────────
    let boost: AuditResult['boost'] = null;
    if (userState) {
      // boost comes as { rawBps, percent } object or a plain number
      let boostBps: number;
      let boostPercent: number;
      if (typeof userState.boost === 'number') {
        boostBps = userState.boost;
        boostPercent = userState.boost / 1_000_000; // raw bps to percent
      } else {
        boostBps = userState.boost.rawBps ?? 0;
        boostPercent = userState.boost.percent ?? 0;
      }
      boost = { totalBps: boostBps, percent: boostPercent };
    }

    // ── Delegation ──────────────────────────────────────────
    let delegation: AuditResult['delegation'] = null;
    const registryId = env('DELEGATE_REGISTRY_ID');
    // Support comma-separated list of LSH token IDs (multiple collections)
    const lshTokenIdsRaw = env('LSH_TOKEN_IDS') ?? env('LSH_TOKEN_ID') ?? '';
    const lshTokenIds = lshTokenIdsRaw.split(',').map(s => s.trim()).filter(Boolean);

    if (registryId) {
      try {
        if (lshTokenIds.length > 0) {
          // Check each LSH collection for delegated serials
          const delegatedTokens: { tokenId: string; serials: number[] }[] = [];
          let totalSerials = 0;
          for (const tokenId of lshTokenIds) {
            try {
              const serials = await getSerialsDelegatedTo(
                this.client,
                registryId,
                accountId,
                tokenId
              );
              delegatedTokens.push({ tokenId, serials: serials.map(Number) });
              totalSerials += serials.length;
            } catch {
              console.warn(`  Failed to check delegation for ${tokenId}`);
            }
          }
          delegation = {
            registryContractId: registryId,
            delegatedTokens,
            totalDelegatedSerials: totalSerials,
          };
        } else {
          const result = await getDelegatedNfts(
            this.client,
            registryId,
            accountId
          );
          delegation = {
            registryContractId: registryId,
            delegatedTokens: result.tokens.map((token, i) => ({
              tokenId: token,
              serials: result.serials[i].map(Number),
            })),
            totalDelegatedSerials: result.serials.reduce(
              (sum, s) => sum + s.length,
              0
            ),
          };
        }
      } catch (e) {
        warnings.push(
          `Failed to query delegate registry: ${e instanceof Error ? e.message : e}`
        );
      }
    } else {
      recommendations.push(
        'Set DELEGATE_REGISTRY_ID in .env to check NFT delegation status.'
      );
    }

    // Smart boost recommendation based on both delegation and boost data
    const hasDelegatedNfts = delegation && delegation.totalDelegatedSerials > 0;
    const boostIsZero = boost && boost.totalBps === 0;
    if (hasDelegatedNfts && boostIsZero) {
      recommendations.push(
        `${delegation!.totalDelegatedSerials} NFT(s) delegated but on-chain boost is 0. ` +
          'The boost may require additional criteria (e.g., minimum LAZY balance, specific collections, or pool-level calculation).'
      );
    } else if (!hasDelegatedNfts && boostIsZero) {
      recommendations.push(
        'Win rate boost is 0 and no NFTs are delegated. Delegate LSH NFTs to this agent for a bonus win rate.'
      );
    }

    // ── Approvals ───────────────────────────────────────────
    let allowances: AuditResult['approvals']['tokenAllowances'] = [];
    try {
      const raw = await getTokenAllowances(accountId);
      allowances = raw.map((a) => ({
        tokenId: a.token_id,
        spender: a.spender,
        amount: a.amount,
        amountGranted: a.amount_granted,
      }));

      const gasStationId = env('LAZY_GAS_STATION_ID');
      const lazyTokenId = env('LAZY_TOKEN_ID');
      if (gasStationId && lazyTokenId) {
        const lazyApproval = raw.find(
          (a) => a.token_id === lazyTokenId && a.spender === gasStationId
        );
        if (!lazyApproval || lazyApproval.amount <= 0) {
          warnings.push('No LAZY allowance to GasStation. Run --setup first.');
        } else if (lazyApproval.amount < 100 * Math.pow(10, HEDERA_DEFAULTS.lazyDecimals)) {
          warnings.push(
            `Low LAZY allowance to GasStation (${lazyApproval.amount / Math.pow(10, HEDERA_DEFAULTS.lazyDecimals)}). Consider re-running --setup.`
          );
        }
      }
    } catch (e) {
      warnings.push(
        `Failed to query token allowances: ${e instanceof Error ? e.message : e}`
      );
    }

    // ── Owner ───────────────────────────────────────────────
    const ownerFromEnv = env('OWNER_EOA');
    const ownerFromStrategy = this.strategy.playStyle.ownerAddress;
    const ownerEoa = ownerFromEnv ?? ownerFromStrategy ?? null;
    const ownerSource = ownerFromEnv
      ? 'OWNER_EOA env var'
      : ownerFromStrategy
        ? 'strategy.playStyle.ownerAddress'
        : 'not configured';

    if (!ownerEoa) {
      warnings.push(
        'No owner address configured. Prizes cannot be transferred. Set OWNER_EOA in .env.'
      );
    } else if (this.strategy.playStyle.transferToOwner) {
      // Validate format
      const validHedera = /^0\.0\.\d+$/.test(ownerEoa);
      const validEvm = /^0x[0-9a-fA-F]{40}$/.test(ownerEoa);
      if (!validHedera && !validEvm) {
        warnings.push(
          `OWNER_EOA "${ownerEoa}" doesn't look like a valid Hedera or EVM address.`
        );
      }
    }

    if (this.strategy.playStyle.transferToOwner && !ownerEoa) {
      warnings.push(
        'transferToOwner is enabled but no owner address is set. Prizes will accumulate in agent wallet.'
      );
    }

    if (ownerEoa && ownerEoa === accountId) {
      warnings.push(
        'OWNER_EOA is the same as the agent wallet. Prize transfers would send to self (wasting gas).'
      );
    }

    // ── Prizes ──────────────────────────────────────────────
    let prizes: AuditResult['prizes'] = null;
    if (userState) {
      prizes = { pendingCount: userState.pendingPrizesCount };
      if (userState.pendingPrizesCount > 0) {
        recommendations.push(
          `${userState.pendingPrizesCount} pending prize(s). Run agent_transfer_prizes or --audit to claim.`
        );
      }
    }

    // ── HOL Registration ──────────────────────────────────────
    let hol: AuditResult['hol'] = null;
    try {
      const { loadAgentConfig } = await import('../hol/registry.js');
      const agentConfig = loadAgentConfig();
      if (agentConfig?.uaid) {
        hol = {
          registered: true,
          uaid: agentConfig.uaid,
          profileTopicId: agentConfig.profileTopicId,
          inboundTopicId: agentConfig.inboundTopicId,
        };
      } else {
        hol = { registered: false, uaid: null, profileTopicId: null, inboundTopicId: null };
        recommendations.push(
          'Agent not registered with HOL. Run --register to make it discoverable.'
        );
      }
    } catch {
      /* registry module load failed */
    }

    // ── General recommendations ─────────────────────────────
    if (tokens.length === 0) {
      recommendations.push('No token associations. Run --setup to associate LAZY token.');
    }

    return {
      timestamp: new Date().toISOString(),
      network,
      wallet: {
        accountId,
        hbar,
        lazy,
        tokenAssociations: tokens.map((t) => ({
          tokenId: t.token_id,
          balance: t.balance / Math.pow(10, t.decimals),
          decimals: t.decimals,
        })),
        nfts: nfts.map((n) => ({
          tokenId: n.token_id,
          serial: n.serial_number,
        })),
      },
      boost,
      delegation,
      approvals: { tokenAllowances: allowances },
      strategy: {
        name: this.strategy.name,
        description: this.strategy.description,
        budget: this.strategy.budget,
        playStyle: {
          action: this.strategy.playStyle.action,
          entriesPerBatch: this.strategy.playStyle.entriesPerBatch,
          transferToOwner: this.strategy.playStyle.transferToOwner,
          ownerAddress: this.strategy.playStyle.ownerAddress,
        },
        schedule: this.strategy.schedule,
      },
      owner: {
        eoa: ownerEoa,
        source: ownerSource,
        isSet: ownerEoa !== null,
      },
      prizes,
      contracts: {
        lazyLotto: env('LAZYLOTTO_CONTRACT_ID'),
        storage: env('LAZYLOTTO_STORAGE_ID'),
        gasStation: env('LAZY_GAS_STATION_ID'),
        delegateRegistry: registryId,
        lazyToken: env('LAZY_TOKEN_ID'),
        lshTokens: lshTokenIds,
      },
      hol,
      warnings,
      recommendations,
    };
  }

  print(result: AuditResult): void {
    const W = 50;
    const line = '='.repeat(W);
    const thin = '-'.repeat(W);

    console.log(`\n${line}`);
    console.log('  LazyLotto Agent — Audit Report');
    console.log(`${line}`);
    console.log(`Timestamp: ${result.timestamp}`);
    console.log(`Network:   ${result.network}`);

    // Wallet
    console.log(`\n${thin}`);
    console.log('WALLET');
    console.log(`${thin}`);
    console.log(`  Account:  ${result.wallet.accountId}`);
    console.log(`  HBAR:     ${result.wallet.hbar.toFixed(4)}`);
    if (result.wallet.lazy !== null) {
      console.log(`  LAZY:     ${result.wallet.lazy}`);
    }
    if (result.wallet.tokenAssociations.length > 0) {
      console.log('  Tokens:');
      for (const t of result.wallet.tokenAssociations) {
        console.log(`    ${t.tokenId}: ${t.balance}`);
      }
    }
    if (result.wallet.nfts.length > 0) {
      console.log(`  NFTs held: ${result.wallet.nfts.length}`);
      for (const n of result.wallet.nfts) {
        console.log(`    ${n.tokenId} #${n.serial}`);
      }
    }

    // Boost
    console.log(`\n${thin}`);
    console.log('WIN RATE BOOST');
    console.log(`${thin}`);
    if (result.boost) {
      console.log(`  Boost: ${result.boost.percent}% (${result.boost.totalBps} raw bps)`);
    } else {
      console.log('  Boost: unavailable (MCP not connected)');
    }

    // Delegation
    console.log(`\n${thin}`);
    console.log('DELEGATION');
    console.log(`${thin}`);
    if (result.delegation) {
      console.log(`  Registry: ${result.delegation.registryContractId}`);
      console.log(`  Total delegated serials: ${result.delegation.totalDelegatedSerials}`);
      for (const dt of result.delegation.delegatedTokens) {
        if (dt.serials.length > 0) {
          console.log(`    ${dt.tokenId}: serials ${dt.serials.join(', ')}`);
        }
      }
      if (result.delegation.totalDelegatedSerials === 0) {
        console.log('  No NFTs delegated to this agent.');
      }
    } else {
      console.log('  Delegation check skipped (DELEGATE_REGISTRY_ID not set)');
    }

    // Approvals
    console.log(`\n${thin}`);
    console.log('APPROVALS');
    console.log(`${thin}`);
    if (result.approvals.tokenAllowances.length > 0) {
      for (const a of result.approvals.tokenAllowances) {
        console.log(`  ${a.tokenId} -> ${a.spender}: ${a.amount}`);
      }
    } else {
      console.log('  No token allowances found.');
    }

    // Strategy
    console.log(`\n${thin}`);
    console.log('STRATEGY');
    console.log(`${thin}`);
    console.log(`  Name:       ${result.strategy.name}`);
    if (result.strategy.description) {
      console.log(`  Desc:       ${result.strategy.description}`);
    }
    console.log(`  Action:     ${result.strategy.playStyle.action}`);
    console.log(`  Entries:    ${result.strategy.playStyle.entriesPerBatch} per batch`);
    console.log('  Budgets:');
    for (const [token, tb] of Object.entries(result.strategy.budget.tokenBudgets)) {
      const label = token === 'hbar' ? 'HBAR' : token;
      console.log(`    ${label}: ${tb.maxPerSession}/session, ${tb.maxPerPool}/pool, reserve ${tb.reserve}`);
    }
    if (result.strategy.budget.usd) {
      console.log(`    USD cap: $${result.strategy.budget.usd.maxPerSession}/session`);
    }
    console.log(`  Transfer:   ${result.strategy.playStyle.transferToOwner ? 'enabled' : 'disabled'}`);

    // Owner
    console.log(`\n${thin}`);
    console.log('PRIZE DESTINATION');
    console.log(`${thin}`);
    if (result.owner.isSet) {
      console.log(`  Owner:  ${result.owner.eoa}`);
      console.log(`  Source: ${result.owner.source}`);
    } else {
      console.log('  Owner: NOT CONFIGURED');
    }

    // Prizes
    if (result.prizes) {
      console.log(`  Pending: ${result.prizes.pendingCount} prize(s)`);
    }

    // Contracts
    console.log(`\n${thin}`);
    console.log('CONTRACTS');
    console.log(`${thin}`);
    const c = result.contracts;
    if (c.lazyLotto) console.log(`  LazyLotto:  ${c.lazyLotto}`);
    if (c.storage) console.log(`  Storage:    ${c.storage}`);
    if (c.gasStation) console.log(`  GasStation: ${c.gasStation}`);
    if (c.lazyToken) console.log(`  LAZY Token: ${c.lazyToken}`);
    if (c.lshTokens.length > 0) console.log(`  LSH Tokens: ${c.lshTokens.join(', ')}`);
    if (c.delegateRegistry) console.log(`  Delegate:   ${c.delegateRegistry}`);

    // HOL Registration
    if (result.hol) {
      console.log(`\n${thin}`);
      console.log('HOL REGISTRY');
      console.log(`${thin}`);
      if (result.hol.registered) {
        console.log(`  UAID:     ${result.hol.uaid}`);
        console.log(`  Profile:  ${result.hol.profileTopicId}`);
        if (result.hol.inboundTopicId) {
          console.log(`  Inbound:  ${result.hol.inboundTopicId}`);
        }
      } else {
        console.log('  Not registered. Run --register to make this agent discoverable.');
      }
    }

    // Warnings
    if (result.warnings.length > 0) {
      console.log(`\n${line}`);
      console.log(`  WARNINGS (${result.warnings.length})`);
      console.log(`${line}`);
      for (const w of result.warnings) {
        console.log(`  [!] ${w}`);
      }
    }

    // Recommendations
    if (result.recommendations.length > 0) {
      console.log(`\n${thin}`);
      console.log(`RECOMMENDATIONS`);
      console.log(`${thin}`);
      for (const r of result.recommendations) {
        console.log(`  -> ${r}`);
      }
    }

    console.log(`\n${line}\n`);
  }
}
