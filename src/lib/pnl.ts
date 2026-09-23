import type { PortfolioHolding } from "@/types/index-basket";

/** Signed difference between current value and cost basis, in six-decimal units. */
export const pnlUnits = (holding: PortfolioHolding): bigint | null => {
  if (holding.currentValueUnits === null) return null;
  try {
    return BigInt(holding.currentValueUnits) - BigInt(holding.costBasisValue);
  } catch {
    return null;
  }
};
