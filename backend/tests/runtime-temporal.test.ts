import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowClient } from "@temporalio/client";

import { TemporalWorkflowClientAdapter } from "../src/runtime/index.js";
import {
  decodeWorkflowPayload,
  encodeWorkflowPayload,
} from "../src/workflows/index.js";

describe("Temporal runtime adapter", () => {
  it("maps retries and preserves encoded bigint payloads at every boundary", async () => {
    let startOptions: Record<string, unknown> | undefined;
    const signals: unknown[][] = [];
    let cancelled = false;
    const temporalHandle = {
      firstExecutionRunId: "run-1",
      result: async () => encodeWorkflowPayload({ shares: 10n ** 30n }),
      signal: async (...args: unknown[]) => {
        signals.push(args);
      },
      cancel: async () => {
        cancelled = true;
      },
    };
    const client = {
      start: async (_name: string, options: Record<string, unknown>) => {
        startOptions = options;
        return temporalHandle;
      },
      getHandle: () => temporalHandle,
    } as unknown as WorkflowClient;
    const adapter = new TemporalWorkflowClientAdapter(client);
    const handle = await adapter.start({
      workflowId: "deposit:intent-1",
      workflowName: "completeDepositWorkflow",
      taskQueue: "financial",
      input: encodeWorkflowPayload({ amount: 10n ** 40n }),
      retry: {
        initialIntervalMs: 1_000,
        backoffCoefficient: 2,
        maximumIntervalMs: 60_000,
        maximumAttempts: 10,
        nonRetryableErrorTypes: ["InvalidIntent"],
      },
      executionTimeoutMs: 3_600_000,
      idReusePolicy: "reject_duplicate",
    });
    assert.equal(startOptions?.workflowIdReusePolicy, "REJECT_DUPLICATE");
    assert.equal(handle.runId, "run-1");
    const result = decodeWorkflowPayload(await handle.result()) as {
      readonly shares: bigint;
    };
    assert.equal(result.shares, 10n ** 30n);
    await handle.signal("bridge.completed", encodeWorkflowPayload({ amount: 1n }));
    assert.equal(signals.length, 1);
    await handle.cancel("operator request");
    assert.equal(cancelled, true);
  });

  it("rejects malformed Temporal results and signal names", async () => {
    const temporalHandle = {
      firstExecutionRunId: "run-1",
      result: async () => ({ encoding: "json", data: "{}" }),
      signal: async () => undefined,
      cancel: async () => undefined,
    };
    const adapter = new TemporalWorkflowClientAdapter({
      start: async () => temporalHandle,
      getHandle: () => temporalHandle,
    } as unknown as WorkflowClient);
    const handle = await adapter.start({
      workflowId: "workflow-1",
      workflowName: "workflow",
      taskQueue: "financial",
      input: encodeWorkflowPayload(null),
      retry: {
        initialIntervalMs: 1,
        backoffCoefficient: 1,
        maximumIntervalMs: 1,
        maximumAttempts: 1,
        nonRetryableErrorTypes: [],
      },
      executionTimeoutMs: 1,
      idReusePolicy: "reject_duplicate",
    });
    await assert.rejects(handle.result(), /invalid AlphaBasket payload/u);
    await assert.rejects(
      handle.signal("unsafe signal name", encodeWorkflowPayload(null)),
      /signal name is invalid/u,
    );
  });
});
