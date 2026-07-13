import { createHash, createPublicKey, verify } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import {
  calculateDepositSettlement,
  calculateWithdrawalSettlement,
  feeCeil,
  minimumAfterSlippage,
  sharesForValue,
  valueForShares,
} from "../accounting/math.js";
import { DEPOSIT_FEE_BPS } from "../accounting/constants.js";
import { MATURE_HOLDING_PERIOD_SECS } from "../accounting/constants.js";
import {
  bytes32,
  depositIntentMessage,
  encodeI64LE,
  encodeU16LE,
  encodeU32LE,
  encodeU64LE,
  publicKeyBytes,
  withdrawalIntentMessage,
} from "../contract/index.js";
import type {
  DepositQuote,
  SignedDepositIntent,
  SignedWithdrawalIntent,
  WithdrawalQuote,
} from "./types.js";

const DEPOSIT_QUOTE_DOMAIN = Buffer.from("ALPHABASKET_DEPOSIT_QUOTE_V1", "ascii");
const WITHDRAWAL_QUOTE_DOMAIN = Buffer.from("ALPHABASKET_WITHDRAWAL_QUOTE_V1", "ascii");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function sha256(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function assertExpiry(expiresAtSeconds: bigint, nowSeconds: bigint): void {
  if (expiresAtSeconds <= nowSeconds) throw new RangeError("quote expiry must be in the future");
  // The signed intent must remain valid through the cross-chain bridge. User
  // min-out bounds still protect execution while the bridge is in flight.
  if (expiresAtSeconds - nowSeconds > 1_800n) throw new RangeError("financial quotes cannot live longer than thirty minutes");
}

function verifyEd25519(publicKey: PublicKey, message: Uint8Array, signature: Uint8Array): void {
  if (signature.byteLength !== 64) throw new TypeError("Ed25519 signature must contain 64 bytes");
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.toBuffer()]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, message, key, signature)) throw new Error("invalid user intent signature");
}

export interface CreateDepositQuoteRequest {
  readonly basket: PublicKey;
  readonly user: PublicKey;
  readonly compositionVersion: number;
  readonly navReportHash: Uint8Array;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly grossAmount: bigint;
  readonly maxSlippageBps: number;
  readonly nowSeconds: bigint;
  readonly expiresAtSeconds: bigint;
}

export interface CreateWithdrawalQuoteRequest {
  readonly basket: PublicKey;
  readonly user: PublicKey;
  readonly compositionVersion: number;
  readonly navReportHash: Uint8Array;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly shareAmount: bigint;
  readonly sharesOwned: bigint;
  readonly costBasisValue: bigint;
  readonly weightedDepositTimestamp: bigint;
  readonly performanceFeeBps: number;
  readonly maxSlippageBps: number;
  readonly nowSeconds: bigint;
  readonly expiresAtSeconds: bigint;
}

export class QuoteService {
  public createDepositQuote(request: CreateDepositQuoteRequest): DepositQuote {
    assertExpiry(request.expiresAtSeconds, request.nowSeconds);
    const protocolFee = feeCeil(request.grossAmount, DEPOSIT_FEE_BPS);
    const settlement = calculateDepositSettlement(
      request.grossAmount,
      request.grossAmount - protocolFee,
      request.sharePrice,
      request.maxSlippageBps,
    );
    const minSharesOut = sharesForValue(settlement.minimumNetValue, request.sharePrice);
    if (minSharesOut === 0n) throw new RangeError("deposit quote would permit zero shares");
    const navHash = bytes32(request.navReportHash, "navReportHash");
    const encoded = Buffer.concat([
      DEPOSIT_QUOTE_DOMAIN,
      publicKeyBytes(request.basket, "basket"),
      publicKeyBytes(request.user, "user"),
      encodeU32LE(request.compositionVersion, "compositionVersion"),
      navHash,
      encodeU64LE(request.basketNavValue, "basketNavValue"),
      encodeU64LE(request.sharePrice, "sharePrice"),
      encodeU64LE(request.grossAmount, "grossAmount"),
      encodeU64LE(settlement.protocolFee, "protocolFee"),
      encodeU64LE(settlement.minimumNetValue, "minimumNetValue"),
      encodeU64LE(minSharesOut, "minSharesOut"),
      encodeU16LE(request.maxSlippageBps, "maxSlippageBps"),
      encodeI64LE(request.expiresAtSeconds, "expiresAtSeconds"),
    ]);
    return Object.freeze({
      kind: "deposit",
      quoteHash: sha256(encoded),
      basket: request.basket,
      user: request.user,
      compositionVersion: request.compositionVersion,
      navReportHash: navHash,
      basketNavValue: request.basketNavValue,
      sharePrice: request.sharePrice,
      maxSlippageBps: request.maxSlippageBps,
      expiresAtSeconds: request.expiresAtSeconds,
      grossAmount: request.grossAmount,
      protocolFee: settlement.protocolFee,
      quotedNetValue: settlement.quotedNetValue,
      minimumNetValue: settlement.minimumNetValue,
      minSharesOut,
    });
  }

  public createWithdrawalQuote(request: CreateWithdrawalQuoteRequest): WithdrawalQuote {
    assertExpiry(request.expiresAtSeconds, request.nowSeconds);
    const maturity = request.weightedDepositTimestamp + MATURE_HOLDING_PERIOD_SECS;
    if (maturity > request.nowSeconds && maturity <= request.expiresAtSeconds) {
      throw new RangeError("withdrawal quote cannot cross the 60-day fee-tier boundary");
    }
    const quotedGrossValue = valueForShares(request.shareAmount, request.sharePrice);
    const minimumGrossValue = minimumAfterSlippage(quotedGrossValue, request.maxSlippageBps);
    const worstCase = calculateWithdrawalSettlement(
      request.costBasisValue,
      request.sharesOwned,
      request.weightedDepositTimestamp,
      request.shareAmount,
      minimumGrossValue,
      request.nowSeconds,
      request.performanceFeeBps,
    );
    const navHash = bytes32(request.navReportHash, "navReportHash");
    const encoded = Buffer.concat([
      WITHDRAWAL_QUOTE_DOMAIN,
      publicKeyBytes(request.basket, "basket"),
      publicKeyBytes(request.user, "user"),
      encodeU32LE(request.compositionVersion, "compositionVersion"),
      navHash,
      encodeU64LE(request.basketNavValue, "basketNavValue"),
      encodeU64LE(request.sharePrice, "sharePrice"),
      encodeU64LE(request.shareAmount, "shareAmount"),
      encodeU64LE(minimumGrossValue, "minimumGrossValue"),
      encodeU64LE(worstCase.userValueOut, "minValueOut"),
      encodeU16LE(request.maxSlippageBps, "maxSlippageBps"),
      encodeI64LE(request.expiresAtSeconds, "expiresAtSeconds"),
    ]);
    return Object.freeze({
      kind: "withdrawal",
      quoteHash: sha256(encoded),
      basket: request.basket,
      user: request.user,
      compositionVersion: request.compositionVersion,
      navReportHash: navHash,
      basketNavValue: request.basketNavValue,
      sharePrice: request.sharePrice,
      maxSlippageBps: request.maxSlippageBps,
      expiresAtSeconds: request.expiresAtSeconds,
      shareAmount: request.shareAmount,
      quotedGrossValue,
      minimumGrossValue,
      minValueOut: worstCase.userValueOut,
      quotedProtocolFee: worstCase.protocolFee,
      quotedCreatorFee: worstCase.creatorFee,
    });
  }
}

export class IntentSubmissionService {
  public submitDeposit(request: {
    readonly quote: DepositQuote;
    readonly nonce: bigint;
    readonly signature: Uint8Array;
    readonly nowSeconds: bigint;
  }): SignedDepositIntent {
    if (request.quote.expiresAtSeconds < request.nowSeconds) throw new Error("deposit quote has expired");
    const message = depositIntentMessage({
      basket: request.quote.basket,
      user: request.quote.user,
      intentNonce: request.nonce,
      intentExpiry: request.quote.expiresAtSeconds,
      expectedCompositionVersion: request.quote.compositionVersion,
      grossAmount: request.quote.grossAmount,
      minSharesOut: request.quote.minSharesOut,
      quoteHash: request.quote.quoteHash,
    });
    verifyEd25519(request.quote.user, message, request.signature);
    return Object.freeze({
      kind: "deposit",
      quote: request.quote,
      nonce: request.nonce,
      encodedMessage: message,
      intentHash: sha256(message),
      signature: Uint8Array.from(request.signature),
    });
  }

  public submitWithdrawal(request: {
    readonly quote: WithdrawalQuote;
    readonly nonce: bigint;
    readonly destination: PublicKey;
    readonly signature: Uint8Array;
    readonly nowSeconds: bigint;
  }): SignedWithdrawalIntent {
    if (request.quote.expiresAtSeconds < request.nowSeconds) throw new Error("withdrawal quote has expired");
    const message = withdrawalIntentMessage({
      basket: request.quote.basket,
      user: request.quote.user,
      intentNonce: request.nonce,
      intentExpiry: request.quote.expiresAtSeconds,
      expectedCompositionVersion: request.quote.compositionVersion,
      shareAmount: request.quote.shareAmount,
      minValueOut: request.quote.minValueOut,
      destination: request.destination,
      quoteHash: request.quote.quoteHash,
    });
    verifyEd25519(request.quote.user, message, request.signature);
    return Object.freeze({
      kind: "withdrawal",
      quote: request.quote,
      nonce: request.nonce,
      destination: request.destination,
      encodedMessage: message,
      intentHash: sha256(message),
      signature: Uint8Array.from(request.signature),
    });
  }
}
