import type { BasketAttributedHolding } from "../nav/types.js";
import type { JsonValue } from "../persistence/outbox.js";
import type { SqlClient } from "../persistence/sql-client.js";

export type LifecycleExternalExecutionKind = "reconstitution" | "resolution";

export interface LifecycleExternalExecutionStorePort {
  prepare(request: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly kind: LifecycleExternalExecutionKind;
    readonly basketId: string;
    readonly now: Date;
  }): Promise<JsonValue | null>;
  loadPlan(operationId: string, requestHash: string): Promise<JsonValue | null>;
  putPlan(request: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly plan: JsonValue;
    readonly now: Date;
  }): Promise<JsonValue>;
  commit(request: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly basketId: string;
    readonly expectedLedgerVersion: string;
    readonly nextCompositionVersion: bigint;
    readonly nextCompositionHash: string;
    readonly idlePusdUnits: bigint;
    readonly holdings: readonly BasketAttributedHolding[];
    readonly result: JsonValue;
    readonly now: Date;
  }): Promise<JsonValue>;
}

interface ExecutionRow extends Record<string, unknown> {
  request_hash: string;
  kind: LifecycleExternalExecutionKind;
  basket_id: string;
  state: "prepared" | "completed";
  plan: JsonValue | null;
  result: JsonValue | null;
}

interface PortfolioRow extends Record<string, unknown> {
  ledger_version: string;
}

function validateIdentity(operationId: string, requestHash: string, basketId: string): void {
  if (operationId.length === 0 || operationId.length > 256 || basketId.length === 0 || basketId.length > 128) {
    throw new RangeError("invalid lifecycle execution identifiers");
  }
  if (!/^[0-9a-f]{64}$/u.test(requestHash)) throw new TypeError("lifecycle execution request hash must be lowercase hex32");
}

function validateHolding(holding: BasketAttributedHolding): void {
  if (holding.quantityUnits < 0n || holding.markPriceUnits < 0n || holding.priceScale <= 0n || holding.markObservedAtMs < 0n) {
    throw new RangeError("portfolio holding values are invalid");
  }
  if (holding.conditionId !== undefined && !/^0x[0-9a-f]{64}$/u.test(holding.conditionId)) {
    throw new TypeError("portfolio condition ID must be canonical lowercase bytes32");
  }
  if ((holding.conditionId === undefined) !== (holding.negativeRisk === undefined)) {
    throw new TypeError("portfolio condition ID and negative-risk flag must be present together");
  }
}

export class PostgresLifecycleExternalExecutionStore implements LifecycleExternalExecutionStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async prepare(request: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly kind: LifecycleExternalExecutionKind;
    readonly basketId: string;
    readonly now: Date;
  }): Promise<JsonValue | null> {
    validateIdentity(request.operationId, request.requestHash, request.basketId);
    const result = await this.sql.query<ExecutionRow>(
      `INSERT INTO lifecycle_external_executions (
         operation_id, request_hash, kind, basket_id, state, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'prepared', $5, $5)
       ON CONFLICT (operation_id) DO UPDATE
       SET operation_id = lifecycle_external_executions.operation_id
       RETURNING request_hash, kind, basket_id, state, plan, result`,
      [request.operationId, request.requestHash, request.kind, request.basketId, request.now],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("failed to prepare lifecycle external execution");
    if (row.request_hash !== request.requestHash || row.kind !== request.kind || row.basket_id !== request.basketId) {
      throw new Error("lifecycle external operation ID was reused with different content");
    }
    return row.state === "completed" ? row.result : null;
  }

  public async loadPlan(operationId: string, requestHash: string): Promise<JsonValue | null> {
    if (operationId.length === 0 || operationId.length > 256 || !/^[0-9a-f]{64}$/u.test(requestHash)) {
      throw new TypeError("invalid lifecycle execution plan identity");
    }
    const result = await this.sql.query<ExecutionRow>(
      `SELECT request_hash, kind, basket_id, state, plan, result
       FROM lifecycle_external_executions WHERE operation_id = $1`,
      [operationId],
    );
    const row = result.rows[0];
    if (row === undefined || row.request_hash !== requestHash) throw new Error("lifecycle execution plan identity mismatch");
    return row.plan;
  }

  public async putPlan(request: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly plan: JsonValue;
    readonly now: Date;
  }): Promise<JsonValue> {
    const encoded = JSON.stringify(request.plan);
    if (encoded === undefined || encoded.length === 0 || encoded.length > 1_000_000) throw new RangeError("invalid lifecycle execution plan");
    const result = await this.sql.query<ExecutionRow>(
      `UPDATE lifecycle_external_executions
       SET plan = COALESCE(plan, $3::jsonb), updated_at = $4
       WHERE operation_id = $1 AND request_hash = $2 AND state = 'prepared'
       RETURNING request_hash, kind, basket_id, state, plan, result`,
      [request.operationId, request.requestHash, encoded, request.now],
    );
    const plan = result.rows[0]?.plan;
    if (plan === null || plan === undefined) throw new Error("failed to persist lifecycle execution plan");
    return plan;
  }

  public commit(request: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly basketId: string;
    readonly expectedLedgerVersion: string;
    readonly nextCompositionVersion: bigint;
    readonly nextCompositionHash: string;
    readonly idlePusdUnits: bigint;
    readonly holdings: readonly BasketAttributedHolding[];
    readonly result: JsonValue;
    readonly now: Date;
  }): Promise<JsonValue> {
    validateIdentity(request.operationId, request.requestHash, request.basketId);
    if (request.expectedLedgerVersion.length === 0 || request.expectedLedgerVersion.length > 256) throw new RangeError("invalid expected ledger version");
    if (request.nextCompositionVersion < 0n || request.idlePusdUnits < 0n || !/^[0-9a-f]{64}$/u.test(request.nextCompositionHash)) {
      throw new RangeError("invalid next portfolio state");
    }
    request.holdings.forEach(validateHolding);
    const duplicateKeys = new Set<string>();
    for (const holding of request.holdings) {
      const key = `${holding.marketId}\u0000${holding.tokenId}\u0000${holding.outcome}`;
      if (duplicateKeys.has(key)) throw new Error("next portfolio contains a duplicate holding");
      duplicateKeys.add(key);
    }
    const encodedResult = JSON.stringify(request.result);
    if (encodedResult === undefined || encodedResult.length > 1_000_000) throw new RangeError("invalid lifecycle execution result");

    return this.sql.transaction(async (transaction) => {
      const execution = await transaction.query<ExecutionRow>(
        `SELECT request_hash, kind, basket_id, state, plan, result
         FROM lifecycle_external_executions
         WHERE operation_id = $1 FOR UPDATE`,
        [request.operationId],
      );
      const executionRow = execution.rows[0];
      if (executionRow === undefined) throw new Error("lifecycle external execution was not prepared");
      if (executionRow.request_hash !== request.requestHash || executionRow.basket_id !== request.basketId) {
        throw new Error("lifecycle external execution identity mismatch");
      }
      if (executionRow.state === "completed") {
        if (executionRow.result === null) throw new Error("completed lifecycle execution is missing its result");
        return executionRow.result;
      }
      const portfolio = await transaction.query<PortfolioRow>(
        `SELECT ledger_version FROM basket_portfolio_states WHERE basket_id = $1 FOR UPDATE`,
        [request.basketId],
      );
      const state = portfolio.rows[0];
      if (state === undefined) throw new Error(`portfolio state not found for basket ${request.basketId}`);
      if (state.ledger_version !== request.expectedLedgerVersion) {
        throw new Error("portfolio ledger version changed during lifecycle execution");
      }
      const nextLedgerVersion = `lifecycle:${request.requestHash}`;
      await transaction.query(
        `UPDATE basket_portfolio_states
         SET ledger_version = $2, composition_version = $3::numeric,
             composition_hash = $4, idle_pusd_units = $5::numeric, updated_at = $6
         WHERE basket_id = $1`,
        [
          request.basketId,
          nextLedgerVersion,
          request.nextCompositionVersion.toString(10),
          request.nextCompositionHash,
          request.idlePusdUnits.toString(10),
          request.now,
        ],
      );
      await transaction.query("DELETE FROM basket_holding_projections WHERE basket_id = $1", [request.basketId]);
      for (const holding of request.holdings) {
        if (holding.quantityUnits === 0n) continue;
        await transaction.query(
          `INSERT INTO basket_holding_projections (
             basket_id, market_id, token_id, condition_id, negative_risk, outcome,
             quantity_units, mark_price_units, price_scale, mark_observed_at_ms,
             mark_source_hash, mark_condition, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric,
             $9::numeric, $10::numeric, $11, $12, $13
           )`,
          [
            request.basketId,
            holding.marketId,
            holding.tokenId,
            holding.conditionId ?? null,
            holding.negativeRisk ?? null,
            holding.outcome,
            holding.quantityUnits.toString(10),
            holding.markPriceUnits.toString(10),
            holding.priceScale.toString(10),
            holding.markObservedAtMs.toString(10),
            holding.markSourceHash,
            holding.markCondition,
            request.now,
          ],
        );
      }
      const completed = await transaction.query<ExecutionRow>(
        `UPDATE lifecycle_external_executions
         SET state = 'completed', result = $3::jsonb,
             updated_at = $4, completed_at = $4
         WHERE operation_id = $1 AND request_hash = $2 AND state = 'prepared'
         RETURNING request_hash, kind, basket_id, state, plan, result`,
        [request.operationId, request.requestHash, encodedResult, request.now],
      );
      const row = completed.rows[0];
      if (row?.result === null || row?.result === undefined) throw new Error("failed to commit lifecycle external execution");
      return row.result;
    }, { isolation: "serializable", maxSerializationRetries: 3 });
  }
}
