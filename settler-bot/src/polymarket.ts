const DEFAULT_POLYMARKET_GAMMA_BASE = 'https://gamma-api.polymarket.com';

export interface PolymarketMarket {
  id?: string;
  condition_id?: string;
  slug?: string;
  question: string;
  description?: string;
  closed: boolean;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  outcome_prices?: string[] | string;
  umaResolutionStatus?: string;
  endDate?: string;
  end_date_iso?: string;
}

export interface ResolutionCheck {
  isResolved: boolean;
  resolved: 'YES' | 'NO' | null; // null = unclear
  yesPrice: number;
  noPrice: number;
  reason: string;
}

/**
 * Fetch a market by slug from Polymarket Gamma API
 */
export async function fetchMarketBySlug(
  slug: string,
  gammaBaseUrl = DEFAULT_POLYMARKET_GAMMA_BASE,
): Promise<PolymarketMarket | null> {
  try {
    // Add cache-busting timestamp to ensure latest data
    const apiUrl = `${gammaBaseUrl}/markets/slug/${slug}?_t=${Date.now()}`;
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`Polymarket market not found by slug ${slug} (404)`);
        return null;
      }
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return normalizeMarket(data);
  } catch (error) {
    console.error(`Failed to fetch market by slug ${slug}:`, error);
    return null;
  }
}

/**
 * Fetch a market by ID from Polymarket Gamma API
 */
export async function fetchMarketById(
  id: string,
  gammaBaseUrl = DEFAULT_POLYMARKET_GAMMA_BASE,
): Promise<PolymarketMarket | null> {
  try {
    // Add cache-busting timestamp to ensure latest data
    const apiUrl = `${gammaBaseUrl}/markets/${id}?_t=${Date.now()}`;
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`Polymarket market not found by id ${id} (404)`);
        return null;
      }
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return normalizeMarket(data);
  } catch (error) {
    console.error(`Failed to fetch market by id ${id}:`, error);
    return null;
  }
}

/**
 * Normalize market data from Polymarket API
 */
function normalizeMarket(data: any): PolymarketMarket {
  // Normalize outcomes
  let outcomes: string[] = ['Yes', 'No'];
  if (data.outcomes) {
    if (typeof data.outcomes === 'string') {
      try {
        outcomes = JSON.parse(data.outcomes);
      } catch {
        outcomes = data.outcomes.split(',');
      }
    } else if (Array.isArray(data.outcomes)) {
      outcomes = data.outcomes;
    }
  }

  // Normalize outcome prices
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
      outcomePrices = pricesSource.map((p: any) => String(p));
    }
  }

  return {
    id: data.id || data.condition_id || data.questionID,
    condition_id: data.condition_id || data.id,
    slug: data.slug || data.questionID,
    question: data.question || data.title || '',
    description: data.description,
    closed: data.closed === true || data.active === false,
    outcomes,
    outcomePrices,
    umaResolutionStatus: data.umaResolutionStatus || data.uma_resolution_status,
    endDate: data.endDate || data.end_date_iso,
    end_date_iso: data.end_date_iso || data.endDate,
  };
}

/**
 * Check if a market is resolved and determine the winning outcome
 */
export function checkMarketResolution(market: PolymarketMarket): ResolutionCheck {
  // Market must be closed
  if (!market.closed) {
    return {
      isResolved: false,
      resolved: null,
      yesPrice: 0,
      noPrice: 0,
      reason: 'Market is not closed',
    };
  }

  // Parse outcome prices
  const prices = market.outcomePrices || [];
  let yesPrice = 0;
  let noPrice = 0;

  if (Array.isArray(prices) && prices.length >= 2) {
    yesPrice = parseFloat(prices[0]) || 0;
    noPrice = parseFloat(prices[1]) || 0;
  } else if (typeof prices === 'string') {
    try {
      const parsed = JSON.parse(prices);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        yesPrice = parseFloat(parsed[0]) || 0;
        noPrice = parseFloat(parsed[1]) || 0;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for clear resolution: one price >= 0.99, other <= 0.01
  const yesWon = yesPrice >= 0.99 && noPrice <= 0.01;
  const noWon = noPrice >= 0.99 && yesPrice <= 0.01;

  if (yesWon) {
    return {
      isResolved: true,
      resolved: 'YES',
      yesPrice,
      noPrice,
      reason: `YES won (${(yesPrice * 100).toFixed(2)}% / ${(noPrice * 100).toFixed(2)}%)`,
    };
  }

  if (noWon) {
    return {
      isResolved: true,
      resolved: 'NO',
      yesPrice,
      noPrice,
      reason: `NO won (${(yesPrice * 100).toFixed(2)}% / ${(noPrice * 100).toFixed(2)}%)`,
    };
  }

  // Market is closed but outcome is unclear
  return {
    isResolved: false,
    resolved: null,
    yesPrice,
    noPrice,
    reason: `Market closed but outcome unclear (${(yesPrice * 100).toFixed(2)}% / ${(noPrice * 100).toFixed(2)}%)`,
  };
}
