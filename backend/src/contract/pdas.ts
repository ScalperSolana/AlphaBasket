import { PublicKey } from "@solana/web3.js";

import { ALPHABASKET_PROGRAM_ID } from "./constants.js";
import {
  bytes32,
  encodeU64LE,
  nonZeroBytes32,
  nonZeroPublicKeyBytes,
  publicKeyBytes,
} from "./validation.js";

export type DerivedPda = readonly [address: PublicKey, bump: number];

export function deriveConfigPda(
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config", "ascii")],
    programId,
  );
}

export function deriveBasketPda(
  basketId: Uint8Array,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("basket", "ascii"), bytes32(basketId, "basketId")],
    programId,
  );
}

export function deriveEligibilityListPda(
  listHash: Uint8Array,
  nonce: bigint,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("eligibility", "ascii"),
      nonZeroBytes32(listHash, "listHash"),
      encodeU64LE(nonce, "nonce"),
    ],
    programId,
  );
}

export function deriveCompositionDraftPda(
  compositionHash: Uint8Array,
  compositionNonce: bigint,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("composition_draft", "ascii"),
      nonZeroBytes32(compositionHash, "compositionHash"),
      encodeU64LE(compositionNonce, "compositionNonce"),
    ],
    programId,
  );
}

export function deriveTokenAllowlistPda(
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_allowlist", "ascii")],
    programId,
  );
}

export function derivePriceAttestationPda(
  tokenMint: PublicKey,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("price_attestation", "ascii"),
      nonZeroPublicKeyBytes(tokenMint, "tokenMint"),
    ],
    programId,
  );
}

export function derivePositionPda(
  basket: PublicKey,
  user: PublicKey,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position", "ascii"),
      publicKeyBytes(basket, "basket"),
      nonZeroPublicKeyBytes(user, "user"),
    ],
    programId,
  );
}

export function deriveReceiptPda(
  executionBatchHash: Uint8Array,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("receipt", "ascii"),
      nonZeroBytes32(executionBatchHash, "executionBatchHash"),
    ],
    programId,
  );
}

/**
 * Phoenix perpetual PDAs.
 *
 * Every prefix is distinct from the ones the accounting instructions already
 * use (`config`, `basket`, `eligibility`, `composition_draft`, `position`,
 * `receipt`, `token_allowlist`, `price_attestation`), so no two account kinds
 * share a namespace.
 */
export function derivePerpEligibilityListPda(
  listHash: Uint8Array,
  nonce: bigint,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("perp_eligibility", "ascii"),
      nonZeroBytes32(listHash, "listHash"),
      encodeU64LE(nonce, "nonce"),
    ],
    programId,
  );
}

export function derivePerpTraderRegistryPda(
  executionWallet: PublicKey,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("perp_trader", "ascii"),
      nonZeroPublicKeyBytes(executionWallet, "executionWallet"),
    ],
    programId,
  );
}

export function derivePerpReceiptPda(
  executionHash: Uint8Array,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("perp_receipt", "ascii"),
      nonZeroBytes32(executionHash, "executionHash"),
    ],
    programId,
  );
}

export function derivePerpEventPda(
  eventHash: Uint8Array,
  programId: PublicKey = ALPHABASKET_PROGRAM_ID,
): DerivedPda {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("perp_event", "ascii"),
      nonZeroBytes32(eventHash, "eventHash"),
    ],
    programId,
  );
}
