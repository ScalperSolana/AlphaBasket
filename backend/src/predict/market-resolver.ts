import type {
  PredictMarket,
  PredictMarketLinkStorePort,
  PredictMarketResolution,
  PredictMarketResolverPort,
  PredictRestPort,
} from "./types.js";

const YES_LABELS = new Set(["yes", "y", "true"]);
const NO_LABELS = new Set(["no", "n", "false"]);

/**
 * Derives which side of a binary market an outcome index means. Polymarket
 * convention (and the on-chain composition) puts outcome 0 first; when the
 * Jupiter payload carries outcome labels they must agree, otherwise the
 * mapping is refused rather than guessed.
 */
function sideForOutcome(outcomeIndex: number, market: PredictMarket): boolean {
  if (outcomeIndex !== 0 && outcomeIndex !== 1) {
    throw new RangeError("prediction outcome index must be 0 or 1");
  }
  const expectedYes = outcomeIndex === 0;
  const label = market.outcomes[outcomeIndex]?.trim().toLowerCase();
  if (label !== undefined && label.length > 0) {
    if (YES_LABELS.has(label)) return true;
    if (NO_LABELS.has(label)) return false;
    throw new Error(
      `Jupiter Predict market ${market.marketId} outcome ${outcomeIndex} is "${label}", not a yes/no label`,
    );
  }
  return expectedYes;
}

export interface JupiterPredictMarketResolverOptions {
  /** Catalog pages scanned before giving up; 100 events per page. */
  readonly maxCatalogPages?: number;
}

/**
 * Resolution chain: durable link -> direct market probe by the composition's
 * marketId -> catalog scan matching the Polymarket condition/token ids the
 * payload exposes. Every derived link is persisted so NAV and later operations
 * resolve without rescanning, and an unresolvable market fails with the exact
 * operator remedy.
 */
export class JupiterPredictMarketResolver implements PredictMarketResolverPort {
  private readonly maxCatalogPages: number;

  public constructor(
    private readonly rest: PredictRestPort,
    private readonly links: PredictMarketLinkStorePort,
    options: JupiterPredictMarketResolverOptions = {},
  ) {
    this.maxCatalogPages = options.maxCatalogPages ?? 5;
    if (!Number.isSafeInteger(this.maxCatalogPages) || this.maxCatalogPages < 0) {
      throw new RangeError("maxCatalogPages must be a non-negative integer");
    }
  }

  public async resolve(request: {
    readonly tokenId: string;
    readonly marketId?: string;
    readonly conditionId?: string | null;
    readonly outcomeIndex?: number;
  }): Promise<PredictMarketResolution> {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(request.tokenId)) {
      throw new TypeError("prediction token id must be a decimal CTF token id");
    }
    const linked = await this.links.load(request.tokenId);
    if (linked !== null) {
      return Object.freeze({ jupiterMarketId: linked.jupiterMarketId, isYes: linked.isYes });
    }

    const conditionId = request.conditionId?.toLowerCase() ?? null;
    const outcomeIndex = request.outcomeIndex;

    if (request.marketId !== undefined && outcomeIndex !== undefined) {
      // Venue-native compositions store the Jupiter market id as the on-chain
      // marketId; probing it directly proves the mapping.
      try {
        const market = await this.rest.getMarket(request.marketId);
        const resolution = this.verified(market, request.tokenId, conditionId, outcomeIndex);
        if (resolution !== null) {
          await this.links.save({
            tokenId: request.tokenId,
            conditionId,
            jupiterMarketId: market.marketId,
            isYes: resolution.isYes,
            source: "market_probe",
          });
          return resolution;
        }
      } catch {
        // Not a Jupiter market id; fall through to the catalog scan.
      }
    }

    if (outcomeIndex !== undefined) {
      for (let page = 0; page < this.maxCatalogPages; page += 1) {
        const markets = await this.rest.listCatalogMarkets({
          start: page * 100,
          end: (page + 1) * 100,
        });
        if (markets.length === 0) break;
        for (const market of markets) {
          const resolution = this.verified(market, request.tokenId, conditionId, outcomeIndex);
          if (resolution === null) continue;
          await this.links.save({
            tokenId: request.tokenId,
            conditionId,
            jupiterMarketId: market.marketId,
            isYes: resolution.isYes,
            source: "catalog",
          });
          return resolution;
        }
      }
    }

    throw new Error(
      `no Jupiter Predict market is linked to prediction token ${request.tokenId}` +
        (conditionId === null ? "" : ` (condition ${conditionId})`) +
        "; insert a predict_market_links row for it",
    );
  }

  /** A market maps only when the payload itself carries a matching external id. */
  private verified(
    market: PredictMarket,
    tokenId: string,
    conditionId: string | null,
    outcomeIndex: number,
  ): PredictMarketResolution | null {
    const matches = market.externalIds.includes(tokenId) ||
      (conditionId !== null && market.externalIds.includes(conditionId));
    if (!matches) return null;
    return Object.freeze({
      jupiterMarketId: market.marketId,
      isYes: sideForOutcome(outcomeIndex, market),
    });
  }
}
