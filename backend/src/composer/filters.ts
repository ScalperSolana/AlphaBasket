import type {
  CandidateFilterResult,
  CandidateRejectionReason,
  ComposerCandidate,
  ComposerPolicy,
  RejectedCandidate,
} from "./types.js";
import { MAX_BASKET_ITEMS } from "../contract/constants.js";

export const COMPOSER_PRICE_SCALE = 1_000_000n;
export const MIN_MIDPOINT_PRICE_UNITS = 50_000n;
export const MAX_MIDPOINT_PRICE_UNITS = 950_000n;

export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");

export const composerCandidateKey = (candidate: ComposerCandidate): string =>
  `${candidate.marketId}\u0000${candidate.tokenId}\u0000${candidate.outcomeIndex.toString()}`;

export const validateComposerPolicy = (policy: ComposerPolicy): void => {
  if (!Number.isSafeInteger(policy.minMarkets) || policy.minMarkets < 1) {
    throw new RangeError("minMarkets must be a positive integer");
  }
  if (
    !Number.isSafeInteger(policy.maxMarkets) ||
    policy.maxMarkets < policy.minMarkets ||
    policy.maxMarkets > MAX_BASKET_ITEMS
  ) {
    throw new RangeError(`maxMarkets must be an integer between minMarkets and ${MAX_BASKET_ITEMS}`);
  }
  if (
    policy.minRemainingMs < 0n ||
    policy.maxRemainingMs < policy.minRemainingMs ||
    policy.minDepthPusdUnits < 0n ||
    policy.minVolume24hPusdUnits < 0n
  ) {
    throw new RangeError("composer policy thresholds must be non-negative");
  }
  if (
    !Number.isSafeInteger(policy.maxSpreadBps) ||
    policy.maxSpreadBps < 0 ||
    policy.maxSpreadBps > 10_000
  ) {
    throw new RangeError("maxSpreadBps must be an integer between 0 and 10000");
  }
};

const rejectionReasons = (
  candidate: ComposerCandidate,
  policy: ComposerPolicy,
  nowMs: bigint,
): CandidateRejectionReason[] => {
  const reasons: CandidateRejectionReason[] = [];
  if (!candidate.active) reasons.push("inactive");
  if (candidate.closed) reasons.push("closed");
  if (!candidate.acceptingOrders) reasons.push("not-accepting-orders");
  if (candidate.eventId === null || candidate.eventId.length === 0) reasons.push("missing-event-id");
  if (candidate.endTimeMs === null) {
    reasons.push("missing-end-time");
  } else if (candidate.endTimeMs < nowMs || candidate.endTimeMs - nowMs < policy.minRemainingMs) {
    reasons.push("closes-too-soon");
  } else if (candidate.endTimeMs - nowMs > policy.maxRemainingMs) {
    reasons.push("closes-too-late");
  }
  if (!candidate.thematicallyRelevant) reasons.push("not-thematically-relevant");
  if (!candidate.outcomeClear) reasons.push("unclear-outcome");
  if (!candidate.hasBid || !candidate.hasAsk) reasons.push("one-sided-book");
  if (candidate.spreadBps > policy.maxSpreadBps) reasons.push("spread-too-wide");
  if (
    candidate.midpointPriceUnits < MIN_MIDPOINT_PRICE_UNITS ||
    candidate.midpointPriceUnits > MAX_MIDPOINT_PRICE_UNITS
  ) {
    reasons.push("midpoint-out-of-band");
  }
  if (candidate.depthPusdUnits < policy.minDepthPusdUnits) reasons.push("insufficient-depth");
  if (candidate.volume24hPusdUnits < policy.minVolume24hPusdUnits) {
    reasons.push("insufficient-volume");
  }
  if (candidate.dataCondition === "stale") reasons.push("stale-data");
  if (candidate.dataCondition === "illiquid") reasons.push("illiquid-data");
  if (candidate.dataCondition === "unavailable") reasons.push("unavailable-data");
  return reasons;
};

export const filterComposerCandidates = (
  candidates: readonly ComposerCandidate[],
  policy: ComposerPolicy,
  nowMs: bigint,
): CandidateFilterResult => {
  validateComposerPolicy(policy);
  if (nowMs < 0n) {
    throw new RangeError("nowMs must be non-negative");
  }
  const ordered = [...candidates].sort((left, right) =>
    compareCodeUnits(composerCandidateKey(left), composerCandidateKey(right)),
  );
  const accepted: ComposerCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  let previousKey: string | null = null;
  const marketIds = new Set<string>();
  const tokenIds = new Set<string>();
  for (const candidate of ordered) {
    const key = composerCandidateKey(candidate);
    if (key === previousKey) {
      throw new Error(`Duplicate composer candidate ${key}`);
    }
    previousKey = key;
    if (marketIds.has(candidate.marketId) || tokenIds.has(candidate.tokenId)) {
      throw new Error(`Composer input contains a duplicate market or CTF token: ${key}`);
    }
    marketIds.add(candidate.marketId);
    tokenIds.add(candidate.tokenId);
    if (
      typeof candidate.marketId !== "string" ||
      candidate.marketId.length === 0 ||
      utf8Length(candidate.marketId) > 64 ||
      typeof candidate.conditionId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/u.test(candidate.conditionId) ||
      (candidate.eventId !== null &&
        (typeof candidate.eventId !== "string" || candidate.eventId.length === 0)) ||
      typeof candidate.tokenId !== "string" ||
      candidate.tokenId.length === 0 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(candidate.tokenId) ||
      typeof candidate.outcomeLabel !== "string" ||
      candidate.outcomeLabel.length === 0 ||
      typeof candidate.classificationSource !== "string" ||
      candidate.classificationSource.length === 0 ||
      candidate.classificationSource.length > 256 ||
      (candidate.outcomeIndex !== 0 && candidate.outcomeIndex !== 1) ||
      typeof candidate.active !== "boolean" ||
      typeof candidate.closed !== "boolean" ||
      typeof candidate.acceptingOrders !== "boolean" ||
      typeof candidate.thematicallyRelevant !== "boolean" ||
      typeof candidate.outcomeClear !== "boolean" ||
      typeof candidate.hasBid !== "boolean" ||
      typeof candidate.hasAsk !== "boolean" ||
      (candidate.endTimeMs !== null && typeof candidate.endTimeMs !== "bigint") ||
      typeof candidate.depthPusdUnits !== "bigint" ||
      candidate.depthPusdUnits < 0n ||
      typeof candidate.volume24hPusdUnits !== "bigint" ||
      candidate.volume24hPusdUnits < 0n ||
      typeof candidate.midpointPriceUnits !== "bigint" ||
      candidate.midpointPriceUnits < 0n ||
      candidate.midpointPriceUnits > COMPOSER_PRICE_SCALE ||
      !["fresh", "stale", "illiquid", "unavailable"].includes(
        candidate.dataCondition,
      ) ||
      !Number.isSafeInteger(candidate.spreadBps) ||
      candidate.spreadBps < 0 ||
      candidate.spreadBps > 10_000
    ) {
      throw new TypeError(`Invalid composer candidate ${key}`);
    }
    const reasons = rejectionReasons(candidate, policy, nowMs);
    if (reasons.length === 0) {
      accepted.push(candidate);
    } else {
      rejected.push(Object.freeze({ candidate, reasons: Object.freeze(reasons) }));
    }
  }
  return Object.freeze({ accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
};
