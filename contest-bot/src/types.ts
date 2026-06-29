export type ProjectedWinner = {
  user: string;
  realizedProfit: bigint;
  reward: bigint;
};

export type ProjectedDayStatus = "ready" | "no_winner" | "settled" | "pending";

export type ProjectedContestDay = {
  dayId: bigint;
  status: ProjectedDayStatus;
  winners: ProjectedWinner[];
  resultHash: `0x${string}`;
  evidenceHash: `0x${string}`;
  indexerComplete: boolean;
  settledOnChain: boolean;
  settlementAllowedAt: bigint;
};

export interface ReadModelClient {
  getOldestUnsettledDay(): Promise<ProjectedContestDay | null>;
}

export interface DailyContestChainClient {
  settleDay(day: ProjectedContestDay): Promise<string>;
}
