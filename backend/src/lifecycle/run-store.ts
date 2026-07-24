import type { SqlClient } from "../persistence/sql-client.js";
import type {
  LifecycleRun,
  LifecycleRunKind,
  LifecycleRunState,
  LifecycleRunStorePort,
} from "./types.js";

interface RunRow extends Record<string, unknown> {
  id: string;
  run_key: string;
  request_hash: string;
  kind: LifecycleRunKind;
  basket_id: string;
  state: LifecycleRunState;
  checkpoint: Readonly<Record<string, unknown>>;
  version: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const allowed: Readonly<Record<LifecycleRunState, readonly LifecycleRunState[]>> = {
  created: ["onchain_started"],
  onchain_started: ["external_execution_completed"],
  external_execution_completed: ["onchain_completed"],
  onchain_completed: [],
};

const mapRun = (row: RunRow): LifecycleRun => Object.freeze({
  id: row.id,
  runKey: row.run_key,
  requestHash: row.request_hash,
  kind: row.kind,
  basketId: row.basket_id,
  state: row.state,
  checkpoint: Object.freeze({ ...row.checkpoint }),
  version: BigInt(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
});

const columns = `id, run_key, request_hash, kind, basket_id, state, checkpoint,
  version::text AS version, created_at, updated_at, completed_at`;

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
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`${path} contains a forbidden key`);
      }
      assertJsonValue(entry, `${path}.${key}`);
    }
  }
  assertJsonValue(checkpoint, "lifecycle checkpoint");
  const encoded = JSON.stringify(checkpoint);
  if (encoded === undefined || encoded.length > 1_000_000) throw new TypeError("invalid lifecycle checkpoint");
  return encoded;
}

export class PostgresLifecycleRunStore implements LifecycleRunStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async createOrLoad(run: Omit<LifecycleRun, "state" | "version" | "updatedAt" | "completedAt">): Promise<LifecycleRun> {
    const inserted = await this.sql.query<RunRow>(
      `INSERT INTO lifecycle_runs (
         id, run_key, request_hash, kind, basket_id, state, checkpoint, version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'created', $6::jsonb, 0, $7, $7)
       ON CONFLICT (run_key) DO NOTHING
       RETURNING ${columns}`,
      [run.id, run.runKey, run.requestHash, run.kind, run.basketId, checkpointJson(run.checkpoint), run.createdAt],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return mapRun(created);
    const existing = await this.sql.query<RunRow>(`SELECT ${columns} FROM lifecycle_runs WHERE run_key = $1`, [run.runKey]);
    const row = existing.rows[0];
    if (row === undefined) throw new Error("lifecycle run disappeared after insert");
    if (row.request_hash !== run.requestHash || row.kind !== run.kind || row.basket_id !== run.basketId) {
      throw new Error("lifecycle run key reused with different content");
    }
    return mapRun(row);
  }

  public async transition(
    id: string,
    expectedVersion: bigint,
    nextState: LifecycleRunState,
    checkpoint: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<LifecycleRun> {
    const currentResult = await this.sql.query<RunRow>(`SELECT ${columns} FROM lifecycle_runs WHERE id = $1`, [id]);
    const current = currentResult.rows[0];
    if (current === undefined) throw new Error(`unknown lifecycle run ${id}`);
    if (current.state === "onchain_completed") return mapRun(current);
    if (BigInt(current.version) !== expectedVersion) throw new Error("lifecycle run version conflict");
    if (!allowed[current.state].includes(nextState)) throw new Error(`invalid lifecycle transition ${current.state} -> ${nextState}`);
    const changed = await this.sql.query<RunRow>(
      `UPDATE lifecycle_runs
       SET state = $3, checkpoint = $4::jsonb, version = version + 1,
           updated_at = $5,
           completed_at = CASE WHEN $3 = 'onchain_completed' THEN $5 ELSE NULL END
       WHERE id = $1 AND version = $2::bigint
       RETURNING ${columns}`,
      [id, expectedVersion.toString(10), nextState, checkpointJson(checkpoint), now],
    );
    const row = changed.rows[0];
    if (row === undefined) throw new Error("lifecycle run version conflict");
    return mapRun(row);
  }
}
