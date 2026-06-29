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

const getRequiredHexEnv = (name: string): `0x${string}` => {
  const value = getRequiredEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Invalid ${name}: expected 32-byte hex ActorId`);
  }

  return value as `0x${string}`;
};

const getPositiveNumberEnv = (name: string, fallback: string): number => {
  const value = Number(getOptionalEnv(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive number`);
  }

  return value;
};

const getAllowedOrigins = (): string[] =>
  (getOptionalEnv('FRONTEND_URLS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const getCsvEnv = (name: string, fallback: string): string[] =>
  (getOptionalEnv(name) ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const normalizeMnemonic = (value: string): string =>
  value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');

const getQuoteSignerSeed = (): string => {
  const seed = getOptionalEnv('BET_QUOTE_SIGNER_SEED');
  const seedFile = getOptionalEnv('BET_QUOTE_SIGNER_SEED_FILE');

  if (seed && seedFile) {
    throw new Error('Set exactly one of BET_QUOTE_SIGNER_SEED or BET_QUOTE_SIGNER_SEED_FILE');
  }

  if (seedFile) {
    const fileValue = readFileSync(seedFile, 'utf8').trim();
    if (!fileValue) {
      throw new Error(`BET_QUOTE_SIGNER_SEED_FILE is empty: ${seedFile}`);
    }

    return normalizeMnemonic(fileValue);
  }

  if (seed) {
    return normalizeMnemonic(seed);
  }

  throw new Error('Missing quote signer secret: set BET_QUOTE_SIGNER_SEED or BET_QUOTE_SIGNER_SEED_FILE');
};

export const config = {
  port: getPositiveNumberEnv('PORT', getOptionalEnv('BET_QUOTE_SERVICE_PORT') ?? '4360'),
  varaRpcUrl: getRequiredEnv('VARA_RPC_URL'),
  varaReconnectAttempts: getPositiveNumberEnv('VARA_RECONNECT_ATTEMPTS', '5'),
  varaReconnectDelayMs: getPositiveNumberEnv('VARA_RECONNECT_DELAY_MS', '1000'),
  varaReconnectMaxDelayMs: getPositiveNumberEnv('VARA_RECONNECT_MAX_DELAY_MS', '10000'),
  basketMarketProgramId: getRequiredHexEnv('BASKET_MARKET_PROGRAM_ID'),
  betLaneProgramId: getRequiredHexEnv('BET_LANE_PROGRAM_ID'),
  quoteSignerSeed: getQuoteSignerSeed(),
  quoteTtlMs: getPositiveNumberEnv('BET_QUOTE_TTL_MS', '30000'),
  betCutoffMs: getPositiveNumberEnv('BASKET_MARKET_BET_CUTOFF_MS', '60000'),
  marketEndToleranceMs: getPositiveNumberEnv('BASKET_MARKET_END_TOLERANCE_MS', '120000'),
  polymarketGammaBaseUrl:
    getOptionalEnv('POLYMARKET_GAMMA_BASE_URL') ?? 'https://gamma-api.polymarket.com',
  allowedOrigins: getAllowedOrigins(),
  bindingPrefix: getOptionalEnv('BET_QUOTE_BINDING_PREFIX') ?? 'BetLaneQuoteV1',
  basketMarketBindingPrefix:
    getOptionalEnv('BASKET_MARKET_QUOTE_BINDING_PREFIX') ?? 'BasketMarketVaraQuoteV1',
  blockedMarketSlugPatterns: getCsvEnv(
    'BASKET_MARKET_BLOCKED_SLUG_PATTERNS',
    'btc-updown-5m,btc-updown-15m',
  ),
};
