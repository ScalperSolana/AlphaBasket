import type { SqlClient } from "../persistence/sql-client.js";
import type {
  BasketReconciliationObservation,
  ReconciliationSourcePort,
} from "./types.js";

export interface BasketAssetReconciliationProjection {
  readonly basketId: string;
  readonly ledgerAttributedPusdUnits: bigint;
  readonly walletAttributedPusdUnits: bigint;
  readonly ledgerSourceVersion: string;
  readonly walletSourceVersion: string;
  readonly observedAtMs: bigint;
}

export interface BasketAssetReconciliationWriterPort {
  upsert(projection: BasketAssetReconciliationProjection): Promise<void>;
}

interface ObservationRow extends Record<string, unknown> {
  basket_id: string;
  total_shares_units: string;
  protocol_fee_shares_units: string;
  position_share_sum_units: string;
  ledger_attributed_pusd_units: string;
  wallet_attributed_pusd_units: string;
  nav_gross_pusd_units: string;
  nav_observed_at_ms: string;
  oldest_pending_operation_at_ms: string | null;
}

const parse = (value: string, name: string): bigint => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`database returned invalid ${name}`);
  return BigInt(value);
};

export class PostgresReconciliationSource implements ReconciliationSourcePort, BasketAssetReconciliationWriterPort {
  public constructor(private readonly sql: SqlClient) {}

  public async listBasketIds(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new RangeError("reconciliation basket limit must be between 1 and 10000");
    const result = await this.sql.query<{ basket_id: string }>(
      `SELECT basket_id FROM basket_share_supply_projections
       ORDER BY basket_id LIMIT $1`,
      [limit],
    );
    return Object.freeze(result.rows.map((row) => row.basket_id));
  }

  public async observeBasket(basketId: string): Promise<BasketReconciliationObservation> {
    return this.sql.transaction(async (transaction) => {
      const result = await transaction.query<ObservationRow>(
        `SELECT supply.basket_id,
                supply.total_shares_units::text AS total_shares_units,
                supply.protocol_fee_shares_units::text AS protocol_fee_shares_units,
                COALESCE(position.position_share_sum_units, 0)::text AS position_share_sum_units,
                assets.ledger_attributed_pusd_units::text AS ledger_attributed_pusd_units,
                assets.wallet_attributed_pusd_units::text AS wallet_attributed_pusd_units,
                (nav.snapshot->>'grossNavPusdUnits')::text AS nav_gross_pusd_units,
                nav.observed_at_ms::text AS nav_observed_at_ms,
                operation.oldest_pending_operation_at_ms::text AS oldest_pending_operation_at_ms
         FROM basket_share_supply_projections AS supply
         JOIN basket_asset_reconciliation_projections AS assets
           ON assets.basket_id = supply.basket_id
         JOIN LATERAL (
           SELECT snapshot, observed_at_ms
           FROM nav_snapshots
           WHERE basket_id = supply.basket_id
           ORDER BY sequence DESC LIMIT 1
         ) AS nav ON true
         LEFT JOIN LATERAL (
           SELECT sum((account_data->>'sharesOwned')::numeric) AS position_share_sum_units
           FROM solana_account_projections
           WHERE account_kind = 'Position' AND is_active = true
             AND account_data->>'basket' = supply.basket_id
         ) AS position ON true
         LEFT JOIN LATERAL (
           SELECT floor(extract(epoch FROM min(created_at)) * 1000)::numeric AS oldest_pending_operation_at_ms
           FROM execution_operations
           WHERE basket = supply.basket_id AND state NOT IN ('completed', 'failed')
         ) AS operation ON true
         WHERE supply.basket_id = $1`,
        [basketId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`reconciliation inputs are incomplete for basket ${basketId}`);
      return Object.freeze({
        basketId: row.basket_id,
        onchainTotalSharesUnits: parse(row.total_shares_units, "total shares"),
        positionShareSumUnits: parse(row.position_share_sum_units, "position shares"),
        protocolFeeSharesUnits: parse(row.protocol_fee_shares_units, "protocol fee shares"),
        ledgerAttributedPusdUnits: parse(row.ledger_attributed_pusd_units, "ledger attribution"),
        walletAttributedPusdUnits: parse(row.wallet_attributed_pusd_units, "wallet attribution"),
        navGrossPusdUnits: parse(row.nav_gross_pusd_units, "NAV gross value"),
        navObservedAtMs: parse(row.nav_observed_at_ms, "NAV observed time"),
        oldestPendingOperationAtMs: row.oldest_pending_operation_at_ms === null
          ? null
          : parse(row.oldest_pending_operation_at_ms, "oldest operation time"),
      });
    }, { isolation: "repeatable read", readOnly: true });
  }

  public async upsert(projection: BasketAssetReconciliationProjection): Promise<void> {
    if (projection.ledgerAttributedPusdUnits < 0n || projection.walletAttributedPusdUnits < 0n || projection.observedAtMs < 0n) {
      throw new RangeError("asset reconciliation values must be non-negative");
    }
    await this.sql.query(
      `INSERT INTO basket_asset_reconciliation_projections (
         basket_id, ledger_attributed_pusd_units, wallet_attributed_pusd_units,
         ledger_source_version, wallet_source_version, observed_at_ms
       ) VALUES ($1, $2::numeric, $3::numeric, $4, $5, $6::numeric)
       ON CONFLICT (basket_id) DO UPDATE
       SET ledger_attributed_pusd_units = EXCLUDED.ledger_attributed_pusd_units,
           wallet_attributed_pusd_units = EXCLUDED.wallet_attributed_pusd_units,
           ledger_source_version = EXCLUDED.ledger_source_version,
           wallet_source_version = EXCLUDED.wallet_source_version,
           observed_at_ms = EXCLUDED.observed_at_ms,
           updated_at = now()
       WHERE basket_asset_reconciliation_projections.observed_at_ms < EXCLUDED.observed_at_ms
          OR (
            basket_asset_reconciliation_projections.observed_at_ms = EXCLUDED.observed_at_ms
            AND basket_asset_reconciliation_projections.ledger_source_version = EXCLUDED.ledger_source_version
            AND basket_asset_reconciliation_projections.wallet_source_version = EXCLUDED.wallet_source_version
          )`,
      [
        projection.basketId,
        projection.ledgerAttributedPusdUnits.toString(10),
        projection.walletAttributedPusdUnits.toString(10),
        projection.ledgerSourceVersion,
        projection.walletSourceVersion,
        projection.observedAtMs.toString(10),
      ],
    );
  }
}
