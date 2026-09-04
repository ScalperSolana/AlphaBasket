/**
 * Market selection.
 *
 * The tradeable pair list always comes live from Phoenix exchange metadata. A
 * pair list in a constant file is a bug: Phoenix listed 76 markets when this was
 * written, including equity and commodity perpetuals, and that catalog moves.
 *
 * A market must pass two independent gates:
 *
 *   * Phoenix currently lists it, calls it active, and can price it.
 *   * The Composer has published it on a `PerpEligibilityList`.
 *
 * Live-but-not-eligible is a governance decision. Eligible-but-not-live is a
 * stale list. Either way the answer is no, but they call for different
 * responses, so every rejection names which gate failed.
 */

import type { PhoenixExchangePort, PhoenixMarket } from "./types.js";

/** The perp eligibility list as market selection needs to see it. */
export interface PerpEligibilityView {
  readonly listHash: string;
  readonly nonce: bigint;
  readonly expiresAt: bigint;
  readonly marketIds: readonly string[];
}

export type MarketRejection =
  | { readonly kind: "not_listed"; readonly market: string }
  | { readonly kind: "not_tradeable"; readonly market: string; readonly status: string }
  | { readonly kind: "not_priceable"; readonly market: string }
  | { readonly kind: "not_eligible"; readonly market: string }
  | { readonly kind: "list_expired"; readonly expiresAt: bigint; readonly now: bigint };

export type MarketSelection =
  | { readonly kind: "selected"; readonly market: PhoenixMarket }
  | { readonly kind: "rejected"; readonly rejection: MarketRejection };

export class PerpMarketSelector {
  constructor(private readonly exchange: PhoenixExchangePort) {}

  /**
   * Every symbol Phoenix lists as active *and* can price.
   *
   * A market with no mark price cannot be sized or verified against, so it is
   * not tradeable by this adapter regardless of what its status says.
   */
  async liveTradeableSymbols(): Promise<readonly string[]> {
    await this.exchange.ready();
    return this.exchange
      .activeSymbols()
      .filter((symbol) => this.exchange.markPriceTicks(symbol) !== undefined)
      .slice()
      .sort();
  }

  /** The set a perpetual basket may actually be composed from. */
  async selectableSymbols(
    eligibility: PerpEligibilityView,
    now: bigint,
  ): Promise<readonly string[]> {
    if (eligibility.expiresAt <= now) return [];
    const live = new Set(await this.liveTradeableSymbols());
    return eligibility.marketIds
      .filter((symbol) => live.has(symbol))
      .slice()
      .sort();
  }

  /**
   * Symbols the eligibility list names that Phoenix no longer lists or prices.
   *
   * Worth surfacing rather than silently filtering: a delisted market in an
   * active list means the list needs republishing, and a position already open
   * in one needs closing on a path this adapter cannot take.
   */
  async staleEligibleSymbols(
    eligibility: PerpEligibilityView,
  ): Promise<readonly string[]> {
    const live = new Set(await this.liveTradeableSymbols());
    return eligibility.marketIds
      .filter((symbol) => !live.has(symbol))
      .slice()
      .sort();
  }

  /** Resolves one market, with a typed reason when it cannot be used. */
  async select(
    symbol: string,
    eligibility: PerpEligibilityView,
    now: bigint,
  ): Promise<MarketSelection> {
    await this.exchange.ready();

    if (eligibility.expiresAt <= now) {
      return {
        kind: "rejected",
        rejection: { kind: "list_expired", expiresAt: eligibility.expiresAt, now },
      };
    }

    const market = this.exchange.market(symbol);
    if (!market) {
      return { kind: "rejected", rejection: { kind: "not_listed", market: symbol } };
    }
    if (market.marketStatus !== "active") {
      return {
        kind: "rejected",
        rejection: { kind: "not_tradeable", market: symbol, status: market.marketStatus },
      };
    }
    if (this.exchange.markPriceTicks(symbol) === undefined) {
      return { kind: "rejected", rejection: { kind: "not_priceable", market: symbol } };
    }
    if (!eligibility.marketIds.includes(symbol)) {
      return { kind: "rejected", rejection: { kind: "not_eligible", market: symbol } };
    }

    return { kind: "selected", market };
  }
}
