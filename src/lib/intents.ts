/**
 * Browser-side encoding of the user intents the backend verifies.
 *
 * Byte-for-byte port of `backend/src/contract/messages.ts` (`depositIntentMessage`
 * and `withdrawalIntentMessage`). The wallet signs exactly these bytes; the
 * backend re-encodes the same fields from its authoritative quote and checks the
 * Ed25519 signature, so any drift here is caught as "invalid user intent
 * signature" rather than silently accepted. Keep the two in lockstep.
 */

import { PublicKey } from "@solana/web3.js";

import type { DepositQuote, WithdrawalQuote } from "@/types/index-basket";

export const ALPHABASKET_PROGRAM_ID = new PublicKey(
  "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm",
);

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);
const DEPOSIT_INTENT_DOMAIN = ascii("ALPHABASKET_DEPOSIT_INTENT_V1");
const WITHDRAWAL_INTENT_DOMAIN = ascii("ALPHABASKET_WITHDRAWAL_INTENT_V1");

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const u64le = (value: bigint, field: string): Uint8Array => {
  if (value < 0n || value > U64_MAX) throw new RangeError(`${field} must be a u64`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};

const i64le = (value: bigint, field: string): Uint8Array => {
  if (value < I64_MIN || value > I64_MAX) throw new RangeError(`${field} must be an i64`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
};

const u32le = (value: number, field: string): Uint8Array => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${field} must be a u32`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

const nonZeroKey = (value: string, field: string): Uint8Array => {
  const bytes = new PublicKey(value).toBytes();
  if (bytes.every((byte) => byte === 0)) throw new RangeError(`${field} cannot be the zero key`);
  return bytes;
};

const hex32 = (value: string, field: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new RangeError(`${field} must be 32 bytes of hex`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  if (bytes.every((byte) => byte === 0)) throw new RangeError(`${field} cannot be all zeroes`);
  return bytes;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const positive = (value: string, field: string): bigint => {
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new RangeError(`${field} must be positive`);
  return parsed;
};

export function depositIntentMessage(quote: DepositQuote, nonce: bigint): Uint8Array {
  if (nonce <= 0n) throw new RangeError("nonce must be positive");
  if (quote.compositionVersion === 0) throw new RangeError("compositionVersion must be positive");
  return concat([
    DEPOSIT_INTENT_DOMAIN,
    ALPHABASKET_PROGRAM_ID.toBytes(),
    nonZeroKey(quote.basket, "basket"),
    nonZeroKey(quote.user, "user"),
    u64le(nonce, "intentNonce"),
    i64le(positive(quote.expiresAtSeconds, "intentExpiry"), "intentExpiry"),
    u32le(quote.compositionVersion, "expectedCompositionVersion"),
    u64le(positive(quote.grossAmount, "grossAmount"), "grossAmount"),
    u64le(positive(quote.minSharesOut, "minSharesOut"), "minSharesOut"),
    hex32(quote.quoteHash, "quoteHash"),
  ]);
}

export function withdrawalIntentMessage(
  quote: WithdrawalQuote,
  nonce: bigint,
  destination: string,
): Uint8Array {
  if (nonce <= 0n) throw new RangeError("nonce must be positive");
  if (quote.compositionVersion === 0) throw new RangeError("compositionVersion must be positive");
  return concat([
    WITHDRAWAL_INTENT_DOMAIN,
    ALPHABASKET_PROGRAM_ID.toBytes(),
    nonZeroKey(quote.basket, "basket"),
    nonZeroKey(quote.user, "user"),
    u64le(nonce, "intentNonce"),
    i64le(positive(quote.expiresAtSeconds, "intentExpiry"), "intentExpiry"),
    u32le(quote.compositionVersion, "expectedCompositionVersion"),
    u64le(positive(quote.shareAmount, "shareAmount"), "shareAmount"),
    u64le(BigInt(quote.minValueOut), "minValueOut"),
    nonZeroKey(destination, "destination"),
    hex32(quote.quoteHash, "quoteHash"),
  ]);
}

/**
 * Intent nonces only have to be positive and strictly increasing per position.
 * Milliseconds since the epoch satisfy both for any human-paced use without a
 * round trip to read the position's last nonce.
 */
export const nextIntentNonce = (): bigint => BigInt(Date.now());

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
