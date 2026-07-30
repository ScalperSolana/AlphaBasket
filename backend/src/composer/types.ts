import type { PublicKey } from "@solana/web3.js";
import type { BasketAsset, EligibleMarket } from "../contract/composition.js";

export type MarketDataCondition = "fresh" | "stale" | "illiquid" | "unavailable";

export interface ComposerCandidate {
  readonly marketId: string;
  readonly conditionId: string;
  readonly eventId: string | null;
  readonly tokenId: string;
  readonly outcomeLabel: string;
  readonly outcomeIndex: 0 | 1;
  readonly active: boolean;
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly endTimeMs: bigint | null;
  readonly thematicallyRelevant: boolean;
  readonly outcomeClear: boolean;
  readonly classificationSource: string;
  readonly hasBid: boolean;
  readonly hasAsk: boolean;
  readonly spreadBps: number;
  readonly midpointPriceUnits: bigint;
  readonly depthPusdUnits: bigint;
  readonly volume24hPusdUnits: bigint;
  readonly dataCondition: MarketDataCondition;
}

export type CandidateRejectionReason =
  | "inactive"
  | "closed"
  | "not-accepting-orders"
  | "missing-event-id"
  | "missing-end-time"
  | "closes-too-soon"
  | "closes-too-late"
  | "not-thematically-relevant"
  | "unclear-outcome"
  | "one-sided-book"
  | "spread-too-wide"
  | "midpoint-out-of-band"
  | "insufficient-depth"
  | "insufficient-volume"
  | "stale-data"
  | "illiquid-data"
  | "unavailable-data";

export interface RejectedCandidate {
  readonly candidate: ComposerCandidate;
  readonly reasons: readonly CandidateRejectionReason[];
}

export interface CandidateFilterResult {
  readonly accepted: readonly ComposerCandidate[];
  readonly rejected: readonly RejectedCandidate[];
}

export interface ComposerPolicy {
  readonly minMarkets: number;
  readonly maxMarkets: number;
  readonly minRemainingMs: bigint;
  readonly maxRemainingMs: bigint;
  readonly maxSpreadBps: number;
  readonly minDepthPusdUnits: bigint;
  readonly minVolume24hPusdUnits: bigint;
}

export interface WeightedCompositionItem {
  readonly assetKind?: "prediction_market";
  readonly marketId: string;
  readonly conditionId: string;
  readonly eventId: string | null;
  readonly tokenId: string;
  readonly ctfTokenId: Uint8Array;
  readonly outcomeLabel: string;
  readonly outcomeIndex: 0 | 1;
  readonly weightBps: number;
  /** Initial off-chain mark only; it is not signed into the on-chain composition. */
  readonly initialMarkPriceUnits: bigint;
}

export interface SpotCompositionSelection {
  readonly marketId: string;
  readonly tokenMint: PublicKey;
  readonly tokenDecimals: number;
  readonly symbol: string;
  readonly weightBps: number;
  readonly initialMarkPriceUnits: bigint;
  readonly markSourceHash: string;
}

export interface SpotWeightedCompositionItem {
  readonly assetKind: "spot";
  readonly marketId: string;
  readonly tokenId: string;
  readonly tokenMint: PublicKey;
  readonly tokenDecimals: number;
  readonly outcomeLabel: "spot";
  readonly weightBps: number;
  readonly initialMarkPriceUnits: bigint;
  readonly markSourceHash: string;
}

export interface BasketComposition {
  readonly version: 2;
  /** Exact SHA-256 of contract canonicalCompositionBytes(assets). */
  readonly hash: string;
  readonly hashBytes: Uint8Array;
  /** Exact SHA-256 of the Composer-screened list; weights are excluded. */
  readonly eligibilityHash: string;
  readonly eligibilityHashBytes: Uint8Array;
  readonly eligibleMarkets: readonly EligibleMarket[];
  readonly auditHash: string;
  readonly composedAtMs: bigint;
  readonly items: readonly (WeightedCompositionItem | SpotWeightedCompositionItem)[];
  readonly assets: readonly BasketAsset[];
  readonly rejected: readonly RejectedCandidate[];
}

export interface CreatorMarketWeight {
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcomeIndex: 0 | 1;
  readonly weightBps: number;
}

export interface CompositionSigningPayload {
  readonly basketId: Uint8Array;
  readonly creator: PublicKey;
  readonly creatorFeeDestination: PublicKey;
  /** Null preserves an omitted rate; performanceFeeBps is the effective signed value. */
  readonly requestedPerformanceFeeBps: number | null;
  readonly performanceFeeBps: number;
  readonly isPerpetual: boolean;
  readonly reconstitutionCadenceSecs: bigint;
  readonly compositionNonce: bigint;
  readonly compositionExpiry: bigint;
  readonly eligibilityNonce: bigint;
  readonly composition: BasketComposition;
}

export interface CompositionMessageEncoderPort {
  /** Must use the canonical byte format expected by create_basket.rs. */
  encode(payload: CompositionSigningPayload): Uint8Array;
}

export interface ComposerSignerPort {
  /** Returns key and signature atomically so key rotation cannot split the envelope. */
  sign(message: Uint8Array): Promise<{
    readonly publicKey: Uint8Array;
    readonly signature: Uint8Array;
  }>;
}

export interface SolanaBasketCreationRequest {
  readonly payload: CompositionSigningPayload;
  readonly encodedMessage: Uint8Array;
  readonly composerPublicKey: Uint8Array;
  readonly composerSignature: Uint8Array;
}

export interface SolanaBasketCreationResult {
  readonly basketAddress: string;
  readonly transactionSignature: string;
  readonly eligibilityTransactionSignature: string | null;
  readonly compositionDraftTransactionSignature: string | null;
  readonly compositionHash: string;
  /** Off-chain execution metadata used to initialize the basket portfolio projection. */
  readonly portfolioItems: readonly Readonly<{
    readonly assetKind?: "prediction_market" | "spot";
    readonly marketId: string;
    readonly conditionId?: string;
    readonly tokenId: string;
    readonly outcome: string;
    readonly tokenDecimals?: number;
    readonly initialMarkPriceUnits: bigint;
    readonly markObservedAtMs: bigint;
    readonly markSourceHash: string;
  }>[];
}

export interface SolanaBasketCreationGatewayPort {
  createBasket(request: SolanaBasketCreationRequest): Promise<SolanaBasketCreationResult>;
}

export interface ComposerClockPort {
  nowMs(): bigint;
}

export interface CandidateSourceMarket {
  readonly marketId: string;
  readonly conditionId: string;
  readonly eventId: string | null;
  readonly tokenId: string;
  readonly outcomeLabel: string;
  readonly outcomeIndex: 0 | 1;
  readonly active: boolean;
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly endTimeMs: bigint | null;
  readonly volume24hPusdUnits: bigint;
}

export interface ComposerMarketMetrics {
  readonly hasBid: boolean;
  readonly hasAsk: boolean;
  readonly spreadBps: number;
  readonly midpointPriceUnits: bigint;
  readonly depthPusdUnits: bigint;
  readonly volume24hPusdUnits: bigint;
  readonly dataCondition: MarketDataCondition;
}

export interface ComposerMarketMetricsPort {
  loadMetrics(market: CandidateSourceMarket): Promise<ComposerMarketMetrics>;
}

export interface ComposerClassification {
  readonly thematicallyRelevant: boolean;
  readonly outcomeClear: boolean;
  readonly source: string;
}

export interface ComposerClassificationPort {
  classify(market: CandidateSourceMarket): Promise<ComposerClassification>;
}
