import { DataSource } from 'typeorm';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AdvisoryLockTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Timed out waiting for advisory lock for ${operation} after ${timeoutMs}ms`);
    this.name = 'AdvisoryLockTimeoutError';
  }
}

/**
 * Acquire a transaction-level Postgres advisory lock without letting waiters
 * occupy pooled DB connections. Transaction-level locks are released by
 * Postgres automatically on commit/rollback or connection termination, so a
 * wedged Node request cannot leave a session-level lock behind for hours.
 */
export async function withAdvisoryLock<T>(
  dataSource: DataSource,
  [key1, key2]: [number, number],
  operation: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number; idleTimeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? Math.max(timeoutMs + 30_000, 120_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const qr = dataSource.createQueryRunner();
    let transactionStarted = false;

    try {
      await qr.connect();
      await qr.startTransaction();
      transactionStarted = true;
      await qr.query(`SET LOCAL idle_in_transaction_session_timeout = '${idleTimeoutMs}ms'`);

      const rows: Array<{ acquired: boolean }> = await qr.query(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
        [key1, key2],
      );

      if (rows[0]?.acquired) {
        try {
          const result = await fn();
          await qr.commitTransaction();
          transactionStarted = false;
          return result;
        } finally {
          if (transactionStarted) {
            await qr.rollbackTransaction();
            transactionStarted = false;
          }
        }
      }

      await qr.rollbackTransaction();
      transactionStarted = false;
    } finally {
      if (transactionStarted) {
        await qr.rollbackTransaction().catch(() => undefined);
      }
      await qr.release();
    }

    await sleep(retryMs);
  }

  throw new AdvisoryLockTimeoutError(operation, timeoutMs);
}
