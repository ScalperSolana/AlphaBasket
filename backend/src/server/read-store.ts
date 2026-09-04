/**
 * Read-side queries for the product surface.
 *
 * Everything here is derived from projections the indexer and NAV worker
 * already maintain: `solana_account_projections` for on-chain accounts and
 * `nav_snapshots` for valuation. Nothing here reads Solana directly, so a slow
 * or rate-limited RPC cannot stall a page load, and nothing here writes.
 *
 * The write path deliberately has no equivalent. Discovery, valuation and
 * portfolio are the only things a browser needs that the quote/intent/operation
 * endpoints did not already cover.
 */

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { SqlClient } from "../persistence/index.js";

const integerText = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const indexedInteger = z.union([
  integerText,
  z.number().int().safe().transform((value) => value.toString(10)),
]);

/**
 * A basket item as the indexer projected it.
 *
 * All three position kinds are accepted. An earlier version of this schema
 * listed only `predictionMarket` and `spot`, which meant a basket holding a
 * perpetual failed validation and disappeared from every read path rather than
 * erroring visibly.
 */
const basketItemSchema = z
  .object({
    marketId: z.string(),
    weightBps: indexedInteger,
    // No `.passthrough()` on the three variants themselves: an index signature
    // of `unknown` would stop `"perp" in kind` from discriminating the union,
    // and every field access below would widen back to `unknown`. The payloads
    // stay permissive.
    kind: z.union([
      z.object({
        predictionMarket: z.object({ outcome: indexedInteger }).passthrough(),
      }),
      z.object({
        spot: z.object({ tokenMint: z.string() }).passthrough(),
      }),
      z.object({
        perp: z
          .object({
            direction: z.unknown(),
            leverageBps: indexedInteger,
            entryMarkPrice: indexedInteger,
            marginPosted: indexedInteger,
            phoenixSubaccount: indexedInteger,
          })
          .passthrough(),
      }),
    ]),
  })
  .passthrough();

const basketProjectionSchema = z
  .object({
    basketId: z.unknown(),
    creator: z.string().optional(),
    status: z.unknown(),
    compositionVersion: indexedInteger,
    compositionHash: z.unknown(),
    performanceFeeBps: indexedInteger,
    isPerpetual: z.boolean(),
    totalSharesOutstanding: integerText,
    hasInitializedSharePrice: z.boolean(),
    createdAt: indexedInteger.optional(),
    updatedAt: indexedInteger.optional(),
    items: z.array(basketItemSchema).min(1).max(16),
  })
  .passthrough();

const positionProjectionSchema = z
  .object({
    owner: z.string(),
    basket: z.string(),
    sharesOwned: integerText,
    costBasisValue: integerText,
    weightedDepositTimestamp: integerText,
  })
  .passthrough();

const navSnapshotSchema = z
  .object({
    grossNavPusdUnits: integerText,
    sharePriceUnits: integerText.nullable(),
  })
  .passthrough();

/** Which venue a composition item trades on. */
export type IndexAssetKind = "prediction_market" | "spot" | "perp";

export interface IndexAssetView {
  readonly marketId: string;
  readonly kind: IndexAssetKind;
  readonly weightBps: number;
  /** Present only for perpetuals. */
  readonly perp?: {
    readonly direction: "long" | "short";
    readonly leverageBps: number;
    readonly entryMarkPrice: string;
    readonly marginPosted: string;
    readonly phoenixSubaccount: number;
  };
  /** Present only for spot. */
  readonly tokenMint?: string;
  /** Present only for prediction markets. */
  readonly outcome?: number;
}

export interface IndexSummaryView {
  readonly address: string;
  readonly basketId: string;
  readonly status: string;
  readonly isPerpetual: boolean;
  readonly compositionVersion: number;
  readonly performanceFeeBps: number;
  readonly totalSharesOutstanding: string;
  /** Null until the first deposit prices the basket. */
  readonly sharePriceUnits: string | null;
  readonly grossNavUnits: string | null;
  readonly assetKinds: readonly IndexAssetKind[];
  readonly itemCount: number;
  readonly updatedAt: string | null;
}

export interface IndexDetailView extends IndexSummaryView {
  readonly items: readonly IndexAssetView[];
  readonly holderCount: number;
}

export interface PortfolioHoldingView {
  readonly basketAddress: string;
  readonly basketId: string;
  readonly sharesOwned: string;
  readonly costBasisValue: string;
  /** Null when the basket has no priced NAV yet. */
  readonly currentValueUnits: string | null;
  readonly sharePriceUnits: string | null;
  readonly assetKinds: readonly IndexAssetKind[];
}

const statusName = (status: unknown): string => {
  if (typeof status === "string") return status;
  if (typeof status === "object" && status !== null) {
    const [key] = Object.keys(status as Record<string, unknown>);
    if (key) return key;
  }
  return "unknown";
};

const directionName = (direction: unknown): "long" | "short" =>
  typeof direction === "object" &&
  direction !== null &&
  "short" in (direction as Record<string, unknown>)
    ? "short"
    : "long";

const hexOrText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((byte) => Number(byte).toString(16).padStart(2, "0"))
      .join("");
  }
  return "";
};

const toAssetView = (
  item: z.infer<typeof basketItemSchema>,
): IndexAssetView => {
  const weightBps = Number(item.weightBps);
  if ("perp" in item.kind) {
    const perp = item.kind.perp;
    return {
      marketId: item.marketId,
      kind: "perp",
      weightBps,
      perp: {
        direction: directionName(perp.direction),
        leverageBps: Number(perp.leverageBps),
        entryMarkPrice: String(perp.entryMarkPrice),
        marginPosted: String(perp.marginPosted),
        phoenixSubaccount: Number(perp.phoenixSubaccount),
      },
    };
  }
  if ("spot" in item.kind) {
    return {
      marketId: item.marketId,
      kind: "spot",
      weightBps,
      tokenMint: String(item.kind.spot.tokenMint),
    };
  }
  return {
    marketId: item.marketId,
    kind: "prediction_market",
    weightBps,
    outcome: Number(item.kind.predictionMarket.outcome),
  };
};

const distinctKinds = (
  items: readonly IndexAssetView[],
): readonly IndexAssetKind[] => [...new Set(items.map((item) => item.kind))];

interface ProjectionRow extends Record<string, unknown> {
  address: string;
  account_data: unknown;
  updated_at: unknown;
}

export class PostgresIndexReadStore {
  public constructor(private readonly sql: SqlClient) {}

  /**
   * Every basket the indexer has seen, newest first.
   *
   * A projection that fails to parse is skipped rather than failing the whole
   * page. One malformed row should not take discovery down for every other
   * basket, and the row is still visible in the projection table for anyone
   * debugging it.
   */
  public async listIndexes(limit = 100): Promise<readonly IndexSummaryView[]> {
    const { rows } = await this.sql.query<ProjectionRow>(
      `SELECT address, account_data, updated_at
         FROM solana_account_projections
        WHERE account_kind = 'Basket' AND is_active = true
        ORDER BY source_slot DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );

    const summaries: IndexSummaryView[] = [];
    for (const row of rows) {
      const parsed = basketProjectionSchema.safeParse(row.account_data);
      if (!parsed.success) continue;
      const items = parsed.data.items.map(toAssetView);
      const nav = await this.latestNav(hexOrText(parsed.data.basketId));
      summaries.push({
        address: row.address,
        basketId: hexOrText(parsed.data.basketId),
        status: statusName(parsed.data.status),
        isPerpetual: parsed.data.isPerpetual,
        compositionVersion: Number(parsed.data.compositionVersion),
        performanceFeeBps: Number(parsed.data.performanceFeeBps),
        totalSharesOutstanding: parsed.data.totalSharesOutstanding,
        sharePriceUnits: nav?.sharePriceUnits ?? null,
        grossNavUnits: nav?.grossNavPusdUnits ?? null,
        assetKinds: distinctKinds(items),
        itemCount: items.length,
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : typeof row.updated_at === "string"
              ? row.updated_at
              : null,
      });
    }
    return summaries;
  }

  public async getIndex(address: string): Promise<IndexDetailView | null> {
    let key: PublicKey;
    try {
      key = new PublicKey(address);
    } catch {
      return null;
    }

    const { rows: found } = await this.sql.query<ProjectionRow>(
      `SELECT address, account_data, updated_at
         FROM solana_account_projections
        WHERE address = $1 AND account_kind = 'Basket' AND is_active = true
        LIMIT 1`,
      [key.toBase58()],
    );
    const row = found[0];
    if (!row) return null;

    const parsed = basketProjectionSchema.safeParse(row.account_data);
    if (!parsed.success) return null;

    const items = parsed.data.items.map(toAssetView);
    const basketId = hexOrText(parsed.data.basketId);
    const nav = await this.latestNav(basketId);
    const holders = await this.holderCount(key.toBase58());

    return {
      address: row.address,
      basketId,
      status: statusName(parsed.data.status),
      isPerpetual: parsed.data.isPerpetual,
      compositionVersion: Number(parsed.data.compositionVersion),
      performanceFeeBps: Number(parsed.data.performanceFeeBps),
      totalSharesOutstanding: parsed.data.totalSharesOutstanding,
      sharePriceUnits: nav?.sharePriceUnits ?? null,
      grossNavUnits: nav?.grossNavPusdUnits ?? null,
      assetKinds: distinctKinds(items),
      itemCount: items.length,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : typeof row.updated_at === "string"
            ? row.updated_at
            : null,
      items,
      holderCount: holders,
    };
  }

  /** Every basket an owner holds shares in. */
  public async getPortfolio(
    owner: string,
  ): Promise<readonly PortfolioHoldingView[]> {
    let key: PublicKey;
    try {
      key = new PublicKey(owner);
    } catch {
      return [];
    }

    const { rows } = await this.sql.query<ProjectionRow>(
      `SELECT address, account_data, updated_at
         FROM solana_account_projections
        WHERE account_kind = 'Position'
          AND is_active = true
          AND account_data->>'owner' = $1`,
      [key.toBase58()],
    );

    const holdings: PortfolioHoldingView[] = [];
    for (const row of rows) {
      const parsed = positionProjectionSchema.safeParse(row.account_data);
      if (!parsed.success) continue;
      // A fully redeemed position stays projected with zero shares. Showing it
      // would fill a portfolio with baskets the user has already exited.
      if (parsed.data.sharesOwned === "0") continue;

      const basket = await this.getIndex(parsed.data.basket);
      if (!basket) continue;

      const sharePrice = basket.sharePriceUnits;
      holdings.push({
        basketAddress: parsed.data.basket,
        basketId: basket.basketId,
        sharesOwned: parsed.data.sharesOwned,
        costBasisValue: parsed.data.costBasisValue,
        currentValueUnits:
          sharePrice === null
            ? null
            : (
                (BigInt(parsed.data.sharesOwned) * BigInt(sharePrice)) /
                1_000_000n
              ).toString(10),
        sharePriceUnits: sharePrice,
        assetKinds: basket.assetKinds,
      });
    }
    return holdings;
  }

  private async latestNav(
    basketId: string,
  ): Promise<{ grossNavPusdUnits: string; sharePriceUnits: string | null } | null> {
    if (basketId === "") return null;
    const { rows: navRows } = await this.sql.query<{ snapshot: unknown }>(
      `SELECT snapshot
         FROM nav_snapshots
        WHERE basket_id = $1
        ORDER BY sequence DESC
        LIMIT 1`,
      [basketId],
    );
    const row = navRows[0];
    if (!row) return null;
    const parsed = navSnapshotSchema.safeParse(row.snapshot);
    return parsed.success
      ? {
          grossNavPusdUnits: parsed.data.grossNavPusdUnits,
          sharePriceUnits: parsed.data.sharePriceUnits,
        }
      : null;
  }

  private async holderCount(basketAddress: string): Promise<number> {
    const { rows: countRows } = await this.sql.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM solana_account_projections
        WHERE account_kind = 'Position'
          AND is_active = true
          AND account_data->>'basket' = $1
          AND account_data->>'sharesOwned' <> '0'`,
      [basketAddress],
    );
    const row = countRows[0];
    return row ? Number(row.count) : 0;
  }
}
