export interface PolymarketMarket {
  id: string;
  slug: string;
  question: string;
  description?: string;
  category?: string;
  active: boolean;
  closed: boolean;
  outcomes: string[];
  outcomePrices?: string[];
  volume?: number;
  liquidity?: number;
  endDate?: string;
  image?: string;
  startDate?: string;
  gameStartTime?: string;
  volume24hr?: number;
  volume1wk?: number;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  competitive?: number;
  icon?: string;
  clobTokenIds?: string[];
  groupItemThreshold?: string;
  groupItemTitle?: string;
  priceToBeat?: string;
}

export interface OutcomeProbabilities {
  YES: number;
  NO: number;
}

export interface MarketSearchResult {
  markets: PolymarketMarket[];
  hasMore: boolean;
}
