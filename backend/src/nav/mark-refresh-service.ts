import type { ClobMarketDataPort } from "../polymarket/index.js";
import type {
  BasketAttributedHolding,
  BasketAttributedHoldingsPort,
  MarkCondition,
} from "./types.js";

export interface NavBasketRegistryPort {
  listBasketIds(limit: number): Promise<readonly string[]>;
}

export interface BasketHoldingMarkWriterPort {
  updateMarks(
    basketId: string,
    marks: readonly Readonly<{
      marketId: string;
      tokenId: string;
      outcome: string;
      priceUnits: bigint;
      priceScale: bigint;
      observedAtMs: bigint;
      sourceHash: string;
      condition: MarkCondition;
    }>[],
    now: Date,
  ): Promise<void>;
}

export interface BasketMarkRefreshPort {
  refresh(basketId: string): Promise<void>;
}

export interface ClobBasketMarkRefreshOptions {
  readonly maxBookAgeMs: bigint;
  readonly nowMs?: () => bigint;
}

function markKey(holding: BasketAttributedHolding): string {
  return `${holding.marketId}\u0000${holding.tokenId}\u0000${holding.outcome}`;
}

export class ClobBasketMarkRefreshService implements BasketMarkRefreshPort {
  private readonly nowMs: () => bigint;

  public constructor(
    private readonly holdings: BasketAttributedHoldingsPort,
    private readonly clob: ClobMarketDataPort,
    private readonly writer: BasketHoldingMarkWriterPort,
    private readonly options: ClobBasketMarkRefreshOptions,
  ) {
    if (options.maxBookAgeMs <= 0n) throw new RangeError("maximum order-book age must be positive");
    this.nowMs = options.nowMs ?? (() => BigInt(Date.now()));
  }

  public async refresh(basketId: string): Promise<void> {
    const state = await this.holdings.loadBasketState(basketId);
    const observedNow = this.nowMs();
    const marks = await Promise.all(state.holdings.map(async (holding) => {
      const book = await this.clob.getOrderBook(holding.tokenId);
      if (
        holding.conditionId !== undefined &&
        book.marketId.toLowerCase() !== holding.conditionId.toLowerCase()
      ) {
        throw new Error(`CLOB condition does not match attributed holding ${markKey(holding)}`);
      }
      if (book.timestampMs > observedNow) throw new Error(`CLOB book is from the future for ${holding.tokenId}`);
      const bestBid = book.bids[0]?.priceUnits;
      const bestAsk = book.asks[0]?.priceUnits;
      const fresh = observedNow - book.timestampMs <= this.options.maxBookAgeMs;
      const twoSided = bestBid !== undefined && bestAsk !== undefined;
      return Object.freeze({
        marketId: holding.marketId,
        tokenId: holding.tokenId,
        outcome: holding.outcome,
        priceUnits: twoSided
          ? ((bestBid as bigint) + (bestAsk as bigint)) / 2n
          : holding.markPriceUnits,
        priceScale: holding.priceScale,
        observedAtMs: twoSided ? book.timestampMs : holding.markObservedAtMs,
        sourceHash: twoSided ? book.sourceHash : holding.markSourceHash,
        condition: !twoSided ? "illiquid" as const : fresh ? "fresh" as const : "stale" as const,
      });
    }));
    await this.writer.updateMarks(basketId, marks, new Date(Number(observedNow)));
  }
}
