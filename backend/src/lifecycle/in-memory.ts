import { randomUUID } from "node:crypto";

import type { DistributedLease, DistributedLeaseStorePort } from "./lease.js";
import type {
  LifecycleRun,
  LifecycleRunState,
  LifecycleRunStorePort,
} from "./types.js";

const transitions: Readonly<Record<LifecycleRunState, readonly LifecycleRunState[]>> = {
  created: ["onchain_started"],
  onchain_started: ["external_execution_completed"],
  external_execution_completed: ["onchain_completed"],
  onchain_completed: [],
};

export class InMemoryLifecycleRunStore implements LifecycleRunStorePort {
  private readonly byId = new Map<string, LifecycleRun>();
  private readonly byKey = new Map<string, string>();

  public async createOrLoad(run: Omit<LifecycleRun, "state" | "version" | "updatedAt" | "completedAt">): Promise<LifecycleRun> {
    const existingId = this.byKey.get(run.runKey);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (existing === undefined) throw new Error("corrupt lifecycle run index");
      if (existing.requestHash !== run.requestHash || existing.kind !== run.kind || existing.basketId !== run.basketId) {
        throw new Error("lifecycle run key reused with different content");
      }
      return existing;
    }
    const value: LifecycleRun = Object.freeze({
      ...run,
      state: "created",
      version: 0n,
      updatedAt: run.createdAt,
    });
    this.byId.set(value.id, value);
    this.byKey.set(value.runKey, value.id);
    return value;
  }

  public async transition(
    id: string,
    expectedVersion: bigint,
    nextState: LifecycleRunState,
    checkpoint: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<LifecycleRun> {
    const current = this.byId.get(id);
    if (current === undefined) throw new Error(`unknown lifecycle run ${id}`);
    if (current.state === "onchain_completed") return current;
    if (current.version !== expectedVersion) throw new Error("lifecycle run version conflict");
    if (!transitions[current.state].includes(nextState)) throw new Error(`invalid lifecycle transition ${current.state} -> ${nextState}`);
    const updated: LifecycleRun = Object.freeze({
      ...current,
      state: nextState,
      checkpoint: Object.freeze({ ...checkpoint }),
      version: current.version + 1n,
      updatedAt: now,
      ...(nextState === "onchain_completed" ? { completedAt: now } : {}),
    });
    this.byId.set(id, updated);
    return updated;
  }
}

export class InMemoryDistributedLeaseStore implements DistributedLeaseStorePort {
  private readonly leases = new Map<string, DistributedLease>();

  public async tryAcquire(key: string, ownerId: string, now: Date, durationMs: number): Promise<DistributedLease | null> {
    const previous = this.leases.get(key);
    if (previous !== undefined && previous.expiresAt.getTime() > now.getTime()) return null;
    const lease: DistributedLease = Object.freeze({
      key,
      ownerId,
      token: randomUUID(),
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + durationMs),
    });
    this.leases.set(key, lease);
    return lease;
  }

  public async release(lease: DistributedLease): Promise<boolean> {
    const current = this.leases.get(lease.key);
    if (current?.token !== lease.token || current.ownerId !== lease.ownerId) return false;
    this.leases.delete(lease.key);
    return true;
  }
}
