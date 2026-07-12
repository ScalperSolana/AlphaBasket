import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OutboxDedupeConflictError,
  PostgresOutboxRepository,
} from "../src/persistence/outbox.js";
import type {
  SqlClient,
  SqlExecutor,
  SqlParameter,
  SqlQueryResult,
} from "../src/persistence/sql-client.js";

interface RecordedQuery {
  readonly text: string;
  readonly parameters: readonly SqlParameter[];
}

class ScriptedSqlClient implements SqlClient {
  public readonly queries: RecordedQuery[] = [];
  public readonly results: Array<SqlQueryResult<Record<string, unknown>>> = [];
  public echoOutboxContentHash = false;

  public async query<Row extends Record<string, unknown>>(
    text: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ text, parameters });
    if (this.echoOutboxContentHash && text.includes("RETURNING content_hash")) {
      return {
        rows: [{ content_hash: parameters[5] }] as unknown as Row[],
        rowCount: 1,
      };
    }
    const result = this.results.shift() ?? { rows: [], rowCount: 0 };
    return result as SqlQueryResult<Row>;
  }

  public transaction<Result>(
    operation: (transaction: SqlExecutor) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }
}

describe("transactional PostgreSQL outbox", () => {
  it("can enqueue through the caller's existing SQL transaction", async () => {
    const owner = new ScriptedSqlClient();
    const transaction = new ScriptedSqlClient();
    transaction.echoOutboxContentHash = true;
    const repository = new PostgresOutboxRepository(owner);
    await repository.enqueue(
      {
        id: "00000000-0000-4000-8000-000000000001",
        topic: "deposit.completed",
        aggregateType: "deposit",
        aggregateId: "deposit-1",
        dedupeKey: "deposit-1:completed",
        payload: { amount: "995000000" },
        occurredAt: new Date("2026-07-12T10:00:00Z"),
      },
      transaction,
    );

    assert.equal(owner.queries.length, 0);
    assert.equal(transaction.queries.length, 1);
    assert.match(transaction.queries[0]?.text ?? "", /ON CONFLICT \(dedupe_key\) DO UPDATE/u);
  });

  it("claims with SKIP LOCKED, bounded attempts, and an unguessable lease token", async () => {
    const sql = new ScriptedSqlClient();
    sql.results.push({ rowCount: 0, rows: [] });
    sql.results.push({
      rowCount: 1,
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          topic: "deposit.completed",
          aggregate_type: "deposit",
          aggregate_id: "deposit-1",
          dedupe_key: "deposit-1:completed",
          payload: { amount: "995000000" },
          headers: {},
          occurred_at: new Date("2026-07-12T10:00:00Z"),
          available_at: new Date("2026-07-12T10:00:00Z"),
          status: "leased",
          attempts: 1,
          lease_owner: "publisher-a",
          lease_token: "00000000-0000-4000-8000-000000000099",
          lease_until: new Date("2026-07-12T10:01:00Z"),
          published_at: null,
          last_error: null,
        },
      ],
    });
    const lease = await new PostgresOutboxRepository(sql).claim({
      owner: "publisher-a",
      limit: 20,
      leaseDurationMs: 60_000,
      maxAttempts: 10,
    });

    const reap = sql.queries[0];
    const claim = sql.queries[1];
    assert.match(reap?.text ?? "", /maximum delivery attempts exhausted/u);
    assert.match(claim?.text ?? "", /FOR UPDATE SKIP LOCKED/u);
    assert.match(claim?.text ?? "", /attempts < \$1/u);
    assert.equal(claim?.parameters[0], 10);
    assert.equal(claim?.parameters[1], 20);
    assert.equal(typeof lease.token, "string");
    assert.equal(lease.events[0]?.attempts, 1);
  });

  it("rejects a dedupe key reused for different event content", async () => {
    const sql = new ScriptedSqlClient();
    sql.results.push({ rows: [], rowCount: 0 });
    await assert.rejects(
      new PostgresOutboxRepository(sql).enqueue({
        id: "00000000-0000-4000-8000-000000000001",
        topic: "withdrawal.completed",
        aggregateType: "withdrawal",
        aggregateId: "withdrawal-1",
        dedupeKey: "already-used",
        payload: { amount: "1" },
        occurredAt: new Date("2026-07-12T10:00:00Z"),
      }),
      OutboxDedupeConflictError,
    );
  });

  it("binds UUIDs as a PostgreSQL array and rejects stale leases", async () => {
    const sql = new ScriptedSqlClient();
    sql.results.push({ rows: [], rowCount: 0 });
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ] as const;
    const updated = await new PostgresOutboxRepository(sql).markPublished(
      ids,
      "publisher-a",
      "00000000-0000-4000-8000-000000000099",
    );

    assert.equal(updated, 0);
    assert.deepEqual(sql.queries[0]?.parameters[0], ids);
    assert.match(sql.queries[0]?.text ?? "", /lease_owner = \$2/u);
    assert.match(sql.queries[0]?.text ?? "", /lease_token = \$3/u);
  });

  it("requires valid positive claim limits", async () => {
    const repository = new PostgresOutboxRepository(new ScriptedSqlClient());
    await assert.rejects(
      repository.claim({
        owner: "publisher-a",
        limit: 0,
        leaseDurationMs: 1,
        maxAttempts: 1,
      }),
      /positive safe integer/,
    );
  });

  it("hashes caller-provided fields without delimiter collisions", async () => {
    const sql = new ScriptedSqlClient();
    sql.echoOutboxContentHash = true;
    const repository = new PostgresOutboxRepository(sql);
    const common = {
      id: "00000000-0000-4000-8000-000000000001",
      aggregateId: "same",
      payload: null,
      occurredAt: new Date("2026-07-12T10:00:00Z"),
    } as const;
    await repository.enqueue({
      ...common,
      topic: "a\nb",
      aggregateType: "c",
      dedupeKey: "one",
    });
    await repository.enqueue({
      ...common,
      id: "00000000-0000-4000-8000-000000000002",
      topic: "a",
      aggregateType: "b\nc",
      dedupeKey: "two",
    });
    assert.notEqual(sql.queries[0]?.parameters[5], sql.queries[1]?.parameters[5]);
  });
});
