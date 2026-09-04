/**
 * Order sizing and Phoenix's leverage tiers.
 *
 * Phoenix caps leverage by position size, interpolating between tier bounds. A
 * position that is legal at 3x when small may not be at the size the same
 * collateral buys, so the tier has to be checked against the *resulting* size,
 * not the requested leverage.
 */

import {
  BPS_DENOMINATOR,
  absBigInt,
  baseLots as toBaseLots,
  quoteLots as toQuoteLots,
  type BaseLots,
  type CollateralUnits,
  type LeverageBps,
  type QuoteLotsPerBaseLot,
} from "./units.js";
import type { PhoenixLeverageTier, PhoenixMarket, SizedOrder } from "./types.js";

export class SizingError extends Error {
  override readonly name = "SizingError";
}

/**
 * Linear interpolation between tier bounds.
 *
 * Mirrors Phoenix's own `interpolateU64`, including its use of floating point
 * between the two bounds and truncation on the way out. Reproducing the rounding
 * matters more than improving it: a size this adapter believes is legal and
 * Phoenix does not is a rejected order.
 */
const interpolate = (
  x1: bigint,
  y1: bigint,
  x2: bigint,
  y2: bigint,
  x: bigint,
): bigint => {
  if (x1 === x2 || y1 === y2) return y1;
  const xRange = Number(x2) - Number(x1);
  if (xRange <= 0) return y1;
  const yRange = Number(y2) - Number(y1);
  const offset = Number(x) - Number(x1);
  const fraction = Math.min(Math.max(offset / xRange, 0), 1);
  return BigInt(Math.trunc(Number(y1) + fraction * yRange));
};

/**
 * The maximum leverage Phoenix permits at `positionSize`.
 *
 * Returns 1 beyond the last tier, as Phoenix does — that is the exchange saying
 * "no leverage at this size", not an error condition.
 */
export const maxLeverageForSize = (
  tiers: readonly PhoenixLeverageTier[],
  positionSize: BaseLots,
): number => {
  const size = absBigInt(positionSize as bigint);
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    if (!tier) continue;
    if (size <= tier.maxSizeBaseLots) {
      if (index === 0) return tier.maxLeverage;
      const previous = tiers[index - 1];
      if (!previous) return tier.maxLeverage;
      return (
        Number(
          interpolate(
            previous.maxSizeBaseLots,
            BigInt(Math.round(previous.maxLeverage * 1_000_000)),
            tier.maxSizeBaseLots,
            BigInt(Math.round(tier.maxLeverage * 1_000_000)),
            size,
          ),
        ) / 1_000_000
      );
    }
  }
  return 1;
};

/**
 * Sizes an opening order from collateral and target leverage.
 *
 * **Fails rather than clamping** when the requested leverage exceeds the tier
 * cap. Silently opening a smaller position than asked for would be a different
 * trade than the one the caller authorised, and the caller would have no way to
 * know it happened.
 */
export const sizeOpeningOrder = (params: {
  market: PhoenixMarket;
  markPrice: QuoteLotsPerBaseLot;
  collateralUnits: CollateralUnits;
  leverageBps: LeverageBps;
}): SizedOrder => {
  const collateral = params.collateralUnits as bigint;
  const markPrice = params.markPrice as bigint;

  if (collateral <= 0n) {
    throw new SizingError("collateralUnits must be positive");
  }
  if (markPrice <= 0n) {
    throw new SizingError(
      `market ${params.market.symbol} has no usable mark price; refusing to size an order`,
    );
  }
  if (params.leverageBps < Number(BPS_DENOMINATOR)) {
    throw new SizingError(
      `leverageBps must be at least ${BPS_DENOMINATOR} (1.00x), got ${params.leverageBps}`,
    );
  }

  // One quote lot is one native USDC unit, so collateral needs no scaling here.
  const targetNotionalQuoteLots =
    (collateral * BigInt(params.leverageBps)) / BPS_DENOMINATOR;
  const lots = targetNotionalQuoteLots / markPrice;

  if (lots <= 0n) {
    throw new SizingError(
      `collateral ${collateral} at ${params.leverageBps}bps leverage sizes to zero base lots ` +
        `on ${params.market.symbol}; the position would be smaller than one lot`,
    );
  }

  const sized = toBaseLots(lots);
  const maxLeverageAtSize = maxLeverageForSize(
    params.market.leverageTiers,
    sized,
  );
  const requestedLeverage = params.leverageBps / Number(BPS_DENOMINATOR);

  if (requestedLeverage > maxLeverageAtSize) {
    throw new SizingError(
      `${params.market.symbol} permits at most ${maxLeverageAtSize}x at ${lots} base lots, ` +
        `but ${requestedLeverage}x was requested; refusing to silently open a smaller position`,
    );
  }

  return {
    baseLots: sized,
    notionalQuoteLots: toQuoteLots(lots * markPrice),
    markPrice: params.markPrice,
    maxLeverageAtSize,
  };
};
