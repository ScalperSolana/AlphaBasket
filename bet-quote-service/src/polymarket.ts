const DEFAULT_POLYMARKET_GAMMA_BASE = 'https://gamma-api.polymarket.com';

export interface PolymarketMarket {
  id?: string;
  slug?: string;
  question: string;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  outcome_prices?: string[] | string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
}

const normalizeMarket = (data: any): PolymarketMarket => {
  let outcomePrices: string[] = [];
  const pricesSource = data.outcomePrices || data.outcome_prices || data.prices;
  if (pricesSource) {
    if (typeof pricesSource === 'string') {
      try {
        outcomePrices = JSON.parse(pricesSource);
      } catch {
        outcomePrices = pricesSource.split(',').map((p: string) => p.trim());
      }
    } else if (Array.isArray(pricesSource)) {
      outcomePrices = pricesSource.map((p: unknown) => String(p));
    }
  }

  return {
    id: data.id || data.condition_id || data.questionID,
    slug: data.slug || data.questionID,
    question: data.question || data.title || '',
    outcomes: data.outcomes,
    outcomePrices,
    outcome_prices: data.outcome_prices,
    endDate: data.endDate || data.end_date_iso || data.end_date || data.endDateISO,
    closed: Boolean(data.closed || data.archived),
    active: data.active === undefined ? undefined : Boolean(data.active),
  };
};

export async function fetchMarketBySlug(
  slug: string,
  gammaBaseUrl = DEFAULT_POLYMARKET_GAMMA_BASE,
): Promise<PolymarketMarket | null> {
  try {
    const response = await fetch(`${gammaBaseUrl}/markets/slug/${slug}?_t=${Date.now()}`, {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return normalizeMarket(data);
  } catch (error) {
    console.error(`[bet-quote-service] Failed to fetch market by slug ${slug}:`, error);
    return null;
  }
}

export async function fetchMarketById(
  id: string,
  gammaBaseUrl = DEFAULT_POLYMARKET_GAMMA_BASE,
): Promise<PolymarketMarket | null> {
  try {
    const response = await fetch(`${gammaBaseUrl}/markets/${id}?_t=${Date.now()}`, {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return normalizeMarket(data);
  } catch (error) {
    console.error(`[bet-quote-service] Failed to fetch market by id ${id}:`, error);
    return null;
  }
}

export const extractYesNoPrices = (market: PolymarketMarket): { yesPrice: number; noPrice: number } | null => {
  const prices = market.outcomePrices || market.outcome_prices;
  let parsed: string[] = [];

  if (Array.isArray(prices)) {
    parsed = prices.map((value) => String(value));
  } else if (typeof prices === 'string') {
    try {
      const decoded = JSON.parse(prices);
      if (Array.isArray(decoded)) {
        parsed = decoded.map((value) => String(value));
      }
    } catch {
      parsed = prices.split(',').map((value) => value.trim());
    }
  }

  if (parsed.length < 2) {
    return null;
  }

  const yesPrice = Number(parsed[0]);
  const noPrice = Number(parsed[1]);
  if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) {
    return null;
  }

  return { yesPrice, noPrice };
};
