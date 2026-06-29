import { ENV } from '@/env';
import type { PolymarketMarket } from '@/types/polymarket.ts';

export const getBetCutoffMs = (): number => ENV.BASKET_BET_CUTOFF_MS;

export const formatBetCutoff = (cutoffMs: number = getBetCutoffMs()): string => {
  const totalMinutes = Math.max(1, Math.ceil(cutoffMs / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  return `${hours}h ${minutes}m`;
};

export const isEndTimestampBettable = (
  endTimestamp: number | undefined | null,
  nowMs: number = Date.now(),
  cutoffMs: number = getBetCutoffMs(),
): boolean => (
  typeof endTimestamp === 'number' &&
  Number.isFinite(endTimestamp) &&
  endTimestamp > nowMs + cutoffMs
);

export const isMarketBettable = (
  market: PolymarketMarket,
  nowMs: number = Date.now(),
  cutoffMs: number = getBetCutoffMs(),
): boolean => {
  if (!market.active || market.closed || market.acceptingOrders === false) {
    return false;
  }

  if (!market.endDate) {
    return true;
  }

  return isEndTimestampBettable(new Date(market.endDate).getTime(), nowMs, cutoffMs);
};

export const filterBettableMarkets = <T extends PolymarketMarket>(
  markets: T[],
  nowMs: number = Date.now(),
  cutoffMs: number = getBetCutoffMs(),
): T[] => markets.filter((market) => isMarketBettable(market, nowMs, cutoffMs));
