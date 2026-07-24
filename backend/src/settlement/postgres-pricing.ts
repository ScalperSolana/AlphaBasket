import type { PublicKey } from "@solana/web3.js";

import type { SqlClient } from "../persistence/sql-client.js";
import type { SettlementPricing, SettlementPricingPort } from "./types.js";

interface PricingRow extends Record<string, unknown> {
  snapshot_hash: string;
  observed_at_ms: string;
  basket_nav_value: string;
  share_price: string | null;
}

function integer(value: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`NAV snapshot contains invalid ${name}`);
  return BigInt(value);
}

export class PostgresSettlementPricing implements SettlementPricingPort {
  public constructor(private readonly sql: SqlClient) {}

  public async loadLatestPricing(basket: PublicKey): Promise<SettlementPricing> {
    const result = await this.sql.query<PricingRow>(
      `SELECT snapshot_hash,
              observed_at_ms::text AS observed_at_ms,
              snapshot->>'grossNavPusdUnits' AS basket_nav_value,
              snapshot->>'sharePriceUnits' AS share_price
       FROM nav_snapshots
       WHERE basket_id = $1
       ORDER BY sequence DESC
       LIMIT 1`,
      [basket.toBase58()],
    );
    const row = result.rows[0];
    if (row === undefined || row.share_price === null) throw new Error(`priced NAV snapshot not found for basket ${basket.toBase58()}`);
    if (!/^[0-9a-f]{64}$/u.test(row.snapshot_hash) || row.snapshot_hash === "0".repeat(64)) throw new TypeError("NAV snapshot hash is invalid");
    return Object.freeze({
      navReportHash: Buffer.from(row.snapshot_hash, "hex"),
      basketNavValue: integer(row.basket_nav_value, "gross NAV"),
      sharePrice: integer(row.share_price, "share price"),
      observedAtSeconds: integer(row.observed_at_ms, "observation time") / 1_000n,
    });
  }
}
