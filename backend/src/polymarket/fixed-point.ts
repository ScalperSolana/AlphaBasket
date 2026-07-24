const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export class DecimalParseError extends Error {
  public constructor(value: string, reason: string) {
    super(`Invalid decimal ${JSON.stringify(value)}: ${reason}`);
    this.name = "DecimalParseError";
  }
}

export const pow10 = (decimals: number): bigint => {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new RangeError("decimals must be an integer between 0 and 30");
  }
  return 10n ** BigInt(decimals);
};

/** Parses a non-negative decimal without rounding or IEEE-754 conversion. */
export const parseDecimalToFixed = (value: string, decimals: number): bigint => {
  const scale = pow10(decimals);
  const match = UNSIGNED_DECIMAL.exec(value);
  if (match === null) {
    throw new DecimalParseError(value, "expected an unsigned canonical decimal string");
  }
  const dot = value.indexOf(".");
  const wholeText = dot === -1 ? value : value.slice(0, dot);
  const fractionText = dot === -1 ? "" : value.slice(dot + 1);
  if (fractionText.length > decimals) {
    throw new DecimalParseError(value, `more than ${decimals} fractional digits`);
  }
  const paddedFraction = fractionText.padEnd(decimals, "0");
  return BigInt(wholeText) * scale + (paddedFraction === "" ? 0n : BigInt(paddedFraction));
};

export const formatFixedDecimal = (value: bigint, decimals: number): string => {
  if (value < 0n) {
    throw new RangeError("value must be non-negative");
  }
  const scale = pow10(decimals);
  const whole = value / scale;
  if (decimals === 0) {
    return whole.toString();
  }
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
};

export const mulDivFloor = (left: bigint, right: bigint, denominator: bigint): bigint => {
  if (left < 0n || right < 0n) {
    throw new RangeError("mulDivFloor operands must be non-negative");
  }
  if (denominator <= 0n) {
    throw new RangeError("mulDivFloor denominator must be positive");
  }
  return (left * right) / denominator;
};
