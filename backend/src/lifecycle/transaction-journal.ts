import { randomUUID } from "node:crypto";

import type { SqlClient } from "../persistence/sql-client.js";

export type LifecycleSubmissionOperationState = "pending" | "finalized" | "failed";
export type LifecycleSubmissionAttemptState =
  | "signed"
  | "submitted"
  | "expired"
  | "finalized"
  | "rejected";

export interface LifecycleSubmissionOperation {
  readonly id: string;
  readonly operationKey: string;
  readonly batchHash: string;
  readonly state: LifecycleSubmissionOperationState;
  readonly finalizedSignature?: string;
  readonly finalizedSlot?: bigint;
  readonly lastError?: string;
  readonly version: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LifecycleSubmissionAttempt {
  readonly operationId: string;
  readonly attemptNumber: number;
  readonly state: LifecycleSubmissionAttemptState;
  readonly transactionSignature: string;
  readonly serializedTransaction: Uint8Array;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly submittedAt?: Date;
  readonly finalizedAt?: Date;
  readonly lastError?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LifecycleTransactionJournalPort {
  createOrLoad(operationKey: string, batchHash: string, now: Date): Promise<LifecycleSubmissionOperation>;
  latestAttempt(operationId: string): Promise<LifecycleSubmissionAttempt | null>;
  appendSignedAttempt(request: {
    readonly operationId: string;
    readonly expectedOperationVersion: bigint;
    readonly transactionSignature: string;
    readonly serializedTransaction: Uint8Array;
    readonly recentBlockhash: string;
    readonly lastValidBlockHeight: bigint;
    readonly now: Date;
  }): Promise<LifecycleSubmissionAttempt>;
  markSubmitted(operationId: string, attemptNumber: number, now: Date): Promise<LifecycleSubmissionAttempt>;
  markExpired(operationId: string, attemptNumber: number, error: string, now: Date): Promise<void>;
  markFinalized(
    operationId: string,
    attemptNumber: number,
    signature: string,
    slot: bigint,
    now: Date,
  ): Promise<LifecycleSubmissionOperation>;
  markRejected(operationId: string, attemptNumber: number, error: string, now: Date): Promise<void>;
}

interface OperationRow extends Record<string, unknown> {
  id: string;
  operation_key: string;
  batch_hash: string;
  state: LifecycleSubmissionOperationState;
  finalized_signature: string | null;
  finalized_slot: string | null;
  last_error: string | null;
  version: string;
  created_at: Date;
  updated_at: Date;
}

interface AttemptRow extends Record<string, unknown> {
  operation_id: string;
  attempt_number: number;
  state: LifecycleSubmissionAttemptState;
  transaction_signature: string;
  serialized_transaction: Buffer;
  recent_blockhash: string;
  last_valid_block_height: string;
  submitted_at: Date | null;
  finalized_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const operationColumns = `id, operation_key, batch_hash, state, finalized_signature,
  finalized_slot::text AS finalized_slot, last_error, version::text AS version,
  created_at, updated_at`;

const attemptColumns = `operation_id, attempt_number, state, transaction_signature,
  serialized_transaction, recent_blockhash,
  last_valid_block_height::text AS last_valid_block_height,
  submitted_at, finalized_at, last_error, created_at, updated_at`;

const optional = <Key extends string, Value>(key: Key, value: Value | null): { readonly [K in Key]?: Value } =>
  value === null ? {} : { [key]: value } as { readonly [K in Key]?: Value };

const mapOperation = (row: OperationRow): LifecycleSubmissionOperation => Object.freeze({
  id: row.id,
  operationKey: row.operation_key,
  batchHash: row.batch_hash,
  state: row.state,
  ...optional("finalizedSignature", row.finalized_signature),
  ...optional("finalizedSlot", row.finalized_slot === null ? null : BigInt(row.finalized_slot)),
  ...optional("lastError", row.last_error),
  version: BigInt(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAttempt = (row: AttemptRow): LifecycleSubmissionAttempt => Object.freeze({
  operationId: row.operation_id,
  attemptNumber: row.attempt_number,
  state: row.state,
  transactionSignature: row.transaction_signature,
  serializedTransaction: Uint8Array.from(row.serialized_transaction),
  recentBlockhash: row.recent_blockhash,
  lastValidBlockHeight: BigInt(row.last_valid_block_height),
  ...optional("submittedAt", row.submitted_at),
  ...optional("finalizedAt", row.finalized_at),
  ...optional("lastError", row.last_error),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class PostgresLifecycleTransactionJournal implements LifecycleTransactionJournalPort {
  public constructor(private readonly sql: SqlClient) {}

  public async createOrLoad(operationKey: string, batchHash: string, now: Date): Promise<LifecycleSubmissionOperation> {
    if (operationKey.length === 0 || operationKey.length > 256 || !/^[0-9a-f]{64}$/u.test(batchHash)) {
      throw new TypeError("invalid lifecycle operation key or batch hash");
    }
    const id = randomUUID();
    const inserted = await this.sql.query<OperationRow>(
      `INSERT INTO solana_lifecycle_operations (
         id, operation_key, batch_hash, state, created_at, updated_at
       ) VALUES ($1, $2, $3, 'pending', $4, $4)
       ON CONFLICT (operation_key) DO NOTHING
       RETURNING ${operationColumns}`,
      [id, operationKey, batchHash, now],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return mapOperation(created);
    const loaded = await this.sql.query<OperationRow>(
      `SELECT ${operationColumns} FROM solana_lifecycle_operations WHERE operation_key = $1`,
      [operationKey],
    );
    const row = loaded.rows[0];
    if (row === undefined) throw new Error("lifecycle transaction operation disappeared after insert");
    if (row.batch_hash !== batchHash) throw new Error("lifecycle operation key was reused for a different instruction batch");
    return mapOperation(row);
  }

  public async latestAttempt(operationId: string): Promise<LifecycleSubmissionAttempt | null> {
    const result = await this.sql.query<AttemptRow>(
      `SELECT ${attemptColumns}
       FROM solana_lifecycle_submission_attempts
       WHERE operation_id = $1
       ORDER BY attempt_number DESC LIMIT 1`,
      [operationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAttempt(row);
  }

  public appendSignedAttempt(request: {
    readonly operationId: string;
    readonly expectedOperationVersion: bigint;
    readonly transactionSignature: string;
    readonly serializedTransaction: Uint8Array;
    readonly recentBlockhash: string;
    readonly lastValidBlockHeight: bigint;
    readonly now: Date;
  }): Promise<LifecycleSubmissionAttempt> {
    if (request.serializedTransaction.byteLength === 0 || request.serializedTransaction.byteLength > 1_232) {
      throw new RangeError("serialized Solana transaction must contain 1-1232 bytes");
    }
    if (request.lastValidBlockHeight < 0n) throw new RangeError("last valid block height cannot be negative");
    return this.sql.transaction(async (transaction) => {
      const updated = await transaction.query<OperationRow>(
        `UPDATE solana_lifecycle_operations
         SET version = version + 1, updated_at = $3
         WHERE id = $1 AND state = 'pending' AND version = $2::bigint
         RETURNING ${operationColumns}`,
        [request.operationId, request.expectedOperationVersion.toString(10), request.now],
      );
      if (updated.rows[0] === undefined) throw new Error("lifecycle transaction operation version conflict");
      const sequence = await transaction.query<{ attempt_number: number }>(
        `SELECT COALESCE(max(attempt_number), 0) + 1 AS attempt_number
         FROM solana_lifecycle_submission_attempts WHERE operation_id = $1`,
        [request.operationId],
      );
      const attemptNumber = sequence.rows[0]?.attempt_number;
      if (attemptNumber === undefined || attemptNumber > 32) throw new Error("lifecycle transaction retry limit exceeded");
      const inserted = await transaction.query<AttemptRow>(
        `INSERT INTO solana_lifecycle_submission_attempts (
           operation_id, attempt_number, state, transaction_signature,
           serialized_transaction, recent_blockhash, last_valid_block_height,
           created_at, updated_at
         ) VALUES ($1, $2, 'signed', $3, $4, $5, $6::numeric, $7, $7)
         RETURNING ${attemptColumns}`,
        [
          request.operationId,
          attemptNumber,
          request.transactionSignature,
          Buffer.from(request.serializedTransaction),
          request.recentBlockhash,
          request.lastValidBlockHeight.toString(10),
          request.now,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("failed to persist signed lifecycle transaction");
      return mapAttempt(row);
    }, { isolation: "serializable" });
  }

  public async markSubmitted(operationId: string, attemptNumber: number, now: Date): Promise<LifecycleSubmissionAttempt> {
    const result = await this.sql.query<AttemptRow>(
      `UPDATE solana_lifecycle_submission_attempts
       SET state = CASE WHEN state = 'signed' THEN 'submitted' ELSE state END,
           submitted_at = COALESCE(submitted_at, $3), updated_at = $3
       WHERE operation_id = $1 AND attempt_number = $2
         AND state IN ('signed', 'submitted', 'finalized')
       RETURNING ${attemptColumns}`,
      [operationId, attemptNumber, now],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("cannot mark lifecycle transaction attempt submitted");
    return mapAttempt(row);
  }

  public async markExpired(operationId: string, attemptNumber: number, error: string, now: Date): Promise<void> {
    const result = await this.sql.query(
      `UPDATE solana_lifecycle_submission_attempts
       SET state = 'expired', last_error = $3, updated_at = $4
       WHERE operation_id = $1 AND attempt_number = $2 AND state IN ('signed', 'submitted')`,
      [operationId, attemptNumber, error.slice(0, 2_048), now],
    );
    if (result.rowCount !== 1) throw new Error("cannot expire lifecycle transaction attempt");
  }

  public markFinalized(
    operationId: string,
    attemptNumber: number,
    signature: string,
    slot: bigint,
    now: Date,
  ): Promise<LifecycleSubmissionOperation> {
    return this.sql.transaction(async (transaction) => {
      const attempt = await transaction.query(
        `UPDATE solana_lifecycle_submission_attempts
         SET state = 'finalized', submitted_at = COALESCE(submitted_at, $4),
             finalized_at = $4, updated_at = $4, last_error = NULL
         WHERE operation_id = $1 AND attempt_number = $2
           AND transaction_signature = $3
           AND state IN ('signed', 'submitted', 'finalized')`,
        [operationId, attemptNumber, signature, now],
      );
      if (attempt.rowCount !== 1) throw new Error("cannot finalize lifecycle transaction attempt");
      const operation = await transaction.query<OperationRow>(
        `UPDATE solana_lifecycle_operations
         SET state = 'finalized', finalized_signature = $2,
             finalized_slot = $3::numeric, completed_at = $4,
             updated_at = $4, last_error = NULL, version = version + 1
         WHERE id = $1 AND state IN ('pending', 'finalized')
         RETURNING ${operationColumns}`,
        [operationId, signature, slot.toString(10), now],
      );
      const row = operation.rows[0];
      if (row === undefined) throw new Error("cannot finalize lifecycle transaction operation");
      return mapOperation(row);
    }, { isolation: "serializable" });
  }

  public async markRejected(operationId: string, attemptNumber: number, error: string, now: Date): Promise<void> {
    await this.sql.transaction(async (transaction) => {
      const reason = error.slice(0, 2_048);
      const attempt = await transaction.query(
        `UPDATE solana_lifecycle_submission_attempts
         SET state = 'rejected', submitted_at = COALESCE(submitted_at, $3),
             last_error = $4, updated_at = $3
         WHERE operation_id = $1 AND attempt_number = $2
           AND state IN ('signed', 'submitted')`,
        [operationId, attemptNumber, now, reason],
      );
      if (attempt.rowCount !== 1) throw new Error("cannot reject lifecycle transaction attempt");
      const operation = await transaction.query(
        `UPDATE solana_lifecycle_operations
         SET state = 'failed', last_error = $2, updated_at = $3,
             version = version + 1
         WHERE id = $1 AND state = 'pending'`,
        [operationId, reason, now],
      );
      if (operation.rowCount !== 1) throw new Error("cannot reject lifecycle transaction operation");
    }, { isolation: "serializable" });
  }
}
