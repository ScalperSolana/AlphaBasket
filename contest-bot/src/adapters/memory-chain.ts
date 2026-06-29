import type { DailyContestChainClient, ProjectedContestDay } from "../types.js";

export class MemoryDailyContestChainClient implements DailyContestChainClient {
  public readonly settledDays: ProjectedContestDay[] = [];

  async settleDay(day: ProjectedContestDay): Promise<string> {
    this.settledDays.push(day);
    return `mock-tx-${day.dayId.toString()}`;
  }
}
