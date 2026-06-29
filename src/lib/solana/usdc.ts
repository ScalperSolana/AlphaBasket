import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { USDC_MINT } from '@/lib/solana/connection';

/** USDC has 6 decimals on Solana. */
export const USDC_DECIMALS = 6;

const USDC_BASE = 10 ** USDC_DECIMALS;

/**
 * Convert a human USDC amount (e.g. "10.5") into base units (bigint).
 * Truncates beyond 6 decimals rather than rounding, so we never overstate the
 * amount the user is asked to sign for.
 */
export function toUsdcUnits(amount: string | number): bigint {
  const num = typeof amount === 'string' ? Number.parseFloat(amount.replace(',', '.')) : amount;
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid USDC amount: ${amount}`);
  }
  // Avoid float drift by working on a fixed-decimal string.
  const [whole, frac = ''] = num.toFixed(USDC_DECIMALS).split('.');
  return BigInt(whole) * BigInt(USDC_BASE) + BigInt(frac.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS));
}

/** Format base units (bigint) back to a human USDC string, trimming trailing zeros. */
export function fromUsdcUnits(units: bigint, maxFractionDigits = USDC_DECIMALS): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / BigInt(USDC_BASE);
  const frac = (abs % BigInt(USDC_BASE)).toString().padStart(USDC_DECIMALS, '0');
  const trimmedFrac = frac.slice(0, Math.max(0, maxFractionDigits)).replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return trimmedFrac ? `${sign}${whole}.${trimmedFrac}` : `${sign}${whole}`;
}

/** Number form for display math (PnL bars etc.). Precision is fine for UI. */
export function usdcUnitsToNumber(units: bigint): number {
  return Number(units) / USDC_BASE;
}

/** Associated token account for a wallet's USDC balance. */
export function usdcAtaFor(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_MINT, owner);
}
