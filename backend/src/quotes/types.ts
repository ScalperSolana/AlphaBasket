import type { PublicKey } from "@solana/web3.js";

export interface QuoteCommon {
  readonly quoteHash: Buffer;
  readonly basket: PublicKey;
  readonly user: PublicKey;
  readonly compositionVersion: number;
  readonly navReportHash: Buffer;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly maxSlippageBps: number;
  readonly expiresAtSeconds: bigint;
}

export interface DepositQuote extends QuoteCommon {
  readonly kind: "deposit";
  readonly grossAmount: bigint;
  readonly protocolFee: bigint;
  readonly quotedNetValue: bigint;
  readonly minimumNetValue: bigint;
  readonly minSharesOut: bigint;
}

export interface WithdrawalQuote extends QuoteCommon {
  readonly kind: "withdrawal";
  readonly shareAmount: bigint;
  readonly quotedGrossValue: bigint;
  readonly minimumGrossValue: bigint;
  readonly minValueOut: bigint;
  readonly quotedProtocolFee: bigint;
  readonly quotedCreatorFee: bigint;
}

export interface SignedDepositIntent {
  readonly kind: "deposit";
  readonly quote: DepositQuote;
  readonly nonce: bigint;
  readonly encodedMessage: Buffer;
  readonly intentHash: Buffer;
  readonly signature: Uint8Array;
}

export interface SignedWithdrawalIntent {
  readonly kind: "withdrawal";
  readonly quote: WithdrawalQuote;
  readonly nonce: bigint;
  readonly destination: PublicKey;
  readonly encodedMessage: Buffer;
  readonly intentHash: Buffer;
  readonly signature: Uint8Array;
}
