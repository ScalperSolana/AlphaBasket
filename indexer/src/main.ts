import "reflect-metadata";
import { TypeormDatabase } from "@subsquid/typeorm-store";
import { GearApi } from "@gear-js/api";
import { BaseHandler } from "./handlers/base";
import { DailyContestHandler } from "./handlers";
import { config, sourceOfTruth } from "./config";
import { processor } from "./processor";

class GearProcessor {
  private handlers: BaseHandler[] = [];
  private userMessageSentRegistered = false;

  private addUserMessageSent(programIds: string[]) {
    for (const programId of programIds) {
      console.log(`[*] Tracking Gear.UserMessageSent for ${programId}`);
    }

    if (!this.userMessageSentRegistered) {
      processor.addGearUserMessageSent({
        programId: undefined,
        extrinsic: true,
        call: true,
      });
      this.userMessageSentRegistered = true;
    }
  }

  registerHandler(handler: BaseHandler) {
    this.handlers.push(handler);

    const userMessageSentProgramIds = handler.getUserMessageSentProgramIds();
    if (userMessageSentProgramIds.length > 0) {
      this.addUserMessageSent(userMessageSentProgramIds);
    }
  }

  async run() {
    const db = new TypeormDatabase({
      supportHotBlocks: true,
      stateSchema: "daily_contest_processor",
    });

    await processor.run(db, async (ctx) => {
      ctx.log.info(`Processing ${ctx.blocks.length} blocks`);

      for (const handler of this.handlers) {
        await handler.process(ctx);
      }

      for (const handler of this.handlers) {
        await handler.save();
      }
    });
  }
}

async function main() {
  const api = await GearApi.create({ providerAddress: config.rpcUrl });
  const runner = new GearProcessor();
  const dailyContestHandler = new DailyContestHandler();

  await dailyContestHandler.init(api);
  runner.registerHandler(dailyContestHandler);

  console.log("Daily contest indexer");
  console.log(`BasketMarket -> ${sourceOfTruth.basketMarket}`);
  console.log(`BetLane -> ${sourceOfTruth.betLane}`);
  console.log(`BetToken -> ${sourceOfTruth.betToken}`);
  if (!config.betTokenProgramId) {
    console.warn(
      "[!] BET_TOKEN_PROGRAM_ID is not configured; Approved/BetToken Claimed activity will be skipped"
    );
  }
  console.log(`DailyContest -> ${sourceOfTruth.dailyContest}`);
  console.log(`Indexer -> ${sourceOfTruth.indexer}`);

  await runner.run();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
