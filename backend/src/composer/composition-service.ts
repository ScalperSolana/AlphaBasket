import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  canonicalCompositionBytes,
  canonicalEligibilityBytes,
  compositionHash,
  eligibilityHash,
  type BasketAsset,
  type EligibleMarket,
} from "../contract/composition.js";
import {
  MAX_SINGLE_SOURCE_WEIGHT_BPS,
  MAX_MIXED_WEIGHT_BPS,
  MAX_BPS,
} from "../contract/constants.js";
import {
  composerCandidateKey,
  filterComposerCandidates,
  validateComposerPolicy,
} from "./filters.js";
import type {
  BasketComposition,
  ComposerCandidate,
  ComposerPolicy,
  CreatorMarketWeight,
  SpotCompositionSelection,
  SpotWeightedCompositionItem,
  WeightedCompositionItem,
} from "./types.js";

export class InsufficientEligibleMarketsError extends Error {
  public constructor(eligible: number, required: number) {
    super(`Only ${eligible} eligible markets remain; ${required} are required`);
    this.name = "InsufficientEligibleMarketsError";
  }
}

const U256_MAX = (1n << 256n) - 1n;

/** Polymarket CTF IDs are decimal uint256 values; Anchor stores their 32-byte big-endian form. */
export const ctfTokenIdDecimalToBytes = (tokenId: string): Uint8Array => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(tokenId)) {
    throw new TypeError("CTF token ID must be a canonical unsigned decimal integer");
  }
  const value = BigInt(tokenId);
  if (value <= 0n || value > U256_MAX) {
    throw new RangeError("CTF token ID must be a non-zero uint256");
  }
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
};

const creatorWeightKey = (weight: CreatorMarketWeight): string =>
  `${weight.marketId}\u0000${weight.tokenId}\u0000${weight.outcomeIndex.toString()}`;

const auditHash = (
  composedAtMs: bigint,
  eligibleMarkets: readonly EligibleMarket[],
  items: readonly (WeightedCompositionItem | SpotWeightedCompositionItem)[],
): string => {
  const canonical = JSON.stringify([
    "ALPHABASKET_COMPOSITION_V2",
    composedAtMs.toString(),
    eligibleMarkets.map((market) => [
      market.marketId,
      market.outcome,
      Buffer.from(market.ctfTokenId).toString("hex"),
    ]),
    items.map((item) => [
      item.marketId,
      item.assetKind === "spot" ? item.tokenMint.toBase58() : item.conditionId,
      item.tokenId,
      item.assetKind === "spot" ? "spot" : item.outcomeIndex,
      item.weightBps,
    ]),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
};

export class BasketCompositionService {
  public compose(
    candidates: readonly ComposerCandidate[],
    creatorWeights: readonly CreatorMarketWeight[],
    policy: ComposerPolicy,
    composedAtMs: bigint,
    spotSelections: readonly SpotCompositionSelection[] = [],
  ): BasketComposition {
    validateComposerPolicy(policy);
    const filtered = filterComposerCandidates(candidates, policy, composedAtMs);
    const eligibleCandidates = filtered.accepted.slice(0, policy.maxMarkets);
    if (eligibleCandidates.length + spotSelections.length < policy.minMarkets) {
      throw new InsufficientEligibleMarketsError(
        eligibleCandidates.length + spotSelections.length,
        policy.minMarkets,
      );
    }
    if (
      creatorWeights.length + spotSelections.length < policy.minMarkets ||
      creatorWeights.length + spotSelections.length > policy.maxMarkets
    ) {
      throw new RangeError(
        `creator must select ${policy.minMarkets}-${policy.maxMarkets} eligible markets`,
      );
    }

    const candidateByKey = new Map(
      eligibleCandidates.map((candidate) => [
        composerCandidateKey(candidate),
        candidate,
      ]),
    );
    const selectedKeys = new Set<string>();
    const mixed = creatorWeights.length > 0 && spotSelections.length > 0;
    const maximumWeight = mixed
      ? MAX_MIXED_WEIGHT_BPS
      : MAX_SINGLE_SOURCE_WEIGHT_BPS;
    let totalWeight = 0;
    for (const weight of creatorWeights) {
      if (
        typeof weight.marketId !== "string" ||
        typeof weight.tokenId !== "string" ||
        (weight.outcomeIndex !== 0 && weight.outcomeIndex !== 1) ||
        !Number.isSafeInteger(weight.weightBps) ||
        weight.weightBps <= 0 ||
        weight.weightBps > maximumWeight
      ) {
        throw new TypeError(
          `creator weight must be an eligible market with 1-${maximumWeight} bps`,
        );
      }
      const key = creatorWeightKey(weight);
      if (selectedKeys.has(key)) {
        throw new RangeError(`creator selected duplicate market ${key}`);
      }
      if (!candidateByKey.has(key)) {
        throw new RangeError(`creator selected ineligible market ${key}`);
      }
      selectedKeys.add(key);
      totalWeight += weight.weightBps;
    }
    const selectedSpotMints = new Set<string>();
    const selectedMarketIds = new Set(creatorWeights.map((weight) => weight.marketId));
    for (const spot of spotSelections) {
      const mint = spot.tokenMint.toBase58();
      if (
        typeof spot.marketId !== "string" ||
        Buffer.byteLength(spot.marketId, "utf8") === 0 ||
        Buffer.byteLength(spot.marketId, "utf8") > 64 ||
        spot.tokenMint.equals(PublicKey.default) ||
        !Number.isInteger(spot.tokenDecimals) ||
        spot.tokenDecimals < 0 ||
        spot.tokenDecimals > 18 ||
        !Number.isSafeInteger(spot.weightBps) ||
        spot.weightBps <= 0 ||
        spot.weightBps > maximumWeight ||
        spot.initialMarkPriceUnits <= 0n ||
        !/^[0-9a-f]{64}$/u.test(spot.markSourceHash)
      ) {
        throw new TypeError(`spot selection must satisfy the 1-${maximumWeight} bps composition policy`);
      }
      if (selectedSpotMints.has(mint) || selectedMarketIds.has(spot.marketId)) {
        throw new RangeError("composition contains a duplicate spot mint or market ID");
      }
      selectedSpotMints.add(mint);
      selectedMarketIds.add(spot.marketId);
      totalWeight += spot.weightBps;
    }
    if (totalWeight !== MAX_BPS) {
      throw new RangeError(`creator weights must total ${MAX_BPS} bps`);
    }

    const eligibleMarkets: EligibleMarket[] = eligibleCandidates.map(
      (candidate) =>
        Object.freeze({
          marketId: candidate.marketId,
          outcome: candidate.outcomeIndex,
          ctfTokenId: ctfTokenIdDecimalToBytes(candidate.tokenId),
        }),
    );
    // Run the exact contract codec before signing/publishing the list.
    canonicalEligibilityBytes(eligibleMarkets);

    const weights = new Map(
      creatorWeights.map((weight) => [
        creatorWeightKey(weight),
        weight.weightBps,
      ]),
    );
    const predictionItems: WeightedCompositionItem[] = eligibleCandidates
      .filter((candidate) => selectedKeys.has(composerCandidateKey(candidate)))
      .map((candidate) => {
        const weightBps = weights.get(composerCandidateKey(candidate));
        if (weightBps === undefined) {
          throw new Error(`Missing creator weight for ${composerCandidateKey(candidate)}`);
        }
        return Object.freeze({
          assetKind: "prediction_market" as const,
          marketId: candidate.marketId,
          conditionId: candidate.conditionId,
          eventId: candidate.eventId,
          tokenId: candidate.tokenId,
          ctfTokenId: ctfTokenIdDecimalToBytes(candidate.tokenId),
          outcomeLabel: candidate.outcomeLabel,
          outcomeIndex: candidate.outcomeIndex,
          weightBps,
          initialMarkPriceUnits: candidate.midpointPriceUnits,
        });
      });
    const spotItems: SpotWeightedCompositionItem[] = [...spotSelections]
      .sort((left, right) =>
        left.marketId.localeCompare(right.marketId, "en") ||
        left.tokenMint.toBase58().localeCompare(right.tokenMint.toBase58(), "en"),
      )
      .map((spot) => Object.freeze({
        assetKind: "spot" as const,
        marketId: spot.marketId,
        tokenId: spot.tokenMint.toBase58(),
        tokenMint: spot.tokenMint,
        tokenDecimals: spot.tokenDecimals,
        outcomeLabel: "spot" as const,
        weightBps: spot.weightBps,
        initialMarkPriceUnits: spot.initialMarkPriceUnits,
        markSourceHash: spot.markSourceHash,
      }));
    const items = Object.freeze([...predictionItems, ...spotItems]);
    const assets: BasketAsset[] = items.map((item) =>
      item.assetKind === "spot"
        ? Object.freeze({
            marketId: item.marketId,
            kind: Object.freeze({
              spot: Object.freeze({ tokenMint: item.tokenMint }),
            }),
            weightBps: item.weightBps,
          })
        : Object.freeze({
        marketId: item.marketId,
        kind: Object.freeze({
          predictionMarket: Object.freeze({
            outcome: item.outcomeIndex,
            ctfTokenId: Uint8Array.from(item.ctfTokenId),
          }),
        }),
        weightBps: item.weightBps,
      }),
    );
    canonicalCompositionBytes(assets);
    const hashBytes = compositionHash(assets);
    const eligibilityHashBytes = eligibilityHash(eligibleMarkets);
    return Object.freeze({
      version: 2,
      hash: hashBytes.toString("hex"),
      hashBytes: Uint8Array.from(hashBytes),
      eligibilityHash: eligibilityHashBytes.toString("hex"),
      eligibilityHashBytes: Uint8Array.from(eligibilityHashBytes),
      eligibleMarkets: Object.freeze(eligibleMarkets),
      auditHash: auditHash(composedAtMs, eligibleMarkets, items),
      composedAtMs,
      items: Object.freeze(items),
      assets: Object.freeze(assets),
      rejected: filtered.rejected,
    });
  }
}

export const hashBasketComposition = (assets: readonly BasketAsset[]): Uint8Array =>
  Uint8Array.from(compositionHash(assets));
