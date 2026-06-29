import { GearApi, BaseGearProgram } from "@gear-js/api";
import { Keyring } from "@polkadot/api";
import { TypeRegistry } from "@polkadot/types";
import { TransactionBuilder } from "sails-js";
import type { DailyContestChainClient, ProjectedContestDay } from "../types.js";

type WinnerInput = {
  account: string;
  realized_profit: bigint;
};

class DailyContestProgram {
  public readonly registry: TypeRegistry;
  private readonly program: BaseGearProgram;

  constructor(public readonly api: GearApi, programId: `0x${string}`) {
    this.program = new BaseGearProgram(programId, api);
    this.registry = new TypeRegistry();
    this.registry.register({
      WinnerInput: {
        account: "[u8;32]",
        realized_profit: "i128",
      },
    });
  }

  settleDay(
    dayId: bigint,
    winners: WinnerInput[],
    resultHash: `0x${string}`,
    evidenceHash: `0x${string}`,
  ) {
    return new TransactionBuilder<null>(
      this.api,
      this.registry,
      "send_message",
      "DailyContest",
      "SettleDay",
      [dayId, winners, resultHash, evidenceHash],
      "(u64, Vec<WinnerInput>, [u8;32], [u8;32])",
      "Null",
      this.program.id,
    );
  }
}

export class SailsDailyContestChainClient implements DailyContestChainClient {
  private api: GearApi | null = null;
  private program: DailyContestProgram | null = null;
  private account: ReturnType<Keyring["addFromUri"]> | null = null;

  constructor(
    private readonly programId: `0x${string}`,
    private readonly rpcUrl: string,
    private readonly seed: string,
  ) {}

  async init(): Promise<void> {
    this.api = await GearApi.create({ providerAddress: this.rpcUrl });
    this.program = new DailyContestProgram(this.api, this.programId);
    const keyring = new Keyring({ type: "sr25519", ss58Format: 137 });
    this.account = keyring.addFromUri(this.seed);
    console.log(
      `[contest-bot] Chain client initialized for program ${this.programId} with settler ${this.account.address}`,
    );
  }

  async settleDay(day: ProjectedContestDay): Promise<string> {
    if (!this.api || !this.program || !this.account) {
      await this.init();
    }

    console.log(
      `[contest-bot] Attempting settlement for day ${day.dayId.toString()} with ${day.winners.length} winner(s)`,
    );

    const tx = this.program!.settleDay(
      day.dayId,
      day.winners.map((winner) => ({
        account: winner.user,
        realized_profit: winner.realizedProfit,
      })),
      day.resultHash,
      day.evidenceHash,
    ).withAccount(this.account!);

    console.log(
      `[contest-bot] Calculating gas for day ${day.dayId.toString()} settlement`,
    );
    try {
      await tx.calculateGas(false, 20);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("DayAlreadySettled")) {
        console.log(
          `[contest-bot] Day ${day.dayId.toString()} is already settled on-chain; skipping duplicate settlement attempt while indexer catches up`,
        );
        return "already-settled";
      }

      throw error;
    }
    console.log(
      `[contest-bot] Signing and sending settlement for day ${day.dayId.toString()}`,
    );
    const { txHash, response } = await tx.signAndSend();
    console.log(
      `[contest-bot] Submitted tx ${txHash} for day ${day.dayId.toString()}, waiting for chain response`,
    );
    await response();
    console.log(
      `[contest-bot] Settlement submitted for day ${day.dayId.toString()}, txHash=${txHash}`,
    );
    return txHash;
  }
}
