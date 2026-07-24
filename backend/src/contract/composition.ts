import { createHash } from "node:crypto";

import {
  MAX_BASKET_ITEMS,
  MAX_BPS,
  MAX_MARKET_ID_BYTES,
  MAX_MARKET_WEIGHT_BPS,
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

export interface BasketAsset {
  readonly marketId: string;
  readonly kind: PredictionMarketPositionKind;
  readonly weightBps: number;
}

function validateAndEncodeAsset(asset: BasketAsset): Buffer {
  if (typeof asset.marketId !== "string") {
    throw new TypeError("marketId must be a string");
  }
  const market = Buffer.from(asset.marketId, "utf8");
  if (market.length === 0 || market.length > MAX_MARKET_ID_BYTES) {
    throw new RangeError(
      `marketId must contain 1-${MAX_MARKET_ID_BYTES} UTF-8 bytes`,
    );
  }

  const prediction = asset.kind?.predictionMarket;
  if (prediction === undefined) {
    throw new TypeError("kind must be predictionMarket");
  }
  const outcome = assertU8(prediction.outcome, "outcome");
  if (outcome > 1) {
    throw new RangeError("prediction-market outcome must be 0 or 1");
  }
  const ctfTokenId = nonZeroBytes32(prediction.ctfTokenId, "ctfTokenId");
  const weight = assertU16(asset.weightBps, "weightBps");
  if (weight === 0 || weight > MAX_MARKET_WEIGHT_BPS) {
    throw new RangeError(
      `weightBps must be in [1, ${MAX_MARKET_WEIGHT_BPS}]`,
    );
  }

  return Buffer.concat([
    encodeU16LE(market.length, "marketId length"),
    market,
    Buffer.from([0, outcome]),
    ctfTokenId,
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
  let totalWeight = 0;

  for (const item of items) {
    const itemBytes = validateAndEncodeAsset(item);
    const ctfKey = Buffer.from(
      item.kind.predictionMarket.ctfTokenId,
    ).toString("hex");
    if (marketIds.has(item.marketId) || ctfTokenIds.has(ctfKey)) {
      throw new RangeError("composition contains a duplicate market or CTF token");
    }
    marketIds.add(item.marketId);
    ctfTokenIds.add(ctfKey);
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

