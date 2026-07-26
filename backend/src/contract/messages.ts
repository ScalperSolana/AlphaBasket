import { PublicKey } from "@solana/web3.js";

import {
  ALPHABASKET_PROGRAM_ID,
  COMPOSITION_DOMAIN,
  DEPOSIT_INTENT_DOMAIN,
  MAX_CREATOR_PERFORMANCE_FEE_BPS,
  PRICE_ATTESTATION_DOMAIN,
  RECONSTITUTION_DOMAIN,
  WITHDRAWAL_INTENT_DOMAIN,
} from "./constants.js";
import {
  assertU16,
  encodeBoolean,
  encodeI64LE,
  encodeU16LE,
  encodeU32LE,
  encodeU64LE,
  nonZeroBytes32,
  nonZeroPublicKeyBytes,
  publicKeyBytes,
  bytes32,
} from "./validation.js";

export interface CreateCompositionAuthorization {
  readonly basketId: Uint8Array;
  readonly creator: PublicKey;
  readonly creatorFeeDestination: PublicKey;
  readonly eligibilityHash: Uint8Array;
  readonly eligibilityNonce: bigint;
  readonly performanceFeeBps: number;
  readonly isPerpetual: boolean;
  readonly reconstitutionCadenceSecs: bigint;
  readonly compositionNonce: bigint;
  readonly compositionExpiry: bigint;
  readonly programId?: PublicKey;
}

export function createCompositionAuthorizationMessage(
  value: CreateCompositionAuthorization,
): Buffer {
  const feeBps = assertU16(value.performanceFeeBps, "performanceFeeBps");
  if (feeBps > MAX_CREATOR_PERFORMANCE_FEE_BPS) {
    throw new RangeError(
      `performanceFeeBps cannot exceed ${MAX_CREATOR_PERFORMANCE_FEE_BPS}`,
    );
  }
  if (
    (value.isPerpetual && value.reconstitutionCadenceSecs <= 0n) ||
    (!value.isPerpetual && value.reconstitutionCadenceSecs !== 0n)
  ) {
    throw new RangeError(
      "reconstitutionCadenceSecs must be positive for perpetual baskets and zero otherwise",
    );
  }
  if (value.compositionExpiry <= 0n) {
    throw new RangeError("compositionExpiry must be positive");
  }
  const programId = value.programId ?? ALPHABASKET_PROGRAM_ID;
  return Buffer.concat([
    COMPOSITION_DOMAIN,
    publicKeyBytes(programId, "programId"),
    bytes32(value.basketId, "basketId"),
    nonZeroPublicKeyBytes(value.creator, "creator"),
    nonZeroPublicKeyBytes(
      value.creatorFeeDestination,
      "creatorFeeDestination",
    ),
    nonZeroBytes32(value.eligibilityHash, "eligibilityHash"),
    encodeU64LE(value.eligibilityNonce, "eligibilityNonce"),
    encodeU16LE(feeBps, "performanceFeeBps"),
    encodeBoolean(value.isPerpetual, "isPerpetual"),
    encodeI64LE(
      value.reconstitutionCadenceSecs,
      "reconstitutionCadenceSecs",
    ),
    encodeU64LE(value.compositionNonce, "compositionNonce"),
    encodeI64LE(value.compositionExpiry, "compositionExpiry"),
  ]);
}

export interface ReconstitutionAuthorization {
  readonly basketId: Uint8Array;
  readonly nextCompositionVersion: number;
  readonly eligibilityHash: Uint8Array;
  readonly eligibilityNonce: bigint;
  readonly compositionNonce: bigint;
  readonly compositionExpiry: bigint;
  readonly programId?: PublicKey;
}

export function reconstitutionAuthorizationMessage(
  value: ReconstitutionAuthorization,
): Buffer {
  if (value.nextCompositionVersion === 0) {
    throw new RangeError("nextCompositionVersion must be positive");
  }
  if (value.compositionExpiry <= 0n) {
    throw new RangeError("compositionExpiry must be positive");
  }
  const programId = value.programId ?? ALPHABASKET_PROGRAM_ID;
  return Buffer.concat([
    RECONSTITUTION_DOMAIN,
    publicKeyBytes(programId, "programId"),
    bytes32(value.basketId, "basketId"),
    encodeU32LE(value.nextCompositionVersion, "nextCompositionVersion"),
    nonZeroBytes32(value.eligibilityHash, "eligibilityHash"),
    encodeU64LE(value.eligibilityNonce, "eligibilityNonce"),
    encodeU64LE(value.compositionNonce, "compositionNonce"),
    encodeI64LE(value.compositionExpiry, "compositionExpiry"),
  ]);
}

export interface SpotPriceAttestation {
  readonly tokenMint: PublicKey;
  readonly priceValue: bigint;
  readonly confidenceBps: number;
  readonly observedAt: bigint;
  readonly validUntil: bigint;
  readonly nonce: bigint;
  readonly programId?: PublicKey;
}

export function spotPriceAttestationMessage(
  value: SpotPriceAttestation,
): Buffer {
  if (value.priceValue <= 0n || value.nonce <= 0n) {
    throw new RangeError("priceValue and nonce must be positive");
  }
  const confidenceBps = assertU16(value.confidenceBps, "confidenceBps");
  if (confidenceBps > 10_000) {
    throw new RangeError("confidenceBps cannot exceed 10000");
  }
  if (value.observedAt <= 0n || value.validUntil <= value.observedAt) {
    throw new RangeError("price attestation timestamps are invalid");
  }
  const programId = value.programId ?? ALPHABASKET_PROGRAM_ID;
  return Buffer.concat([
    PRICE_ATTESTATION_DOMAIN,
    publicKeyBytes(programId, "programId"),
    nonZeroPublicKeyBytes(value.tokenMint, "tokenMint"),
    encodeU64LE(value.priceValue, "priceValue"),
    encodeU16LE(confidenceBps, "confidenceBps"),
    encodeI64LE(value.observedAt, "observedAt"),
    encodeI64LE(value.validUntil, "validUntil"),
    encodeU64LE(value.nonce, "nonce"),
  ]);
}

interface IntentCommon {
  readonly basket: PublicKey;
  readonly user: PublicKey;
  readonly intentNonce: bigint;
  readonly intentExpiry: bigint;
  readonly expectedCompositionVersion: number;
  readonly quoteHash: Uint8Array;
  readonly programId?: PublicKey;
}

export interface DepositIntent extends IntentCommon {
  readonly grossAmount: bigint;
  readonly minSharesOut: bigint;
}

export function depositIntentMessage(value: DepositIntent): Buffer {
  const programId = value.programId ?? ALPHABASKET_PROGRAM_ID;
  if (value.grossAmount <= 0n || value.minSharesOut <= 0n) {
    throw new RangeError("grossAmount and minSharesOut must be positive");
  }
  if (
    value.intentNonce <= 0n ||
    value.intentExpiry <= 0n ||
    value.expectedCompositionVersion === 0
  ) {
    throw new RangeError(
      "intentNonce, intentExpiry and expectedCompositionVersion must be positive",
    );
  }
  return Buffer.concat([
    DEPOSIT_INTENT_DOMAIN,
    publicKeyBytes(programId, "programId"),
    nonZeroPublicKeyBytes(value.basket, "basket"),
    nonZeroPublicKeyBytes(value.user, "user"),
    encodeU64LE(value.intentNonce, "intentNonce"),
    encodeI64LE(value.intentExpiry, "intentExpiry"),
    encodeU32LE(
      value.expectedCompositionVersion,
      "expectedCompositionVersion",
    ),
    encodeU64LE(value.grossAmount, "grossAmount"),
    encodeU64LE(value.minSharesOut, "minSharesOut"),
    nonZeroBytes32(value.quoteHash, "quoteHash"),
  ]);
}

export interface WithdrawalIntent extends IntentCommon {
  readonly shareAmount: bigint;
  readonly minValueOut: bigint;
  readonly destination: PublicKey;
}

export function withdrawalIntentMessage(value: WithdrawalIntent): Buffer {
  const programId = value.programId ?? ALPHABASKET_PROGRAM_ID;
  if (value.shareAmount <= 0n) {
    throw new RangeError("shareAmount must be positive");
  }
  if (
    value.intentNonce <= 0n ||
    value.intentExpiry <= 0n ||
    value.expectedCompositionVersion === 0
  ) {
    throw new RangeError(
      "intentNonce, intentExpiry and expectedCompositionVersion must be positive",
    );
  }
  return Buffer.concat([
    WITHDRAWAL_INTENT_DOMAIN,
    publicKeyBytes(programId, "programId"),
    nonZeroPublicKeyBytes(value.basket, "basket"),
    nonZeroPublicKeyBytes(value.user, "user"),
    encodeU64LE(value.intentNonce, "intentNonce"),
    encodeI64LE(value.intentExpiry, "intentExpiry"),
    encodeU32LE(
      value.expectedCompositionVersion,
      "expectedCompositionVersion",
    ),
    encodeU64LE(value.shareAmount, "shareAmount"),
    encodeU64LE(value.minValueOut, "minValueOut"),
    nonZeroPublicKeyBytes(value.destination, "destination"),
    nonZeroBytes32(value.quoteHash, "quoteHash"),
  ]);
}
