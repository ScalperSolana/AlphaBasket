export const PUSD_DECIMALS = 6;
export const SHARE_DECIMALS = 6;
export const PRICE_DECIMALS = 6;
export const PRICE_SCALE = 1_000_000n;

export interface GammaMarketToken {
  readonly tokenId: string;
  readonly outcome: string;
}

export interface GammaMarket {
  /** Compact Gamma database ID; this is the value eligible for the contract's <=64-byte marketId. */
  readonly marketId: string;
  /** Full CLOB/CTF condition ID used to correlate books and execution. */
  readonly conditionId: string;
  readonly eventId: string | null;
  readonly question: string;
  readonly slug: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly endTimeMs: bigint | null;
  readonly volume24hUnits: bigint;
  readonly liquidityUnits: bigint;
  readonly tokens: readonly GammaMarketToken[];
}

export interface GammaMarketPage {
  readonly markets: readonly GammaMarket[];
  readonly nextCursor: string | null;
}

export interface GammaMarketDataPort {
  listMarkets(options?: { readonly cursor?: string; readonly limit?: number }): Promise<GammaMarketPage>;
}

export interface OrderBookLevel {
  readonly priceUnits: bigint;
  readonly sizeUnits: bigint;
}

export interface OrderBook {
  readonly marketId: string;
  readonly tokenId: string;
  readonly timestampMs: bigint;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly minOrderSizeUnits: bigint;
  readonly tickSizeUnits: bigint;
  readonly negativeRisk: boolean;
  readonly sourceHash: string;
}

export interface ClobMarketDataPort {
  getOrderBook(tokenId: string): Promise<OrderBook>;
  getMidpoint(tokenId: string): Promise<bigint>;
}

export type TradeSide = "buy" | "sell";
