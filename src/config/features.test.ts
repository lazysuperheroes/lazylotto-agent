import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFeatureConfig, isX402Active } from './features.js';

/** Run `fn` with env vars patched, restoring the prior values afterward. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k]!;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

// revert-proof: every new surface MUST default OFF, so a prod deploy with unset
// env never silently enables the chat interface or the x402 payment gate.
test('feature flags default OFF when env is unset', () => {
  withEnv({ CHAT_ENABLED: undefined, X402_ENABLED: undefined }, () => {
    const cfg = loadFeatureConfig();
    assert.equal(cfg.chat.enabled, false);
    assert.equal(cfg.x402.enabled, false);
  });
});

// revert-proof: a flag flips on ONLY for the exact string 'true' (not '1'/'yes'),
// so a stray truthy-ish value can't accidentally enable a surface.
test('flags require the exact string "true"', () => {
  withEnv({ CHAT_ENABLED: '1' }, () =>
    assert.equal(loadFeatureConfig().chat.enabled, false),
  );
  withEnv({ CHAT_ENABLED: 'true' }, () =>
    assert.equal(loadFeatureConfig().chat.enabled, true),
  );
});

// revert-proof: x402 stays inactive (serve transparently, no 402) if enabled but
// no payTo is configured — never 402 with nowhere to send funds.
test('isX402Active requires BOTH the flag AND a payTo', () => {
  withEnv(
    { X402_ENABLED: 'true', X402_PAY_TO: '', HEDERA_ACCOUNT_ID: undefined },
    () => assert.equal(isX402Active(), false),
  );
  withEnv({ X402_ENABLED: 'true', X402_PAY_TO: '0.0.123' }, () =>
    assert.equal(isX402Active(), true),
  );
});

// revert-proof: USD-denominated rake-holiday defaults are $5.00 / 30d / 0.97.
test('rake holiday defaults: $5.00, 30 days, 0.97 slippage', () => {
  withEnv(
    {
      X402_RAKE_HOLIDAY_PRICE_USD_CENTS: undefined,
      X402_RAKE_HOLIDAY_DAYS: undefined,
      X402_PRICE_MIN_ACCEPTED_FRACTION: undefined,
    },
    () => {
      const rh = loadFeatureConfig().x402.rakeHoliday;
      assert.equal(rh.priceUsdCents, 500);
      assert.equal(rh.durationDays, 30);
      assert.equal(rh.minAcceptedFraction, 0.97);
    },
  );
});

// revert-proof: chat model defaults to the cheapest capable tier (Haiku 4.5,
// owner decision); still configurable via CHAT_MODEL.
test('chat model defaults to claude-haiku-4-5', () => {
  withEnv({ CHAT_MODEL: undefined }, () =>
    assert.equal(loadFeatureConfig().chat.model, 'claude-haiku-4-5'),
  );
});

// revert-proof: chat cost guardrails MUST have conservative defaults so a demo
// can't blow its budget — output-token cap, input cap, history trim, step cap,
// and a per-user daily message cap. Loosening these is a deliberate, explicit
// act, not an accident.
test('chat cost guardrails have conservative defaults', () => {
  withEnv(
    {
      CHAT_MAX_OUTPUT_TOKENS: undefined,
      CHAT_MAX_INPUT_CHARS: undefined,
      CHAT_MAX_HISTORY_MESSAGES: undefined,
      CHAT_MAX_STEPS: undefined,
      CHAT_DAILY_MESSAGE_LIMIT: undefined,
    },
    () => {
      const chat = loadFeatureConfig().chat;
      assert.equal(chat.maxOutputTokens, 800);
      assert.equal(chat.maxInputChars, 1200);
      assert.equal(chat.maxHistoryMessages, 10);
      assert.equal(chat.maxSteps, 4);
      assert.equal(chat.dailyMessageLimit, 40);
    },
  );
});

// revert-proof: a present-but-EMPTY env key (as in a .env copied from
// .env.example, e.g. `X402_MIRROR_NODE_URL=`) MUST fall back to the default, not
// resolve to "". Plain `?? ` doesn't catch ""; the env() helper does. This
// guards the relative-URL fetch crash that broke the x402 gate during UAT.
test('empty-string env keys fall back to defaults (not "")', () => {
  withEnv(
    {
      HEDERA_NETWORK: 'testnet',
      X402_MIRROR_NODE_URL: '',
      X402_USDC_TOKEN_ID: '',
      X402_FEE_PAYER: '',
      X402_FACILITATOR_URL: '',
      CHAT_MODEL: '',
    },
    () => {
      const cfg = loadFeatureConfig();
      assert.equal(cfg.x402.mirrorNodeUrl, 'https://testnet.mirrornode.hedera.com');
      assert.equal(cfg.x402.usdcTokenId, '0.0.429274');
      assert.equal(cfg.x402.feePayer, '0.0.7162784');
      assert.equal(cfg.x402.facilitatorUrl, 'https://api.testnet.blocky402.com');
      assert.equal(cfg.chat.model, 'claude-haiku-4-5');
    },
  );
});
