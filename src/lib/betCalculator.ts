import { BasketItem } from '@/types/basket.ts';

/**
 * Bet math for USDC-denominated stakes. USDC is already USD, so there is no
 * exchange-rate conversion — allocations are computed directly in USDC by basket
 * weight.
 */

export interface MarketBetAllocation {
  marketId: string;
  weightBps: number;
  polymarketPrice: number; // Price (0-1) for the selected outcome
  usdcAmount: number; // USDC allocated to this market
  shares: number; // Shares at Polymarket price (usdcAmount / price)
}

/**
 * Suggested stake based on basket composition: ~10 USDC per market, clamped to
 * a sensible [10, 1000] USDC range.
 */
export function calculateSuggestedBetAmount(items: BasketItem[]): number {
  if (items.length === 0) {
    return 0;
  }
  const baseAmountPerMarket = 10;
  const suggested = items.length * baseAmountPerMarket;
  return Math.max(10, Math.min(suggested, 1000));
}

/**
 * Split a total USDC stake across the basket's markets by weight.
 */
export function calculateBetAllocationFromUsdc(
  totalUsdc: number,
  items: BasketItem[],
  marketPrices?: Map<string, { YES: number; NO: number }>,
): {
  allocations: MarketBetAllocation[];
  totalUsdc: number;
} {
  const allocations: MarketBetAllocation[] = [];

  items.forEach((item) => {
    const weightFraction = item.weightBps / 10000;
    const usdcAmount = totalUsdc * weightFraction;

    let shares = 0;
    let polymarketPrice = 0;
    if (marketPrices) {
      const prices = marketPrices.get(item.marketId);
      if (prices) {
        polymarketPrice = item.outcome === 'YES' ? prices.YES : prices.NO;
        if (polymarketPrice > 0) {
          shares = usdcAmount / polymarketPrice;
        }
      }
    }

    allocations.push({
      marketId: item.marketId,
      weightBps: item.weightBps,
      polymarketPrice,
      usdcAmount,
      shares,
    });
  });

  return { allocations, totalUsdc };
}

/** Format a USDC amount for display. */
export function formatUsdc(amount: number): string {
  if (amount >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(2)}M USDC`;
  }
  if (amount >= 1_000) {
    return `${(amount / 1_000).toFixed(2)}K USDC`;
  }
  return `${amount.toFixed(2)} USDC`;
}

/** Format a plain USD amount for display. */
export function formatUsd(usd: number): string {
  if (usd >= 1) {
    return `$${usd.toFixed(2)}`;
  }
  if (usd >= 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(6)}`;
}
