export const bigintTransformer = {
  to(value?: bigint | null): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return value.toString();
  },
  from(value?: string | null): bigint | null {
    if (value === null || value === undefined) {
      return null;
    }
    return BigInt(value);
  },
};

export const requiredBigintTransformer = {
  to(value: bigint): string {
    return value.toString();
  },
  from(value: string): bigint {
    return BigInt(value);
  },
};
