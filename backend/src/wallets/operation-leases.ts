import { randomUUID } from "node:crypto";

import type { SqlClient } from "../persistence/sql-client.js";
import type {
  WalletOperationLease,
  WalletOperationLeaseStorePort,
  WalletExecutionCoordinatorPort,
} from "./types.js";

export class InMemoryWalletOperationLeaseStore implements WalletOperationLeaseStorePort {
  private readonly leases = new Map<string, WalletOperationLease>();

  public constructor(private readonly capacityByWallet: ReadonlyMap<string, number>) {}

  public async tryAcquire(request: {
    readonly walletId: string;
    readonly operationId: string;
    readonly ownerId: string;
    readonly now: Date;
    readonly durationMs: number;
  }): Promise<WalletOperationLease | null> {
    if (!Number.isSafeInteger(request.durationMs) || request.durationMs < 1_000 || request.durationMs > 3_600_000) {
      throw new RangeError("wallet lease duration must be between 1 second and 1 hour");
    }
    const key = `${request.walletId}\u0000${request.operationId}`;
    const replay = this.leases.get(key);
    if (replay !== undefined && replay.expiresAt.getTime() > request.now.getTime()) return null;
    for (const [leaseKey, lease] of this.leases) {
      if (lease.expiresAt.getTime() <= request.now.getTime()) this.leases.delete(leaseKey);
    }
    const capacity = this.capacityByWallet.get(request.walletId);
    if (capacity === undefined || !Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("execution wallet capacity is not configured");
    const active = [...this.leases.values()].filter((lease) => lease.walletId === request.walletId).length;
    if (active >= capacity) return null;
    const lease: WalletOperationLease = Object.freeze({
      walletId: request.walletId,
      operationId: request.operationId,
      ownerId: request.ownerId,
      token: randomUUID(),
      acquiredAt: request.now,
      expiresAt: new Date(request.now.getTime() + request.durationMs),
    });
    this.leases.set(key, lease);
    return lease;
  }

  public async release(lease: WalletOperationLease): Promise<boolean> {
    const key = `${lease.walletId}\u0000${lease.operationId}`;
    const current = this.leases.get(key);
    if (current?.token !== lease.token || current.ownerId !== lease.ownerId) return false;
    this.leases.delete(key);
    return true;
  }

  public async renew(lease: WalletOperationLease, now: Date, durationMs: number): Promise<WalletOperationLease | null> {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) {
      throw new RangeError("wallet lease duration must be between 1 second and 1 hour");
    }
    const key = `${lease.walletId}\u0000${lease.operationId}`;
    const current = this.leases.get(key);
    if (
      current?.token !== lease.token ||
      current.ownerId !== lease.ownerId ||
      current.expiresAt.getTime() <= now.getTime()
    ) return null;
    const renewed = Object.freeze({
      ...current,
      expiresAt: new Date(now.getTime() + durationMs),
    });
    this.leases.set(key, renewed);
    return renewed;
  }
}

interface LeaseRow extends Record<string, unknown> {
  wallet_id: string;
  operation_id: string;
  owner_id: string;
  token: string;
  acquired_at: Date;
  expires_at: Date;
}

const mapLease = (row: LeaseRow): WalletOperationLease => Object.freeze({
  walletId: row.wallet_id,
  operationId: row.operation_id,
  ownerId: row.owner_id,
  token: row.token,
  acquiredAt: row.acquired_at,
  expiresAt: row.expires_at,
});

export class PostgresWalletOperationLeaseStore implements WalletOperationLeaseStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async tryAcquire(request: {
    readonly walletId: string;
    readonly operationId: string;
    readonly ownerId: string;
    readonly now: Date;
    readonly durationMs: number;
  }): Promise<WalletOperationLease | null> {
    if (!Number.isSafeInteger(request.durationMs) || request.durationMs < 1_000 || request.durationMs > 3_600_000) {
      throw new RangeError("wallet lease duration must be between 1 second and 1 hour");
    }
    return this.sql.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1441702612))", [request.walletId]);
      await transaction.query(
        "DELETE FROM wallet_operation_leases WHERE wallet_id = $1 AND expires_at <= $2",
        [request.walletId, request.now],
      );
      const existing = await transaction.query<LeaseRow>(
        `SELECT wallet_id, operation_id, owner_id, token::text AS token, acquired_at, expires_at
         FROM wallet_operation_leases
         WHERE wallet_id = $1 AND operation_id = $2`,
        [request.walletId, request.operationId],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) return null;
      const capacityResult = await transaction.query<{ max_concurrent_operations: number }>(
        `SELECT max_concurrent_operations FROM execution_wallets
         WHERE wallet_id = $1 AND status = 'active'`,
        [request.walletId],
      );
      const capacity = capacityResult.rows[0]?.max_concurrent_operations;
      if (capacity === undefined) throw new Error("execution wallet is missing or not active");
      if (capacity !== 1) throw new Error("live execution wallets must be configured for exclusive access");
      const activeResult = await transaction.query<{ active: string }>(
        `SELECT count(*)::text AS active FROM wallet_operation_leases
         WHERE wallet_id = $1 AND expires_at > $2`,
        [request.walletId, request.now],
      );
      if (BigInt(activeResult.rows[0]?.active ?? "0") >= BigInt(capacity)) return null;
      const token = randomUUID();
      const inserted = await transaction.query<LeaseRow>(
        `INSERT INTO wallet_operation_leases (
           wallet_id, operation_id, owner_id, token, acquired_at, expires_at
         ) VALUES ($1, $2, $3, $4::uuid, $5, $5 + ($6::bigint * interval '1 millisecond'))
         RETURNING wallet_id, operation_id, owner_id, token::text AS token, acquired_at, expires_at`,
        [request.walletId, request.operationId, request.ownerId, token, request.now, request.durationMs],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("wallet lease insert returned no row");
      return mapLease(row);
    }, { isolation: "serializable" });
  }

  public async release(lease: WalletOperationLease): Promise<boolean> {
    const result = await this.sql.query(
      `DELETE FROM wallet_operation_leases
       WHERE wallet_id = $1 AND operation_id = $2 AND owner_id = $3 AND token = $4::uuid`,
      [lease.walletId, lease.operationId, lease.ownerId, lease.token],
    );
    return result.rowCount === 1;
  }

  public async renew(lease: WalletOperationLease, now: Date, durationMs: number): Promise<WalletOperationLease | null> {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) {
      throw new RangeError("wallet lease duration must be between 1 second and 1 hour");
    }
    const result = await this.sql.query<LeaseRow>(
      `UPDATE wallet_operation_leases
       SET expires_at = $5 + ($6::bigint * interval '1 millisecond')
       WHERE wallet_id = $1 AND operation_id = $2 AND owner_id = $3
         AND token = $4::uuid AND expires_at > $5
       RETURNING wallet_id, operation_id, owner_id, token::text AS token, acquired_at, expires_at`,
      [lease.walletId, lease.operationId, lease.ownerId, lease.token, now, durationMs],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapLease(row);
  }
}

export class WalletLeaseLostError extends Error {
  public constructor(walletId: string, options?: ErrorOptions) {
    super(`execution wallet ${walletId} lease was lost`, options);
    this.name = "WalletLeaseLostError";
  }
}

export class WalletExecutionCoordinator implements WalletExecutionCoordinatorPort {
  public constructor(
    private readonly leases: WalletOperationLeaseStorePort,
    private readonly ownerId: string,
    private readonly leaseDurationMs: number,
  ) {
    if (ownerId.length === 0 || ownerId.length > 256) throw new RangeError("wallet lease owner must contain 1-256 characters");
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 3_000 || leaseDurationMs > 3_600_000) {
      throw new RangeError("coordinator lease duration must be between 3 seconds and 1 hour");
    }
  }

  public async execute<Result>(
    walletId: string,
    operationId: string,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (walletId.length === 0 || walletId.length > 256 || operationId.length === 0 || operationId.length > 256) {
      throw new RangeError("wallet and operation IDs must contain 1-256 characters");
    }
    let lease = await this.leases.tryAcquire({
      walletId,
      operationId,
      ownerId: this.ownerId,
      now: new Date(),
      durationMs: this.leaseDurationMs,
    });
    if (lease === null) throw new Error(`execution wallet ${walletId} is at capacity`);
    const operationController = new AbortController();
    const heartbeatIntervalMs = Math.max(1_000, Math.floor(this.leaseDurationMs / 3));
    let stopped = false;
    let wakeHeartbeat: (() => void) | undefined;
    let leaseFailure: WalletLeaseLostError | undefined;
    const heartbeat = (async () => {
      while (!stopped) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, heartbeatIntervalMs);
          timeout.unref();
          wakeHeartbeat = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
        wakeHeartbeat = undefined;
        if (stopped) break;
        try {
          const renewed = await this.leases.renew(lease, new Date(), this.leaseDurationMs);
          if (renewed === null) throw new WalletLeaseLostError(walletId);
          lease = renewed;
        } catch (error) {
          leaseFailure = error instanceof WalletLeaseLostError
            ? error
            : new WalletLeaseLostError(walletId, { cause: error });
          operationController.abort(leaseFailure);
          break;
        }
      }
    })();
    let operationResult: Result | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      operationResult = await operation(operationController.signal);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      stopped = true;
      wakeHeartbeat?.();
      await heartbeat;
      await this.leases.release(lease).catch(() => false);
    }
    if (operationFailed) throw operationError;
    if (leaseFailure !== undefined) throw leaseFailure;
    return operationResult as Result;
  }
}
