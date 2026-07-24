import { createHash, randomUUID } from "node:crypto";

import type { SqlClient, SqlExecutor } from "./sql-client.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type OutboxStatus = "pending" | "leased" | "published" | "dead";

export interface NewOutboxEvent {
  readonly id: string;
  readonly topic: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly dedupeKey: string;
  readonly payload: JsonValue;
  readonly headers?: Readonly<Record<string, string>>;
  readonly occurredAt: Date;
  readonly availableAt?: Date;
}

export interface OutboxEvent extends NewOutboxEvent {
  readonly headers: Readonly<Record<string, string>>;
  readonly availableAt: Date;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly leaseUntil?: Date;
  readonly publishedAt?: Date;
  readonly lastError?: string;
}

export interface ClaimOutboxOptions {
  readonly owner: string;
  readonly limit: number;
  readonly leaseDurationMs: number;
  readonly maxAttempts: number;
}

export interface OutboxLease {
  readonly owner: string;
  readonly token: string;
  readonly events: readonly OutboxEvent[];
}

export interface ReleaseOutboxOptions {
  readonly eventIds: readonly string[];
  readonly owner: string;
  readonly token: string;
  readonly retryAt: Date;
  readonly error: string;
}

export interface TransactionalOutboxRepository {
  enqueue(event: NewOutboxEvent, transaction?: SqlExecutor): Promise<void>;
  claim(options: ClaimOutboxOptions): Promise<OutboxLease>;
  markPublished(
    eventIds: readonly string[],
    owner: string,
    token: string,
  ): Promise<number>;
  release(options: ReleaseOutboxOptions): Promise<number>;
  markDead(
    eventIds: readonly string[],
    owner: string,
    token: string,
    error: string,
  ): Promise<number>;
}

export class OutboxDedupeConflictError extends Error {
  public constructor(public readonly dedupeKey: string) {
    super(`outbox dedupe key was reused with different content: ${dedupeKey}`);
    this.name = "OutboxDedupeConflictError";
  }
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  dedupe_key: string;
  payload: JsonValue;
  headers: Readonly<Record<string, string>>;
  occurred_at: Date;
  available_at: Date;
  status: OutboxStatus;
  attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: Date | null;
  published_at: Date | null;
  last_error: string | null;
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | null,
): { readonly [Property in Key]?: Value } {
  return value === null ? {} : ({ [key]: value } as {
      readonly [Property in Key]?: Value;
    });
}

function mapOutboxRow(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    headers: row.headers,
    occurredAt: row.occurred_at,
    availableAt: row.available_at,
    status: row.status,
    attempts: row.attempts,
    ...optionalProperty("leaseOwner", row.lease_owner),
    ...optionalProperty("leaseToken", row.lease_token),
    ...optionalProperty("leaseUntil", row.lease_until),
    ...optionalProperty("publishedAt", row.published_at),
    ...optionalProperty("lastError", row.last_error),
  };
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireLease(eventIds: readonly string[], owner: string, token: string): void {
  if (eventIds.length === 0) {
    throw new RangeError("eventIds must not be empty");
  }
  if (owner.length === 0 || token.length === 0) {
    throw new RangeError("lease owner and token must not be empty");
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("outbox JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function outboxContentHash(event: NewOutboxEvent): string {
  // Encode fields as an unambiguous tuple. Newline concatenation is unsafe
  // because topic/aggregate identifiers are caller-provided strings.
  const content = JSON.stringify([
    "alphabasket-outbox-v1",
    event.topic,
    event.aggregateType,
    event.aggregateId,
    event.occurredAt.toISOString(),
    (event.availableAt ?? event.occurredAt).toISOString(),
    canonicalJson(event.payload),
    canonicalJson(event.headers ?? {}),
  ]);
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class PostgresOutboxRepository implements TransactionalOutboxRepository {
  public constructor(private readonly sql: SqlClient) {}

  public async enqueue(
    event: NewOutboxEvent,
    transaction: SqlExecutor = this.sql,
  ): Promise<void> {
    if (event.dedupeKey.length === 0) {
      throw new RangeError("dedupeKey must not be empty");
    }

    const contentHash = outboxContentHash(event);

    const result = await transaction.query<{ content_hash: string }>(
      `INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, dedupe_key, content_hash,
         payload, headers, occurred_at, available_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
       ON CONFLICT (dedupe_key) DO UPDATE
       SET dedupe_key = outbox_events.dedupe_key
       WHERE outbox_events.content_hash = EXCLUDED.content_hash
       RETURNING content_hash`,
      [
        event.id,
        event.topic,
        event.aggregateType,
        event.aggregateId,
        event.dedupeKey,
        contentHash,
        JSON.stringify(event.payload),
        JSON.stringify(event.headers ?? {}),
        event.occurredAt,
        event.availableAt ?? event.occurredAt,
      ],
    );
    const persistedHash = result.rows[0]?.content_hash;
    if (persistedHash !== contentHash) {
      throw new OutboxDedupeConflictError(event.dedupeKey);
    }
  }

  public async claim(options: ClaimOutboxOptions): Promise<OutboxLease> {
    requirePositiveInteger(options.limit, "limit");
    requirePositiveInteger(options.leaseDurationMs, "leaseDurationMs");
    requirePositiveInteger(options.maxAttempts, "maxAttempts");
    if (options.owner.length === 0) {
      throw new RangeError("owner must not be empty");
    }

    const token = randomUUID();
    const result = await this.sql.transaction(
      async (transaction) => {
        await transaction.query(
          `UPDATE outbox_events
           SET status = 'dead',
               last_error = COALESCE(last_error, 'maximum delivery attempts exhausted'),
               lease_owner = NULL, lease_token = NULL, lease_until = NULL
           WHERE attempts >= $1
             AND (
               (status = 'pending' AND available_at <= now())
               OR (status = 'leased' AND lease_until <= now())
             )`,
          [options.maxAttempts],
        );
        return transaction.query<OutboxRow>(
          `WITH candidates AS (
             SELECT id
             FROM outbox_events
             WHERE status IN ('pending', 'leased')
               AND available_at <= now()
               AND (status = 'pending' OR lease_until <= now())
               AND attempts < $1
             ORDER BY available_at, occurred_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           )
           UPDATE outbox_events AS event
           SET status = 'leased',
               attempts = event.attempts + 1,
               lease_owner = $3,
               lease_token = $4,
               lease_until = now() + ($5::bigint * interval '1 millisecond'),
               last_error = NULL
           FROM candidates
           WHERE event.id = candidates.id
           RETURNING event.*`,
          [
            options.maxAttempts,
            options.limit,
            options.owner,
            token,
            options.leaseDurationMs,
          ],
        );
      },
      { isolation: "read committed" },
    );

    return {
      owner: options.owner,
      token,
      events: result.rows.map(mapOutboxRow),
    };
  }

  public async markPublished(
    eventIds: readonly string[],
    owner: string,
    token: string,
  ): Promise<number> {
    requireLease(eventIds, owner, token);
    const result = await this.sql.query(
      `UPDATE outbox_events
       SET status = 'published', published_at = now(),
           lease_owner = NULL, lease_token = NULL, lease_until = NULL
       WHERE id = ANY($1::uuid[])
         AND status = 'leased'
         AND lease_owner = $2
         AND lease_token = $3`,
      [eventIds, owner, token],
    );
    return result.rowCount;
  }

  public async release(options: ReleaseOutboxOptions): Promise<number> {
    requireLease(options.eventIds, options.owner, options.token);
    const result = await this.sql.query(
      `UPDATE outbox_events
       SET status = 'pending', available_at = $4, last_error = $5,
           lease_owner = NULL, lease_token = NULL, lease_until = NULL
       WHERE id = ANY($1::uuid[])
         AND status = 'leased'
         AND lease_owner = $2
         AND lease_token = $3`,
      [
        options.eventIds,
        options.owner,
        options.token,
        options.retryAt,
        options.error,
      ],
    );
    return result.rowCount;
  }

  public async markDead(
    eventIds: readonly string[],
    owner: string,
    token: string,
    error: string,
  ): Promise<number> {
    requireLease(eventIds, owner, token);
    const result = await this.sql.query(
      `UPDATE outbox_events
       SET status = 'dead', last_error = $4,
           lease_owner = NULL, lease_token = NULL, lease_until = NULL
       WHERE id = ANY($1::uuid[])
         AND status = 'leased'
         AND lease_owner = $2
         AND lease_token = $3`,
      [eventIds, owner, token, error],
    );
    return result.rowCount;
  }
}
