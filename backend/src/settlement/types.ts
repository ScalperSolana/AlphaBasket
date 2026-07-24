import type { PublicKey } from "@solana/web3.js";

import type { SignedDepositIntent, SignedWithdrawalIntent } from "../quotes/types.js";
import type { SettlementResult } from "../execution/types.js";

export interface CompleteDepositRequest {
  readonly intent: SignedDepositIntent;
  readonly navReportHash: Uint8Array;
  readonly executionBatchHash: Uint8Array;
  readonly executedAtSeconds: bigint;
  readonly settlementNonce: bigint;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly netDepositValue: bigint;
  readonly sharesCredited: bigint;
  readonly protocolFee: bigint;
}

export interface CompleteWithdrawalRequest {
  readonly intent: SignedWithdrawalIntent;
  readonly navReportHash: Uint8Array;
  readonly executionBatchHash: Uint8Array;
  readonly executedAtSeconds: bigint;
  readonly settlementNonce: bigint;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly grossRealizedValue: bigint;
  readonly protocolFee: bigint;
  readonly creatorFee: bigint;
  readonly userValueOut: bigint;
}

export interface CompleteProtocolFeeWithdrawalRequest {
  readonly basket: PublicKey;
  readonly navReportHash: Uint8Array;
  readonly executionBatchHash: Uint8Array;
  readonly executedAtSeconds: bigint;
  readonly settlementNonce: bigint;
  readonly shareAmount: bigint;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly grossRealizedValue: bigint;
}

export interface SolanaSettlementGatewayPort {
  completeDeposit(request: CompleteDepositRequest): Promise<SettlementResult>;
  completeWithdrawal(request: CompleteWithdrawalRequest): Promise<SettlementResult>;
  completeProtocolFeeWithdrawal(request: CompleteProtocolFeeWithdrawalRequest): Promise<SettlementResult>;
}

export interface SettlementPricing {
  readonly navReportHash: Uint8Array;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly observedAtSeconds: bigint;
}

export interface SettlementPricingPort {
  loadLatestPricing(basket: PublicKey): Promise<SettlementPricing>;
}

export function assertFreshSettlementPricing(pricing: SettlementPricing, nowSeconds: bigint, maxAgeSeconds = 15n): void {
  if (pricing.basketNavValue < 0n || pricing.sharePrice <= 0n) throw new RangeError("settlement pricing contains invalid financial values");
  if (pricing.navReportHash.byteLength !== 32 || Buffer.from(pricing.navReportHash).equals(Buffer.alloc(32))) throw new TypeError("settlement pricing contains an invalid NAV hash");
  if (pricing.observedAtSeconds > nowSeconds || nowSeconds - pricing.observedAtSeconds > maxAgeSeconds) throw new Error("settlement pricing is stale or from the future");
}

export function assertExecutionTimestamp(executedAtSeconds: bigint, nowSeconds: bigint): void {
  if (executedAtSeconds <= 0n || executedAtSeconds > nowSeconds) {
    throw new Error("execution timestamp is invalid or from the future");
  }
}
