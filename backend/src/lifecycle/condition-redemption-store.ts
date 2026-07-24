import type { SqlClient } from "../persistence/sql-client.js";

export interface ConditionRedemptionPreparation {
  readonly walletAddress: string;
  readonly conditionId: string;
  readonly requestHash: string;
  readonly negativeRisk: boolean;
  readonly winningTokenId: string;
  readonly walletPayoutUnits: bigint;
  readonly walletBalanceBeforeUnits: bigint;
}

export interface ConditionRedemptionResult {
  readonly walletAddress: string;
  readonly conditionId: string;
  readonly negativeRisk: boolean;
  readonly winningTokenId: string;
  readonly walletPayoutUnits: bigint;
  readonly relayerTransactionId: string;
  readonly polygonTransactionHash: string;
}

export type ConditionRedemptionRecord =
  | (ConditionRedemptionPreparation & { readonly state: "prepared" })
  | (ConditionRedemptionPreparation & ConditionRedemptionResult & { readonly state: "completed" });

export interface ConditionRedemptionStorePort {
  load(request: {
    readonly walletAddress: string;
    readonly conditionId: string;
  }): Promise<ConditionRedemptionRecord | null>;
  prepare(request: ConditionRedemptionPreparation & { readonly now: Date }): Promise<ConditionRedemptionRecord>;
  complete(request: ConditionRedemptionResult & {
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<ConditionRedemptionResult>;
}

interface RedemptionRow extends Record<string, unknown> {
  wallet_address: string;
  condition_id: string;
  request_hash: string;
  negative_risk: boolean;
  state: "prepared" | "completed";
  winning_token_id: string;
  wallet_payout_units: string;
  wallet_balance_before_units: string;
  relayer_transaction_id: string | null;
  polygon_transaction_hash: string | null;
}

const columns = `wallet_address, condition_id, request_hash, negative_risk, state,
  winning_token_id, wallet_payout_units::text AS wallet_payout_units,
  wallet_balance_before_units::text AS wallet_balance_before_units,
  relayer_transaction_id, polygon_transaction_hash`;

function validateIdentity(walletAddress: string, conditionId: string, requestHash?: string): void {
  if (!/^0x[0-9a-f]{40}$/u.test(walletAddress) || !/^0x[0-9a-f]{64}$/u.test(conditionId) ||
      (requestHash !== undefined && !/^[0-9a-f]{64}$/u.test(requestHash))) {
    throw new TypeError("invalid condition-redemption identity");
  }
}

function mapRecord(row: RedemptionRow): ConditionRedemptionRecord {
  const prepared: ConditionRedemptionPreparation = {
    walletAddress: row.wallet_address,
    conditionId: row.condition_id,
    requestHash: row.request_hash,
    negativeRisk: row.negative_risk,
    winningTokenId: row.winning_token_id,
    walletPayoutUnits: BigInt(row.wallet_payout_units),
    walletBalanceBeforeUnits: BigInt(row.wallet_balance_before_units),
  };
  if (row.state === "prepared") return Object.freeze({ ...prepared, state: "prepared" });
  if (row.relayer_transaction_id === null || row.polygon_transaction_hash === null) {
    throw new Error("completed condition redemption is missing transaction references");
  }
  return Object.freeze({
    ...prepared,
    state: "completed",
    relayerTransactionId: row.relayer_transaction_id,
    polygonTransactionHash: row.polygon_transaction_hash,
  });
}

function completedResult(record: Extract<ConditionRedemptionRecord, { readonly state: "completed" }>): ConditionRedemptionResult {
  return Object.freeze({
    walletAddress: record.walletAddress,
    conditionId: record.conditionId,
    negativeRisk: record.negativeRisk,
    winningTokenId: record.winningTokenId,
    walletPayoutUnits: record.walletPayoutUnits,
    relayerTransactionId: record.relayerTransactionId,
    polygonTransactionHash: record.polygonTransactionHash,
  });
}

export class PostgresConditionRedemptionStore implements ConditionRedemptionStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async load(request: {
    readonly walletAddress: string;
    readonly conditionId: string;
  }): Promise<ConditionRedemptionRecord | null> {
    const wallet = request.walletAddress.toLowerCase();
    const condition = request.conditionId.toLowerCase();
    validateIdentity(wallet, condition);
    const result = await this.sql.query<RedemptionRow>(
      `SELECT ${columns} FROM polymarket_condition_redemptions
       WHERE wallet_address = $1 AND condition_id = $2`,
      [wallet, condition],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRecord(row);
  }

  public async prepare(request: ConditionRedemptionPreparation & { readonly now: Date }): Promise<ConditionRedemptionRecord> {
    const wallet = request.walletAddress.toLowerCase();
    const condition = request.conditionId.toLowerCase();
    validateIdentity(wallet, condition, request.requestHash);
    if (request.walletPayoutUnits < 0n || request.walletBalanceBeforeUnits < 0n || !/^(?:0|[1-9][0-9]*)$/u.test(request.winningTokenId)) {
      throw new TypeError("invalid condition-redemption preparation");
    }
    const result = await this.sql.query<RedemptionRow>(
      `INSERT INTO polymarket_condition_redemptions (
         wallet_address, condition_id, request_hash, negative_risk, state,
         winning_token_id, wallet_payout_units, wallet_balance_before_units,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'prepared', $5, $6::numeric, $7::numeric, $8, $8)
       ON CONFLICT (wallet_address, condition_id) DO UPDATE
       SET wallet_address = polymarket_condition_redemptions.wallet_address
       RETURNING ${columns}`,
      [
        wallet,
        condition,
        request.requestHash,
        request.negativeRisk,
        request.winningTokenId,
        request.walletPayoutUnits.toString(10),
        request.walletBalanceBeforeUnits.toString(10),
        request.now,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("failed to prepare condition redemption");
    const record = mapRecord(row);
    if (
      record.requestHash !== request.requestHash ||
      record.negativeRisk !== request.negativeRisk ||
      record.winningTokenId !== request.winningTokenId ||
      record.walletPayoutUnits !== request.walletPayoutUnits ||
      record.walletBalanceBeforeUnits !== request.walletBalanceBeforeUnits
    ) {
      throw new Error("condition redemption identity was reused with different metadata");
    }
    return record;
  }

  public async complete(request: ConditionRedemptionResult & {
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<ConditionRedemptionResult> {
    const wallet = request.walletAddress.toLowerCase();
    const condition = request.conditionId.toLowerCase();
    validateIdentity(wallet, condition, request.requestHash);
    if (request.walletPayoutUnits < 0n || !/^(?:0|[1-9][0-9]*)$/u.test(request.winningTokenId) ||
        !/^0x[0-9a-f]{64}$/u.test(request.polygonTransactionHash)) {
      throw new TypeError("invalid completed condition redemption");
    }
    const result = await this.sql.query<RedemptionRow>(
      `UPDATE polymarket_condition_redemptions
       SET state = 'completed', relayer_transaction_id = $7,
           polygon_transaction_hash = $8, updated_at = $9, completed_at = $9
       WHERE wallet_address = $1 AND condition_id = $2
         AND request_hash = $3 AND negative_risk = $4 AND state = 'prepared'
         AND winning_token_id = $5 AND wallet_payout_units = $6::numeric
       RETURNING ${columns}`,
      [
        wallet,
        condition,
        request.requestHash,
        request.negativeRisk,
        request.winningTokenId,
        request.walletPayoutUnits.toString(10),
        request.relayerTransactionId,
        request.polygonTransactionHash,
        request.now,
      ],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      const record = mapRecord(row);
      if (record.state !== "completed") throw new Error("condition redemption did not complete");
      return completedResult(record);
    }
    const existing = await this.load({ walletAddress: wallet, conditionId: condition });
    if (existing === null || existing.state !== "completed") throw new Error("condition redemption completion conflict");
    const completed = completedResult(existing);
    if (existing.requestHash !== request.requestHash || completed.negativeRisk !== request.negativeRisk ||
        completed.winningTokenId !== request.winningTokenId || completed.walletPayoutUnits !== request.walletPayoutUnits ||
        completed.relayerTransactionId !== request.relayerTransactionId || completed.polygonTransactionHash !== request.polygonTransactionHash) {
      throw new Error("condition redemption replay result differs from the stored result");
    }
    return completed;
  }
}
