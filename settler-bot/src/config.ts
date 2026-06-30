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

const getBooleanEnv = (name: string, fallback: string): boolean => {
  const value = (getOptionalEnv(name) ?? fallback).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}: expected true or false`);
};

/** Base58-encoded Solana private key for the settler (the program's oracle authority). */
const getSettlerKeypairBase58 = (): string => {
  const key = getOptionalEnv('SETTLER_KEYPAIR');
  const keyFile = getOptionalEnv('SETTLER_KEYPAIR_FILE');

  if (key && keyFile) {
    throw new Error('Set exactly one of SETTLER_KEYPAIR or SETTLER_KEYPAIR_FILE');
  }
  if (keyFile) {
    const fileValue = readFileSync(keyFile, 'utf8').trim();
    if (!fileValue) {
      throw new Error(`SETTLER_KEYPAIR_FILE is empty: ${keyFile}`);
    }
    return fileValue;
  }
  if (key) {
    return key;
  }
  throw new Error('Missing settler secret: set SETTLER_KEYPAIR (base58 private key) or SETTLER_KEYPAIR_FILE');
};

export const config = {
  // Solana RPC for the bot (can differ from the frontend RPC).
  rpcUrl: getRequiredEnv('SETTLER_RPC_URL'),
  // Settler (oracle authority) signing key, base58.
  settlerKeypairBase58: getSettlerKeypairBase58(),
  pollIntervalMs: getNumberEnv('SETTLER_BOT_POLL_INTERVAL_MS', '30000'),
  shouldPropose: getBooleanEnv('SETTLER_BOT_PROPOSE_ENABLED', 'true'),
  shouldFinalize: getBooleanEnv('SETTLER_BOT_FINALIZE_ENABLED', 'true'),
  polymarketGammaBaseUrl:
    getOptionalEnv('POLYMARKET_GAMMA_BASE_URL') ?? 'https://gamma-api.polymarket.com',
};
