import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  SqlClient,
  SqlExecutor,
  SqlParameter,
  SqlQueryResult,
  TransactionOptions,
} from "./sql-client.js";

function normalizeParameters(
  parameters: readonly SqlParameter[] | undefined,
): unknown[] | undefined {
  return parameters?.map((value) =>
    typeof value === "bigint" ? value.toString(10) : value,
  );
}

class PgExecutor implements SqlExecutor {
  public constructor(private readonly client: Pool | PoolClient) {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
    parameters?: readonly SqlParameter[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query<QueryResultRow>(
      text,
      normalizeParameters(parameters),
    );

    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? 0,
    };
  }
}

export class PgSqlClient implements SqlClient {
  private readonly executor: PgExecutor;

  public constructor(private readonly pool: Pool) {
    this.executor = new PgExecutor(pool);
  }

  public query<Row extends Record<string, unknown>>(
    text: string,
    parameters?: readonly SqlParameter[],
  ): Promise<SqlQueryResult<Row>> {
    return this.executor.query<Row>(text, parameters);
  }

  public async transaction<Result>(
    operation: (transaction: SqlExecutor) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    const retries =
      options.maxSerializationRetries ??
      (options.isolation === "serializable" ? 3 : 0);
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) {
      throw new RangeError("maxSerializationRetries must be an integer from 0 to 10");
    }

    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        if (options.isolation !== undefined) {
          const isolation = options.isolation.toUpperCase();
          await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        }

        if (options.readOnly === true) {
          await client.query("SET TRANSACTION READ ONLY");
        }

        const result = await operation(new PgExecutor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        let rollbackError: unknown;
        try {
          await client.query("ROLLBACK");
        } catch (caught) {
          rollbackError = caught;
        }
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        const retryable = code === "40001" || code === "40P01";
        if (!retryable || attempt >= retries || rollbackError !== undefined) {
          if (
            error instanceof Error &&
            rollbackError instanceof Error
          ) {
            error.cause = rollbackError;
          }
          throw error;
        }
      } finally {
        client.release();
      }
    }
  }
}
