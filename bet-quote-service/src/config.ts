import 'dotenv/config';
import { readFileSync } from 'node:fs';

const getOptionalEnv = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const getRequiredEnv = (name: string): string => {
  const value = getOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const getNumberEnv = (name: string, fallback: string): number => {
  const value = Number(getOptionalEnv(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive number`);
  }
  return value;
};

/** Base58-encoded Solana private key for the quote signer (the program's quote_signer). */
const getQuoteSignerKeypairBase58 = (): string => {
  const key = getOptionalEnv('BET_QUOTE_SIGNER_KEYPAIR');
  const keyFile = getOptionalEnv('BET_QUOTE_SIGNER_KEYPAIR_FILE');

  if (key && keyFile) {
    throw new Error('Set exactly one of BET_QUOTE_SIGNER_KEYPAIR or BET_QUOTE_SIGNER_KEYPAIR_FILE');
  }
  if (keyFile) {
    const fileValue = readFileSync(keyFile, 'utf8').trim();
    if (!fileValue) {
      throw new Error(`BET_QUOTE_SIGNER_KEYPAIR_FILE is empty: ${keyFile}`);
    }
    return fileValue;
  }
  if (key) {
    return key;
  }
  throw new Error(
    'Missing quote signer secret: set BET_QUOTE_SIGNER_KEYPAIR (base58 private key) or BET_QUOTE_SIGNER_KEYPAIR_FILE',
  );
};

export const config = {
  port: getNumberEnv('BET_QUOTE_SERVICE_PORT', '4360'),
  signerKeypairBase58: getQuoteSignerKeypairBase58(),
  // Solana RPC used to read basket composition on-chain.
  rpcUrl:
    getOptionalEnv('QUOTE_RPC_URL') ??
    getOptionalEnv('SOLANA_RPC_URL') ??
    'https://api.devnet.solana.com',
  polymarketGammaBaseUrl:
    getOptionalEnv('POLYMARKET_GAMMA_BASE_URL') ?? 'https://gamma-api.polymarket.com',
  // Signed-quote lifetime; the escrow rejects quotes past `expiry`.
  quoteTtlMs: getNumberEnv('BET_QUOTE_TTL_MS', '120000'),
  // CORS allowlist (comma-separated). Empty → allow all (dev).
  allowedOrigins: (getOptionalEnv('FRONTEND_URLS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};
