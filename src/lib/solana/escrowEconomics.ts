export const BASIS_POINTS = 10_000n;
export const DEPOSIT_FEE_BPS = 200n;
export const WITHDRAWAL_FEE_BPS = 200n;

export function feeUnitsCeil(amountUnits: bigint, feeBps: bigint): bigint {
  if (amountUnits < 0n) throw new Error('amountUnits cannot be negative');
  return (amountUnits * feeBps + BASIS_POINTS - 1n) / BASIS_POINTS;
}

export function netDepositUnits(grossAmountUnits: bigint): bigint {
  return grossAmountUnits - feeUnitsCeil(grossAmountUnits, DEPOSIT_FEE_BPS);
}
