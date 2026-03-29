import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategySchema } from './strategy.js';

describe('StrategySchema', () => {
  const validStrategy = {
    name: 'test',
    poolFilter: {
      type: 'all',
      feeToken: 'any',
      minPrizeCount: 1,
    },
    budget: {
      maxSpendPerSession: 50,
      maxSpendPerPool: 25,
      maxEntriesPerPool: 5,
      reserveBalance: 5,
      currency: 'LAZY',
    },
    playStyle: {
      action: 'buy_and_roll',
      entriesPerBatch: 2,
      claimImmediately: true,
      transferToOwner: true,
    },
  };

  it('parses a valid strategy', () => {
    const result = StrategySchema.parse(validStrategy);
    assert.equal(result.name, 'test');
    assert.equal(result.budget.maxSpendPerSession, 50);
    assert.equal(result.playStyle.action, 'buy_and_roll');
  });

  it('applies defaults for optional fields', () => {
    const result = StrategySchema.parse(validStrategy);
    assert.equal(result.schedule.enabled, false);
    assert.equal(result.schedule.cron, '0 */6 * * *');
    assert.equal(result.schedule.maxSessionsPerDay, 4);
    assert.equal(result.playStyle.minExpectedValue, -Infinity);
    assert.equal(result.playStyle.ownerAddress, undefined);
  });

  it('rejects missing required fields', () => {
    assert.throws(() => {
      StrategySchema.parse({ name: 'bad' });
    });
  });

  it('rejects invalid enum values', () => {
    assert.throws(() => {
      StrategySchema.parse({
        ...validStrategy,
        poolFilter: { ...validStrategy.poolFilter, type: 'invalid' },
      });
    });
  });

  it('rejects negative budget values', () => {
    assert.throws(() => {
      StrategySchema.parse({
        ...validStrategy,
        budget: { ...validStrategy.budget, maxSpendPerSession: -10 },
      });
    });
  });

  it('accepts all three built-in actions', () => {
    for (const action of ['buy', 'buy_and_roll', 'buy_and_redeem']) {
      const result = StrategySchema.parse({
        ...validStrategy,
        playStyle: { ...validStrategy.playStyle, action },
      });
      assert.equal(result.playStyle.action, action);
    }
  });

  it('accepts both currency options', () => {
    for (const currency of ['HBAR', 'LAZY']) {
      const result = StrategySchema.parse({
        ...validStrategy,
        budget: { ...validStrategy.budget, currency },
      });
      assert.equal(result.budget.currency, currency);
    }
  });

  it('parses strategy files from disk', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));

    for (const name of ['conservative', 'balanced', 'aggressive']) {
      const path = resolve(__dirname, '..', '..', 'strategies', `${name}.json`);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const result = StrategySchema.parse(raw);
      assert.equal(result.name, name);
    }
  });
});
