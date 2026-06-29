import { config } from "./config.js";
import { SailsDailyContestChainClient } from "./adapters/daily-contest-chain.js";
import { GraphqlReadModelClient } from "./adapters/graphql-read-model.js";
import { pathToFileURL } from "node:url";
import { pollOnce } from "./core.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const main = async () => {
  const readModel = new GraphqlReadModelClient(config.graphqlEndpoint);
  const chain = new SailsDailyContestChainClient(
    config.dailyContestProgramId as `0x${string}`,
    config.varaRpcUrl,
    config.settlerSeed,
  );

  console.log("Contest bot scaffold");
  console.log(`DailyContest program: ${config.dailyContestProgramId}`);
  console.log(`Indexer GraphQL: ${config.graphqlEndpoint}`);
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log("Policy: oldest unsettled day first, settlementAllowedAt is sourced from the read model, NoWinner days are settled on-chain too.");
  console.log("Indexer completeness is explicit: the bot only trusts days where the read model says indexerComplete=true.");

  while (true) {
    try {
      await pollOnce(readModel, chain);
    } catch (error) {
      console.error("Contest bot polling iteration failed:", error);
    }

    await sleep(config.pollIntervalMs);
  }
};

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  void main();
}
