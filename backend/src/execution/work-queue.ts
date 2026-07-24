import type { SqlClient } from "../persistence/index.js";
import { PublicKey } from "@solana/web3.js";
import type {
  SignedDepositIntent,
  SignedWithdrawalIntent,
} from "../quotes/index.js";
import {
  deserializeDepositQuote,
  deserializeWithdrawalQuote,
} from "../server/application-service.js";
import type { ExecutionKind } from "./types.js";

export interface ExecutionWorkRequest {
  readonly operationId: string;
  readonly requestKey: string;
  readonly workflowId: string;
  readonly kind: "deposit" | "withdrawal";
  readonly walletId: string;
  readonly polymarketWallet: string;
  readonly fundingAddress: string | null;
  readonly fundingTransactionSignature: string | null;
  readonly intent: SignedDepositIntent | SignedWithdrawalIntent;
}

export interface ClaimedExecutionWork {
  readonly operationId: string;
  readonly workflowId: string;
  readonly kind: "deposit" | "withdrawal";
  readonly claimToken: string;
}

export interface ExecutionWorkQueuePort {
  claimReady(request: {
    readonly ownerId: string;
    readonly limit: number;
    readonly leaseDurationMs: number;
    readonly now: Date;
  }): Promise<readonly ClaimedExecutionWork[]>;
  markDispatched(
    operationId: string,
    claimToken: string,
    temporalRunId: string | null,
    now: Date,
  ): Promise<void>;
  releaseClaim(
    operationId: string,
    claimToken: string,
    error: string,
    retryAt: Date,
    now: Date,
  ): Promise<void>;
  markCompleted(operationId: string, now: Date): Promise<void>;
  loadRequest(operationId: string): Promise<ExecutionWorkRequest>;
}

export interface ExecutionOperationRunnerPort {
  run(request: ExecutionWorkRequest): Promise<Readonly<{
    operationId: string;
    kind: "deposit" | "withdrawal";
    executionBatchHash: string;
    settlementTransaction: string;
  }>>;
}

interface ClaimRow extends Record<string, unknown> {
  operation_id: string;
  workflow_id: string;
  kind: "deposit" | "withdrawal";
  claim_token: string;
}

interface RequestRow extends Record<string, unknown> {
  operation_id: string;
  request_key: string;
  workflow_id: string;
  kind: "deposit" | "withdrawal";
  wallet_id: string;
  polymarket_wallet: string;
  funding_address: string | null;
  funding_transaction_signature: string | null;
  withdrawal_destination: string | null;
  payload: unknown;
  intent_nonce: string;
  intent_hash: string;
  encoded_message: Uint8Array;
  signature: Uint8Array;
  signer_public_key: Uint8Array;
}

function boundedError(error: string): string {
  return error.length <= 4_096 ? error : error.slice(0, 4_096);
}

export class PostgresExecutionWorkQueue implements ExecutionWorkQueuePort {
  public constructor(private readonly sql: SqlClient) {}

  public async claimReady(request: {
    readonly ownerId: string;
    readonly limit: number;
    readonly leaseDurationMs: number;
    readonly now: Date;
  }): Promise<readonly ClaimedExecutionWork[]> {
    if (request.ownerId.length === 0 || request.ownerId.length > 256) throw new RangeError("dispatch owner ID is invalid");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) throw new RangeError("dispatch limit is invalid");
    if (!Number.isSafeInteger(request.leaseDurationMs) || request.leaseDurationMs < 5_000 || request.leaseDurationMs > 600_000) {
      throw new RangeError("dispatch lease duration must be between 5 seconds and 10 minutes");
    }
    const result = await this.sql.query<ClaimRow>(
      `WITH ready AS (
         SELECT w.operation_id
         FROM execution_work_items w
         JOIN execution_operations o ON o.id = w.operation_id
         WHERE (
             (w.state = 'pending' AND w.next_attempt_at <= $1)
             OR (w.state = 'claimed' AND w.claim_expires_at <= $1)
           )
           AND o.state NOT IN ('completed', 'failed')
         ORDER BY w.next_attempt_at, w.operation_id
         FOR UPDATE OF w SKIP LOCKED
         LIMIT $2
       )
       UPDATE execution_work_items w
       SET state = 'claimed',
           claim_token = gen_random_uuid(),
           claim_owner = $3,
           claim_expires_at = $1 + ($4::bigint * interval '1 millisecond'),
           dispatch_attempts = dispatch_attempts + 1,
           updated_at = $1
       FROM ready, execution_operations o
       WHERE w.operation_id = ready.operation_id AND o.id = w.operation_id
       RETURNING w.operation_id::text AS operation_id,
                 o.workflow_id, o.kind, w.claim_token::text AS claim_token`,
      [request.now, request.limit, request.ownerId, request.leaseDurationMs],
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      operationId: row.operation_id,
      workflowId: row.workflow_id,
      kind: row.kind,
      claimToken: row.claim_token,
    })));
  }

  public async markDispatched(
    operationId: string,
    claimToken: string,
    temporalRunId: string | null,
    now: Date,
  ): Promise<void> {
    const result = await this.sql.query(
      `UPDATE execution_work_items
       SET state = 'dispatched', temporal_run_id = COALESCE($3, temporal_run_id),
           claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL,
           last_error = NULL, updated_at = $4
       WHERE operation_id = $1::uuid AND state = 'claimed'
         AND claim_token = $2::uuid`,
      [operationId, claimToken, temporalRunId, now],
    );
    if (result.rowCount !== 1) throw new Error("execution dispatch claim was lost");
  }

  public async releaseClaim(
    operationId: string,
    claimToken: string,
    error: string,
    retryAt: Date,
    now: Date,
  ): Promise<void> {
    if (retryAt.getTime() < now.getTime()) throw new RangeError("dispatch retry time cannot be in the past");
    const result = await this.sql.query(
      `UPDATE execution_work_items
       SET state = 'pending', next_attempt_at = $3,
           claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL,
           last_error = $4, updated_at = $5
       WHERE operation_id = $1::uuid AND state = 'claimed'
         AND claim_token = $2::uuid`,
      [operationId, claimToken, retryAt, boundedError(error), now],
    );
    if (result.rowCount !== 1) throw new Error("execution dispatch claim was lost");
  }

  public async markCompleted(operationId: string, now: Date): Promise<void> {
    const result = await this.sql.query(
      `UPDATE execution_work_items
       SET state = 'completed', completed_at = $2, updated_at = $2,
           claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL,
           last_error = NULL
       WHERE operation_id = $1::uuid AND state <> 'completed'`,
      [operationId, now],
    );
    if (result.rowCount === 0) {
      const existing = await this.sql.query<{ state: string }>(
        "SELECT state FROM execution_work_items WHERE operation_id = $1::uuid",
        [operationId],
      );
      if (existing.rows[0]?.state !== "completed") throw new Error("execution work item was not found");
    }
  }

  public async loadRequest(operationId: string): Promise<ExecutionWorkRequest> {
    const result = await this.sql.query<RequestRow>(
      `SELECT o.id::text AS operation_id, o.request_key, o.workflow_id, o.kind,
              w.wallet_id, w.polymarket_wallet, w.funding_address,
              w.funding_transaction_signature, w.withdrawal_destination,
              q.payload, i.intent_nonce::text AS intent_nonce, i.intent_hash,
              i.encoded_message, i.signature, i.signer_public_key
       FROM execution_operations o
       JOIN execution_work_items w ON w.operation_id = o.id
       JOIN financial_quotes q ON q.operation_id = o.id
       JOIN signed_intents i ON i.operation_id = o.id
       WHERE o.id = $1::uuid`,
      [operationId],
    );
    const row = result.rows[0];
    if (row === undefined || (row.kind !== "deposit" && row.kind !== "withdrawal")) {
      throw new Error(`executable work item ${operationId} was not found`);
    }
    const nonce = BigInt(row.intent_nonce);
    const intentHash = Buffer.from(row.intent_hash, "hex");
    const encodedMessage = Buffer.from(row.encoded_message);
    const signature = Uint8Array.from(row.signature);
    if (intentHash.byteLength !== 32 || signature.byteLength !== 64) throw new TypeError("stored intent cryptography is malformed");
    let intent: SignedDepositIntent | SignedWithdrawalIntent;
    if (row.kind === "deposit") {
      const quote = deserializeDepositQuote(row.payload);
      if (!Buffer.from(row.signer_public_key).equals(quote.user.toBuffer())) throw new Error("stored deposit signer does not match quote user");
      intent = Object.freeze({
        kind: "deposit",
        quote,
        nonce,
        encodedMessage,
        intentHash,
        signature,
      });
      if (row.funding_address === null || row.funding_transaction_signature === null) {
        throw new Error("deposit work item is not funded");
      }
    } else {
      const quote = deserializeWithdrawalQuote(row.payload);
      if (!Buffer.from(row.signer_public_key).equals(quote.user.toBuffer())) throw new Error("stored withdrawal signer does not match quote user");
      if (row.withdrawal_destination === null) throw new Error("withdrawal work item is missing its destination");
      intent = Object.freeze({
        kind: "withdrawal",
        quote,
        nonce,
        destination: new PublicKey(row.withdrawal_destination),
        encodedMessage,
        intentHash,
        signature,
      });
    }
    return Object.freeze({
      operationId: row.operation_id,
      requestKey: row.request_key,
      workflowId: row.workflow_id,
      kind: row.kind,
      walletId: row.wallet_id,
      polymarketWallet: row.polymarket_wallet,
      fundingAddress: row.funding_address,
      fundingTransactionSignature: row.funding_transaction_signature,
      intent,
    });
  }
}

export function executableKind(kind: ExecutionKind): kind is "deposit" | "withdrawal" {
  return kind === "deposit" || kind === "withdrawal";
}
