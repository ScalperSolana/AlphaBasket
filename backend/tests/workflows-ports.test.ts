import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryWorkflowClient,
  WorkflowAlreadyStartedError,
  decodeWorkflowPayload,
  deterministicWorkflowId,
  encodeWorkflowPayload,
} from "../src/workflows/index.js";

const retry = {
  initialIntervalMs: 1_000,
  backoffCoefficient: 2,
  maximumIntervalMs: 60_000,
  maximumAttempts: 20,
  nonRetryableErrorTypes: ["InvalidIntent"],
} as const;

describe("Temporal-safe workflow boundary", () => {
  it("round-trips amounts beyond JS safe integer range without precision loss", () => {
    const amount = 10n ** 77n;
    const encoded = encodeWorkflowPayload({
      amount,
      negativeAdjustment: -amount,
      nested: [true, "2026-07-12T10:00:00.000Z", null],
    });
    const decoded = decodeWorkflowPayload(encoded) as {
      readonly amount: bigint;
      readonly negativeAdjustment: bigint;
    };

    assert.equal(decoded.amount, amount);
    assert.equal(decoded.negativeAdjustment, -amount);
    assert.equal(typeof JSON.parse(JSON.stringify(encoded)), "object");
    assert.doesNotMatch(encoded.data, /1e\+/u);
  });

  it("uses deterministic key ordering and rejects numbers and prototype keys", () => {
    assert.equal(
      encodeWorkflowPayload({ z: 1n, a: 2n }).data,
      encodeWorkflowPayload({ a: 2n, z: 1n }).data,
    );
    assert.throws(
      () => encodeWorkflowPayload(1 as unknown as bigint),
      /workflow payloads support only/u,
    );
    assert.throws(
      () =>
        decodeWorkflowPayload({
          encoding: "alphabasket/workflow-json-v1",
          data: '["object",[["__proto__",["string","polluted"]]]]',
        }),
      /unsafe workflow object key/u,
    );
    assert.equal(({} as { polluted?: string }).polluted, undefined);
  });

  it("uses a deterministic opaque workflow ID", () => {
    const first = deterministicWorkflowId("complete-deposit", "intent-secret-value");
    const second = deterministicWorkflowId("complete-deposit", "intent-secret-value");
    assert.equal(first, second);
    assert.equal(first.includes("intent-secret-value"), false);
    assert.notEqual(
      deterministicWorkflowId("a\nb", "c"),
      deterministicWorkflowId("a", "b\nc"),
    );
  });

  it("accepts only encoded inputs, signals, and results", async () => {
    const client = new InMemoryWorkflowClient();
    const workflowId = deterministicWorkflowId("deposit", "intent-1");
    const handle = await client.start({
      workflowId,
      workflowName: "depositWorkflow",
      taskQueue: "financial-workflows",
      input: encodeWorkflowPayload({ amount: 995_000_000n }),
      retry,
      executionTimeoutMs: 3_600_000,
      idReusePolicy: "reject_duplicate",
    });
    await handle.signal(
      "bridge-completed",
      encodeWorkflowPayload({ creditedAmount: 994_999_999n }),
    );
    client.complete(
      workflowId,
      encodeWorkflowPayload({ mintedShares: 994_999_999n }),
    );

    const result = decodeWorkflowPayload(await handle.result()) as {
      readonly mintedShares: bigint;
    };
    assert.equal(result.mintedShares, 994_999_999n);
    assert.equal(
      (decodeWorkflowPayload(client.signalsFor(workflowId)[0]?.payload ??
        encodeWorkflowPayload(null)) as { readonly creditedAmount: bigint })
        .creditedAmount,
      994_999_999n,
    );
    assert.equal(typeof handle.runId, "string");

    await assert.rejects(
      client.start({
        workflowId,
        workflowName: "depositWorkflow",
        taskQueue: "financial-workflows",
        input: encodeWorkflowPayload({ amount: 995_000_000n }),
        retry,
        executionTimeoutMs: 3_600_000,
        idReusePolicy: "reject_duplicate",
      }),
      WorkflowAlreadyStartedError,
    );
  });
});
