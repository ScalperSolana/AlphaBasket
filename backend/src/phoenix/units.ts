/**
 * Phoenix perpetual units.
 *
 * Four different quantities are all "amounts of money or size" and mixing them
 * up is the classic way to lose a lot of it:
 *
 * | Unit                  | Scale                    | Used for                |
 * | --------------------- | ------------------------ | ----------------------- |
 * | native USDC units     | 1 USDC = 1_000_000       | moving collateral       |
 * | quote lots            | 1 USD = 1_000_000        | position value, PnL     |
 * | base lots             | per market               | position size           |
 * | price ticks           | per market               | prices                  |
 *
 * The branded types make the compiler enforce the distinction: passing a price
 * where a size is expected does not compile. They are erased at runtime, so the
 * cost is zero.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Native USDC units. One USDC is 1_000_000. What actually moves on chain. */
export type CollateralUnits = Brand<bigint, "CollateralUnits">;
/** Phoenix quote lots. `QUOTE_LOTS_PER_USD = 1_000_000`. */
export type QuoteLots = Brand<bigint, "QuoteLots">;
/** Phoenix base lots. Scale is per market, from `baseLotsDecimals`. */
export type BaseLots = Brand<bigint, "BaseLots">;
/** A price in ticks. Scale is per market, from `tickSize`. */
export type PriceTicks = Brand<bigint, "PriceTicks">;
/** A price expressed as quote lots per base lot. */
export type QuoteLotsPerBaseLot = Brand<bigint, "QuoteLotsPerBaseLot">;
/** Basis points. 10_000 is 100%. */
export type Bps = Brand<number, "Bps">;
/** Leverage in basis points. 30_000 is 3.00x. */
export type LeverageBps = Brand<number, "LeverageBps">;
/** A Solana slot. */
export type Slot = Brand<bigint, "Slot">;

export const collateralUnits = (value: bigint): CollateralUnits =>
  value as CollateralUnits;
export const quoteLots = (value: bigint): QuoteLots => value as QuoteLots;
export const baseLots = (value: bigint): BaseLots => value as BaseLots;
export const priceTicks = (value: bigint): PriceTicks => value as PriceTicks;
export const quoteLotsPerBaseLot = (value: bigint): QuoteLotsPerBaseLot =>
  value as QuoteLotsPerBaseLot;
export const bps = (value: number): Bps => value as Bps;
export const leverageBps = (value: number): LeverageBps => value as LeverageBps;
export const slot = (value: bigint): Slot => value as Slot;

export const QUOTE_LOTS_PER_USD = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;

/**
 * One quote lot is one native USDC unit, so this is an identity conversion.
 *
 * It exists as a named function rather than a cast because the *reason* it is an
 * identity is a property of Phoenix's scale, not a coincidence. If Phoenix ever
 * changed `QUOTE_LOTS_PER_USD`, this is the single place that would need to move.
 */
export const quoteLotsToCollateralUnits = (value: QuoteLots): CollateralUnits =>
  (value as bigint) as CollateralUnits;

export const collateralUnitsToQuoteLots = (value: CollateralUnits): QuoteLots =>
  (value as bigint) as QuoteLots;

/** The per-market scale factors every price and size conversion needs. */
export interface MarketScale {
  readonly symbol: string;
  readonly tickSize: number;
  readonly baseLotsDecimals: number;
}

/**
 * `priceTicks * tickSize` is quote lots per base lot.
 *
 * This is the unit Phoenix's own margin math works in.
 */
export const ticksToQuoteLotsPerBaseLot = (
  ticks: PriceTicks,
  scale: MarketScale,
): QuoteLotsPerBaseLot =>
  quoteLotsPerBaseLot((ticks as bigint) * BigInt(scale.tickSize));

/** A human-readable USD price, for logs and dashboards only. */
export const ticksToUsd = (ticks: PriceTicks, scale: MarketScale): number =>
  Number((ticks as bigint) * BigInt(scale.tickSize)) /
  Number(QUOTE_LOTS_PER_USD);

/** Base lots as a human-readable token amount, for logs only. */
export const baseLotsToTokens = (lots: BaseLots, scale: MarketScale): number =>
  Number(lots as bigint) / 10 ** scale.baseLotsDecimals;

export const absBigInt = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * How far `actual` drifted from `expected`, in basis points.
 *
 * Returns 0 when both are zero — no expectation and no outcome is not a
 * divergence. Returns the full 10_000 when something was expected and nothing
 * happened, which is a total miss rather than an undefined ratio.
 */
export const deviationBps = (expected: bigint, actual: bigint): number => {
  const target = absBigInt(expected);
  const observed = absBigInt(actual);
  if (target === 0n) return observed === 0n ? 0 : Number(BPS_DENOMINATOR);
  const difference = target > observed ? target - observed : observed - target;
  return Number((difference * BPS_DENOMINATOR) / target);
};

/**
 * Converts base lots to the decimal base-units string Phoenix's order-packet
 * builder expects.
 *
 * Done in integer arithmetic on the digit string, never through `Number`. A
 * position of 31,357 lots on a 2-decimal market is `313.57` units; routing that
 * through a float would be fine here but would not be for a market with nine
 * decimals and a large size, and there is no reason to have two rules.
 */
export const baseLotsToUnitsString = (
  lots: bigint,
  baseLotsDecimals: number,
): string => {
  if (baseLotsDecimals < 0 || !Number.isInteger(baseLotsDecimals)) {
    throw new RangeError(`invalid baseLotsDecimals: ${baseLotsDecimals}`);
  }
  const negative = lots < 0n;
  const magnitude = (negative ? -lots : lots).toString();

  if (baseLotsDecimals === 0) return `${negative ? "-" : ""}${magnitude}`;

  const padded = magnitude.padStart(baseLotsDecimals + 1, "0");
  const whole = padded.slice(0, padded.length - baseLotsDecimals);
  const fraction = padded
    .slice(padded.length - baseLotsDecimals)
    .replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
};
