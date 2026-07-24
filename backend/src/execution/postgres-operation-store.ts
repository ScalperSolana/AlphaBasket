import type { SqlClient } from "../persistence/sql-client.js";
import type {
  ExecutionKind,
  ExecutionOperation,
  ExecutionOperationStore,
  ExecutionState,
  NewExecutionOperation,
} from "./types.js";
import { assertExecutionTransition } from "./state-machine.js";

interface OperationRow extends Record<string, unknown> {
  id: string;
  request_key: string;
  request_hash: string;
  kind: ExecutionKind;
  state: ExecutionState;
  workflow_id: string;
  basket: string;
  user_address: string | null;
  checkpoint: Readonly<Record<string, unknown>>;
  version: string;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function optional<Key extends string, Value>(key: Key, value: Value | null): { readonly [Property in Key]?: Value } {
  return value === null ? {} : ({ [key]: value } as { readonly [Property in Key]?: Value });
}

function mapRow(row: OperationRow): ExecutionOperation {
  return Object.freeze({
    id: row.id,
    requestKey: row.request_key,
    requestHash: row.request_hash,
    kind: row.kind,
    state: row.state,
    workflowId: row.workflow_id,
    basket: row.basket,
    ...optional("userAddress", row.user_address),
    checkpoint: Object.freeze({ ...row.checkpoint }),
    version: BigInt(row.version),
    ...optional("lastError", row.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...optional("completedAt", row.completed_at),
  });
}

const columns = `id, request_key, request_hash, kind, state, workflow_id, basket,
  user_address, checkpoint, version::text AS version, last_error, created_at,
  updated_at, completed_at`;

function checkpointJson(checkpoint: Readonly<Record<string, unknown>>): string {
  function assertJsonValue(value: unknown, path: string): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new TypeError(`${path} contains a non-integer or unsafe number`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object") throw new TypeError(`${path} is not JSON serializable`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new TypeError(`${path} contains a forbidden key`);
      assertJsonValue(entry, `${path}.${key}`);
    }
  }
  assertJsonValue(checkpoint, "execution checkpoint");
  const value = JSON.stringify(checkpoint);
  if (value === undefined) throw new TypeError("execution checkpoint is not JSON serializable");
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new TypeError("execution checkpoint must be a JSON object");
  return value;
}

export class PostgresExecutionOperationStore implements ExecutionOperationStore {
  public constructor(private readonly sql: SqlClient) {}

  public async createOrLoad(operation: NewExecutionOperation): Promise<{ readonly operation: ExecutionOperation; readonly created: boolean }> {
    const inserted = await this.sql.query<OperationRow>(
      `INSERT INTO execution_operations (
         id, request_key, request_hash, kind, state, workflow_id, basket,
         user_address, checkpoint, version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8::jsonb, 0, $9, $9)
       ON CONFLICT (request_key) DO NOTHING
       RETURNING ${columns}`,
      [
        operation.id,
        operation.requestKey,
        operation.requestHash,
        operation.kind,
        operation.workflowId,
        operation.basket,
        operation.userAddress ?? null,
        checkpointJson(operation.checkpoint),
        operation.createdAt,
      ],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return { operation: mapRow(created), created: true };
    const result = await this.sql.query<OperationRow>(
      `SELECT ${columns} FROM execution_operations WHERE request_key = $1`,
      [operation.requestKey],
    );
    const existing = result.rows[0];
    if (existing === undefined) throw new Error("execution operation disappeared after idempotent insert");
    if (existing.request_hash !== operation.requestHash || existing.kind !== operation.kind) {
      throw new Error("execution request key was reused with different content");
    }
    return { operation: mapRow(existing), created: false };
  }

  public async transition(
    id: string,
    expectedVersion: bigint,
    nextState: ExecutionState,
    checkpoint: Readonly<Record<string, unknown>>,
    now: Date,
    error?: string,
  ): Promise<ExecutionOperation> {
    const before = await this.sql.query<OperationRow>(
      `SELECT ${columns} FROM execution_operations WHERE id = $1`,
      [id],
    );
    const prior = before.rows[0];
    if (prior === undefined) throw new Error(`unknown execution operation ${id}`);
    if (prior.state === "completed") return mapRow(prior);
    if (BigInt(prior.version) !== expectedVersion) throw new Error("execution operation version conflict");
    assertExecutionTransition(prior.state, nextState);
    const result = await this.sql.query<OperationRow>(
      `UPDATE execution_operations
       SET state = $3,
           checkpoint = $4::jsonb,
           version = version + 1,
           last_error = $5,
           updated_at = $6,
           completed_at = CASE WHEN $3 = 'completed' THEN $6 ELSE NULL END
       WHERE id = $1 AND version = $2::bigint AND state <> 'completed'
       RETURNING ${columns}`,
      [id, expectedVersion.toString(10), nextState, checkpointJson(checkpoint), error ?? null, now],
    );
    const changed = result.rows[0];
    if (changed !== undefined) return mapRow(changed);
    const currentResult = await this.sql.query<OperationRow>(
      `SELECT ${columns} FROM execution_operations WHERE id = $1`,
      [id],
    );
    const current = currentResult.rows[0];
    if (current === undefined) throw new Error(`unknown execution operation ${id}`);
    if (current.state === "completed") return mapRow(current);
    throw new Error("execution operation version conflict");
  }
}
