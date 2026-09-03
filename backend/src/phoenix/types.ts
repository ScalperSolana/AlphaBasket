/**
 * Ports the Phoenix perpetual adapter is written against.
 *
 * Nothing in `sizing.ts`, `market-selection.ts`, `verify.ts` or
 * `subaccount-allocator.ts` imports the Phoenix SDK. They are written against
 * these interfaces, which is what lets the whole decision layer be tested
 * without a network, a wallet, or a gated exchange — and what lets the SDK
 * adapter be replaced without touching any of the logic above it.
 */

import type {
  BaseLots,
  Bps,
  CollateralUnits,
  LeverageBps,
  PriceTicks,
  QuoteLots,
  QuoteLotsPerBaseLot,
  Slot,
} from "./units.js";

/** Direction of a perpetual position. */
export type PerpDirection = "long" | "short";
/** Whether a trade opens or closes. */
export type PerpTradeSide = "open" | "close";
/** Phoenix orderbook side. `bid` opens a long *or* closes a short. */
export type OrderSide = "bid" | "ask";

/**
 * Maps an AlphaBasket intent onto a Phoenix orderbook side.
 *
 * Phoenix has no notion of long or short at the order level, only bid and ask,
 * so this mapping is where the two vocabularies meet. Getting it backwards would
 * double a position instead of closing it.
 */
export const sideForTrade = (
  side: PerpTradeSide,
  direction: PerpDirection,
): OrderSide => {
  if (side === "open") return direction === "long" ? "bid" : "ask";
  return direction === "long" ? "ask" : "bid";
};

/**
 * An isolated Phoenix subaccount index.
 *
 * The type makes subaccount 0 unrepresentable. Phoenix's subaccount 0 is the
 * shared cross-margin account: a loss there can consume collateral backing an
 * unrelated position, which breaks the invariant that every basket item is
 * independently valuable.
 */
declare const isolatedBrand: unique symbol;
export type IsolatedSubaccountIndex = number & {
  readonly [isolatedBrand]: "IsolatedSubaccountIndex";
};

export const isolatedSubaccount = (value: number): IsolatedSubaccountIndex => {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new RangeError(
      `isolated subaccount must be an integer in [1, 255], got ${value}; ` +
        "subaccount 0 is Phoenix's cross-margin account and may never hold a position",
    );
  }
  return value as IsolatedSubaccountIndex;
};

export interface PhoenixLeverageTier {
  readonly maxSizeBaseLots: bigint;
  readonly maxLeverage: number;
}

export interface PhoenixMarket {
  readonly symbol: string;
  readonly assetId: number;
  readonly marketStatus: string;
  readonly tickSize: number;
  readonly baseLotsDecimals: number;
  readonly isolatedOnly: boolean;
  readonly leverageTiers: readonly PhoenixLeverageTier[];
}

/** Live exchange metadata and market data. */
export interface PhoenixExchangePort {
  /** Resolves once exchange metadata has loaded. */
  ready(): Promise<void>;
  symbols(): readonly string[];
  activeSymbols(): readonly string[];
  market(symbol: string): PhoenixMarket | undefined;
  /**
   * Undefined until the market-data stream has delivered a price. A market that
   * cannot be priced is not tradeable, and the caller must treat it that way
   * rather than substituting a stale or default value.
   */
  markPriceTicks(symbol: string): PriceTicks | undefined;
}

export interface PhoenixPosition {
  readonly symbol: string;
  readonly basePositionLots: string;
  readonly virtualQuotePositionLots: string;
  readonly entryPriceTicks: string;
  readonly unsettledFundingQuoteLots: string;
}

export interface PhoenixSubaccountState {
  readonly subaccountIndex: number;
  readonly collateral: string;
  readonly positions: readonly PhoenixPosition[];
}

export interface PhoenixTraderStateSnapshot {
  readonly slot: string;
  readonly subaccounts: readonly PhoenixSubaccountState[];
}

export interface PhoenixTraderStatePort {
  getSnapshot(
    authority: string,
    traderPdaIndex: number,
  ): Promise<PhoenixTraderStateSnapshot>;
}

/** Raised when Phoenix has no trader account for an authority. */
export class TraderNotFoundError extends Error {
  override readonly name = "TraderNotFoundError";
  constructor(readonly authority: string) {
    super(`Phoenix has no trader account for ${authority}`);
  }
}

/**
 * Post-execution state, read back from Phoenix rather than quoted.
 *
 * Every field here came from a `getSnapshot` taken at or after the slot the
 * transaction confirmed in.
 */
export interface VerifiedExecutionState {
  readonly subaccountIndex: IsolatedSubaccountIndex;
  readonly collateralQuoteLots: QuoteLots;
  readonly basePositionLots: BaseLots;
  readonly virtualQuotePositionLots: QuoteLots;
  /** Null when the position is flat, which is the normal result of a close. */
  readonly entryPriceTicks: PriceTicks | null;
  readonly unsettledFundingQuoteLots: QuoteLots;
  readonly observedAtSlot: Slot;
}

/** How far a real execution drifted from what was requested. */
export interface DivergenceReport {
  readonly requestedCollateralUnits: CollateralUnits;
  readonly actualMarginPostedUnits: CollateralUnits;
  readonly marginDeviationBps: number;
  readonly requestedPositionLots: BaseLots;
  readonly actualPositionLots: BaseLots;
  readonly sizeDeviationBps: number;
  readonly toleranceBps: Bps;
}

export interface PerpTradeRequest {
  readonly basketId: string;
  readonly market: string;
  readonly side: PerpTradeSide;
  readonly direction: PerpDirection;
  readonly subaccountIndex: IsolatedSubaccountIndex;
  readonly collateralUnits: CollateralUnits;
  readonly leverageBps: LeverageBps;
  readonly traderAuthority: string;
  readonly maxDivergenceBps: Bps;
  readonly idempotencyKey: string;
}

export interface SizedOrder {
  readonly baseLots: BaseLots;
  readonly notionalQuoteLots: QuoteLots;
  readonly markPrice: QuoteLotsPerBaseLot;
  /** Phoenix's tier cap at this size, after interpolation. */
  readonly maxLeverageAtSize: number;
}
