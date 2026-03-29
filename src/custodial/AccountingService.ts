import {
  Client,
  TopicId,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';
import { getPrivateKey } from '../hedera/wallet.js';

// ── Types ────────────────────────────────────────────────────

export interface HCS20Operation {
  op: 'mint' | 'burn' | 'transfer';
  amt: string;
  from?: string;
  to?: string;
  memo?: string;
}

interface AccountingConfig {
  client: Client;
  tick: string;
  topicId?: string;
}

// ── Service ──────────────────────────────────────────────────

/**
 * Wraps HCS-20 on-chain accounting for the multi-user custodial agent.
 *
 * Every credit-affecting operation (deposit, withdrawal, rake, play session,
 * operator withdrawal) is recorded as an immutable HCS-20 message on a
 * Hedera Consensus Service topic. This provides a verifiable audit trail
 * that any third party can reconstruct from the public mirror node.
 *
 * If no topicId is configured (i.e., HCS-20 has not been deployed yet),
 * all record methods are safe no-ops so the agent can run in development
 * without on-chain accounting.
 */
export class AccountingService {
  private readonly client: Client;
  private readonly tick: string;
  private topicId: string | null;

  constructor(config: AccountingConfig) {
    this.client = config.client;
    this.tick = config.tick;
    this.topicId = config.topicId ?? null;
  }

  // ── Accessors ────────────────────────────────────────────

  getTopicId(): string | null {
    return this.topicId;
  }

  // ── Deployment ───────────────────────────────────────────

  /**
   * One-time setup: create an HCS topic and submit the HCS-20 deploy message.
   *
   * The agent's operator key is set as both the admin key and submit key so
   * that only the agent can write accounting records.
   *
   * @param name  - Human-readable token name (e.g. "LazyLotto Credits")
   * @param maxSupply - Maximum supply for the HCS-20 token
   * @returns The newly created topic ID as a string (e.g. "0.0.12345")
   */
  async deploy(name: string, maxSupply: string): Promise<string> {
    const adminKey = getPrivateKey();

    const topicTx = new TopicCreateTransaction()
      .setAdminKey(adminKey)
      .setSubmitKey(adminKey);

    const topicResponse = await topicTx.execute(this.client);
    const topicReceipt = await topicResponse.getReceipt(this.client);
    const newTopicId = topicReceipt.topicId;

    if (!newTopicId) {
      throw new Error('TopicCreateTransaction succeeded but returned no topicId');
    }

    this.topicId = newTopicId.toString();

    // Submit the HCS-20 deploy message
    const deployMessage = JSON.stringify({
      p: 'hcs-20',
      op: 'deploy',
      name,
      tick: this.tick,
      max: maxSupply,
      lim: maxSupply,
    });

    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(deployMessage)
      .execute(this.client);

    return this.topicId;
  }

  // ── Individual Operations ────────────────────────────────

  /**
   * Record a user deposit as an HCS-20 mint.
   *
   * The deposit transaction ID is included in the memo field so it can
   * be correlated with the on-chain LAZY token transfer.
   */
  async recordDeposit(
    userAccountId: string,
    amount: number,
    depositTxId: string,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'mint',
      tick: this.tick,
      amt: String(amount),
      to: userAccountId,
      memo: `deposit:${depositTxId}`,
    });
  }

  /**
   * Record a rake fee as an HCS-20 transfer from user to agent.
   */
  async recordRake(
    userAccountId: string,
    agentAccountId: string,
    amount: number,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'transfer',
      tick: this.tick,
      amt: String(amount),
      from: userAccountId,
      to: agentAccountId,
      memo: 'rake',
    });
  }

  /**
   * Record a user withdrawal as an HCS-20 burn.
   */
  async recordWithdrawal(
    userAccountId: string,
    amount: number,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'burn',
      tick: this.tick,
      amt: String(amount),
      from: userAccountId,
      memo: 'withdrawal',
    });
  }

  /**
   * Record an operator (agent) withdrawal as an HCS-20 burn.
   *
   * This covers the case where the agent operator withdraws accumulated
   * rake fees from the platform balance.
   */
  async recordOperatorWithdrawal(
    agentAccountId: string,
    amount: number,
  ): Promise<void> {
    await this.submitMessage({
      p: 'hcs-20',
      op: 'burn',
      tick: this.tick,
      amt: String(amount),
      from: agentAccountId,
      memo: 'operator_withdrawal',
    });
  }

  // ── Batched Operations ───────────────────────────────────

  /**
   * Record a play session as a single batched HCS-20 message.
   *
   * Play sessions typically involve multiple burns (entry fees, gas costs)
   * that logically belong together. Batching them in one consensus message
   * keeps the audit trail clean and reduces transaction costs.
   */
  async recordPlaySession(
    sessionId: string,
    operations: HCS20Operation[],
  ): Promise<void> {
    const batchMessage = {
      p: 'hcs-20',
      op: 'batch',
      tick: this.tick,
      sessionId,
      operations: operations.map((op) => ({
        ...op,
        tick: this.tick,
      })),
      timestamp: new Date().toISOString(),
    };

    await this.submitMessage(batchMessage);
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Submit a JSON message to the HCS-20 topic.
   *
   * If no topic is configured, logs a warning and returns without throwing.
   * This allows the agent to operate without on-chain accounting during
   * development or before the HCS-20 token has been deployed.
   */
  private async submitMessage(payload: Record<string, unknown>): Promise<void> {
    if (!this.topicId) {
      console.warn(
        `[AccountingService] No HCS-20 topic configured — skipping record: ${payload.op}`,
      );
      return;
    }

    const message = JSON.stringify(payload);

    await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(message)
      .execute(this.client);
  }
}
