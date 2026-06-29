import type { ProjectedContestDay, ReadModelClient } from "../types.js";

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type OldestUnsettledDayProjectionQuery = {
  allContestDayProjections: {
    nodes: Array<{
      dayId: string;
      status: ProjectedContestDay["status"];
      indexerComplete: boolean;
      settledOnChain: boolean;
      settlementAllowedAt: string;
      resultHash: string | null;
      evidenceHash: string | null;
    }>;
  };
};

type DayWinnersQuery = {
  allContestDayWinners: {
    nodes: Array<{
      user: string;
      rank: number;
      realizedProfit: string;
      reward: string | null;
    }>;
  };
};

export class GraphqlReadModelClient implements ReadModelClient {
  constructor(private readonly endpoint: string) {}

  async getOldestUnsettledDay(): Promise<ProjectedContestDay | null> {
    console.log(
      `[contest-bot] Querying oldest unsettled contest day from ${this.endpoint}`,
    );

    const projectionResponse = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `
          query OldestUnsettledDay {
            allContestDayProjections(
              first: 1
              orderBy: DAY_ID_ASC
              filter: {
                indexerComplete: { equalTo: true }
                settledOnChain: { equalTo: false }
              }
            ) {
              nodes {
                dayId
                status
                indexerComplete
                settledOnChain
                settlementAllowedAt
                resultHash
                evidenceHash
              }
            }
          }
        `,
      }),
    });

    const projectionBody =
      (await projectionResponse.json()) as GraphqlResponse<OldestUnsettledDayProjectionQuery>;
    if (projectionBody.errors?.length) {
      throw new Error(
        projectionBody.errors.map((error) => error.message).join("; ")
      );
    }

    const day = projectionBody.data?.allContestDayProjections.nodes[0];
    if (!day) {
      console.log(
        "[contest-bot] Read model returned no unsettled day with indexerComplete=true and settledOnChain=false",
      );
      return null;
    }

    console.log(
      `[contest-bot] Candidate day ${day.dayId}: status=${day.status}, indexerComplete=${day.indexerComplete}, settledOnChain=${day.settledOnChain}, settlementAllowedAt=${day.settlementAllowedAt}`,
    );

    const winnersResponse = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `
          query DayWinners($dayId: String!) {
            allContestDayWinners(
              orderBy: RANK_ASC
              filter: { dayId: { equalTo: $dayId } }
            ) {
              nodes {
                user
                rank
                realizedProfit
                reward
              }
            }
          }
        `,
        variables: {
          dayId: day.dayId,
        },
      }),
    });

    const winnersBody =
      (await winnersResponse.json()) as GraphqlResponse<DayWinnersQuery>;
    if (winnersBody.errors?.length) {
      throw new Error(winnersBody.errors.map((error) => error.message).join("; "));
    }

    const winners = winnersBody.data?.allContestDayWinners.nodes ?? [];
    console.log(
      `[contest-bot] Loaded ${winners.length} projected winner row(s) for day ${day.dayId}`,
    );

    return {
      dayId: BigInt(day.dayId),
      status: day.status,
      winners: winners.map((winner) => ({
        user: winner.user,
        realizedProfit: BigInt(winner.realizedProfit),
        reward: BigInt(winner.reward ?? "0"),
      })),
      resultHash: (day.resultHash ?? "0x" + "0".repeat(64)) as `0x${string}`,
      evidenceHash: (day.evidenceHash ?? "0x" + "0".repeat(64)) as `0x${string}`,
      indexerComplete: day.indexerComplete,
      settledOnChain: day.settledOnChain,
      settlementAllowedAt: BigInt(Date.parse(day.settlementAllowedAt)),
    };
  }
}
