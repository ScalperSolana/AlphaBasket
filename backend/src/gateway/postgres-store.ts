import type { SqlClient } from "../persistence/index.js";
import type {
  GatewayRequestKind,
  GatewayRequestStorePort,
  PreparedGatewayRequest,
} from "./types.js";

interface GatewayRow extends Record<string, unknown> {
  request_key: string;
  request_kind: GatewayRequestKind;
  request_hash: string;
  signed_payload: Buffer;
  transaction_reference: string | null;
  state: "prepared" | "submitted" | "finalized";
  result: Readonly<Record<string, unknown>> | null;
}

function mapRow(row: GatewayRow): PreparedGatewayRequest {
  return Object.freeze({
    requestKey: row.request_key,
    requestKind: row.request_kind,
    requestHash: row.request_hash,
    signedPayload: Uint8Array.from(row.signed_payload),
    transactionReference: row.transaction_reference,
    state: row.state,
    result: row.result === null ? null : Object.freeze({ ...row.result }),
  });
}

const selection = `request_key, request_kind, request_hash, signed_payload,
  transaction_reference, state, result`;

export class PostgresGatewayRequestStore implements GatewayRequestStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async prepare(request: {
    readonly requestKey: string;
    readonly requestKind: GatewayRequestKind;
    readonly requestHash: string;
    readonly build: () => Promise<{
      readonly signedPayload: Uint8Array;
      readonly transactionReference?: string;
    }>;
    readonly now: Date;
  }): Promise<PreparedGatewayRequest> {
    return this.sql.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 1196442695))",
        [request.requestKey],
      );
      const existing = await transaction.query<GatewayRow>(
        `SELECT ${selection} FROM execution_gateway_requests WHERE request_key = $1`,
        [request.requestKey],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (
          replay.request_kind !== request.requestKind ||
          replay.request_hash !== request.requestHash
        ) {
          throw new Error("execution gateway request key was reused with different content");
        }
        return mapRow(replay);
      }
      const built = await request.build();
      if (built.signedPayload.byteLength === 0 || built.signedPayload.byteLength > 262_144) {
        throw new RangeError("execution gateway signed payload has an invalid size");
      }
      const inserted = await transaction.query<GatewayRow>(
        `INSERT INTO execution_gateway_requests (
           request_key, request_kind, request_hash, signed_payload,
           transaction_reference, state, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'prepared', $6, $6)
         RETURNING ${selection}`,
        [
          request.requestKey,
          request.requestKind,
          request.requestHash,
          Buffer.from(built.signedPayload),
          built.transactionReference ?? null,
          request.now,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("execution gateway request disappeared after insert");
      return mapRow(row);
    }, { isolation: "serializable" });
  }

  public async markSubmitted(
    requestKey: string,
    transactionReference: string,
    now: Date,
  ): Promise<void> {
    const result = await this.sql.query(
      `UPDATE execution_gateway_requests
       SET state = CASE WHEN state = 'prepared' THEN 'submitted' ELSE state END,
           transaction_reference = COALESCE(transaction_reference, $2),
           updated_at = $3
       WHERE request_key = $1
         AND state IN ('prepared', 'submitted', 'finalized')
         AND (transaction_reference IS NULL OR transaction_reference = $2)`,
      [requestKey, transactionReference, now],
    );
    if (result.rowCount !== 1) throw new Error("execution gateway submission journal conflict");
  }

  public async markFinalized(
    requestKey: string,
    transactionReference: string,
    resultValue: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void> {
    const result = await this.sql.query(
      `UPDATE execution_gateway_requests
       SET state = 'finalized', transaction_reference = $2, result = $3::jsonb,
           updated_at = $4, finalized_at = $4
       WHERE request_key = $1
         AND state IN ('prepared', 'submitted', 'finalized')
         AND (transaction_reference IS NULL OR transaction_reference = $2)
         AND (result IS NULL OR result = $3::jsonb)`,
      [requestKey, transactionReference, JSON.stringify(resultValue), now],
    );
    if (result.rowCount !== 1) throw new Error("execution gateway finalization journal conflict");
  }

  public async findFinalizedByTransactionReference(
    requestKind: GatewayRequestKind,
    transactionReference: string,
  ): Promise<PreparedGatewayRequest | null> {
    const result = await this.sql.query<GatewayRow>(
      `SELECT ${selection} FROM execution_gateway_requests
       WHERE request_kind = $1 AND transaction_reference = $2
         AND state = 'finalized'`,
      [requestKind, transactionReference],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  }

  public async claimCapitalSources(request: {
    readonly requestKey: string;
    readonly requestHash: string;
    readonly sources: readonly Readonly<{
      kind: "bridge_receipt" | "jupiter_swap";
      reference: string;
      amountUnits: bigint;
    }>[];
    readonly now: Date;
  }): Promise<void> {
    if (
      request.requestKey.length === 0 ||
      request.requestKey.length > 256 ||
      !/^[0-9a-f]{64}$/u.test(request.requestHash)
    ) {
      throw new TypeError("capital source claim identity is invalid");
    }
    const seen = new Set<string>();
    await this.sql.transaction(async (transaction) => {
      for (const source of request.sources) {
        const key = `${source.kind}\u0000${source.reference}`;
        if (
          source.reference.length === 0 ||
          source.reference.length > 256 ||
          source.amountUnits <= 0n ||
          seen.has(key)
        ) {
          throw new TypeError("capital source claim is malformed or duplicated");
        }
        seen.add(key);
        await transaction.query(
          `INSERT INTO execution_gateway_capital_source_claims (
             source_kind, source_reference, request_key, request_hash,
             amount_units, created_at
           ) VALUES ($1, $2, $3, $4, $5::numeric, $6)
           ON CONFLICT (source_kind, source_reference) DO NOTHING`,
          [
            source.kind,
            source.reference,
            request.requestKey,
            request.requestHash,
            source.amountUnits.toString(10),
            request.now,
          ],
        );
        const claimed = await transaction.query<{
          request_key: string;
          request_hash: string;
          amount_units: string;
        }>(
          `SELECT request_key, request_hash,
                  amount_units::text AS amount_units
           FROM execution_gateway_capital_source_claims
           WHERE source_kind = $1 AND source_reference = $2`,
          [source.kind, source.reference],
        );
        const row = claimed.rows[0];
        if (
          row === undefined ||
          row.request_key !== request.requestKey ||
          row.request_hash !== request.requestHash ||
          BigInt(row.amount_units) !== source.amountUnits
        ) {
          throw new Error("capital source was already claimed by another split");
        }
      }
    }, { isolation: "serializable" });
  }
}
