import type { SqlClient } from "../persistence/index.js";
import type { PredictMarketLink, PredictMarketLinkStorePort } from "./types.js";

interface LinkRow extends Record<string, unknown> {
  token_id: string;
  condition_id: string | null;
  jupiter_market_id: string;
  is_yes: boolean;
  source: "operator" | "market_probe" | "catalog";
}

export class PostgresPredictMarketLinkStore implements PredictMarketLinkStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async load(tokenId: string): Promise<PredictMarketLink | null> {
    const result = await this.sql.query<LinkRow>(
      `SELECT token_id, condition_id, jupiter_market_id, is_yes, source
       FROM predict_market_links WHERE token_id = $1`,
      [tokenId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return Object.freeze({
      tokenId: row.token_id,
      conditionId: row.condition_id,
      jupiterMarketId: row.jupiter_market_id,
      isYes: row.is_yes,
      source: row.source,
    });
  }

  public async save(link: PredictMarketLink): Promise<void> {
    // Operator rows outrank derived ones and are never overwritten by a probe
    // or catalog scan; derived rows refresh only when the mapping changed.
    await this.sql.query(
      `INSERT INTO predict_market_links (
         token_id, condition_id, jupiter_market_id, is_yes, source, updated_at
       ) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (token_id) DO UPDATE SET
         condition_id = EXCLUDED.condition_id,
         jupiter_market_id = EXCLUDED.jupiter_market_id,
         is_yes = EXCLUDED.is_yes,
         source = EXCLUDED.source,
         updated_at = now()
       WHERE predict_market_links.source <> 'operator'
         AND (predict_market_links.jupiter_market_id <> EXCLUDED.jupiter_market_id
              OR predict_market_links.is_yes <> EXCLUDED.is_yes
              OR predict_market_links.condition_id IS DISTINCT FROM EXCLUDED.condition_id)`,
      [link.tokenId, link.conditionId, link.jupiterMarketId, link.isYes, link.source],
    );
  }
}
