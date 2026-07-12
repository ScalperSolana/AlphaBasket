import { z } from "zod";
import { mulDivFloor, parseDecimalToFixed } from "./fixed-point.js";
import { JsonHttpClient } from "./http-json.js";
import {
  PRICE_DECIMALS,
  PRICE_SCALE,
  SHARE_DECIMALS,
  type ClobMarketDataPort,
  type OrderBook,
  type OrderBookLevel,
  type TradeSide,
} from "./types.js";

const decimalText = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const levelSchema = z.object({ price: decimalText, size: decimalText }).passthrough();
const bookSchema = z
  .object({
    market: z.string().min(1),
    asset_id: z.string().min(1),
    timestamp: z
      .union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative().safe()])
      .transform(String),
    bids: z.array(levelSchema),
    asks: z.array(levelSchema),
    min_order_size: decimalText,
    tick_size: decimalText,
    neg_risk: z.boolean(),
    hash: z.string().min(1),
  })
  .passthrough();
const midpointSchema = z.object({ mid: decimalText }).passthrough();

const mapLevel = (raw: z.infer<typeof levelSchema>): OrderBookLevel => {
  const priceUnits = parseDecimalToFixed(raw.price, PRICE_DECIMALS);
  const sizeUnits = parseDecimalToFixed(raw.size, SHARE_DECIMALS);
  if (priceUnits <= 0n || priceUnits > PRICE_SCALE) {
    throw new RangeError(`Polymarket price ${raw.price} must be in (0, 1]`);
  }
  if (sizeUnits <= 0n) {
    throw new RangeError("Polymarket order-book sizes must be positive");
  }
  return Object.freeze({
    priceUnits,
    sizeUnits,
  });
};

const validateOrderBook = (
  tokenId: string,
  rawTokenId: string,
  bids: readonly OrderBookLevel[],
  asks: readonly OrderBookLevel[],
  tickSizeUnits: bigint,
  minOrderSizeUnits: bigint,
): void => {
  if (rawTokenId !== tokenId) {
    throw new Error(`Polymarket returned asset_id ${rawTokenId} for requested token ${tokenId}`);
  }
  if (tickSizeUnits <= 0n || tickSizeUnits > PRICE_SCALE) {
    throw new RangeError("Polymarket tick size must be in (0, 1]");
  }
  if (minOrderSizeUnits <= 0n) {
    throw new RangeError("Polymarket minimum order size must be positive");
  }
  for (let index = 0; index < bids.length; index += 1) {
    const level = bids[index];
    if (level === undefined) throw new Error("unreachable missing bid level");
    if (level.priceUnits % tickSizeUnits !== 0n) {
      throw new RangeError("Polymarket bid price is not aligned to tick size");
    }
    if (index > 0 && (bids[index - 1]?.priceUnits ?? 0n) < level.priceUnits) {
      throw new Error("Polymarket bids must be sorted from highest to lowest price");
    }
  }
  for (let index = 0; index < asks.length; index += 1) {
    const level = asks[index];
    if (level === undefined) throw new Error("unreachable missing ask level");
    if (level.priceUnits % tickSizeUnits !== 0n) {
      throw new RangeError("Polymarket ask price is not aligned to tick size");
    }
    if (index > 0 && (asks[index - 1]?.priceUnits ?? PRICE_SCALE) > level.priceUnits) {
      throw new Error("Polymarket asks must be sorted from lowest to highest price");
    }
  }
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (bestBid !== undefined && bestAsk !== undefined && bestBid.priceUnits >= bestAsk.priceUnits) {
    throw new Error("Polymarket order book is crossed or locked");
  }
};

export interface ClobRestMarketDataOptions {
  readonly baseUrl?: string;
}

export class ClobRestMarketData implements ClobMarketDataPort {
  private readonly baseUrl: string;

  public constructor(
    private readonly http: JsonHttpClient,
    options: ClobRestMarketDataOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://clob.polymarket.com").replace(/\/$/, "");
  }

  public async getOrderBook(tokenId: string): Promise<OrderBook> {
    if (tokenId.length === 0) {
      throw new TypeError("tokenId must not be empty");
    }
    const query = new URLSearchParams({ token_id: tokenId });
    const raw = await this.http.get(`${this.baseUrl}/book?${query.toString()}`, bookSchema);
    const timestamp = BigInt(raw.timestamp);
    const bids = Object.freeze(raw.bids.map(mapLevel));
    const asks = Object.freeze(raw.asks.map(mapLevel));
    const minOrderSizeUnits = parseDecimalToFixed(raw.min_order_size, SHARE_DECIMALS);
    const tickSizeUnits = parseDecimalToFixed(raw.tick_size, PRICE_DECIMALS);
    validateOrderBook(tokenId, raw.asset_id, bids, asks, tickSizeUnits, minOrderSizeUnits);
    return Object.freeze({
      marketId: raw.market,
      tokenId: raw.asset_id,
      timestampMs: timestamp,
      bids,
      asks,
      minOrderSizeUnits,
      tickSizeUnits,
      negativeRisk: raw.neg_risk,
      sourceHash: raw.hash,
    });
  }

  public async getMidpoint(tokenId: string): Promise<bigint> {
    if (tokenId.length === 0) {
      throw new TypeError("tokenId must not be empty");
    }
    const query = new URLSearchParams({ token_id: tokenId });
    const raw = await this.http.get(`${this.baseUrl}/midpoint?${query.toString()}`, midpointSchema);
    const midpoint = parseDecimalToFixed(raw.mid, PRICE_DECIMALS);
    if (midpoint <= 0n || midpoint >= PRICE_SCALE) {
      throw new RangeError(`Polymarket midpoint ${raw.mid} must be strictly between 0 and 1`);
    }
    return midpoint;
  }
}

/** Returns executable pUSD notional, rounded down, inside a caller-provided price bound. */
export const calculateExecutableDepth = (
  book: OrderBook,
  side: TradeSide,
  worstPriceUnits: bigint,
): bigint => {
  if (worstPriceUnits < 0n || worstPriceUnits > PRICE_SCALE) {
    throw new RangeError("worstPriceUnits must be between 0 and PRICE_SCALE");
  }
  const levels = side === "buy" ? book.asks : book.bids;
  let total = 0n;
  for (const level of levels) {
    const acceptable =
      side === "buy" ? level.priceUnits <= worstPriceUnits : level.priceUnits >= worstPriceUnits;
    if (acceptable) {
      total += mulDivFloor(level.sizeUnits, level.priceUnits, PRICE_SCALE);
    }
  }
  return total;
};
