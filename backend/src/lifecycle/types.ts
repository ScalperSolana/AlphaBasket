import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

import type { BasketAsset, EligibleMarket } from "../contract/composition.js";

export type BasketLifecycleStatus =
  | "active"
  | "reconstituting"
  | "resolving"
  | "redeemable"
  | "closed";

export interface LifecycleBasket {
  readonly address: PublicKey;
  readonly basketId: Uint8Array;
  readonly status: BasketLifecycleStatus;
  readonly isPerpetual: boolean;
  readonly compositionVersion: number;
  readonly lastCompositionNonce: bigint;
  readonly lastManagementFeeAtSeconds: bigint;
  readonly lastReconstitutionAtSeconds: bigint;
  readonly reconstitutionCadenceSeconds: bigint;
  readonly totalSharesOutstanding: bigint;
}

export interface LifecycleBasketSourcePort {
  listBaskets(statuses: readonly BasketLifecycleStatus[], limit: number): Promise<readonly LifecycleBasket[]>;
  loadBasket(address: PublicKey): Promise<LifecycleBasket>;
}

export interface LifecycleTransactionResult {
  readonly transactionSignature: string;
  readonly finalizedSlot: bigint;
}

export interface LifecycleInstructionBatch {
  readonly operationKey: string;
  readonly instructions: readonly TransactionInstruction[];
  readonly requiredSignerPublicKeys: readonly PublicKey[];
}

/** Production implementations sign through role-separated KMS/HSM keys and journal operationKey. */
export interface LifecycleTransactionSubmitterPort {
  submit(batch: LifecycleInstructionBatch): Promise<LifecycleTransactionResult>;
}

export interface SignedReconstitution {
  readonly basket: PublicKey;
  readonly basketId: Uint8Array;
  readonly nextCompositionVersion: number;
  readonly compositionHash: Uint8Array;
  readonly eligibilityHash: Uint8Array;
  readonly eligibilityNonce: bigint;
  readonly eligibleMarkets: readonly EligibleMarket[];
  readonly items: readonly BasketAsset[];
  readonly compositionNonce: bigint;
  readonly compositionExpirySeconds: bigint;
  readonly encodedMessage: Uint8Array;
  readonly composerPublicKey: Uint8Array;
  readonly composerSignature: Uint8Array;
}

export interface FinalSettlementRequest {
  readonly basket: PublicKey;
  readonly finalReportHash: Uint8Array;
  readonly finalNavValue: bigint;
}

export interface FinalSettlementResult extends LifecycleTransactionResult {
  readonly finalShareSnapshot: bigint;
}

/** Every method is idempotent for the supplied operation key. */
export interface LifecycleSolanaGatewayPort {
  accrueManagementFee(basket: PublicKey, operationKey: string): Promise<LifecycleTransactionResult>;
  beginReconstitution(basket: PublicKey, operationKey: string): Promise<LifecycleTransactionResult>;
  completeReconstitution(request: SignedReconstitution, operationKey: string): Promise<LifecycleTransactionResult>;
  beginResolution(basket: PublicKey, operationKey: string): Promise<LifecycleTransactionResult>;
  recordFinalSettlement(request: FinalSettlementRequest, operationKey: string): Promise<FinalSettlementResult>;
}

export type LifecycleRunKind = "reconstitution" | "resolution";
export type LifecycleRunState =
  | "created"
  | "onchain_started"
  | "external_execution_completed"
  | "onchain_completed";

export interface LifecycleRun {
  readonly id: string;
  readonly runKey: string;
  readonly requestHash: string;
  readonly kind: LifecycleRunKind;
  readonly basketId: string;
  readonly state: LifecycleRunState;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly version: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
}

export interface LifecycleRunStorePort {
  createOrLoad(run: Omit<LifecycleRun, "state" | "version" | "updatedAt" | "completedAt">): Promise<LifecycleRun>;
  transition(
    id: string,
    expectedVersion: bigint,
    nextState: LifecycleRunState,
    checkpoint: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<LifecycleRun>;
}

export interface ReconstitutionExecutionResult {
  readonly executionHash: string;
  readonly orderIds: readonly string[];
  readonly jupiterTransactions?: readonly string[];
  readonly realizedPusdDeltaUnits: bigint;
  readonly realizedUsdcDeltaUnits?: bigint;
  readonly executedAtMs: bigint;
}

export interface ReconstitutionExecutionPort {
  /** Must replay the original result for the same operationId. */
  rebalance(request: {
    readonly operationId: string;
    readonly basket: PublicKey;
    readonly previousCompositionVersion: number;
    readonly nextComposition: SignedReconstitution;
  }): Promise<ReconstitutionExecutionResult>;
}

export interface ResolutionExecutionResult {
  readonly executionHash: string;
  readonly finalReportHash: Uint8Array;
  readonly finalNavValue: bigint;
  readonly externalReferences: readonly string[];
  readonly executedAtMs: bigint;
}

export interface ResolutionExecutionPort {
  /** Must replay the original result for the same operationId. */
  resolve(request: {
    readonly operationId: string;
    readonly basket: PublicKey;
  }): Promise<ResolutionExecutionResult>;
}

export interface ClockPort {
  now(): Date;
}
