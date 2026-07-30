export type MarkCondition = "fresh" | "stale" | "illiquid" | "unavailable";

export interface BasketAttributedHolding {
  readonly assetKind?: "prediction_market" | "spot";
  readonly marketId: string;
  readonly tokenId: string;
  /** Off-chain execution metadata; intentionally not part of the Solana composition account. */
  readonly conditionId?: string;
  readonly negativeRisk?: boolean;
  readonly outcome: string;
  readonly quantityUnits: bigint;
  readonly markPriceUnits: bigint;
  readonly priceScale: bigint;
  readonly tokenDecimals?: number;
  readonly markObservedAtMs: bigint;
  readonly markSourceHash: string;
  readonly markCondition: MarkCondition;
}

export interface BasketAttributedState {
  readonly basketId: string;
  readonly ledgerVersion: string;
  readonly compositionVersion: bigint;
  readonly compositionHash: string;
  readonly idlePusdUnits: bigint;
  readonly idleUsdcUnits?: bigint;
  readonly holdings: readonly BasketAttributedHolding[];
}

export interface BasketAttributedHoldingsPort {
  loadBasketState(basketId: string): Promise<BasketAttributedState>;
}

export interface BasketShareSupply {
  /** Supply currently finalized on Solana, before lazy fee projection. */
  readonly totalSharesUnits: bigint;
  readonly protocolFeeSharesUnits: bigint;
  readonly lastManagementFeeAtSeconds: bigint;
  readonly managementFeeAccrualRemainder: bigint;
  readonly sourceSlot: bigint;
  readonly sourceVersion: string;
}

export interface BasketShareSupplyPort {
  loadShareSupply(basketId: string): Promise<BasketShareSupply>;
}

export interface BasketShareSupplyProjectionWriterPort {
  /** Must ignore older source slots and reject conflicting values at the same slot. */
  upsertShareSupply(
    basketId: string,
    supply: BasketShareSupply,
  ): Promise<void>;
}

export interface NavHoldingValue {
  readonly assetKind?: "prediction_market" | "spot";
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: string;
  readonly quantityUnits: bigint;
  readonly markPriceUnits: bigint;
  readonly priceScale: bigint;
  readonly valuePusdUnits: bigint;
  readonly markObservedAtMs: bigint;
  readonly markSourceHash: string;
}

export interface NavSnapshot {
  readonly version: 1;
  readonly hash: string;
  readonly basketId: string;
  readonly ledgerVersion: string;
  readonly compositionVersion: bigint;
  readonly compositionHash: string;
  readonly shareSupplySourceSlot: bigint;
  readonly shareSupplySourceVersion: string;
  readonly sequence: bigint;
  readonly observedAtMs: bigint;
  readonly idlePusdUnits: bigint;
  readonly idleUsdcUnits?: bigint;
  readonly positionValuePusdUnits: bigint;
  readonly grossNavPusdUnits: bigint;
  readonly onchainTotalSharesUnits: bigint;
  readonly totalSharesUnits: bigint;
  readonly projectedManagementFeeSharesUnits: bigint;
  readonly managementFeeAccrualThroughSeconds: bigint;
  readonly sharePriceUnits: bigint | null;
  readonly sharePriceScale: bigint;
  readonly holdings: readonly NavHoldingValue[];
}

export interface NavSnapshotStorePort {
  nextSequence(basketId: string): Promise<bigint>;
  /** Must append by hash/sequence and reject conflicting immutable snapshots. */
  append(snapshot: NavSnapshot): Promise<void>;
}

export type MarkFallbackReason = "declared-stale" | "declared-illiquid" | "unavailable" | "too-old";

export interface MarkFallbackContext {
  readonly basketId: string;
  readonly holding: BasketAttributedHolding;
  readonly reason: MarkFallbackReason;
  readonly snapshotTimeMs: bigint;
}

export interface StaleOrIlliquidMarkPolicyPort {
  resolve(context: MarkFallbackContext): Promise<ResolvedMark>;
}

export interface ResolvedMark {
  readonly priceUnits: bigint;
  readonly observedAtMs: bigint;
  readonly sourceHash: string;
}

export interface ClockPort {
  nowMs(): bigint;
}
