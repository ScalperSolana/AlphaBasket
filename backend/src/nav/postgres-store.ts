import type { SqlClient } from "../persistence/sql-client.js";
import type {
  BasketAttributedHolding,
  BasketAttributedHoldingsPort,
  BasketAttributedState,
  BasketShareSupply,
  BasketShareSupplyPort,
  BasketShareSupplyProjectionWriterPort,
  MarkCondition,
  NavSnapshot,
  NavSnapshotStorePort,
} from "./types.js";
import type {
  BasketHoldingMarkWriterPort,
  NavBasketRegistryPort,
} from "./mark-refresh-service.js";

interface PortfolioStateRow extends Record<string, unknown> {
  basket_id: string;
  ledger_version: string;
  composition_version: string;
  composition_hash: string;
  idle_pusd_units: string;
  idle_usdc_units: string;
}

interface HoldingRow extends Record<string, unknown> {
  market_id: string;
  token_id: string;
  condition_id: string | null;
  negative_risk: boolean | null;
  outcome: string;
  quantity_units: string;
  mark_price_units: string;
  price_scale: string;
  mark_observed_at_ms: string;
  mark_source_hash: string;
  mark_condition: MarkCondition;
  asset_kind: "prediction_market" | "spot";
  token_decimals: number | null;
}

interface SupplyRow extends Record<string, unknown> {
  total_shares_units: string;
  protocol_fee_shares_units: string;
  last_management_fee_at_seconds: string;
  management_fee_accrual_remainder: string;
  source_slot: string;
  source_version: string;
}

interface SequenceRow extends Record<string, unknown> {
  sequence: string;
}

interface HashRow extends Record<string, unknown> {
  snapshot_hash: string;
}

const parseInteger = (value: string, field: string): bigint => {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`database returned invalid ${field}`);
  }
  return BigInt(value);
};

const snapshotJson = (snapshot: NavSnapshot): string =>
  JSON.stringify({
    ...snapshot,
    compositionVersion: snapshot.compositionVersion.toString(10),
    shareSupplySourceSlot: snapshot.shareSupplySourceSlot.toString(10),
    sequence: snapshot.sequence.toString(10),
    observedAtMs: snapshot.observedAtMs.toString(10),
    idlePusdUnits: snapshot.idlePusdUnits.toString(10),
    idleUsdcUnits: (snapshot.idleUsdcUnits ?? 0n).toString(10),
    positionValuePusdUnits: snapshot.positionValuePusdUnits.toString(10),
    grossNavPusdUnits: snapshot.grossNavPusdUnits.toString(10),
    onchainTotalSharesUnits: snapshot.onchainTotalSharesUnits.toString(10),
    totalSharesUnits: snapshot.totalSharesUnits.toString(10),
    projectedManagementFeeSharesUnits:
      snapshot.projectedManagementFeeSharesUnits.toString(10),
    managementFeeAccrualThroughSeconds:
      snapshot.managementFeeAccrualThroughSeconds.toString(10),
    sharePriceUnits: snapshot.sharePriceUnits?.toString(10) ?? null,
    sharePriceScale: snapshot.sharePriceScale.toString(10),
    holdings: snapshot.holdings.map((holding) => ({
      ...holding,
      quantityUnits: holding.quantityUnits.toString(10),
      markPriceUnits: holding.markPriceUnits.toString(10),
      priceScale: holding.priceScale.toString(10),
      valuePusdUnits: holding.valuePusdUnits.toString(10),
      markObservedAtMs: holding.markObservedAtMs.toString(10),
    })),
  });

export class PostgresBasketAttributedHoldings
  implements BasketAttributedHoldingsPort
{
  public constructor(private readonly sql: SqlClient) {}

  public loadBasketState(basketId: string): Promise<BasketAttributedState> {
    return this.sql.transaction(
      async (transaction) => {
        const stateResult = await transaction.query<PortfolioStateRow>(
          `SELECT basket_id, ledger_version,
                  composition_version::text AS composition_version,
                  composition_hash, idle_pusd_units::text AS idle_pusd_units,
                  idle_usdc_units::text AS idle_usdc_units
           FROM basket_portfolio_states WHERE basket_id = $1`,
          [basketId],
        );
        const state = stateResult.rows[0];
        if (state === undefined) {
          throw new Error(`portfolio state not found for basket ${basketId}`);
        }
        const holdingResult = await transaction.query<HoldingRow>(
          `SELECT market_id, token_id, condition_id, negative_risk, outcome,
                  asset_kind, token_decimals,
                  quantity_units::text AS quantity_units,
                  mark_price_units::text AS mark_price_units,
                  price_scale::text AS price_scale,
                  mark_observed_at_ms::text AS mark_observed_at_ms,
                  mark_source_hash, mark_condition
           FROM basket_holding_projections
           WHERE basket_id = $1
           ORDER BY market_id, token_id, outcome`,
          [basketId],
        );
        const holdings: BasketAttributedHolding[] = holdingResult.rows.map(
          (row) =>
            Object.freeze({
              marketId: row.market_id,
              tokenId: row.token_id,
              assetKind: row.asset_kind,
              ...(row.token_decimals === null ? {} : { tokenDecimals: row.token_decimals }),
              ...(row.condition_id === null ? {} : { conditionId: row.condition_id }),
              ...(row.negative_risk === null ? {} : { negativeRisk: row.negative_risk }),
              outcome: row.outcome,
              quantityUnits: parseInteger(row.quantity_units, "quantity_units"),
              markPriceUnits: parseInteger(row.mark_price_units, "mark_price_units"),
              priceScale: parseInteger(row.price_scale, "price_scale"),
              markObservedAtMs: parseInteger(
                row.mark_observed_at_ms,
                "mark_observed_at_ms",
              ),
              markSourceHash: row.mark_source_hash,
              markCondition: row.mark_condition,
            }),
        );
        return Object.freeze({
          basketId: state.basket_id,
          ledgerVersion: state.ledger_version,
          compositionVersion: parseInteger(
            state.composition_version,
            "composition_version",
          ),
          compositionHash: state.composition_hash,
          idlePusdUnits: parseInteger(state.idle_pusd_units, "idle_pusd_units"),
          idleUsdcUnits: parseInteger(state.idle_usdc_units, "idle_usdc_units"),
          holdings: Object.freeze(holdings),
        });
      },
      { isolation: "repeatable read", readOnly: true },
    );
  }
}

export class PostgresBasketShareSupply
  implements BasketShareSupplyPort, BasketShareSupplyProjectionWriterPort
{
  public constructor(private readonly sql: SqlClient) {}

  public async loadShareSupply(basketId: string): Promise<BasketShareSupply> {
    const result = await this.sql.query<SupplyRow>(
      `SELECT total_shares_units::text AS total_shares_units,
              protocol_fee_shares_units::text AS protocol_fee_shares_units,
              last_management_fee_at_seconds::text AS last_management_fee_at_seconds,
              management_fee_accrual_remainder::text AS management_fee_accrual_remainder,
              source_slot::text AS source_slot, source_version
       FROM basket_share_supply_projections WHERE basket_id = $1`,
      [basketId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`share supply projection not found for basket ${basketId}`);
    }
    return Object.freeze({
      totalSharesUnits: parseInteger(row.total_shares_units, "total_shares_units"),
      protocolFeeSharesUnits: parseInteger(
        row.protocol_fee_shares_units,
        "protocol_fee_shares_units",
      ),
      lastManagementFeeAtSeconds: parseInteger(
        row.last_management_fee_at_seconds,
        "last_management_fee_at_seconds",
      ),
      managementFeeAccrualRemainder: parseInteger(
        row.management_fee_accrual_remainder,
        "management_fee_accrual_remainder",
      ),
      sourceSlot: parseInteger(row.source_slot, "source_slot"),
      sourceVersion: row.source_version,
    });
  }

  public async upsertShareSupply(
    basketId: string,
    supply: BasketShareSupply,
  ): Promise<void> {
    const values = [
      supply.totalSharesUnits,
      supply.protocolFeeSharesUnits,
      supply.lastManagementFeeAtSeconds,
      supply.managementFeeAccrualRemainder,
      supply.sourceSlot,
    ];
    if (values.some((value) => value < 0n)) {
      throw new RangeError("share-supply projection values must be non-negative");
    }
    if (supply.protocolFeeSharesUnits > supply.totalSharesUnits) {
      throw new RangeError("protocol fee shares cannot exceed total shares");
    }
    const result = await this.sql.query(
      `INSERT INTO basket_share_supply_projections (
         basket_id, total_shares_units, protocol_fee_shares_units,
         last_management_fee_at_seconds, management_fee_accrual_remainder,
         source_slot, source_version
       ) VALUES (
         $1, $2::numeric, $3::numeric, $4::numeric, $5::numeric,
         $6::numeric, $7
       )
       ON CONFLICT (basket_id) DO UPDATE
       SET total_shares_units = EXCLUDED.total_shares_units,
           protocol_fee_shares_units = EXCLUDED.protocol_fee_shares_units,
           last_management_fee_at_seconds = EXCLUDED.last_management_fee_at_seconds,
           management_fee_accrual_remainder = EXCLUDED.management_fee_accrual_remainder,
           source_slot = EXCLUDED.source_slot,
           source_version = EXCLUDED.source_version,
           updated_at = now()
       WHERE basket_share_supply_projections.source_slot < EXCLUDED.source_slot
          OR (
            basket_share_supply_projections.source_slot = EXCLUDED.source_slot
            AND basket_share_supply_projections.source_version = EXCLUDED.source_version
          )`,
      [
        basketId,
        supply.totalSharesUnits.toString(10),
        supply.protocolFeeSharesUnits.toString(10),
        supply.lastManagementFeeAtSeconds.toString(10),
        supply.managementFeeAccrualRemainder.toString(10),
        supply.sourceSlot.toString(10),
        supply.sourceVersion,
      ],
    );
    if (result.rowCount === 0) {
      const current = await this.loadShareSupply(basketId);
      if (
        current.sourceSlot === supply.sourceSlot &&
        (current.sourceVersion !== supply.sourceVersion ||
          current.totalSharesUnits !== supply.totalSharesUnits ||
          current.protocolFeeSharesUnits !== supply.protocolFeeSharesUnits ||
          current.lastManagementFeeAtSeconds !==
            supply.lastManagementFeeAtSeconds ||
          current.managementFeeAccrualRemainder !==
            supply.managementFeeAccrualRemainder)
      ) {
        throw new Error(`conflicting share-supply projection for ${basketId}`);
      }
    }
  }
}

export class PostgresNavSnapshotStore implements NavSnapshotStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async nextSequence(basketId: string): Promise<bigint> {
    const result = await this.sql.query<SequenceRow>(
      `INSERT INTO nav_sequence_counters (basket_id, next_sequence)
       VALUES ($1, 1)
       ON CONFLICT (basket_id) DO UPDATE
       SET next_sequence = nav_sequence_counters.next_sequence + 1
       RETURNING next_sequence::text AS sequence`,
      [basketId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("failed to allocate NAV sequence");
    return parseInteger(row.sequence, "NAV sequence");
  }

  public async append(snapshot: NavSnapshot): Promise<void> {
    const inserted = await this.sql.query(
      `INSERT INTO nav_snapshots (
         basket_id, sequence, snapshot_hash, observed_at_ms, snapshot
       ) VALUES ($1, $2::numeric, $3, $4::numeric, $5::jsonb)
       ON CONFLICT (basket_id, sequence) DO NOTHING`,
      [
        snapshot.basketId,
        snapshot.sequence.toString(10),
        snapshot.hash,
        snapshot.observedAtMs.toString(10),
        snapshotJson(snapshot),
      ],
    );
    if (inserted.rowCount === 1) return;
    const existing = await this.sql.query<HashRow>(
      `SELECT snapshot_hash FROM nav_snapshots
       WHERE basket_id = $1 AND sequence = $2::numeric`,
      [snapshot.basketId, snapshot.sequence.toString(10)],
    );
    if (existing.rows[0]?.snapshot_hash !== snapshot.hash) {
      throw new Error(
        `conflicting NAV snapshot at ${snapshot.basketId}/${snapshot.sequence.toString()}`,
      );
    }
  }
}

export class PostgresNavBasketRegistry implements NavBasketRegistryPort {
  public constructor(private readonly sql: SqlClient) {}

  public async listBasketIds(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("NAV basket scan limit must be between 1 and 10000");
    }
    const result = await this.sql.query<{ basket_id: string }>(
      `SELECT p.basket_id
       FROM basket_portfolio_states p
       JOIN basket_share_supply_projections s ON s.basket_id = p.basket_id
       ORDER BY p.basket_id
       LIMIT $1`,
      [limit],
    );
    return Object.freeze(result.rows.map((row) => row.basket_id));
  }
}

export class PostgresBasketHoldingMarkWriter
  implements BasketHoldingMarkWriterPort
{
  public constructor(private readonly sql: SqlClient) {}

  public async updateMarks(
    basketId: string,
    marks: readonly Readonly<{
      marketId: string;
      tokenId: string;
      outcome: string;
      priceUnits: bigint;
      priceScale: bigint;
      observedAtMs: bigint;
      sourceHash: string;
      condition: MarkCondition;
      assetKind?: "prediction_market" | "spot";
    }>[],
    now: Date,
  ): Promise<void> {
    await this.sql.transaction(async (transaction) => {
      for (const mark of marks) {
        if (
          mark.priceUnits < 0n ||
          mark.priceScale <= 0n ||
          (mark.assetKind !== "spot" && mark.priceUnits > mark.priceScale) ||
          mark.observedAtMs < 0n
        ) {
          throw new RangeError("CLOB mark is outside its fixed-point bounds");
        }
        const result = await transaction.query(
          `UPDATE basket_holding_projections
           SET mark_price_units = $5::numeric,
               price_scale = $6::numeric,
               mark_observed_at_ms = $7::numeric,
               mark_source_hash = $8,
               mark_condition = $9,
               updated_at = $10
           WHERE basket_id = $1 AND market_id = $2
             AND token_id = $3 AND outcome = $4`,
          [
            basketId,
            mark.marketId,
            mark.tokenId,
            mark.outcome,
            mark.priceUnits.toString(10),
            mark.priceScale.toString(10),
            mark.observedAtMs.toString(10),
            mark.sourceHash,
            mark.condition,
            now,
          ],
        );
        if (result.rowCount !== 1) {
          throw new Error(`attributed holding disappeared while refreshing ${mark.tokenId}`);
        }
      }
    }, { isolation: "repeatable read" });
  }
}
