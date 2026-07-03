export const BASIS_POINTS = 10_000n;
export const DEPOSIT_FEE_BPS = 200n;
export const WITHDRAWAL_FEE_BPS = 200n;
export const MAX_USER_DEPOSIT_USDC_UNITS = 500_000_000n;
export const MAX_BASKET_DEPOSIT_USDC_UNITS = 10_000_000_000n;

export function feeUnitsCeil(amountUnits: bigint, feeBps: bigint): bigint {
  if (amountUnits < 0n) throw new Error('amountUnits cannot be negative');
  return (amountUnits * feeBps + BASIS_POINTS - 1n) / BASIS_POINTS;
}

export function netDepositUnits(grossAmountUnits: bigint): bigint {
  return grossAmountUnits - feeUnitsCeil(grossAmountUnits, DEPOSIT_FEE_BPS);
}
