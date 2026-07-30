import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

import {
  MAX_BASKET_ITEMS,
  MAX_BPS,
  MAX_ELIGIBLE_MARKETS,
  MAX_MARKET_ID_BYTES,
  MAX_MIXED_WEIGHT_BPS,
  MAX_SINGLE_SOURCE_WEIGHT_BPS,
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

export interface BasketAsset {
  readonly marketId: string;
  readonly kind: PredictionMarketPositionKind | SpotPositionKind;
  readonly weightBps: number;
}

export interface EligibleMarket {
  readonly marketId: string;
  readonly outcome: number;
  readonly ctfTokenId: Uint8Array;
}

const isPredictionMarket = (
  kind: BasketAsset["kind"],
): kind is PredictionMarketPositionKind =>
  "predictionMarket" in kind;

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
  const tokenMint = asset.kind?.spot?.tokenMint;
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
  let totalWeight = 0;
  const hasPrediction = items.some((item) => isPredictionMarket(item.kind));
  const hasSpot = items.some((item) => !isPredictionMarket(item.kind));
  const weightCapBps =
    hasPrediction && hasSpot
      ? MAX_MIXED_WEIGHT_BPS
      : MAX_SINGLE_SOURCE_WEIGHT_BPS;

  for (const item of items) {
    const itemBytes = validateAndEncodeAsset(item, weightCapBps);
    if (isPredictionMarket(item.kind)) {
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
