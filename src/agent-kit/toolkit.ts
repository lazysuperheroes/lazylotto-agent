import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { AgentMode } from '@hashgraph/hedera-agent-kit';
import {
  coreAccountQueryPlugin,
  coreTokenQueryPlugin,
  coreConsensusQueryPlugin,
  coreTransactionQueryPlugin,
  coreMiscQueriesPlugin,
} from '@hashgraph/hedera-agent-kit/plugins';
import { HederaAIToolkit } from '@hashgraph/hedera-agent-kit-ai-sdk';
import { createLazyLottoPlugin } from './plugin.js';

let cachedClient: Client | null = null;

/**
 * Build (and cache per warm Lambda) the kit's `@hiero-ledger/sdk` Client for the
 * agent wallet. We build it from `@hiero-ledger/sdk` — the SAME package the kit
 * imports — so no Client object ever crosses between our app's `@hashgraph/sdk`
 * and the kit (no `instanceof` impedance). The read-only query plugins use this
 * client; value movement never does.
 */
function getHieroClient(): Client {
  if (cachedClient) return cachedClient;
  const isMainnet = (process.env.HEDERA_NETWORK ?? 'testnet') === 'mainnet';
  const client = isMainnet ? Client.forMainnet() : Client.forTestnet();
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const key = process.env.HEDERA_PRIVATE_KEY;
  if (accountId && key) {
    // Mirror src/hedera/wallet.ts: the agent key is DER-encoded.
    client.setOperator(accountId, PrivateKey.fromStringDer(key));
  }
  cachedClient = client;
  return client;
}

export interface BuildChatToolkitOptions {
  /** Deployment origin, used by the custodial plugin to reach /api/mcp. */
  origin: string;
  /** The signed-in user's session token, threaded into every custodial call. */
  authToken: string;
  /**
   * Include the confirmed `multi_user_play` tool (CHAT_ALLOW_PLAY). Default
   * false. Even when true, the mutating surface is ONLY our own audited-path
   * play tool — the kit's mutating core plugins are still never loaded.
   */
  allowPlay?: boolean;
}

/**
 * Build a per-request Agent Kit toolkit whose ENTIRE tool surface is:
 *   - read-only Hedera `*Query` plugins (no value movement), AND
 *   - the LazyLotto custodial plugin (routes value ops through the audited MCP
 *     path with user-tier auth).
 *
 * The four MUTATING core plugins (`coreAccountPlugin`, `coreTokenPlugin`,
 * `coreConsensusPlugin`, `coreEVMPlugin`) are NEVER loaded — so the chat LLM has
 * NO kit tool that can move value. That exclusion is the structural security
 * guarantee; see src/agent-kit/toolkit.test.ts.
 */
export function buildChatToolkit(opts: BuildChatToolkitOptions): HederaAIToolkit {
  return new HederaAIToolkit({
    client: getHieroClient(),
    configuration: {
      plugins: [
        coreAccountQueryPlugin,
        coreTokenQueryPlugin,
        coreConsensusQueryPlugin,
        coreTransactionQueryPlugin,
        coreMiscQueriesPlugin,
        createLazyLottoPlugin({
          origin: opts.origin,
          authToken: opts.authToken,
          allowPlay: opts.allowPlay,
        }),
      ],
      context: {
        mode: AgentMode.AUTONOMOUS,
        accountId: process.env.HEDERA_ACCOUNT_ID,
      },
    },
  });
}
