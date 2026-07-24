import { createHash } from "node:crypto";
import {
  canonicalCompositionBytes,
  compositionHash,
  type BasketAsset,
} from "../contract/composition.js";
import { composerCandidateKey, filterComposerCandidates, validateComposerPolicy } from "./filters.js";
import {
  MAX_SINGLE_MARKET_WEIGHT_BPS,
  TOTAL_WEIGHT_BPS,
  allocateEventCappedWeights,
  liquidityVolumeScore,
} from "./weighting.js";
import type {
  BasketComposition,
  ComposerCandidate,
  ComposerPolicy,
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

const auditHash = (
  composedAtMs: bigint,
  items: readonly WeightedCompositionItem[],
): string => {
  const canonical = JSON.stringify([
    "ALPHABASKET_COMPOSITION_V1",
    composedAtMs.toString(),
    items.map((item) => [
      item.marketId,
      item.conditionId,
      item.tokenId,
      item.outcomeIndex,
      item.weightBps,
      item.score.toString(),
    ]),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
};

export class BasketCompositionService {
  public compose(
    candidates: readonly ComposerCandidate[],
    policy: ComposerPolicy,
    composedAtMs: bigint,
  ): BasketComposition {
    validateComposerPolicy(policy);
    if (policy.minMarkets * MAX_SINGLE_MARKET_WEIGHT_BPS < TOTAL_WEIGHT_BPS) {
      throw new RangeError("minMarkets is incompatible with the 4,000 bps cap");
    }
    const filtered = filterComposerCandidates(candidates, policy, composedAtMs);
    const allRanked = filtered.accepted
      .map((candidate) => ({
        candidate,
        key: composerCandidateKey(candidate),
        score: liquidityVolumeScore(candidate.depthPusdUnits, candidate.volume24hPusdUnits),
      }))
      .filter((entry) => entry.score > 0n)
      .sort((left, right) => {
        if (left.score !== right.score) return left.score > right.score ? -1 : 1;
        return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
      });
    const representativeByEvent = new Map<string, (typeof allRanked)[number]>();
    for (const entry of allRanked) {
      const eventId = entry.candidate.eventId;
      if (eventId !== null && !representativeByEvent.has(eventId)) {
        representativeByEvent.set(eventId, entry);
      }
    }
    const requiredEventGroups = Math.ceil(TOTAL_WEIGHT_BPS / MAX_SINGLE_MARKET_WEIGHT_BPS);
    if (representativeByEvent.size < requiredEventGroups) {
      throw new InsufficientEligibleMarketsError(representativeByEvent.size, requiredEventGroups);
    }
    const selectedKeys = new Set<string>();
    const ranked: typeof allRanked = [];
    for (const entry of [...representativeByEvent.values()].slice(0, requiredEventGroups)) {
      ranked.push(entry);
      selectedKeys.add(entry.key);
    }
    for (const entry of allRanked) {
      if (ranked.length === policy.maxMarkets) break;
      if (!selectedKeys.has(entry.key)) {
        ranked.push(entry);
        selectedKeys.add(entry.key);
      }
    }
    if (ranked.length < policy.minMarkets) {
      throw new InsufficientEligibleMarketsError(ranked.length, policy.minMarkets);
    }
    const allocations = allocateEventCappedWeights(
      ranked.map((entry) => ({
        key: entry.key,
        groupKey: entry.candidate.eventId ?? "",
        score: entry.score,
      })),
    );
    const weights = new Map(allocations.map((allocation) => [allocation.key, allocation.weightBps]));
    const items: WeightedCompositionItem[] = ranked
      .map((entry) => {
        const weightBps = weights.get(entry.key);
        if (weightBps === undefined) throw new Error(`Missing weight for ${entry.key}`);
        return Object.freeze({
          marketId: entry.candidate.marketId,
          conditionId: entry.candidate.conditionId,
          eventId: entry.candidate.eventId,
          tokenId: entry.candidate.tokenId,
          ctfTokenId: ctfTokenIdDecimalToBytes(entry.candidate.tokenId),
          outcomeLabel: entry.candidate.outcomeLabel,
          outcomeIndex: entry.candidate.outcomeIndex,
          weightBps,
          initialMarkPriceUnits: entry.candidate.midpointPriceUnits,
          score: entry.score,
        });
      })
      .sort((left, right) => {
        const leftKey = `${left.marketId}\u0000${left.tokenId}\u0000${left.outcomeIndex.toString()}`;
        const rightKey = `${right.marketId}\u0000${right.tokenId}\u0000${right.outcomeIndex.toString()}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
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
    // Validation and uniqueness are intentionally run through the exact contract codec.
    canonicalCompositionBytes(assets);
    const hashBytes = compositionHash(assets);
    return Object.freeze({
      version: 1,
      hash: hashBytes.toString("hex"),
      hashBytes: Uint8Array.from(hashBytes),
      auditHash: auditHash(composedAtMs, items),
      composedAtMs,
      items: Object.freeze(items),
      assets: Object.freeze(assets),
      rejected: filtered.rejected,
    });
  }
}

export const hashBasketComposition = (assets: readonly BasketAsset[]): Uint8Array =>
  Uint8Array.from(compositionHash(assets));
