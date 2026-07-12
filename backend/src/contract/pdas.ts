import { PublicKey } from "@solana/web3.js";

import { ALPHABASKET_PROGRAM_ID } from "./constants.js";
import {
  bytes32,
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

