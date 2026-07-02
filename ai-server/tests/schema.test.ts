import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWeightBps, validateCanonicalBasket } from '../src/schema.js';
import { relevanceScore, type PolymarketMarket } from '../src/polymarket.js';

test('normalizes 40/30/30 weights to exactly 10,000 bps', () => {
  const result = normalizeWeightBps([40, 30, 30]);
  assert.deepEqual(result, [4000, 3000, 3000]);
  assert.equal(result.reduce((sum, value) => sum + value, 0), 10_000);
});

test('distributes rounding remainder deterministically', () => {
  const result = normalizeWeightBps([1, 1, 1]);
  assert.deepEqual(result, [3334, 3333, 3333]);
});

test('rejects a canonical basket whose basis points do not total 10,000', () => {
  assert.throws(() => validateCanonicalBasket({
    name: 'Invalid',
    markets: [{
      marketId: '123',
      question: 'Test market?',
      outcome: 'YES',
      weightBps: 9999,
    }],
  }), /must total 10000/);
});

test('does not confuse a generic high-value market with a Bitcoin thesis', () => {
  const base: Omit<PolymarketMarket, 'id' | 'question'> = {
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.5, 0.5],
    volume: 1_000,
    liquidity: 1_000,
    acceptingOrders: true,
  };
  const bitcoin = relevanceScore(
    'Bitcoin reaches a new all-time high in 2026',
    { ...base, id: '1', question: 'Will Bitcoin reach $100,000 in 2026?' },
    ['bitcoin', '2026'],
  );
  const unrelated = relevanceScore(
    'Bitcoin reaches a new all-time high in 2026',
    { ...base, id: '2', question: 'Will Anthropic reach a high valuation in 2026?' },
    ['bitcoin', '2026'],
  );
  assert.ok(bitcoin > unrelated);
});
