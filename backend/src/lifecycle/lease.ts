import type { SqlClient } from "../persistence/sql-client.js";

export interface DistributedLease {
  readonly key: string;
  readonly ownerId: string;
  readonly token: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

export interface DistributedLeaseStorePort {
  tryAcquire(key: string, ownerId: string, now: Date, durationMs: number): Promise<DistributedLease | null>;
  release(lease: DistributedLease): Promise<boolean>;
}

interface LeaseRow extends Record<string, unknown> {
  lease_key: string;
  owner_id: string;
  token: string;
  acquired_at: Date;
  expires_at: Date;
}

const mapLease = (row: LeaseRow): DistributedLease => Object.freeze({
  key: row.lease_key,
  ownerId: row.owner_id,
  token: row.token,
  acquiredAt: row.acquired_at,
  expiresAt: row.expires_at,
});

export class PostgresDistributedLeaseStore implements DistributedLeaseStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async tryAcquire(key: string, ownerId: string, now: Date, durationMs: number): Promise<DistributedLease | null> {
    if (key.length === 0 || key.length > 256 || ownerId.length === 0 || ownerId.length > 256) {
      throw new RangeError("lease key and owner must contain 1-256 characters");
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) {
      throw new RangeError("lease duration must be between 1 second and 1 hour");
    }
    const result = await this.sql.query<LeaseRow>(
      `INSERT INTO distributed_leases (lease_key, owner_id, token, acquired_at, expires_at)
       VALUES ($1, $2, gen_random_uuid(), $3, $3 + ($4::bigint * interval '1 millisecond'))
       ON CONFLICT (lease_key) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           token = EXCLUDED.token,
           acquired_at = EXCLUDED.acquired_at,
           expires_at = EXCLUDED.expires_at
       WHERE distributed_leases.expires_at <= $3
       RETURNING lease_key, owner_id, token::text AS token, acquired_at, expires_at`,
      [key, ownerId, now, durationMs],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapLease(row);
  }

  public async release(lease: DistributedLease): Promise<boolean> {
    const result = await this.sql.query(
      `DELETE FROM distributed_leases
       WHERE lease_key = $1 AND owner_id = $2 AND token = $3::uuid`,
      [lease.key, lease.ownerId, lease.token],
    );
    return result.rowCount === 1;
  }
}
