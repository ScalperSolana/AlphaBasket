import { createHash } from "node:crypto";

import type {
  ClockPort,
  LifecycleRun,
  LifecycleRunStorePort,
  LifecycleSolanaGatewayPort,
  ReconstitutionExecutionPort,
  ReconstitutionExecutionResult,
  SignedReconstitution,
} from "./types.js";
import { NOOP_FAULT_INJECTOR, type FaultInjectorPort } from "../resilience/index.js";

export interface ReconstitutionWorkflowRequest {
  readonly id: string;
  readonly runKey: string;
  readonly authorization: SignedReconstitution;
}

export interface ReconstitutionWorkflowResult {
  readonly run: LifecycleRun;
  readonly execution: ReconstitutionExecutionResult;
  readonly completionTransaction: string;
}

function executionFromCheckpoint(checkpoint: Readonly<Record<string, unknown>>): ReconstitutionExecutionResult {
  const executionHash = checkpoint.executionHash;
  const orderIds = checkpoint.orderIds;
  const jupiterTransactions = checkpoint.jupiterTransactions;
  const realized = checkpoint.realizedPusdDeltaUnits;
  const realizedUsdc = checkpoint.realizedUsdcDeltaUnits;
  const executedAt = checkpoint.executedAtMs;
  if (
    typeof executionHash !== "string" ||
    !Array.isArray(orderIds) ||
    !orderIds.every((id) => typeof id === "string") ||
    (
      jupiterTransactions !== undefined &&
      (
        !Array.isArray(jupiterTransactions) ||
        !jupiterTransactions.every((id) => typeof id === "string")
      )
    ) ||
    typeof realized !== "string" ||
    (
      realizedUsdc !== undefined &&
      typeof realizedUsdc !== "string"
    ) ||
    typeof executedAt !== "string"
  ) {
    throw new Error("reconstitution checkpoint is incomplete");
  }
  return Object.freeze({
    executionHash,
    orderIds: Object.freeze(orderIds as string[]),
    ...(jupiterTransactions === undefined
      ? {}
      : {
          jupiterTransactions: Object.freeze(
            jupiterTransactions as string[],
          ),
        }),
    realizedPusdDeltaUnits: BigInt(realized),
    ...(realizedUsdc === undefined
      ? {}
      : { realizedUsdcDeltaUnits: BigInt(realizedUsdc) }),
    executedAtMs: BigInt(executedAt),
  });
}

function requestHash(authorization: SignedReconstitution): string {
  return createHash("sha256")
    .update("alphabasket:reconstitution-run:v1\u0000", "utf8")
    .update(authorization.basket.toBuffer())
    .update(authorization.encodedMessage)
    .update(authorization.composerPublicKey)
    .update(authorization.composerSignature)
    .digest("hex");
}

export class ReconstitutionWorkflow {
  public constructor(
    private readonly runs: LifecycleRunStorePort,
    private readonly gateway: LifecycleSolanaGatewayPort,
    private readonly execution: ReconstitutionExecutionPort,
    private readonly clock: ClockPort,
    private readonly faults: FaultInjectorPort = NOOP_FAULT_INJECTOR,
  ) {}

  public async execute(request: ReconstitutionWorkflowRequest): Promise<ReconstitutionWorkflowResult> {
    const auth = request.authorization;
    if (
      auth.nextCompositionVersion <= 1 ||
      auth.items.length === 0 ||
      auth.compositionNonce <= 0n ||
      auth.eligibilityNonce <= 0n
    ) {
      throw new RangeError("invalid reconstitution authorization");
    }
    let run = await this.runs.createOrLoad({
      id: request.id,
      runKey: request.runKey,
      requestHash: requestHash(auth),
      kind: "reconstitution",
      basketId: auth.basket.toBase58(),
      checkpoint: Object.freeze({ nextCompositionVersion: auth.nextCompositionVersion }),
      createdAt: this.clock.now(),
    });
    if (run.state === "created") {
      const started = await this.gateway.beginReconstitution(auth.basket, `${request.runKey}:begin`);
      await this.faults.after("reconstitution.onchain_started", {
        operationId: request.runKey,
        metadata: { transactionSignature: started.transactionSignature },
      });
      run = await this.runs.transition(run.id, run.version, "onchain_started", {
        ...run.checkpoint,
        beginTransaction: started.transactionSignature,
      }, this.clock.now());
    }
    let executed: ReconstitutionExecutionResult;
    if (run.state === "onchain_started") {
      executed = await this.execution.rebalance({
        operationId: request.runKey,
        basket: auth.basket,
        previousCompositionVersion: auth.nextCompositionVersion - 1,
        nextComposition: auth,
      });
      await this.faults.after("reconstitution.external_execution_completed", {
        operationId: request.runKey,
        metadata: { executionHash: executed.executionHash },
      });
      run = await this.runs.transition(run.id, run.version, "external_execution_completed", {
        ...run.checkpoint,
        executionHash: executed.executionHash,
        orderIds: [...executed.orderIds],
        ...(executed.jupiterTransactions === undefined
          ? {}
          : {
              jupiterTransactions: [...executed.jupiterTransactions],
            }),
        realizedPusdDeltaUnits: executed.realizedPusdDeltaUnits.toString(10),
        ...(executed.realizedUsdcDeltaUnits === undefined
          ? {}
          : {
              realizedUsdcDeltaUnits:
                executed.realizedUsdcDeltaUnits.toString(10),
            }),
        executedAtMs: executed.executedAtMs.toString(10),
      }, this.clock.now());
    } else {
      executed = executionFromCheckpoint(run.checkpoint);
    }
    let completionTransaction = run.checkpoint.completionTransaction;
    if (run.state === "external_execution_completed") {
      const completed = await this.gateway.completeReconstitution(auth, `${request.runKey}:complete`);
      await this.faults.after("reconstitution.onchain_completed", {
        operationId: request.runKey,
        metadata: { transactionSignature: completed.transactionSignature },
      });
      completionTransaction = completed.transactionSignature;
      run = await this.runs.transition(run.id, run.version, "onchain_completed", {
        ...run.checkpoint,
        completionTransaction,
      }, this.clock.now());
    }
    if (typeof completionTransaction !== "string") throw new Error("reconstitution completion transaction is missing");
    return Object.freeze({ run, execution: executed, completionTransaction });
  }
}
