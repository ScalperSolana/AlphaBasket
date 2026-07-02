import { z } from 'zod';

export const outcomeSchema = z.enum(['YES', 'NO']);

export const canonicalMarketSchema = z.object({
  marketId: z.string().trim().min(1).max(64),
  slug: z.string().trim().min(1).optional(),
  question: z.string().trim().min(1),
  outcome: outcomeSchema,
  weightBps: z.number().int().min(1).max(10_000),
  probability: z.number().min(0).max(1).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
});

export const canonicalBasketSchema = z.object({
  basketId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(100),
  thesis: z.string().trim().min(1).optional(),
  markets: z.array(canonicalMarketSchema).min(1).max(10),
});

export const thesisRequestSchema = z.object({
  thesis: z.string().trim().min(3).max(2_000),
  limit: z.number().int().min(1).max(10).default(5),
  name: z.string().trim().min(1).max(100).optional(),
});

export const buyBasketSchema = z.object({
  basket: canonicalBasketSchema,
  amountUsdc: z.union([z.string(), z.number()]),
});

export type CanonicalMarket = z.infer<typeof canonicalMarketSchema>;
export type CanonicalBasket = z.infer<typeof canonicalBasketSchema>;
export type ThesisRequest = z.infer<typeof thesisRequestSchema>;

/** Convert arbitrary positive weights into integer basis points totalling 10,000. */
export function normalizeWeightBps(weights: number[]): number[] {
  if (weights.length === 0 || weights.length > 10) {
    throw new Error('A basket must contain between 1 and 10 markets');
  }
  if (weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error('Every basket weight must be positive');
  }

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (weight / total) * 10_000);
  const result = exact.map((weight) => Math.floor(weight));
  let remaining = 10_000 - result.reduce((sum, weight) => sum + weight, 0);

  const remainderOrder = exact
    .map((weight, index) => ({ index, remainder: weight - Math.floor(weight) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

  for (let index = 0; index < remaining; index += 1) {
    const target = remainderOrder[index % remainderOrder.length];
    if (target) result[target.index] = (result[target.index] ?? 0) + 1;
  }

  return result;
}

export function validateCanonicalBasket(input: unknown): CanonicalBasket {
  const basket = canonicalBasketSchema.parse(input);
  const total = basket.markets.reduce((sum, market) => sum + market.weightBps, 0);
  if (total !== 10_000) {
    throw new Error(`Basket weights must total 10000 bps; received ${total}`);
  }
  return basket;
}
