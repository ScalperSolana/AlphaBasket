import type { ClobMarketDataPort, OrderBook } from "../polymarket/index.js";
import type {
  PredictMarketLinkStorePort,
  PredictRestPort,
} from "./types.js";

const PRICE_SCALE = 1_000_000n;

/**
 * Serves the existing market-data port from Jupiter Predict quotes, so the
 * execution runner, NAV mark refresh and composer metrics run unchanged when
 * the prediction venue is Jupiter.
 *
 * Jupiter quotes through competing market makers rather than a public book, so
 * the "book" is one level per side: the price you can trade at right now.
 * `buy*PriceUsd` is the effective ask, `sell*PriceUsd` the effective bid; level
 * size is the venue's minimum order so depth-based composer filters read a
 * conservative floor, not a fabricated depth.
 */
export class JupiterPredictMarketData implements ClobMarketDataPort {
  public constructor(
    private readonly rest: PredictRestPort,
    private readonly links: PredictMarketLinkStorePort,
    private readonly options: {
      readonly minimumOrderUnits: bigint;
      readonly nowMs?: () => bigint;
    },
  ) {
    if (options.minimumOrderUnits <= 0n) {
      throw new RangeError("Jupiter Predict minimum order units must be positive");
    }
  }

  public async getOrderBook(tokenId: string): Promise<OrderBook> {
    const link = await this.links.load(tokenId);
    if (link === null) {
      throw new Error(
        `no Jupiter Predict market is linked to prediction token ${tokenId}; ` +
          "insert a predict_market_links row for it",
      );
    }
    const market = await this.rest.getMarket(link.jupiterMarketId);
    if (market.status !== "open") {
      throw new Error(`Jupiter Predict market ${link.jupiterMarketId} is ${market.status}, not open`);
    }
    const ask = link.isYes ? market.pricing.buyYesPriceUnits : market.pricing.buyNoPriceUnits;
    const bid = link.isYes ? market.pricing.sellYesPriceUnits : market.pricing.sellNoPriceUnits;
    const size = this.options.minimumOrderUnits;
    return Object.freeze({
      // The runner and NAV refresh cross-check the book against the holding's
      // condition id; echo the linked one so a mislinked row fails that check.
      marketId: link.conditionId ?? link.jupiterMarketId,
      tokenId,
      timestampMs: market.observedAtMs,
      bids: Object.freeze(bid === null ? [] : [Object.freeze({ priceUnits: bid, sizeUnits: size })]),
      asks: Object.freeze(ask === null ? [] : [Object.freeze({ priceUnits: ask, sizeUnits: size })]),
      minOrderSizeUnits: this.options.minimumOrderUnits,
      tickSizeUnits: 10_000n,
      negativeRisk: false,
      sourceHash: market.sourceHash,
    });
  }

  public async getMidpoint(tokenId: string): Promise<bigint> {
    const book = await this.getOrderBook(tokenId);
    const bid = book.bids[0]?.priceUnits;
    const ask = book.asks[0]?.priceUnits;
    if (bid === undefined || ask === undefined) {
      throw new Error(`Jupiter Predict market for token ${tokenId} is one-sided`);
    }
    const midpoint = (bid + ask) / 2n;
    if (midpoint <= 0n || midpoint >= PRICE_SCALE) {
      throw new Error(`Jupiter Predict midpoint for token ${tokenId} is outside (0, 1)`);
    }
    return midpoint;
  }
}
