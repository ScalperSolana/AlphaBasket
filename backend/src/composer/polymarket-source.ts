import type { GammaMarket } from "../polymarket/types.js";
import type { CandidateSourceMarket } from "./types.js";

/** Selects exactly one binary outcome before duplicate-market Composer checks. */
export const gammaOutcomeCandidate = (
  market: GammaMarket,
  outcomeIndex: 0 | 1,
): CandidateSourceMarket => {
  if (market.tokens.length !== 2) {
    throw new TypeError(
      `Gamma market ${market.marketId} is not a binary prediction market`,
    );
  }
  const token = market.tokens[outcomeIndex];
  if (token === undefined) {
    throw new TypeError(`Gamma market ${market.marketId} is missing outcome ${outcomeIndex}`);
  }
  return Object.freeze({
    marketId: market.marketId,
    conditionId: market.conditionId,
    eventId: market.eventId,
    tokenId: token.tokenId,
    outcomeLabel: token.outcome,
    outcomeIndex,
    active: market.active,
    closed: market.closed,
    acceptingOrders: market.acceptingOrders,
    endTimeMs: market.endTimeMs,
    volume24hPusdUnits: market.volume24hUnits,
  });
};
