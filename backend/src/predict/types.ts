/**
 * Jupiter Predict: Solana-native execution for prediction-market items.
 *
 * Jupiter's Prediction API serves Polymarket markets on Solana. Contracts are
 * binary (a winning contract pays exactly $1.00), quantities and prices use the
 * same six-decimal scale as the rest of the system, and capital enters and
 * leaves as USDC in the settlement wallet — no Polygon, no bridge, no pUSD.
 *
 * On-chain composition identity stays Polymarket-native (conditionId and
 * ctfTokenId are already deployed in `PositionKind::PredictionMarket`), so this
 * module carries the link between a composition item and the Jupiter market
 * that trades it.
 */

export interface PredictMarketPricing {
  /** Cost to buy one contract now; the effective ask. Six-decimal micro-USD. */
  readonly buyYesPriceUnits: bigint | null;
  readonly buyNoPriceUnits: bigint | null;
  /** Proceeds of selling one contract now; the effective bid. */
  readonly sellYesPriceUnits: bigint | null;
  readonly sellNoPriceUnits: bigint | null;
}

export interface PredictMarket {
  readonly marketId: string;
  readonly eventId: string | null;
  readonly provider: string | null;
  readonly status: string;
  /** Outcome labels in index order when the API reports them, e.g. ["Yes","No"]. */
  readonly outcomes: readonly string[];
  readonly pricing: PredictMarketPricing;
  /** External (provider) identifiers found in the payload, normalized lowercase. */
  readonly externalIds: readonly string[];
  readonly sourceHash: string;
  readonly observedAtMs: bigint;
}

export interface PredictOrderBuild {
  /** Base64 VersionedTransaction, unsigned by the owner. */
  readonly transactionBase64: string;
  readonly orderPubkey: string;
  readonly positionPubkey: string | null;
  /** Exact contract amount the API quoted for this order, when reported. */
  readonly contractsMicro: bigint | null;
  readonly lastValidBlockHeight: bigint | null;
}

export type PredictOrderStatus = "created" | "partiallyfilled" | "filled" | "failed";

export interface PredictRestPort {
  getMarket(marketId: string): Promise<PredictMarket>;
  /** Pages the event catalog; used only to discover market links. */
  listCatalogMarkets(options: {
    readonly start: number;
    readonly end: number;
  }): Promise<readonly PredictMarket[]>;
  buildOrder(request: {
    readonly ownerPubkey: string;
    readonly depositMint: string;
    /** Buy: USDC to spend. Sell: contracts to sell. Six-decimal units. */
    readonly amountUnits: bigint;
    readonly marketId: string;
    readonly isYes: boolean;
    readonly isBuy: boolean;
  }): Promise<PredictOrderBuild>;
  getOrderStatus(orderPubkey: string): Promise<PredictOrderStatus>;
}

export interface PredictMarketLink {
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly jupiterMarketId: string;
  readonly isYes: boolean;
  readonly source: "operator" | "market_probe" | "catalog";
}

export interface PredictMarketLinkStorePort {
  load(tokenId: string): Promise<PredictMarketLink | null>;
  save(link: PredictMarketLink): Promise<void>;
}

export interface PredictMarketResolution {
  readonly jupiterMarketId: string;
  readonly isYes: boolean;
}

export interface PredictMarketResolverPort {
  /**
   * Maps a composition item to the Jupiter market and side that trade it.
   * `marketId` is the on-chain composition marketId, which for venue-native
   * baskets is the Jupiter market id itself.
   */
  resolve(request: {
    readonly tokenId: string;
    readonly marketId?: string;
    readonly conditionId?: string | null;
    readonly outcomeIndex?: number;
  }): Promise<PredictMarketResolution>;
}
