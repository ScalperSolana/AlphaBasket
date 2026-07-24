import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ExecutionWorkQueuePort,
  ExecutionWorkRequest,
} from "../src/execution/index.js";
import { ExecutionDispatcher } from "../src/workers/index.js";
import type { WorkflowClientPort } from "../src/workflows/index.js";

function queue(overrides: Partial<ExecutionWorkQueuePort> = {}): ExecutionWorkQueuePort {
  return {
    claimReady: async () => [],
    markDispatched: async () => undefined,
    releaseClaim: async () => undefined,
    markCompleted: async () => undefined,
    loadRequest: async (_operationId: string): Promise<ExecutionWorkRequest> => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

describe("execution dispatch and resumption", () => {
  it("starts a deterministic workflow and commits the dispatch claim", async () => {
    const marked: string[] = [];
    const started: string[] = [];
    const operationId = "10000000-0000-4000-8000-000000000001";
    const dispatcher = new ExecutionDispatcher(
      queue({
        claimReady: async () => [{
          operationId,
          workflowId: "deposit-workflow",
          kind: "deposit",
          claimToken: "20000000-0000-4000-8000-000000000001",
        }],
        markDispatched: async (id, token, runId) => {
          marked.push(`${id}:${token}:${runId ?? ""}`);
        },
      }),
      {
        start: async (request) => {
          started.push(`${request.workflowName}:${request.workflowId}:${request.idReusePolicy}`);
          return {
            workflowId: request.workflowId,
            runId: "temporal-run",
            result: async () => request.input,
            signal: async () => undefined,
            cancel: async () => undefined,
          };
        },
        getHandle: () => { throw new Error("not used"); },
      } satisfies WorkflowClientPort,
      {
        ownerId: "dispatcher",
        taskQueue: "alphabasket",
        batchSize: 10,
        claimDurationMs: 30_000,
        retryDelayMs: 5_000,
      },
    );
    assert.equal(await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z")), 1);
    assert.deepEqual(started, ["depositExecutionWorkflow:deposit-workflow:reject_duplicate"]);
    assert.equal(marked.length, 1);
    assert.match(marked[0] as string, /temporal-run$/u);
  });

  it("treats an already-started workflow as successful crash recovery", async () => {
    let marked = 0;
    let released = 0;
    const dispatcher = new ExecutionDispatcher(
      queue({
        claimReady: async () => [{
          operationId: "10000000-0000-4000-8000-000000000002",
          workflowId: "withdrawal-workflow",
          kind: "withdrawal",
          claimToken: "20000000-0000-4000-8000-000000000002",
        }],
        markDispatched: async () => { marked += 1; },
        releaseClaim: async () => { released += 1; },
      }),
      {
        start: async () => {
          const error = new Error("workflow already exists");
          error.name = "WorkflowExecutionAlreadyStartedError";
          throw error;
        },
        getHandle: () => { throw new Error("not used"); },
      },
      {
        ownerId: "dispatcher",
        taskQueue: "alphabasket",
        batchSize: 10,
        claimDurationMs: 30_000,
        retryDelayMs: 5_000,
      },
    );
    assert.equal(await dispatcher.runOnce(), 1);
    assert.equal(marked, 1);
    assert.equal(released, 0);
  });
});
