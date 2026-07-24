import { Context } from "@temporalio/activity";

import type {
  ExecutionOperationRunnerPort,
  ExecutionWorkQueuePort,
} from "../execution/work-queue.js";
import {
  decodeWorkflowPayload,
  encodeWorkflowPayload,
  type EncodedWorkflowPayload,
  type WorkflowValue,
} from "../workflows/index.js";

function requestPayload(value: WorkflowValue): Readonly<{
  operationId: string;
  kind: "deposit" | "withdrawal";
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("financial workflow input must be an object");
  }
  const record = value as { readonly [key: string]: WorkflowValue };
  const operationId = record.operationId;
  const kind = record.kind;
  if (
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    (kind !== "deposit" && kind !== "withdrawal")
  ) {
    throw new TypeError("financial workflow input is malformed");
  }
  return Object.freeze({ operationId, kind });
}

export class FinancialExecutionActivities {
  public constructor(
    private readonly queue: ExecutionWorkQueuePort,
    private readonly runner: ExecutionOperationRunnerPort,
  ) {}

  public async executeFinancialOperation(
    input: EncodedWorkflowPayload,
  ): Promise<EncodedWorkflowPayload> {
    const request = requestPayload(decodeWorkflowPayload(input));
    const stored = await this.queue.loadRequest(request.operationId);
    if (stored.kind !== request.kind) throw new TypeError("workflow kind differs from persisted operation kind");
    const context = Context.current();
    context.heartbeat({ operationId: request.operationId, phase: "loaded" });
    const result = await this.runner.run(stored);
    context.heartbeat({ operationId: request.operationId, phase: "settled" });
    await this.queue.markCompleted(request.operationId, new Date());
    return encodeWorkflowPayload({
      operationId: result.operationId,
      kind: result.kind,
      executionBatchHash: result.executionBatchHash,
      settlementTransaction: result.settlementTransaction,
    });
  }
}
