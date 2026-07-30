import { PublicKey } from "@solana/web3.js";

export const ALPHABASKET_PROGRAM_ID = new PublicKey(
  "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm",
);

export const COMPOSITION_DOMAIN = Buffer.from(
  "AB_CREATE_V2",
  "ascii",
);
export const RECONSTITUTION_DOMAIN = Buffer.from(
  "AB_RECON_V2",
  "ascii",
);
export const PRICE_ATTESTATION_DOMAIN = Buffer.from(
  "ALPHABASKET_SPOT_PRICE_V1",
  "ascii",
);
export const DEPOSIT_INTENT_DOMAIN = Buffer.from(
  "ALPHABASKET_DEPOSIT_INTENT_V1",
  "ascii",
);
export const WITHDRAWAL_INTENT_DOMAIN = Buffer.from(
  "ALPHABASKET_WITHDRAWAL_INTENT_V1",
  "ascii",
);

export const MAX_BASKET_ITEMS = 16;
export const MAX_ELIGIBLE_MARKETS = 16;
export const MAX_MARKET_ID_BYTES = 64;
export const MAX_SINGLE_SOURCE_WEIGHT_BPS = 3_000;
export const MAX_MIXED_WEIGHT_BPS = 2_000;
export const MAX_BPS = 10_000;
export const MAX_CREATOR_PERFORMANCE_FEE_BPS = 2_000;
export const DEFAULT_CREATOR_PERFORMANCE_FEE_BPS = 1_000;
export const EXECUTION_BATCH_VERSION = 1;
