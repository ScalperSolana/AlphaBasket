import { createHash } from "node:crypto";

import {
  Connection,
  PublicKey,
} from "@solana/web3.js";

import type { PolymarketBalancePort } from "../execution/index.js";
import type { SqlClient } from "../persistence/index.js";
import type { PolymarketPositionsPort } from "../polymarket/index.js";
import type { BasketAssetReconciliationWriterPort } from "./postgres-source.js";

interface AssetRow extends Record<string, unknown> {
  wallet_id: string;
  polygon_address: string;
  solana_address: string | null;
  basket_id: string;
  ledger_version: string;
  idle_pusd_units: string;
  idle_usdc_units: string;
  nav_gross_pusd_units: string;
  asset_kind: "prediction_market" | "spot" | null;
  token_id: string | null;
  quantity_units: string | null;
  mark_price_units: string | null;
  price_scale: string | null;
}

interface BasketState {
  readonly basketId: string;
  readonly walletId: string;
  readonly ledgerVersion: string;
  readonly ledgerValue: bigint;
  readonly idlePusd: bigint;
  readonly idleUsdc: bigint;
  readonly holdings: Map<string, {
    readonly quantity: bigint;
    readonly markPrice: bigint;
    readonly priceScale: bigint;
  }>;
}

function integer(value: string | null, name: string): bigint {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`database returned invalid ${name}`);
  }
  return BigInt(value);
}

const assetKey = (
  kind: "prediction_market" | "spot",
  tokenId: string,
): string => `${kind}:${tokenId}`;

export interface SolanaTokenBalancePort {
  getTokenBalanceUnits(owner: PublicKey, mint: PublicKey): Promise<bigint>;
}

export class Web3SolanaTokenBalance implements SolanaTokenBalancePort {
  public constructor(private readonly connection: Connection) {}

  public async getTokenBalanceUnits(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    const result = await this.connection.getParsedTokenAccountsByOwner(
      owner,
      { mint },
      "finalized",
    );
    let total = 0n;
    for (const account of result.value) {
      const parsed = account.account.data;
      if (Buffer.isBuffer(parsed) || !("parsed" in parsed)) {
        throw new Error("Solana RPC returned an unparsed token account");
      }
      const amount = (parsed.parsed as {
        readonly info?: {
          readonly mint?: unknown;
          readonly owner?: unknown;
          readonly tokenAmount?: { readonly amount?: unknown };
        };
      }).info;
      if (
        amount?.mint !== mint.toBase58() ||
        amount.owner !== owner.toBase58() ||
        typeof amount.tokenAmount?.amount !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(amount.tokenAmount.amount)
      ) {
        throw new Error("Solana RPC token-account identity or amount is malformed");
      }
      total += BigInt(amount.tokenAmount.amount);
    }
    return total;
  }
}

/**
 * Reconciles each shared execution wallet by asset, then attributes any
 * shortage/surplus proportionally back to its baskets. This keeps wallet
 * sharding compatible with basket-level alerts without pretending each basket
 * has a separate custody address.
 */
export class HybridAssetReconciliationRefresher {
  public constructor(
    private readonly sql: SqlClient,
    private readonly basketWriter: BasketAssetReconciliationWriterPort,
    private readonly pusdBalance: PolymarketBalancePort,
    private readonly positions: PolymarketPositionsPort,
    private readonly solanaBalances: SolanaTokenBalancePort,
    private readonly options: Readonly<{
      usdcMint: PublicKey;
      fallbackSolanaOwner: PublicKey;
      nowMs?: () => bigint;
    }>,
  ) {}

  public async runOnce(): Promise<void> {
    const result = await this.sql.query<AssetRow>(
      `SELECT assignment.wallet_id, wallet.polygon_address, wallet.solana_address,
              portfolio.basket_id, portfolio.ledger_version,
              portfolio.idle_pusd_units::text AS idle_pusd_units,
              portfolio.idle_usdc_units::text AS idle_usdc_units,
              (nav.snapshot->>'grossNavPusdUnits')::text AS nav_gross_pusd_units,
              holding.asset_kind, holding.token_id,
              holding.quantity_units::text AS quantity_units,
              holding.mark_price_units::text AS mark_price_units,
              holding.price_scale::text AS price_scale
       FROM wallet_assignments assignment
       JOIN execution_wallets wallet ON wallet.wallet_id = assignment.wallet_id
       JOIN basket_portfolio_states portfolio
         ON portfolio.basket_id = assignment.basket_id
       JOIN LATERAL (
         SELECT snapshot FROM nav_snapshots
         WHERE basket_id = portfolio.basket_id
         ORDER BY sequence DESC LIMIT 1
       ) nav ON true
       LEFT JOIN basket_holding_projections holding
         ON holding.basket_id = portfolio.basket_id
       WHERE wallet.status IN ('active', 'draining')
       ORDER BY assignment.wallet_id, portfolio.basket_id, holding.token_id`,
    );
    const baskets = new Map<string, BasketState>();
    const walletIdentity = new Map<string, {
      polygon: string;
      solana: PublicKey;
    }>();
    for (const row of result.rows) {
      const priorIdentity = walletIdentity.get(row.wallet_id);
      const solana = row.solana_address === null
        ? this.options.fallbackSolanaOwner
        : new PublicKey(row.solana_address);
      if (
        priorIdentity !== undefined &&
        (priorIdentity.polygon !== row.polygon_address.toLowerCase() ||
          !priorIdentity.solana.equals(solana))
      ) {
        throw new Error(`execution wallet ${row.wallet_id} has conflicting custody identities`);
      }
      walletIdentity.set(row.wallet_id, {
        polygon: row.polygon_address.toLowerCase(),
        solana,
      });
      const key = `${row.wallet_id}\u0000${row.basket_id}`;
      let basket = baskets.get(key);
      if (basket === undefined) {
        basket = {
          basketId: row.basket_id,
          walletId: row.wallet_id,
          ledgerVersion: row.ledger_version,
          ledgerValue: integer(row.nav_gross_pusd_units, "NAV gross value"),
          idlePusd: integer(row.idle_pusd_units, "idle pUSD"),
          idleUsdc: integer(row.idle_usdc_units, "idle USDC"),
          holdings: new Map(),
        };
        baskets.set(key, basket);
      }
      if (
        row.asset_kind !== null &&
        row.token_id !== null &&
        row.quantity_units !== null &&
        row.mark_price_units !== null &&
        row.price_scale !== null
      ) {
        const key = assetKey(row.asset_kind, row.token_id);
        if (basket.holdings.has(key)) {
          throw new Error(`duplicate attributed holding ${row.basket_id}/${key}`);
        }
        basket.holdings.set(key, {
          quantity: integer(row.quantity_units, "holding quantity"),
          markPrice: integer(row.mark_price_units, "holding mark"),
          priceScale: integer(row.price_scale, "holding price scale"),
        });
      }
    }

    const byWallet = new Map<string, BasketState[]>();
    for (const basket of baskets.values()) {
      const values = byWallet.get(basket.walletId) ?? [];
      values.push(basket);
      byWallet.set(basket.walletId, values);
    }
    const observedAtMs = this.options.nowMs?.() ?? BigInt(Date.now());
    for (const [walletId, walletBaskets] of byWallet) {
      const identity = walletIdentity.get(walletId);
      if (identity === undefined) throw new Error(`missing execution wallet ${walletId}`);
      const attributed = new Map<string, bigint>();
      for (const basket of walletBaskets) {
        attributed.set("pusd", (attributed.get("pusd") ?? 0n) + basket.idlePusd);
        attributed.set("usdc", (attributed.get("usdc") ?? 0n) + basket.idleUsdc);
        for (const [key, holding] of basket.holdings) {
          attributed.set(key, (attributed.get(key) ?? 0n) + holding.quantity);
        }
      }
      const allPositions = this.positions.listPositions === undefined
        ? []
        : await this.positions.listPositions(identity.polygon);
      const positionByToken = new Map(
        allPositions.map((position) => [position.tokenId, position.sizeUnits]),
      );
      const actual = new Map<string, bigint>();
      actual.set("pusd", await this.pusdBalance.getPusdBalanceUnits(identity.polygon));
      actual.set(
        "usdc",
        await this.solanaBalances.getTokenBalanceUnits(
          identity.solana,
          this.options.usdcMint,
        ),
      );
      for (const key of attributed.keys()) {
        if (key === "pusd" || key === "usdc") continue;
        const [kind, tokenId] = key.split(":", 2) as [
          "prediction_market" | "spot",
          string,
        ];
        actual.set(
          key,
          kind === "prediction_market"
            ? positionByToken.get(tokenId) ?? 0n
            : await this.solanaBalances.getTokenBalanceUnits(
                identity.solana,
                new PublicKey(tokenId),
              ),
        );
      }
      const walletVersion = createHash("sha256").update(JSON.stringify([
        walletId,
        observedAtMs.toString(10),
        [...actual.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, value]) => [key, value.toString(10)]),
      ]), "utf8").digest("hex");
      await this.sql.transaction(async (transaction) => {
        for (const [key, attributedUnits] of attributed) {
          const separator = key.indexOf(":");
          const rawKind = separator < 0 ? key : key.slice(0, separator);
          const assetId = separator < 0
            ? (key === "usdc" ? this.options.usdcMint.toBase58() : "pusd")
            : key.slice(separator + 1);
          const kind = rawKind;
          if (
            (
              kind !== "pusd" &&
              kind !== "usdc" &&
              kind !== "prediction_market" &&
              kind !== "spot"
            ) ||
            assetId.length === 0
          ) {
            throw new Error(`unsupported reconciliation asset ${key}`);
          }
          await transaction.query(
            `INSERT INTO wallet_asset_reconciliation_projections (
               wallet_id, asset_kind, asset_id, attributed_units, actual_units,
               source_version, observed_at_ms, updated_at
             ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7::numeric, now())
             ON CONFLICT (wallet_id, asset_kind, asset_id) DO UPDATE
             SET attributed_units = EXCLUDED.attributed_units,
                 actual_units = EXCLUDED.actual_units,
                 source_version = EXCLUDED.source_version,
                 observed_at_ms = EXCLUDED.observed_at_ms,
                 updated_at = now()
             WHERE wallet_asset_reconciliation_projections.observed_at_ms
                   <= EXCLUDED.observed_at_ms`,
            [
              walletId,
              kind,
              assetId,
              attributedUnits.toString(10),
              (actual.get(key) ?? 0n).toString(10),
              walletVersion,
              observedAtMs.toString(10),
            ],
          );
        }
      });
      for (const basket of walletBaskets) {
        const share = (key: string, units: bigint): bigint => {
          const totalAttributed = attributed.get(key) ?? 0n;
          return totalAttributed === 0n
            ? 0n
            : ((actual.get(key) ?? 0n) * units) / totalAttributed;
        };
        let walletValue =
          share("pusd", basket.idlePusd) +
          share("usdc", basket.idleUsdc);
        for (const [key, holding] of basket.holdings) {
          walletValue +=
            (share(key, holding.quantity) * holding.markPrice) /
            holding.priceScale;
        }
        await this.basketWriter.upsert({
          basketId: basket.basketId,
          ledgerAttributedPusdUnits: basket.ledgerValue,
          walletAttributedPusdUnits: walletValue,
          ledgerSourceVersion: basket.ledgerVersion,
          walletSourceVersion: walletVersion,
          observedAtMs,
        });
      }
    }
  }
}
