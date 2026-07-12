import type {
  WorkflowClient as TemporalClient,
  WorkflowHandle as TemporalHandle,
} from "@temporalio/client";

import {
  decodeWorkflowPayload,
  type EncodedWorkflowPayload,
} from "../workflows/payload-codec.js";
import type {
  StartWorkflowRequest,
  WorkflowClientPort,
  WorkflowHandle,
} from "../workflows/ports.js";
import { validateStartWorkflowRequest } from "../workflows/validation.js";

function assertEncodedPayload(value: unknown): EncodedWorkflowPayload {
  if (
    value === null ||
    typeof value !== "object" ||
    !("encoding" in value) ||
    value.encoding !== "alphabasket/workflow-json-v1" ||
    !("data" in value) ||
    typeof value.data !== "string"
  ) {
    throw new TypeError("Temporal workflow returned an invalid AlphaBasket payload");
  }

  const payload: EncodedWorkflowPayload = {
    encoding: value.encoding,
    data: value.data,
  };
  // Parse once at the boundary so malformed or prototype-polluting payloads never
  // enter the application through a workflow result.
  decodeWorkflowPayload(payload);
  return payload;
}

function assertSignalName(name: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(name)) {
    throw new TypeError("Temporal signal name is invalid");
  }
}

function wrapHandle(
  handle: TemporalHandle,
  workflowId: string,
  runId?: string,
): WorkflowHandle {
  return {
    workflowId,
    ...(runId === undefined ? {} : { runId }),
    result: async () => assertEncodedPayload(await handle.result()),
    signal: async (name, payload) => {
      assertSignalName(name);
      // Validate before serialization by Temporal's data converter.
      decodeWorkflowPayload(payload);
      await handle.signal(name, payload);
    },
    cancel: async (_reason) => {
      // Temporal cancellation has no reason field. The caller should persist its
      // reason in the outbox/audit log before invoking this method.
      await handle.cancel();
    },
  };
}

/**
 * Production Temporal adapter. Business code depends only on WorkflowClientPort;
 * connection lifecycle and credentials stay in the composition root.
 */
export class TemporalWorkflowClientAdapter implements WorkflowClientPort {
  public constructor(private readonly client: TemporalClient) {}

  public async start(request: StartWorkflowRequest): Promise<WorkflowHandle> {
    validateStartWorkflowRequest(request);
    // Validate the tagged payload before it reaches Temporal's generic JSON
    // converter; this also proves that BigInt values were encoded explicitly.
    decodeWorkflowPayload(request.input);

    const handle = await this.client.start(request.workflowName, {
      workflowId: request.workflowId,
      taskQueue: request.taskQueue,
      args: [request.input],
      retry: {
        initialInterval: request.retry.initialIntervalMs,
        backoffCoefficient: request.retry.backoffCoefficient,
        maximumInterval: request.retry.maximumIntervalMs,
        maximumAttempts: request.retry.maximumAttempts,
        nonRetryableErrorTypes: [...request.retry.nonRetryableErrorTypes],
      },
      workflowExecutionTimeout: request.executionTimeoutMs,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      ...(request.memo === undefined ? {} : { memo: request.memo }),
    });

    return wrapHandle(handle, request.workflowId, handle.firstExecutionRunId);
  }

  public getHandle(workflowId: string, runId?: string): WorkflowHandle {
    if (workflowId.length === 0) {
      throw new TypeError("workflowId is required");
    }
    const handle = this.client.getHandle(workflowId, runId);
    return wrapHandle(handle, workflowId, runId);
  }
}
