import { compareCodeUnits } from "./filters.js";
import type {
  CandidateSourceMarket,
  ComposerCandidate,
  ComposerClassificationPort,
  ComposerMarketMetricsPort,
} from "./types.js";

/** Joins objective CLOB metrics with separately attestable theme/clarity classification. */
export class ComposerCandidateBuilder {
  public constructor(
    private readonly metrics: ComposerMarketMetricsPort,
    private readonly classification: ComposerClassificationPort,
  ) {}

  public async build(markets: readonly CandidateSourceMarket[]): Promise<readonly ComposerCandidate[]> {
    const ordered = [...markets].sort((left, right) => {
      const leftKey = `${left.marketId}\u0000${left.tokenId}\u0000${left.outcomeIndex.toString()}`;
      const rightKey = `${right.marketId}\u0000${right.tokenId}\u0000${right.outcomeIndex.toString()}`;
      return compareCodeUnits(leftKey, rightKey);
    });
    const candidates = await Promise.all(
      ordered.map(async (market): Promise<ComposerCandidate> => {
        const [metrics, classification] = await Promise.all([
          this.metrics.loadMetrics(market),
          this.classification.classify(market),
        ]);
        if (
          typeof classification.thematicallyRelevant !== "boolean" ||
          typeof classification.outcomeClear !== "boolean" ||
          typeof classification.source !== "string" ||
          classification.source.length === 0
        ) {
          throw new TypeError(`Classifier returned invalid data for ${market.marketId}`);
        }
        if (
          typeof metrics.hasBid !== "boolean" ||
          typeof metrics.hasAsk !== "boolean" ||
          !Number.isSafeInteger(metrics.spreadBps) ||
          typeof metrics.midpointPriceUnits !== "bigint" ||
          typeof metrics.depthPusdUnits !== "bigint" ||
          typeof metrics.volume24hPusdUnits !== "bigint" ||
          !["fresh", "stale", "illiquid", "unavailable"].includes(
            metrics.dataCondition,
          )
        ) {
          throw new TypeError(`Metrics provider returned invalid data for ${market.marketId}`);
        }
        return Object.freeze({
          ...market,
          ...metrics,
          thematicallyRelevant: classification.thematicallyRelevant,
          outcomeClear: classification.outcomeClear,
          classificationSource: classification.source,
        });
      }),
    );
    return Object.freeze(candidates);
  }
}
