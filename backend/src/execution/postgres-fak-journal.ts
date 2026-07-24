import { randomUUID } from "node:crypto";

import type { SqlClient } from "../persistence/index.js";
import type {
  FakExecutionPort,
  FakOrderRequest,
  FakOrderResult,
} from "./types.js";

interface OrderRow extends Record<string, unknown> {
  client_order_id: string;
  order_id: string;
  token_id: string;
  side: "buy" | "sell";
  requested_amount: string;
  filled_input_amount: string;
  filled_output_amount: string;
  average_price: string | null;
  status: "matched" | "partially_filled" | "unfilled";
  transaction_hashes: unknown;
  trade_ids: unknown;
  executed_at_ms: string;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`stored FAK ${field} is malformed`);
  }
  return Object.freeze([...value] as string[]);
}

function mapOrder(row: OrderRow): FakOrderResult {
  return Object.freeze({
    clientOrderId: row.client_order_id,
    orderId: row.order_id,
    tokenId: row.token_id,
    side: row.side,
    requestedAmountUnits: BigInt(row.requested_amount),
    filledInputUnits: BigInt(row.filled_input_amount),
    filledOutputUnits: BigInt(row.filled_output_amount),
    averagePriceUnits: row.average_price === null ? null : BigInt(row.average_price),
    status: row.status,
    transactionHashes: stringArray(row.transaction_hashes, "transaction hashes"),
    tradeIds: stringArray(row.trade_ids, "trade IDs"),
    executedAtMs: BigInt(row.executed_at_ms),
  });
}

const columns = `client_order_id, order_id, token_id, side,
  requested_amount::text AS requested_amount,
  filled_input_amount::text AS filled_input_amount,
  filled_output_amount::text AS filled_output_amount,
  average_price::text AS average_price, status, transaction_hashes, trade_ids,
  floor(extract(epoch FROM executed_at) * 1000)::text AS executed_at_ms`;

function operationId(clientOrderId: string): string {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):/iu.exec(clientOrderId);
  if (match?.[1] === undefined) throw new TypeError("FAK client order ID must begin with its operation UUID");
  return match[1];
}

function sameRequest(request: FakOrderRequest, result: FakOrderResult): boolean {
  return request.clientOrderId === result.clientOrderId &&
    request.tokenId === result.tokenId &&
    request.side === result.side &&
    request.amountUnits === result.requestedAmountUnits;
}

/** Durable idempotency journal around the external CLOB side effect. */
export class PostgresFakExecutionJournal implements FakExecutionPort {
  public constructor(
    private readonly sql: SqlClient,
    private readonly inner: FakExecutionPort,
  ) {}

  public async executeFak(request: FakOrderRequest): Promise<FakOrderResult> {
    const existing = await this.load(request.clientOrderId);
    if (existing !== null) {
      if (!sameRequest(request, existing)) throw new Error("FAK client order ID was reused with different content");
      return existing;
    }
    const executed = await this.inner.executeFak(request);
    if (!sameRequest(request, executed)) throw new Error("FAK provider returned a result for a different request");
    const executedAt = Number(executed.executedAtMs);
    if (!Number.isSafeInteger(executedAt) || executedAt < 0) throw new RangeError("FAK execution time is invalid");
    await this.sql.query(
      `INSERT INTO clob_execution_orders (
         id, operation_id, client_order_id, order_id, token_id, side, order_type,
         requested_amount, filled_input_amount, filled_output_amount,
         average_price, status, transaction_hashes, trade_ids, executed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, 'FAK',
         $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11,
         $12::jsonb, $13::jsonb, $14
       ) ON CONFLICT (client_order_id) DO NOTHING`,
      [
        randomUUID(),
        operationId(request.clientOrderId),
        request.clientOrderId,
        executed.orderId,
        executed.tokenId,
        executed.side,
        executed.requestedAmountUnits.toString(10),
        executed.filledInputUnits.toString(10),
        executed.filledOutputUnits.toString(10),
        executed.averagePriceUnits?.toString(10) ?? null,
        executed.status,
        JSON.stringify(executed.transactionHashes),
        JSON.stringify(executed.tradeIds),
        new Date(executedAt),
      ],
    );
    const persisted = await this.load(request.clientOrderId);
    if (persisted === null || !sameRequest(request, persisted)) {
      throw new Error("FAK execution journal conflicts with the provider result");
    }
    return persisted;
  }

  private async load(clientOrderId: string): Promise<FakOrderResult | null> {
    const result = await this.sql.query<OrderRow>(
      `SELECT ${columns} FROM clob_execution_orders WHERE client_order_id = $1`,
      [clientOrderId],
    );
    return result.rows[0] === undefined ? null : mapOrder(result.rows[0]);
  }
}
