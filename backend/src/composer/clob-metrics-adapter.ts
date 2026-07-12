import {
  PRICE_SCALE,
  calculateExecutableDepth,
  type ClobMarketDataPort,
} from "../polymarket/index.js";
import type {
  CandidateSourceMarket,
  ComposerMarketMetrics,
  ComposerMarketMetricsPort,
} from "./types.js";

export interface ClobComposerMetricsOptions {
  readonly maxBookAgeMs: bigint;
  readonly executableDepthBandBps: number;
}

export class ClobComposerMetricsAdapter implements ComposerMarketMetricsPort {
  public constructor(
    private readonly clob: ClobMarketDataPort,
    private readonly nowMs: () => bigint,
    private readonly options: ClobComposerMetricsOptions,
  ) {
    if (options.maxBookAgeMs < 0n) {
      throw new RangeError("maxBookAgeMs must be non-negative");
    }
    if (
      !Number.isSafeInteger(options.executableDepthBandBps) ||
      options.executableDepthBandBps < 0 ||
      options.executableDepthBandBps > 10_000
    ) {
      throw new RangeError("executableDepthBandBps must be between 0 and 10000");
    }
  }

  public async loadMetrics(
    market: CandidateSourceMarket,
  ): Promise<ComposerMarketMetrics> {
    const book = await this.clob.getOrderBook(market.tokenId);
    if (book.marketId.toLowerCase() !== market.conditionId.toLowerCase()) {
      throw new Error(
        `CLOB condition ${book.marketId} does not match Gamma condition ${market.conditionId}`,
      );
    }
    const now = this.nowMs();
    if (book.timestampMs > now) {
      throw new Error(`CLOB book timestamp is in the future for ${market.tokenId}`);
    }
    const bestBid = book.bids[0]?.priceUnits;
    const bestAsk = book.asks[0]?.priceUnits;
    const hasBid = bestBid !== undefined;
    const hasAsk = bestAsk !== undefined;
    const midpointPriceUnits =
      bestBid === undefined || bestAsk === undefined
        ? 0n
        : (bestBid + bestAsk) / 2n;
    const spreadBps =
      bestBid === undefined || bestAsk === undefined || midpointPriceUnits === 0n
        ? 10_000
        : Number(((bestAsk - bestBid) * 10_000n) / midpointPriceUnits);
    const worstBuyPrice =
      midpointPriceUnits === 0n
        ? 0n
        : ((midpointPriceUnits *
              BigInt(10_000 + this.options.executableDepthBandBps)) /
              10_000n >
            PRICE_SCALE
            ? PRICE_SCALE
            : (midpointPriceUnits *
                BigInt(10_000 + this.options.executableDepthBandBps)) /
              10_000n);
    const dataCondition =
      !hasBid || !hasAsk
        ? "illiquid"
        : now - book.timestampMs > this.options.maxBookAgeMs
          ? "stale"
          : "fresh";
    return Object.freeze({
      hasBid,
      hasAsk,
      spreadBps,
      midpointPriceUnits,
      depthPusdUnits: calculateExecutableDepth(book, "buy", worstBuyPrice),
      volume24hPusdUnits: market.volume24hPusdUnits,
      dataCondition,
    });
  }
}
