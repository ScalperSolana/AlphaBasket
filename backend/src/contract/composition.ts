import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

import {
  MAX_BASKET_ITEMS,
  MAX_BPS,
  MAX_ELIGIBLE_MARKETS,
  MAX_MARKET_ID_BYTES,
  MAX_MIXED_WEIGHT_BPS,
  MAX_PERP_ELIGIBLE_MARKETS,
  MAX_PERP_LEVERAGE_BPS,
  MAX_SINGLE_SOURCE_WEIGHT_BPS,
  MIN_PERP_LEVERAGE_BPS,
  PHOENIX_CROSS_SUBACCOUNT_INDEX,
} from "./constants.js";
import {
  assertU8,
  assertU16,
  encodeU16LE,
  nonZeroBytes32,
} from "./validation.js";

export interface PredictionMarketPositionKind {
  readonly predictionMarket: {
    readonly outcome: number;
    readonly ctfTokenId: Uint8Array;
  };
}

export interface SpotPositionKind {
  readonly spot: {
    readonly tokenMint: PublicKey;
  };
}

export type PerpDirection = "long" | "short";

export interface PerpPositionKind {
  readonly perp: {
    readonly direction: PerpDirection;
    readonly leverageBps: number;
    /**
     * Post-execution figures. Present on the item but **excluded from the
     * canonical hash**: settlement rewrites both in place, so hashing them would
     * make the composition hash stop matching the composition after the first
     * fill. See `canonical_composition_bytes` in `create_basket.rs`.
     */
    readonly entryMarkPrice: bigint;
    readonly marginPosted: bigint;
    /** Phoenix isolated subaccount. Must be greater than zero. */
    readonly phoenixSubaccount: number;
  };
}

export interface BasketAsset {
  readonly marketId: string;
  readonly kind:
    | PredictionMarketPositionKind
    | SpotPositionKind
    | PerpPositionKind;
  readonly weightBps: number;
}

/** One Phoenix market a Composer has admitted. No weights, no CTF fields. */
export interface PerpEligibleMarket {
  readonly marketId: string;
}

export interface EligibleMarket {
  readonly marketId: string;
  readonly outcome: number;
  readonly ctfTokenId: Uint8Array;
}

const isPredictionMarket = (
  kind: BasketAsset["kind"],
): kind is PredictionMarketPositionKind => "predictionMarket" in kind;

const isPerp = (kind: BasketAsset["kind"]): kind is PerpPositionKind =>
  "perp" in kind;

const isSpot = (kind: BasketAsset["kind"]): kind is SpotPositionKind =>
  "spot" in kind;

function validateAndEncodeAsset(asset: BasketAsset, weightCapBps: number): Buffer {
  if (typeof asset.marketId !== "string") {
    throw new TypeError("marketId must be a string");
  }
  const market = Buffer.from(asset.marketId, "utf8");
  if (market.length === 0 || market.length > MAX_MARKET_ID_BYTES) {
    throw new RangeError(
      `marketId must contain 1-${MAX_MARKET_ID_BYTES} UTF-8 bytes`,
    );
  }

  const weight = assertU16(asset.weightBps, "weightBps");
  if (weight === 0 || weight > weightCapBps) {
    throw new RangeError(
      `weightBps must be in [1, ${weightCapBps}]`,
    );
  }

  if (isPredictionMarket(asset.kind)) {
    const prediction = asset.kind.predictionMarket;
    const outcome = assertU8(prediction.outcome, "outcome");
    if (outcome > 1) {
      throw new RangeError("prediction-market outcome must be 0 or 1");
    }
    const ctfTokenId = nonZeroBytes32(prediction.ctfTokenId, "ctfTokenId");
    return Buffer.concat([
      encodeU16LE(market.length, "marketId length"),
      market,
      Buffer.from([0, outcome]),
      ctfTokenId,
      encodeU16LE(weight, "weightBps"),
    ]);
  }
  if (isPerp(asset.kind)) {
    const perp = asset.kind.perp;
    const subaccount = assertU8(perp.phoenixSubaccount, "phoenixSubaccount");
    if (subaccount === PHOENIX_CROSS_SUBACCOUNT_INDEX) {
      throw new RangeError(
        "phoenixSubaccount 0 is Phoenix's cross-margin account and may never hold a position",
      );
    }
    const leverage = assertU16(perp.leverageBps, "leverageBps");
    if (leverage < MIN_PERP_LEVERAGE_BPS || leverage > MAX_PERP_LEVERAGE_BPS) {
      throw new RangeError(
        `leverageBps must be in [${MIN_PERP_LEVERAGE_BPS}, ${MAX_PERP_LEVERAGE_BPS}]`,
      );
    }
    if (perp.direction !== "long" && perp.direction !== "short") {
      throw new TypeError('perp direction must be "long" or "short"');
    }
    // `entryMarkPrice` and `marginPosted` are deliberately not encoded.
    return Buffer.concat([
      encodeU16LE(market.length, "marketId length"),
      market,
      Buffer.from([2, perp.direction === "short" ? 1 : 0]),
      encodeU16LE(leverage, "leverageBps"),
      Buffer.from([subaccount]),
      encodeU16LE(weight, "weightBps"),
    ]);
  }

  const tokenMint = (asset.kind as SpotPositionKind)?.spot?.tokenMint;
  if (!(tokenMint instanceof PublicKey) || tokenMint.equals(PublicKey.default)) {
    throw new TypeError("spot tokenMint must be a non-zero PublicKey");
  }
  return Buffer.concat([
    encodeU16LE(market.length, "marketId length"),
    market,
    Buffer.from([1]),
    tokenMint.toBuffer(),
    encodeU16LE(weight, "weightBps"),
  ]);
}

export function canonicalCompositionBytes(
  items: readonly BasketAsset[],
): Buffer {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RangeError("composition must contain at least one item");
  }
  if (items.length > MAX_BASKET_ITEMS) {
    throw new RangeError(
      `composition cannot contain more than ${MAX_BASKET_ITEMS} items`,
    );
  }

  const encoded: Buffer[] = [];
  const marketIds = new Set<string>();
  const ctfTokenIds = new Set<string>();
  const spotMints = new Set<string>();
  const perpSubaccounts = new Set<number>();
  let totalWeight = 0;
  const hasPrediction = items.some((item) => isPredictionMarket(item.kind));
  const hasSpot = items.some((item) => isSpot(item.kind));
  const hasPerp = items.some((item) => isPerp(item.kind));

  // A perpetual basket is never mixed with spot or prediction markets. Perps
  // carry leverage and a liquidation price; blending them with unlevered
  // positions makes the basket's NAV undecomposable.
  if (hasPerp && (hasPrediction || hasSpot)) {
    throw new RangeError(
      "a perpetual basket may not contain spot or prediction-market items",
    );
  }

  const weightCapBps =
    hasPrediction && hasSpot
      ? MAX_MIXED_WEIGHT_BPS
      : MAX_SINGLE_SOURCE_WEIGHT_BPS;

  for (const item of items) {
    const itemBytes = validateAndEncodeAsset(item, weightCapBps);
    if (isPerp(item.kind)) {
      const subaccount = item.kind.perp.phoenixSubaccount;
      // Two items sharing one isolated subaccount would share collateral, which
      // is the thing isolation exists to prevent.
      if (marketIds.has(item.marketId) || perpSubaccounts.has(subaccount)) {
        throw new RangeError(
          "composition contains a duplicate perp market or isolated subaccount",
        );
      }
      marketIds.add(item.marketId);
      perpSubaccounts.add(subaccount);
    } else if (isPredictionMarket(item.kind)) {
      const ctfKey = Buffer.from(
        item.kind.predictionMarket.ctfTokenId,
      ).toString("hex");
      if (marketIds.has(item.marketId) || ctfTokenIds.has(ctfKey)) {
        throw new RangeError("composition contains a duplicate market or CTF token");
      }
      marketIds.add(item.marketId);
      ctfTokenIds.add(ctfKey);
    } else {
      const mint = item.kind.spot.tokenMint.toBase58();
      if (spotMints.has(mint)) {
        throw new RangeError("composition contains a duplicate spot token");
      }
      spotMints.add(mint);
    }
    totalWeight += item.weightBps;
    encoded.push(itemBytes);
  }

  if (totalWeight !== MAX_BPS) {
    throw new RangeError(`composition weights must total ${MAX_BPS} bps`);
  }

  return Buffer.concat([
    encodeU16LE(items.length, "item count"),
    ...encoded,
  ]);
}

export function compositionHash(items: readonly BasketAsset[]): Buffer {
  return createHash("sha256").update(canonicalCompositionBytes(items)).digest();
}

/** Mirrors `canonical_perp_eligibility_bytes` in `registry.rs`. */
export function canonicalPerpEligibilityBytes(
  markets: readonly PerpEligibleMarket[],
): Buffer {
  if (
    !Array.isArray(markets) ||
    markets.length === 0 ||
    markets.length > MAX_PERP_ELIGIBLE_MARKETS
  ) {
    throw new RangeError(
      `perp eligible list must contain 1-${MAX_PERP_ELIGIBLE_MARKETS} markets`,
    );
  }
  const seen = new Set<string>();
  const encoded = markets.map((market) => {
    if (typeof market.marketId !== "string") {
      throw new TypeError("perp eligible marketId must be a string");
    }
    const marketId = Buffer.from(market.marketId, "utf8");
    if (marketId.length === 0 || marketId.length > MAX_MARKET_ID_BYTES) {
      throw new RangeError(
        `perp eligible marketId must contain 1-${MAX_MARKET_ID_BYTES} UTF-8 bytes`,
      );
    }
    if (seen.has(market.marketId)) {
      throw new RangeError("perp eligible list contains a duplicate market");
    }
    seen.add(market.marketId);
    return Buffer.concat([
      encodeU16LE(marketId.length, "perp eligible marketId length"),
      marketId,
    ]);
  });
  return Buffer.concat([
    encodeU16LE(markets.length, "perp eligible market count"),
    ...encoded,
  ]);
}

export function perpEligibilityHash(
  markets: readonly PerpEligibleMarket[],
): Buffer {
  return createHash("sha256")
    .update(canonicalPerpEligibilityBytes(markets))
    .digest();
}

export function canonicalEligibilityBytes(
  markets: readonly EligibleMarket[],
): Buffer {
  if (!Array.isArray(markets) || markets.length > MAX_ELIGIBLE_MARKETS) {
    throw new RangeError(
      `eligible list cannot contain more than ${MAX_ELIGIBLE_MARKETS} markets`,
    );
  }
  const marketIds = new Set<string>();
  const ctfTokenIds = new Set<string>();
  const encoded = markets.map((market) => {
    if (typeof market.marketId !== "string") {
      throw new TypeError("eligible marketId must be a string");
    }
    const marketId = Buffer.from(market.marketId, "utf8");
    if (
      marketId.length === 0 ||
      marketId.length > MAX_MARKET_ID_BYTES
    ) {
      throw new RangeError(
        `eligible marketId must contain 1-${MAX_MARKET_ID_BYTES} UTF-8 bytes`,
      );
    }
    const outcome = assertU8(market.outcome, "eligible outcome");
    if (outcome > 1) {
      throw new RangeError("eligible prediction-market outcome must be 0 or 1");
    }
    const ctfTokenId = nonZeroBytes32(
      market.ctfTokenId,
      "eligible ctfTokenId",
    );
    const ctfKey = ctfTokenId.toString("hex");
    if (marketIds.has(market.marketId) || ctfTokenIds.has(ctfKey)) {
      throw new RangeError("eligible list contains a duplicate market or CTF token");
    }
    marketIds.add(market.marketId);
    ctfTokenIds.add(ctfKey);
    return Buffer.concat([
      encodeU16LE(marketId.length, "eligible marketId length"),
      marketId,
      Buffer.from([outcome]),
      ctfTokenId,
    ]);
  });
  return Buffer.concat([
    encodeU16LE(markets.length, "eligible market count"),
    ...encoded,
  ]);
}

export function eligibilityHash(markets: readonly EligibleMarket[]): Buffer {
  return createHash("sha256").update(canonicalEligibilityBytes(markets)).digest();
}
