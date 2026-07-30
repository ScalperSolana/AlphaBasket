import type { ClobMarketDataPort } from "../polymarket/index.js";
import { PublicKey } from "@solana/web3.js";
import type { JupiterPricePort } from "../jupiter/index.js";
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
      assetKind?: "prediction_market" | "spot";
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
      if (holding.assetKind === "spot") {
        throw new Error("ClobBasketMarkRefreshService cannot price a Jupiter spot holding");
      }
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
        assetKind: "prediction_market" as const,
      });
    }));
    await this.writer.updateMarks(basketId, marks, new Date(Number(observedNow)));
  }
}

/** Refreshes prediction marks from CLOB and spot marks from Jupiter Price V3. */
export class HybridBasketMarkRefreshService implements BasketMarkRefreshPort {
  private readonly nowMs: () => bigint;

  public constructor(
    private readonly holdings: BasketAttributedHoldingsPort,
    private readonly clob: ClobMarketDataPort,
    private readonly jupiter: JupiterPricePort,
    private readonly usdcMint: PublicKey,
    private readonly writer: BasketHoldingMarkWriterPort,
    private readonly options: ClobBasketMarkRefreshOptions,
  ) {
    if (options.maxBookAgeMs <= 0n) throw new RangeError("maximum mark age must be positive");
    this.nowMs = options.nowMs ?? (() => BigInt(Date.now()));
  }

  public async refresh(basketId: string): Promise<void> {
    const state = await this.holdings.loadBasketState(basketId);
    const observedNow = this.nowMs();
    const spots = state.holdings.filter((holding) => holding.assetKind === "spot");
    const spotPrices = spots.length === 0
      ? []
      : await this.jupiter.getUsdcPrices(
          spots.map((holding) => new PublicKey(holding.tokenId)),
          this.usdcMint,
        );
    const spotByMint = new Map(
      spotPrices.map((price) => [price.mint.toBase58(), price]),
    );
    const marks = await Promise.all(state.holdings.map(async (holding) => {
      if (holding.assetKind === "spot") {
        const price = spotByMint.get(holding.tokenId);
        if (price === undefined) throw new Error(`Jupiter price is missing for ${holding.tokenId}`);
        return Object.freeze({
          marketId: holding.marketId,
          tokenId: holding.tokenId,
          outcome: holding.outcome,
          priceUnits: price.priceUsdcUnits,
          priceScale: holding.priceScale,
          observedAtMs: price.observedAtMs,
          sourceHash: price.sourceHash,
          condition: "fresh" as const,
          assetKind: "spot" as const,
        });
      }
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
        assetKind: "prediction_market" as const,
      });
    }));
    await this.writer.updateMarks(basketId, marks, new Date(Number(observedNow)));
  }
}
