import { randomUUID } from "node:crypto";

import type { EncodedWorkflowPayload } from "./payload-codec.js";
import type {
  StartWorkflowRequest,
  WorkflowClientPort,
  WorkflowHandle,
} from "./ports.js";
import { validateStartWorkflowRequest } from "./validation.js";

export class WorkflowAlreadyStartedError extends Error {
  public constructor(public readonly workflowId: string) {
    super(`workflow already started: ${workflowId}`);
    this.name = "WorkflowAlreadyStartedError";
  }
}

export class WorkflowNotFoundError extends Error {
  public constructor(public readonly workflowId: string) {
    super(`workflow not found: ${workflowId}`);
    this.name = "WorkflowNotFoundError";
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface WorkflowRecord {
  readonly request: StartWorkflowRequest;
  readonly runId: string;
  readonly result: Deferred<EncodedWorkflowPayload>;
  readonly signals: Array<{
    readonly name: string;
    readonly payload: EncodedWorkflowPayload;
  }>;
  cancelled: boolean;
}

export class InMemoryWorkflowClient implements WorkflowClientPort {
  private readonly records = new Map<string, WorkflowRecord>();

  public async start(request: StartWorkflowRequest): Promise<WorkflowHandle> {
    validateStartWorkflowRequest(request);
    if (this.records.has(request.workflowId)) {
      throw new WorkflowAlreadyStartedError(request.workflowId);
    }
    const record: WorkflowRecord = {
      request,
      runId: randomUUID(),
      result: deferred(),
      signals: [],
      cancelled: false,
    };
    this.records.set(request.workflowId, record);
    return this.handle(request.workflowId, record);
  }

  public getHandle(
    workflowId: string,
    runId?: string,
  ): WorkflowHandle {
    const record = this.records.get(workflowId);
    if (record === undefined || (runId !== undefined && runId !== record.runId)) {
      throw new WorkflowNotFoundError(workflowId);
    }
    return this.handle(workflowId, record);
  }

  public complete(workflowId: string, result: EncodedWorkflowPayload): void {
    const record = this.requireRecord(workflowId);
    record.result.resolve(result);
  }

  public fail(workflowId: string, error: unknown): void {
    this.requireRecord(workflowId).result.reject(error);
  }

  public signalsFor(
    workflowId: string,
  ): readonly {
    readonly name: string;
    readonly payload: EncodedWorkflowPayload;
  }[] {
    return [...this.requireRecord(workflowId).signals];
  }

  private requireRecord(workflowId: string): WorkflowRecord {
    const record = this.records.get(workflowId);
    if (record === undefined) {
      throw new WorkflowNotFoundError(workflowId);
    }
    return record;
  }

  private handle(
    workflowId: string,
    record: WorkflowRecord,
  ): WorkflowHandle {
    return {
      workflowId,
      runId: record.runId,
      result: async () => record.result.promise,
      signal: async (name: string, payload: EncodedWorkflowPayload) => {
        if (record.cancelled) {
          throw new Error(`cannot signal cancelled workflow ${workflowId}`);
        }
        record.signals.push({ name, payload });
      },
      cancel: async (reason: string) => {
        if (!record.cancelled) {
          record.cancelled = true;
          record.result.reject(new Error(`workflow cancelled: ${reason}`));
        }
      },
    };
  }
}
