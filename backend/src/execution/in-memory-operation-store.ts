import type {
  ExecutionOperation,
  ExecutionOperationStore,
  ExecutionState,
  NewExecutionOperation,
} from "./types.js";
import { assertExecutionTransition } from "./state-machine.js";

function freeze(operation: ExecutionOperation): ExecutionOperation {
  return Object.freeze({ ...operation, checkpoint: Object.freeze({ ...operation.checkpoint }) });
}

export class InMemoryExecutionOperationStore implements ExecutionOperationStore {
  private readonly byId = new Map<string, ExecutionOperation>();
  private readonly byRequestKey = new Map<string, string>();

  public async createOrLoad(operation: NewExecutionOperation): Promise<{ readonly operation: ExecutionOperation; readonly created: boolean }> {
    const existingId = this.byRequestKey.get(operation.requestKey);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (existing === undefined) throw new Error("operation index is corrupt");
      if (existing.requestHash !== operation.requestHash || existing.kind !== operation.kind) {
        throw new Error("execution request key was reused with different content");
      }
      return { operation: existing, created: false };
    }
    const created = freeze({
      ...operation,
      state: "created",
      version: 0n,
      updatedAt: operation.createdAt,
    });
    this.byId.set(created.id, created);
    this.byRequestKey.set(created.requestKey, created.id);
    return { operation: created, created: true };
  }

  public async transition(
    id: string,
    expectedVersion: bigint,
    nextState: ExecutionState,
    checkpoint: Readonly<Record<string, unknown>>,
    now: Date,
    error?: string,
  ): Promise<ExecutionOperation> {
    const current = this.byId.get(id);
    if (current === undefined) throw new Error(`unknown execution operation ${id}`);
    if (current.version !== expectedVersion) throw new Error("execution operation version conflict");
    if (current.state === "completed") return current;
    assertExecutionTransition(current.state, nextState);
    const next = freeze({
      ...current,
      state: nextState,
      checkpoint,
      version: current.version + 1n,
      updatedAt: now,
      ...(error === undefined ? {} : { lastError: error }),
      ...(nextState === "completed" ? { completedAt: now } : {}),
    });
    this.byId.set(id, next);
    return next;
  }
}
