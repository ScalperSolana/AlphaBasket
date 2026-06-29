import { Connection, PublicKey } from '@solana/web3.js';
import { ENV } from '@/env';

/**
 * Solana RPC connection (singleton). Uses VITE_SOLANA_RPC_URL, defaulting to devnet.
 * 'confirmed' commitment is a good default for a dApp: fast, and final enough
 * for UI state once we also explicitly confirm the stake transaction.
 */
export const connection = new Connection(ENV.SOLANA_RPC, 'confirmed');

export const SOLANA_CLUSTER = ENV.SOLANA_CLUSTER;

/**
 * Parse a base58 address into a PublicKey, returning null instead of throwing.
 * Used to validate env-supplied addresses without crashing module load.
 */
export function tryPublicKey(value: string | undefined | null): PublicKey | null {
  if (!value) {
    return null;
  }
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

/**
 * USDC SPL mint for the configured cluster. Validated as a real PublicKey at
 * load — a malformed mint is a configuration error we want to surface loudly.
 */
export const USDC_MINT = (() => {
  const mint = tryPublicKey(ENV.USDC_MINT);
  if (!mint) {
    throw new Error(
      `Invalid VITE_USDC_MINT: ${ENV.USDC_MINT}. Expected a base58 SPL mint address.`,
    );
  }
  return mint;
})();

/**
 * Protocol treasury wallet that receives stakes. May be empty in local dev;
 * callers must check `isTreasuryConfigured()` before building a transfer so we
 * never send funds to a zero/garbage address (fail closed — safe-solana-builder).
 */
export const TREASURY_ADDRESS = tryPublicKey(ENV.TREASURY_ADDRESS);

export function isTreasuryConfigured(): boolean {
  return TREASURY_ADDRESS !== null;
}

export function requireTreasury(): PublicKey {
  if (!TREASURY_ADDRESS) {
    throw new Error(
      'Treasury wallet is not configured. Set VITE_TREASURY_ADDRESS to the protocol treasury pubkey.',
    );
  }
  return TREASURY_ADDRESS;
}

/** Explorer URLs, cluster-aware. */
const clusterQuery = SOLANA_CLUSTER === 'mainnet-beta' ? '' : `?cluster=${SOLANA_CLUSTER}`;

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${clusterQuery}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}${clusterQuery}`;
}
