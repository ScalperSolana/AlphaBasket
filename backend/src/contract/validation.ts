import { PublicKey } from "@solana/web3.js";

const U8_MAX = 0xff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;
export const U64_MAX = (1n << 64n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

export function assertU8(value: number, field = "value"): number {
  return assertUnsignedNumber(value, U8_MAX, field);
}

export function assertU16(value: number, field = "value"): number {
  return assertUnsignedNumber(value, U16_MAX, field);
}

export function assertU32(value: number, field = "value"): number {
  return assertUnsignedNumber(value, U32_MAX, field);
}

function assertUnsignedNumber(
  value: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${field} must be an integer in [0, ${maximum}]`);
  }
  return value;
}

export function assertU64(value: bigint, field = "value"): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new RangeError(`${field} must be a u64 bigint`);
  }
  return value;
}

export function assertI64(value: bigint, field = "value"): bigint {
  if (typeof value !== "bigint" || value < I64_MIN || value > I64_MAX) {
    throw new RangeError(`${field} must be an i64 bigint`);
  }
  return value;
}

export function assertU128(value: bigint, field = "value"): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U128_MAX) {
    throw new RangeError(`${field} must be a u128 bigint`);
  }
  return value;
}

export function fixedBytes(
  value: Uint8Array,
  length: number,
  field = "value",
): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new RangeError(`${field} must contain exactly ${length} bytes`);
  }
  return Buffer.from(value);
}

export function bytes32(value: Uint8Array, field = "value"): Buffer {
  return fixedBytes(value, 32, field);
}

export function nonZeroBytes32(value: Uint8Array, field = "value"): Buffer {
  const bytes = bytes32(value, field);
  if (bytes.every((byte) => byte === 0)) {
    throw new RangeError(`${field} cannot be all zeroes`);
  }
  return bytes;
}

export function publicKeyBytes(value: PublicKey, field = "value"): Buffer {
  if (!(value instanceof PublicKey)) {
    throw new TypeError(`${field} must be a PublicKey`);
  }
  return value.toBuffer();
}

export function nonZeroPublicKeyBytes(
  value: PublicKey,
  field = "value",
): Buffer {
  const bytes = publicKeyBytes(value, field);
  if (bytes.every((byte) => byte === 0)) {
    throw new RangeError(`${field} cannot be the zero public key`);
  }
  return bytes;
}

export function encodeU8(value: number, field = "value"): Buffer {
  return Buffer.from([assertU8(value, field)]);
}

export function encodeU16LE(value: number, field = "value"): Buffer {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16LE(assertU16(value, field));
  return bytes;
}

export function encodeU32LE(value: number, field = "value"): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(assertU32(value, field));
  return bytes;
}

export function encodeU64LE(value: bigint, field = "value"): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64LE(assertU64(value, field));
  return bytes;
}

export function encodeI64LE(value: bigint, field = "value"): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigInt64LE(assertI64(value, field));
  return bytes;
}

export function encodeBoolean(value: boolean, field = "value"): Buffer {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return Buffer.from([value ? 1 : 0]);
}

