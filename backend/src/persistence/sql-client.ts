export type SqlParameter =
  | string
  | number
  | boolean
  | bigint
  | Date
  | Uint8Array
  | readonly string[]
  | null;

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown>>(
    text: string,
    parameters?: readonly SqlParameter[],
  ): Promise<SqlQueryResult<Row>>;
}

export type TransactionIsolation =
  | "read committed"
  | "repeatable read"
  | "serializable";

export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
  readonly readOnly?: boolean;
  /** Whole-transaction retries for PostgreSQL 40001/40P01 failures. */
  readonly maxSerializationRetries?: number;
}

export interface SqlClient extends SqlExecutor {
  transaction<Result>(
    operation: (transaction: SqlExecutor) => Promise<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;
}

export class UnexpectedRowCountError extends Error {
  public constructor(
    public readonly operation: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`${operation}: expected ${expected} row(s), received ${actual}`);
    this.name = "UnexpectedRowCountError";
  }
}

export function exactlyOne<Row>(
  result: SqlQueryResult<Row>,
  operation: string,
): Row {
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new UnexpectedRowCountError(operation, 1, result.rowCount);
  }

  return result.rows[0] as Row;
}
