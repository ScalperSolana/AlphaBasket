import { createHash } from "node:crypto";
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
  items: readonly WeightedCompositionItem[],
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
      item.conditionId,
      item.tokenId,
      item.outcomeIndex,
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
  ): BasketComposition {
    validateComposerPolicy(policy);
    const filtered = filterComposerCandidates(candidates, policy, composedAtMs);
    const eligibleCandidates = filtered.accepted.slice(0, policy.maxMarkets);
    if (eligibleCandidates.length < policy.minMarkets) {
      throw new InsufficientEligibleMarketsError(
        eligibleCandidates.length,
        policy.minMarkets,
      );
    }
    if (
      creatorWeights.length < policy.minMarkets ||
      creatorWeights.length > policy.maxMarkets
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
    let totalWeight = 0;
    for (const weight of creatorWeights) {
      if (
        typeof weight.marketId !== "string" ||
        typeof weight.tokenId !== "string" ||
        (weight.outcomeIndex !== 0 && weight.outcomeIndex !== 1) ||
        !Number.isSafeInteger(weight.weightBps) ||
        weight.weightBps <= 0 ||
        weight.weightBps > MAX_SINGLE_SOURCE_WEIGHT_BPS
      ) {
        throw new TypeError(
          `creator weight must be an eligible market with 1-${MAX_SINGLE_SOURCE_WEIGHT_BPS} bps`,
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
    const items: WeightedCompositionItem[] = eligibleCandidates
      .filter((candidate) => selectedKeys.has(composerCandidateKey(candidate)))
      .map((candidate) => {
        const weightBps = weights.get(composerCandidateKey(candidate));
        if (weightBps === undefined) {
          throw new Error(`Missing creator weight for ${composerCandidateKey(candidate)}`);
        }
        return Object.freeze({
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
    const assets: BasketAsset[] = items.map((item) =>
      Object.freeze({
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
