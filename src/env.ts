import type { BasketAssetKind } from '@/types/basket.ts';

const parseBooleanEnv = (value: unknown, fallback: boolean): boolean => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const parseNumberEnv = (value: unknown, fallback: number): number => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeUrl = (value: string): string => value.replace(/\/+$/, '');

// USDC SPL mint on Solana devnet.
const DEVNET_USDC_MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

export const ENV = {
  // Solana configuration
  SOLANA_RPC: import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  SOLANA_CLUSTER: (import.meta.env.VITE_SOLANA_CLUSTER || 'devnet') as
    | 'devnet'
    | 'testnet'
    | 'mainnet-beta',
  USDC_MINT: import.meta.env.VITE_USDC_MINT || DEVNET_USDC_MINT,
  // House funder of basket vaults (covers net winnings beyond staked principal).
  TREASURY_ADDRESS: import.meta.env.VITE_TREASURY_ADDRESS || '',
  // Entry-index quote signer service: signs the Ed25519 quotes the escrow verifies.
  QUOTE_API_URL: normalizeUrl(import.meta.env.VITE_QUOTE_API_URL || ''),
  // DEV ONLY: JSON array of 64 ints (a keypair secret) to sign quotes client-side.
  // Insecure — never set in production. Use VITE_QUOTE_API_URL instead.
  DEV_QUOTE_SIGNER_SECRET: import.meta.env.VITE_DEV_QUOTE_SIGNER_SECRET || '',

  // Generic, chain-agnostic flags
  ENABLE_MANUAL_BETTING: parseBooleanEnv(import.meta.env.VITE_ENABLE_MANUAL_BETTING, true),
  EXPLORER_HOLD_ENABLED: parseBooleanEnv(import.meta.env.VITE_EXPLORER_HOLD_ENABLED, false),
  BASKET_BET_CUTOFF_MS: parseNumberEnv(import.meta.env.VITE_BASKET_BET_CUTOFF_MS, 300_000),

  // Off-chain dashboard services (stats / rewards / contest). Not part of the
  // Solana settlement path; retained so the read-only dashboards compile. These
  // identifiers are unused by the core Solana flow.
  PROGRAM_ID: import.meta.env.VITE_PROGRAM_ID || '',
  BASKET_HISTORY_PROGRAM_IDS: (import.meta.env.VITE_BASKET_HISTORY_PROGRAM_IDS || '')
    .split(',')
    .map((v: string) => v.trim())
    .filter(Boolean) as `0x${string}`[],
  INDEXER_GRAPHQL_ENDPOINT:
    import.meta.env.VITE_INDEXER_GRAPHQL_ENDPOINT || 'http://localhost:4350/graphql',
  REWARDS_API_URL: normalizeUrl(import.meta.env.VITE_REWARDS_API_URL || 'http://127.0.0.1:3002'),
  REWARDS_WEEKLY_POST_URL:
    import.meta.env.VITE_REWARDS_WEEKLY_POST_URL || 'https://x.com/poly_baskets',
  CONTEST_DAY_BOUNDARY_OFFSET_MS: parseNumberEnv(
    import.meta.env.VITE_CONTEST_DAY_BOUNDARY_OFFSET_MS,
    43_200_000,
  ),

  EXPLORER_HOLD_BADGE: import.meta.env.VITE_EXPLORER_HOLD_BADGE || 'Temporary pause',
  EXPLORER_HOLD_TITLE:
    import.meta.env.VITE_EXPLORER_HOLD_TITLE || 'PolyBaskets is taking a short pause',
  EXPLORER_HOLD_MESSAGE:
    import.meta.env.VITE_EXPLORER_HOLD_MESSAGE ||
    'We are polishing the next launch experience. Stay close, the app will reopen soon and we would love to have you there on day one.',
  EXPLORER_HOLD_PRIMARY_CTA_LABEL:
    import.meta.env.VITE_EXPLORER_HOLD_PRIMARY_CTA_LABEL || 'Get launch updates',
  EXPLORER_HOLD_PRIMARY_CTA_URL:
    import.meta.env.VITE_EXPLORER_HOLD_PRIMARY_CTA_URL || 'https://t.me/polybaskets',
};

export const getLaunchAppUrl = (): string => {
  const configuredUrl = import.meta.env.VITE_APP_URL;
  if (typeof configuredUrl === 'string' && configuredUrl.trim()) {
    return normalizeUrl(configuredUrl.trim());
  }

  if (typeof window !== 'undefined') {
    const { hostname } = window.location;
    if (hostname === 'polybaskets.xyz' || hostname === 'www.polybaskets.xyz') {
      return 'https://app.polybaskets.xyz';
    }
  }

  return '/explorer';
};

export const isManualBettingEnabled = () => ENV.ENABLE_MANUAL_BETTING;

export const getDefaultBasketAssetKind = (): BasketAssetKind => 'USDC';
