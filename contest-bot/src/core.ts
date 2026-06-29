import type { DailyContestChainClient, ProjectedContestDay, ReadModelClient } from "./types.js";

export const isEligibleForSettlement = (
  day: ProjectedContestDay,
  nowMs: bigint,
): boolean => {
  if (day.settledOnChain || !day.indexerComplete) {
    return false;
  }

  if (day.status !== "ready" && day.status !== "no_winner") {
    return false;
  }

  return nowMs >= day.settlementAllowedAt;
};

const getSettlementSkipReason = (
  day: ProjectedContestDay,
  nowMs: bigint,
): string | null => {
  if (day.settledOnChain) {
    return "already settled on-chain";
  }

  if (!day.indexerComplete) {
    return "indexerComplete=false";
  }

  if (day.status !== "ready" && day.status !== "no_winner") {
    return `unsupported status=${day.status}`;
  }

  if (nowMs < day.settlementAllowedAt) {
    return `waiting until settlementAllowedAt=${new Date(Number(day.settlementAllowedAt)).toISOString()}`;
  }

  return null;
};

export const pollOnce = async (
  readModel: ReadModelClient,
  chain: DailyContestChainClient,
): Promise<void> => {
  const day = await readModel.getOldestUnsettledDay();
  if (!day) {
    console.log("[contest-bot] No eligible unsettled contest day found in read model");
    return;
  }

  const nowMs = BigInt(Date.now());
  const skipReason = getSettlementSkipReason(day, nowMs);
  if (skipReason) {
    console.log(
      `[contest-bot] Skipping day ${day.dayId.toString()}: ${skipReason}`,
    );
    return;
  }

  console.log(
    `[contest-bot] Day ${day.dayId.toString()} is eligible for settlement`,
  );
  await chain.settleDay(day);
};
