import {
  encodeWorkflowPayload,
  type WorkflowClientPort,
} from "../workflows/index.js";
import type {
  ClaimedExecutionWork,
  ExecutionWorkQueuePort,
} from "../execution/work-queue.js";

export interface ExecutionDispatcherOptions {
  readonly ownerId: string;
  readonly taskQueue: string;
  readonly batchSize: number;
  readonly claimDurationMs: number;
  readonly retryDelayMs: number;
}

function workflowName(kind: ClaimedExecutionWork["kind"]): string {
  return kind === "deposit"
    ? "depositExecutionWorkflow"
    : "withdrawalExecutionWorkflow";
}

export class ExecutionDispatcher {
  public constructor(
    private readonly queue: ExecutionWorkQueuePort,
    private readonly workflows: WorkflowClientPort,
    private readonly options: ExecutionDispatcherOptions,
  ) {
    if (options.ownerId.length === 0 || options.taskQueue.length === 0) throw new RangeError("dispatcher owner and task queue are required");
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) throw new RangeError("dispatcher batch size is invalid");
    if (!Number.isSafeInteger(options.claimDurationMs) || options.claimDurationMs < 5_000) throw new RangeError("dispatcher claim duration is invalid");
    if (!Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 1_000) throw new RangeError("dispatcher retry delay is invalid");
  }

  public async runOnce(now = new Date()): Promise<number> {
    const claimed = await this.queue.claimReady({
      ownerId: this.options.ownerId,
      limit: this.options.batchSize,
      leaseDurationMs: this.options.claimDurationMs,
      now,
    });
    for (const work of claimed) {
      try {
        const handle = await this.workflows.start({
          workflowId: work.workflowId,
          workflowName: workflowName(work.kind),
          taskQueue: this.options.taskQueue,
          input: encodeWorkflowPayload({
            operationId: work.operationId,
            kind: work.kind,
          }),
          retry: {
            initialIntervalMs: 1_000,
            backoffCoefficient: 2,
            maximumIntervalMs: 60_000,
            maximumAttempts: 100,
            nonRetryableErrorTypes: [
              "TypeError",
              "RangeError",
              "SignerPolicyError",
            ],
          },
          executionTimeoutMs: 3_600_000,
          idReusePolicy: "reject_duplicate",
          memo: {
            operationId: work.operationId,
            kind: work.kind,
          },
        });
        await this.queue.markDispatched(
          work.operationId,
          work.claimToken,
          handle.runId ?? null,
          new Date(),
        );
      } catch (error) {
        // Temporal may report an already-started workflow when the dispatcher
        // crashed after start but before its PostgreSQL commit. Treat that exact
        // condition as successful replay; any other failure is rescheduled.
        if (
          error instanceof Error &&
          (error.name === "WorkflowExecutionAlreadyStartedError" ||
            /already started|already exists/iu.test(error.message))
        ) {
          await this.queue.markDispatched(work.operationId, work.claimToken, null, new Date());
        } else {
          const failedAt = new Date();
          await this.queue.releaseClaim(
            work.operationId,
            work.claimToken,
            error instanceof Error ? error.message : "unknown Temporal dispatch failure",
            new Date(failedAt.getTime() + this.options.retryDelayMs),
            failedAt,
          );
        }
      }
    }
    return claimed.length;
  }
}
