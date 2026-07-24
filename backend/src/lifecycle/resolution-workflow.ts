import { createHash } from "node:crypto";

import type {
  ClockPort,
  FinalSettlementResult,
  LifecycleRun,
  LifecycleRunStorePort,
  LifecycleSolanaGatewayPort,
  ResolutionExecutionPort,
  ResolutionExecutionResult,
} from "./types.js";
import type { PublicKey } from "@solana/web3.js";
import { NOOP_FAULT_INJECTOR, type FaultInjectorPort } from "../resilience/index.js";

export interface ResolutionWorkflowRequest {
  readonly id: string;
  readonly runKey: string;
  readonly basket: PublicKey;
}

export interface ResolutionWorkflowResult {
  readonly run: LifecycleRun;
  readonly execution: ResolutionExecutionResult;
  readonly settlement: FinalSettlementResult;
}

function resolutionFromCheckpoint(checkpoint: Readonly<Record<string, unknown>>): ResolutionExecutionResult {
  const executionHash = checkpoint.executionHash;
  const reportHash = checkpoint.finalReportHash;
  const nav = checkpoint.finalNavValue;
  const references = checkpoint.externalReferences;
  const executedAt = checkpoint.executedAtMs;
  if (typeof executionHash !== "string" || typeof reportHash !== "string" || !/^[0-9a-f]{64}$/u.test(reportHash) || typeof nav !== "string" || !Array.isArray(references) || !references.every((item) => typeof item === "string") || typeof executedAt !== "string") {
    throw new Error("resolution checkpoint is incomplete");
  }
  return Object.freeze({
    executionHash,
    finalReportHash: Uint8Array.from(Buffer.from(reportHash, "hex")),
    finalNavValue: BigInt(nav),
    externalReferences: Object.freeze(references as string[]),
    executedAtMs: BigInt(executedAt),
  });
}

function requestHash(basket: PublicKey): string {
  return createHash("sha256")
    .update("alphabasket:resolution-run:v1\u0000", "utf8")
    .update(basket.toBuffer())
    .digest("hex");
}

export class ResolutionWorkflow {
  public constructor(
    private readonly runs: LifecycleRunStorePort,
    private readonly gateway: LifecycleSolanaGatewayPort,
    private readonly execution: ResolutionExecutionPort,
    private readonly clock: ClockPort,
    private readonly faults: FaultInjectorPort = NOOP_FAULT_INJECTOR,
  ) {}

  public async execute(request: ResolutionWorkflowRequest): Promise<ResolutionWorkflowResult> {
    let run = await this.runs.createOrLoad({
      id: request.id,
      runKey: request.runKey,
      requestHash: requestHash(request.basket),
      kind: "resolution",
      basketId: request.basket.toBase58(),
      checkpoint: Object.freeze({}),
      createdAt: this.clock.now(),
    });
    if (run.state === "created") {
      const started = await this.gateway.beginResolution(request.basket, `${request.runKey}:begin`);
      await this.faults.after("resolution.onchain_started", {
        operationId: request.runKey,
        metadata: { transactionSignature: started.transactionSignature },
      });
      run = await this.runs.transition(run.id, run.version, "onchain_started", {
        beginTransaction: started.transactionSignature,
      }, this.clock.now());
    }
    let executed: ResolutionExecutionResult;
    if (run.state === "onchain_started") {
      executed = await this.execution.resolve({ operationId: request.runKey, basket: request.basket });
      await this.faults.after("resolution.external_execution_completed", {
        operationId: request.runKey,
        metadata: { executionHash: executed.executionHash },
      });
      if (executed.finalNavValue < 0n || executed.finalReportHash.byteLength !== 32 || Buffer.from(executed.finalReportHash).equals(Buffer.alloc(32))) {
        throw new Error("resolution execution returned an invalid final settlement report");
      }
      run = await this.runs.transition(run.id, run.version, "external_execution_completed", {
        ...run.checkpoint,
        executionHash: executed.executionHash,
        finalReportHash: Buffer.from(executed.finalReportHash).toString("hex"),
        finalNavValue: executed.finalNavValue.toString(10),
        externalReferences: [...executed.externalReferences],
        executedAtMs: executed.executedAtMs.toString(10),
      }, this.clock.now());
    } else {
      executed = resolutionFromCheckpoint(run.checkpoint);
    }
    let settlement: FinalSettlementResult;
    if (run.state === "external_execution_completed") {
      settlement = await this.gateway.recordFinalSettlement({
        basket: request.basket,
        finalReportHash: executed.finalReportHash,
        finalNavValue: executed.finalNavValue,
      }, `${request.runKey}:final`);
      await this.faults.after("resolution.final_settlement_recorded", {
        operationId: request.runKey,
        metadata: { transactionSignature: settlement.transactionSignature },
      });
      run = await this.runs.transition(run.id, run.version, "onchain_completed", {
        ...run.checkpoint,
        finalSettlementTransaction: settlement.transactionSignature,
        finalShareSnapshot: settlement.finalShareSnapshot.toString(10),
      }, this.clock.now());
    } else {
      const signature = run.checkpoint.finalSettlementTransaction;
      const shares = run.checkpoint.finalShareSnapshot;
      if (typeof signature !== "string" || typeof shares !== "string") throw new Error("final settlement checkpoint is missing");
      settlement = Object.freeze({ transactionSignature: signature, finalizedSlot: 0n, finalShareSnapshot: BigInt(shares) });
    }
    return Object.freeze({ run, execution: executed, settlement });
  }
}
