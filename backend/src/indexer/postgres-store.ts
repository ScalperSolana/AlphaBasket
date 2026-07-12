import { createHash } from "node:crypto";

import type { SqlClient } from "../persistence/sql-client.js";
import type {
  AccountCursorStorePort,
  AccountProjectionSinkPort,
  EventCursor,
  EventCursorStorePort,
  EventSinkPort,
  IndexedAccountRecord,
  IndexedEventRecord,
} from "./types.js";

interface CursorRow extends Record<string, unknown> {
  cursor_kind: "account" | "event";
  source_slot: string;
  signature: string | null;
}

const bigintText = (value: bigint, field: string): string => {
  if (value < 0n) throw new RangeError(`${field} must be non-negative`);
  return value.toString(10);
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString(10));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("indexed JSON numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError(`unsupported indexed JSON value: ${typeof value}`);
};

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export class PostgresSolanaReadStore
  implements AccountProjectionSinkPort, EventSinkPort
{
  public constructor(private readonly sql: SqlClient) {}

  public async applySnapshotMonotonic(
    programId: string,
    sourceSlot: bigint,
    records: readonly IndexedAccountRecord[],
  ): Promise<void> {
    if (programId.length === 0) throw new TypeError("programId must not be empty");
    const slotText = bigintText(sourceSlot, "sourceSlot");
    await this.sql.transaction(async (transaction) => {
      for (const record of records) {
        if (record.sourceSlot !== sourceSlot || record.owner !== programId) {
          throw new TypeError("account snapshot record does not match its program/slot");
        }
        const accountData = canonicalJson(record.data);
        const contentHash = digest([
          "alphabasket-solana-account-v1",
          record.address,
          record.owner,
          record.lamports.toString(10),
          record.kind,
          accountData,
        ]);
        const upserted = await transaction.query<{ content_hash: string }>(
          `INSERT INTO solana_account_projections (
             address, owner, lamports, account_kind, account_data, content_hash,
             source_slot, is_active
           ) VALUES ($1, $2, $3::numeric, $4, $5::jsonb, $6, $7::numeric, true)
           ON CONFLICT (address) DO UPDATE
           SET owner = EXCLUDED.owner,
               lamports = EXCLUDED.lamports,
               account_kind = EXCLUDED.account_kind,
               account_data = EXCLUDED.account_data,
               content_hash = EXCLUDED.content_hash,
               source_slot = EXCLUDED.source_slot,
               is_active = true,
               updated_at = now()
           WHERE solana_account_projections.source_slot < EXCLUDED.source_slot
              OR (solana_account_projections.source_slot = EXCLUDED.source_slot
                  AND solana_account_projections.content_hash = EXCLUDED.content_hash)
           RETURNING content_hash`,
          [
            record.address,
            record.owner,
            bigintText(record.lamports, "lamports"),
            record.kind,
            accountData,
            contentHash,
            slotText,
          ],
        );
        if (upserted.rowCount === 0) {
          const existing = await transaction.query<{
            source_slot: string;
            content_hash: string;
          }>(
            `SELECT source_slot::text AS source_slot, content_hash
             FROM solana_account_projections WHERE address = $1`,
            [record.address],
          );
          const row = existing.rows[0];
          if (
            row !== undefined &&
            BigInt(row.source_slot) === sourceSlot &&
            row.content_hash !== contentHash
          ) {
            throw new Error(`conflicting account snapshot for ${record.address} at slot ${slotText}`);
          }
        }
      }
      const addresses = records.map((record) => record.address);
      await transaction.query(
        `UPDATE solana_account_projections
         SET is_active = false, source_slot = $2::numeric, updated_at = now()
         WHERE owner = $1 AND is_active = true AND source_slot < $2::numeric
           AND NOT (address = ANY($3::text[]))`,
        [programId, slotText, addresses],
      );
    });
  }

  public async appendEvents(records: readonly IndexedEventRecord[]): Promise<void> {
    await this.sql.transaction(async (transaction) => {
      for (const record of records) {
        const eventData = canonicalJson(record.data);
        const contentHash = digest([
          "alphabasket-solana-event-v1",
          record.id,
          record.signature,
          record.eventIndex,
          record.sourceSlot.toString(10),
          record.blockTimeMs?.toString(10) ?? null,
          record.name,
          eventData,
        ]);
        const inserted = await transaction.query(
          `INSERT INTO solana_program_events (
             id, signature, event_index, source_slot, block_time_ms,
             event_name, event_data, content_hash
           ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7::jsonb, $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            record.id,
            record.signature,
            record.eventIndex,
            bigintText(record.sourceSlot, "sourceSlot"),
            record.blockTimeMs === null
              ? null
              : bigintText(record.blockTimeMs, "blockTimeMs"),
            record.name,
            eventData,
            contentHash,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await transaction.query<{ content_hash: string }>(
            "SELECT content_hash FROM solana_program_events WHERE id = $1",
            [record.id],
          );
          if (existing.rows[0]?.content_hash !== contentHash) {
            throw new Error(`conflicting immutable Solana event ${record.id}`);
          }
        }
      }
    });
  }

}

async function loadCursor(sql: SqlClient, stream: string): Promise<CursorRow | null> {
  const result = await sql.query<CursorRow>(
    `SELECT cursor_kind, source_slot::text AS source_slot, signature
     FROM indexer_cursors WHERE stream = $1`,
    [stream],
  );
  return result.rows[0] ?? null;
}

async function insertInitialCursor(
  sql: SqlClient,
  stream: string,
  kind: "account" | "event",
  slot: bigint,
  signature: string | null,
): Promise<boolean> {
  const inserted = await sql.query(
    `INSERT INTO indexer_cursors (
       stream, cursor_kind, source_slot, signature
     ) VALUES ($1, $2, $3::numeric, $4)
     ON CONFLICT (stream) DO NOTHING`,
    [stream, kind, bigintText(slot, "sourceSlot"), signature],
  );
  return inserted.rowCount === 1;
}

export class PostgresAccountCursorStore implements AccountCursorStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async load(stream: string): Promise<bigint | null> {
    const row = await loadCursor(this.sql, stream);
    if (row === null) return null;
    if (row.cursor_kind !== "account" || row.signature !== null) {
      throw new TypeError(`stream ${stream} is not an account cursor`);
    }
    return BigInt(row.source_slot);
  }

  public async compareAndSet(
    stream: string,
    expected: bigint | null,
    next: bigint,
  ): Promise<boolean> {
    if (expected === null) {
      return insertInitialCursor(this.sql, stream, "account", next, null);
    }
    const updated = await this.sql.query(
      `UPDATE indexer_cursors
       SET source_slot = $2::numeric, updated_at = now()
       WHERE stream = $1 AND cursor_kind = 'account'
         AND source_slot = $3::numeric AND signature IS NULL`,
      [
        stream,
        bigintText(next, "sourceSlot"),
        bigintText(expected, "expected sourceSlot"),
      ],
    );
    return updated.rowCount === 1;
  }
}

export class PostgresEventCursorStore implements EventCursorStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async load(stream: string): Promise<EventCursor | null> {
    const row = await loadCursor(this.sql, stream);
    if (row === null) return null;
    if (row.cursor_kind !== "event" || row.signature === null) {
      throw new TypeError(`stream ${stream} is not an event cursor`);
    }
    return Object.freeze({ signature: row.signature, slot: BigInt(row.source_slot) });
  }

  public async compareAndSet(
    stream: string,
    expected: EventCursor | null,
    next: EventCursor,
  ): Promise<boolean> {
    if (expected === null) {
      return insertInitialCursor(
        this.sql,
        stream,
        "event",
        next.slot,
        next.signature,
      );
    }
    const updated = await this.sql.query(
      `UPDATE indexer_cursors
       SET source_slot = $2::numeric, signature = $3, updated_at = now()
       WHERE stream = $1 AND cursor_kind = 'event'
         AND source_slot = $4::numeric AND signature = $5`,
      [
        stream,
        bigintText(next.slot, "sourceSlot"),
        next.signature,
        bigintText(expected.slot, "expected sourceSlot"),
        expected.signature,
      ],
    );
    return updated.rowCount === 1;
  }
}
