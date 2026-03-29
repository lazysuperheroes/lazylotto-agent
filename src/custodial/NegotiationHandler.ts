import { Client, TopicId, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import type { PersistentStore } from './PersistentStore.js';
import type {
  NegotiationMessage,
  CustodialConfig,
  UserAccount,
  UserBalances,
  PlaySessionResult,
} from './types.js';
import { emptyBalances } from './types.js';
import { StrategySchema, type Strategy } from '../config/strategy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Constants ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const AVAILABLE_STRATEGIES = ['conservative', 'balanced', 'aggressive'] as const;

// ── NegotiationHandler ─────────────────────────────────────────

/**
 * Handles user registration (MCP/CLI path) and HCS-10 notification
 * delivery for the multi-user custodial lottery agent.
 *
 * Registration creates a UserAccount with a unique deposit memo and
 * a frozen strategy snapshot. Notifications are sent as HCS-10 messages
 * on the user's connection topic (if one exists). Notification failures
 * are logged but never block the caller.
 */
export class NegotiationHandler {
  constructor(
    private readonly client: Client,
    private readonly store: PersistentStore,
    private readonly config: CustodialConfig,
    private readonly agentAccountId: string,
  ) {}

  // ── Registration (MCP / CLI path) ───────────────────────────

  /**
   * Register a new user or return an existing one.
   *
   * @param hederaAccountId - The user's Hedera account (e.g. "0.0.12345")
   * @param eoaAddress      - EOA address (0.0.X or 0x format)
   * @param strategyName    - One of "conservative", "balanced", "aggressive"
   * @param rakePercent     - Optional override for the rake percentage
   * @returns The created (or existing) UserAccount
   */
  async registerUser(
    hederaAccountId: string,
    eoaAddress: string,
    strategyName: string,
    rakePercent?: number,
  ): Promise<UserAccount> {
    // 1. Validate EOA format
    if (!this.isValidEoa(eoaAddress)) {
      throw new Error(
        `Invalid EOA address "${eoaAddress}": expected 0.0.X or 0x hex address`,
      );
    }

    // 2. Check for existing registration
    const existing = this.store.getUserByAccountId(hederaAccountId);
    if (existing) {
      return existing;
    }

    // 3. Validate and load strategy
    if (!this.isAvailableStrategy(strategyName)) {
      throw new Error(
        `Unknown strategy "${strategyName}". Available: ${AVAILABLE_STRATEGIES.join(', ')}`,
      );
    }

    const strategy = this.loadStrategy(strategyName);

    // 4. Resolve rake
    const resolvedRake = this.validateRake(
      rakePercent ?? this.config.rake.defaultPercent,
    );

    // 5. Generate deposit memo
    const memo = this.generateDepositMemo();

    // 6. Build UserAccount
    const user: UserAccount = {
      userId: randomUUID(),
      depositMemo: memo,
      hederaAccountId,
      eoaAddress,
      strategyName: strategy.name,
      strategyVersion: strategy.version,
      strategySnapshot: strategy,
      rakePercent: resolvedRake,
      balances: emptyBalances(),
      connectionTopicId: null,
      registeredAt: new Date().toISOString(),
      lastPlayedAt: null,
      active: true,
    };

    // 7. Persist
    this.store.saveUser(user);

    // 8. Return
    return user;
  }

  // ── HCS-10 Messaging ────────────────────────────────────────

  /**
   * Send a JSON notification to a user's HCS-10 connection topic.
   *
   * The message is wrapped in the standard HCS-10 envelope:
   * ```json
   * { "p": "hcs-10", "op": "message", "data": "<inner JSON>", "connection_topic_id": "0.0.xyz" }
   * ```
   *
   * Failures are logged as warnings and never re-thrown so that
   * notification delivery cannot break the main agent flow.
   */
  async sendToUser(
    connectionTopicId: string,
    msg: NegotiationMessage,
  ): Promise<void> {
    const message = JSON.stringify({
      p: 'hcs-10',
      op: 'message',
      data: JSON.stringify(msg),
      connection_topic_id: connectionTopicId,
    });

    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(connectionTopicId))
      .setMessage(message)
      .execute(this.client);
  }

  // ── Notification Helpers ────────────────────────────────────

  /**
   * Notify a user about the results of their play session.
   * No-op if the user has no connection topic.
   */
  async notifyPlayResult(
    user: UserAccount,
    session: PlaySessionResult,
  ): Promise<void> {
    if (!user.connectionTopicId) return;

    try {
      await this.sendToUser(user.connectionTopicId, {
        type: 'play_result',
        session,
        newBalance: user.balances,
      });
    } catch (err) {
      console.warn(
        `[NegotiationHandler] Failed to notify play result for user ${user.userId}:`,
        err,
      );
    }
  }

  /**
   * Notify a user that their deposit has been confirmed and credited.
   * No-op if the user has no connection topic.
   */
  async notifyDepositConfirmed(
    user: UserAccount,
    grossAmount: number,
    rakeAmount: number,
    netCredited: number,
    newBalance: UserBalances,
  ): Promise<void> {
    if (!user.connectionTopicId) return;

    try {
      await this.sendToUser(user.connectionTopicId, {
        type: 'deposit_confirmed',
        grossAmount,
        rakeAmount,
        netCredited,
        newBalance,
      });
    } catch (err) {
      console.warn(
        `[NegotiationHandler] Failed to notify deposit confirmed for user ${user.userId}:`,
        err,
      );
    }
  }

  /**
   * Notify a user that their withdrawal has been processed.
   * No-op if the user has no connection topic.
   */
  async notifyWithdrawalConfirmed(
    user: UserAccount,
    amount: number,
    transactionId: string,
    newBalance: UserBalances,
  ): Promise<void> {
    if (!user.connectionTopicId) return;

    try {
      await this.sendToUser(user.connectionTopicId, {
        type: 'withdrawal_confirmed',
        amount,
        transactionId,
        newBalance,
      });
    } catch (err) {
      console.warn(
        `[NegotiationHandler] Failed to notify withdrawal confirmed for user ${user.userId}:`,
        err,
      );
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  /**
   * Returns the list of built-in strategy names that users can choose from.
   */
  getAvailableStrategies(): string[] {
    return [...AVAILABLE_STRATEGIES];
  }

  /**
   * Clamp a proposed rake percentage to the configured [min, max] range.
   */
  validateRake(proposed: number): number {
    return Math.min(
      this.config.rake.maxPercent,
      Math.max(this.config.rake.minPercent, proposed),
    );
  }

  /**
   * Calculate the rake based on the intended deposit/play volume.
   * Larger commitments get lower rates. Returns the best tier the
   * user qualifies for, clamped to the configured band.
   */
  rakeForVolume(intendedAmount: number): number {
    const tiers = this.config.rake.volumeTiers;
    // Tiers are sorted highest minDeposit first
    for (const tier of tiers) {
      if (intendedAmount >= tier.minDeposit) {
        return this.validateRake(tier.rakePercent);
      }
    }
    return this.config.rake.defaultPercent;
  }

  /**
   * Generate a unique deposit memo in the format "ll-<12 hex chars>".
   */
  generateDepositMemo(): string {
    return 'll-' + randomBytes(16).toString('hex');
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Load and validate a strategy JSON file from the strategies/ directory.
   */
  private loadStrategy(strategyName: string): Strategy {
    const stratPath = resolve(
      __dirname,
      '..',
      '..',
      'strategies',
      `${strategyName}.json`,
    );

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(stratPath, 'utf-8'));
    } catch (err) {
      throw new Error(
        `Failed to load strategy file "${stratPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return StrategySchema.parse(raw);
  }

  /**
   * Check whether a strategy name is one of the built-in options.
   */
  private isAvailableStrategy(name: string): name is (typeof AVAILABLE_STRATEGIES)[number] {
    return (AVAILABLE_STRATEGIES as readonly string[]).includes(name);
  }

  /**
   * Validate that an EOA address matches either the Hedera 0.0.X format
   * or a standard 0x hex address.
   */
  private isValidEoa(address: string): boolean {
    // Hedera account ID: 0.0.<digits>
    if (/^0\.0\.\d+$/.test(address)) return true;
    // Ethereum-style hex address: 0x followed by 40 hex chars
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return true;
    return false;
  }
}
