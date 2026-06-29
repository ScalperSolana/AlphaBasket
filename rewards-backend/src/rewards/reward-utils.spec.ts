import {
  X_TASK_AMOUNTS_VARA,
  getUtcWeekKey,
  parseTweetId,
  varaToPlanck,
} from './reward-utils';

describe('reward utils', () => {
  it('parses x and twitter status urls', () => {
    expect(parseTweetId('https://x.com/poly_baskets/status/1234567890')).toBe('1234567890');
    expect(parseTweetId('https://twitter.com/poly_baskets/statuses/987654321')).toBe('987654321');
  });

  it('rejects non-status urls', () => {
    expect(() => parseTweetId('https://example.com/poly_baskets/status/123')).toThrow();
    expect(() => parseTweetId('https://x.com/poly_baskets')).toThrow();
  });

  it('uses monday utc as week key', () => {
    expect(getUtcWeekKey(new Date('2026-05-18T12:00:00.000Z'))).toBe('2026-05-18');
    expect(getUtcWeekKey(new Date('2026-05-24T23:59:59.000Z'))).toBe('2026-05-18');
    expect(getUtcWeekKey(new Date('2026-05-25T00:00:00.000Z'))).toBe('2026-05-25');
  });

  it('converts configured task rewards to planck', () => {
    expect(varaToPlanck(X_TASK_AMOUNTS_VARA.repost).toString()).toBe('100000000000000');
    expect(varaToPlanck(X_TASK_AMOUNTS_VARA.quote).toString()).toBe('300000000000000');
  });
});
