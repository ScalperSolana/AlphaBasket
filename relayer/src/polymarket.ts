const POLYMARKET_GAMMA_BASE = 'https://gamma-api.polymarket.com';

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
  winningIndex: number | null; // 0 = YES, 1 = NO, null = unclear
  reason: string;
}

/**
 * Fetch a market by slug from Polymarket Gamma API
 */
export async function fetchMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
  try {
    const response = await fetch(`${POLYMARKET_GAMMA_BASE}/markets/slug/${slug}`, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
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
export async function fetchMarketById(id: string): Promise<PolymarketMarket | null> {
  try {
    const response = await fetch(`${POLYMARKET_GAMMA_BASE}/markets/${id}`, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
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
 * Handles stringified arrays and different field names
 */
function normalizeMarket(data: any): PolymarketMarket {
  // Normalize outcomes
  let outcomes: string[] = ['Yes', 'No'];
  if (data.outcomes) {
    if (typeof data.outcomes === 'string') {
      try {
        outcomes = JSON.parse(data.outcomes);
      } catch {
        // If parse fails, try splitting by comma
        outcomes = data.outcomes.split(',').map((s: string) => s.trim());
      }
    } else if (Array.isArray(data.outcomes)) {
      outcomes = data.outcomes;
    }
  }

  // Normalize outcomePrices
  let outcomePrices: string[] = ['0.5', '0.5'];
  const pricesSource = data.outcomePrices || data.outcome_prices;
  if (pricesSource) {
    if (typeof pricesSource === 'string') {
      try {
        outcomePrices = JSON.parse(pricesSource);
      } catch {
        // If parse fails, try splitting by comma
        outcomePrices = pricesSource.split(',').map((s: string) => s.trim());
      }
    } else if (Array.isArray(pricesSource)) {
      outcomePrices = pricesSource.map((p: any) => String(p));
    }
  }

  return {
    id: data.id || data.condition_id,
    condition_id: data.condition_id || data.id,
    slug: data.slug || data.id,
    question: data.question,
    description: data.description,
    closed: data.closed === true,
    outcomes,
    outcomePrices,
    outcome_prices: outcomePrices,
    umaResolutionStatus: data.umaResolutionStatus || data.uma_resolution_status,
    endDate: data.endDate || data.end_date_iso,
    end_date_iso: data.end_date_iso || data.endDate,
  };
}

/**
 * Check if a market is resolved and determine the winning outcome
 * Returns null for winningIndex if unclear/disputed
 */
export function checkMarketResolution(market: PolymarketMarket): ResolutionCheck {
  // Must be closed
  if (!market.closed) {
    return {
      isResolved: false,
      winningIndex: null,
      reason: 'Market not closed',
    };
  }

  // Normalize prices
  const prices = market.outcomePrices || market.outcome_prices || [];
  if (!Array.isArray(prices) || prices.length < 2) {
    return {
      isResolved: false,
      winningIndex: null,
      reason: 'Invalid outcome prices',
    };
  }

  const yesPrice = parseFloat(String(prices[0])) || 0;
  const noPrice = parseFloat(String(prices[1])) || 0;

  // Check for hard resolution: prices should be exactly 1.0 and 0.0 (or very close)
  const YES_WON = yesPrice >= 0.99 && noPrice <= 0.01;
  const NO_WON = noPrice >= 0.99 && yesPrice <= 0.01;

  // Also check umaResolutionStatus if available
  const umaStatus = market.umaResolutionStatus?.toLowerCase();
  const umaResolved = umaStatus && (
    umaStatus.includes('resolved') ||
    umaStatus.includes('final') ||
    umaStatus === 'finalized'
  );

  // Determine winner
  if (YES_WON && (umaResolved || yesPrice === 1.0)) {
    return {
      isResolved: true,
      winningIndex: 0, // YES won
      reason: `YES resolved (${yesPrice.toFixed(3)} / ${noPrice.toFixed(3)})`,
    };
  }

  if (NO_WON && (umaResolved || noPrice === 1.0)) {
    return {
      isResolved: true,
      winningIndex: 1, // NO won
      reason: `NO resolved (${yesPrice.toFixed(3)} / ${noPrice.toFixed(3)})`,
    };
  }

  // If closed but prices are ambiguous or disputed, don't resolve
  if (market.closed) {
    return {
      isResolved: false,
      winningIndex: null,
      reason: `Market closed but unclear (${yesPrice.toFixed(3)} / ${noPrice.toFixed(3)}, UMA: ${umaStatus || 'N/A'})`,
    };
  }

  return {
    isResolved: false,
    winningIndex: null,
    reason: 'Market still active',
  };
}

/**
 * Create resolver payload JSON string for on-chain storage
 */
export function createResolverPayload(market: PolymarketMarket, winningIndex: number): string {
  const payload = {
    polyMarketId: market.id || market.condition_id,
    polySlug: market.slug,
    closedTime: new Date().toISOString(),
    outcomePrices: market.outcomePrices || market.outcome_prices,
    umaResolutionStatus: market.umaResolutionStatus,
    endDate: market.endDate || market.end_date_iso,
  };

  return JSON.stringify(payload);
}
