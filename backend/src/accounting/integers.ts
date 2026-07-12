export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

export function u64(value: bigint, field = "value"): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new RangeError(`${field} must be a u64 bigint`);
  }
  return value;
}

export function u128(value: bigint, field = "value"): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U128_MAX) {
    throw new RangeError(`${field} must be a u128 bigint`);
  }
  return value;
}

export function i64(value: bigint, field = "value"): bigint {
  if (typeof value !== "bigint" || value < I64_MIN || value > I64_MAX) {
    throw new RangeError(`${field} must be an i64 bigint`);
  }
  return value;
}

export function basisPoints(value: number, field = "basisPoints"): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`${field} must be an integer in [0, 10000]`);
  }
  return BigInt(value);
}

export function addU64(left: bigint, right: bigint, field: string): bigint {
  return u64(u64(left, field) + u64(right, field), field);
}

export function subU64(left: bigint, right: bigint, field: string): bigint {
  const checkedLeft = u64(left, field);
  const checkedRight = u64(right, field);
  if (checkedRight > checkedLeft) {
    throw new RangeError(`${field} underflow`);
  }
  return checkedLeft - checkedRight;
}

export function addU128(left: bigint, right: bigint, field: string): bigint {
  return u128(u128(left, field) + u128(right, field), field);
}

export function multiplyU128(
  left: bigint,
  right: bigint,
  field: string,
): bigint {
  return u128(u128(left, field) * u128(right, field), field);
}

export function subtractI64(
  left: bigint,
  right: bigint,
  field: string,
): bigint {
  return i64(i64(left, field) - i64(right, field), field);
}

