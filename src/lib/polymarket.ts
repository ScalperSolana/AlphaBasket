import { PolymarketMarket, OutcomeProbabilities } from '@/types/polymarket.ts';
import { getBetCutoffMs } from '@/lib/betCutoff';

// Live data only; remove mock fallback
const POLYMARKET_GAMMA_BASE = import.meta.env.VITE_GAMMA_PROXY || 'https://gamma-api.polymarket.com';
const gammaBase = POLYMARKET_GAMMA_BASE.includes('gamma-api') ? '/gamma' : POLYMARKET_GAMMA_BASE;

// Lightweight session cache to avoid repeated network hits (keeps UI responsive)
const MARKET_CACHE_TTL_MS = 30_000; // 30s
type CacheEntry<T> = { data: T; expiresAt: number };

function cacheGet<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed.expiresAt || parsed.expiresAt < Date.now()) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function cacheSet<T>(key: string, data: T, ttlMs: number = MARKET_CACHE_TTL_MS): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: CacheEntry<T> = { data, expiresAt: Date.now() + ttlMs };
    window.sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Ignore storage errors (quota, private mode, etc.)
  }
}

export interface MarketFilters {
  query?: string;
  category?: string;
  tagId?: number | null; // Polymarket tag_id for category filtering
  active?: boolean;
  closed?: boolean;
  minVolume?: number;
  minLiquidity?: number;
  startDateMin?: string; // ISO date string
  startDateMax?: string; // ISO date string
  endDateMin?: string; // ISO date string
  endDateMax?: string; // ISO date string
  limit?: number;
  offset?: number;
  orderBy?: 'volume' | 'liquidity' | 'endDate' | 'created';
  ascending?: boolean;
}

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'vs', 'will', 'with'
]);

// Polymarket category definitions with tag_id values from their API
// Each category has a tag_id that maps to Polymarket's category system
export const POLYMARKET_CATEGORIES = [
  { 
    id: 'all', 
    label: 'All Markets', 
    tagId: null,
    query: '', 
    categoryValues: [],
    keywords: []
  },
  {
    id: 'ending-soon',
    label: 'Ending Soon (1hr)',
    tagId: null,
    query: '',
    categoryValues: [],
    keywords: [],
    isTimeBased: true // Special flag for time-based filtering
  },
  {
    id: 'politics',
    label: 'Politics', 
    tagId: 2, // Politics tag_id from Polymarket API
    query: 'politics', 
    categoryValues: ['politics', 'political', 'election', 'elections', 'government', 'president', 'senate', 'congress'],
    keywords: ['trump', 'biden', 'election', 'vote', 'president', 'senate', 'congress', 'democrat', 'republican', 'political']
  },
  { 
    id: 'crypto', 
    label: 'Crypto', 
    tagId: 21, // Crypto tag_id from Polymarket API
    query: 'crypto', 
    categoryValues: ['crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'blockchain'],
    keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency', 'blockchain', 'defi', 'nft', 'xrp', 'solana', 'cardano']
  },
  { 
    id: 'tech', 
    label: 'Tech', 
    tagId: 1401, // Tech tag_id from Polymarket API
    query: 'tech', 
    categoryValues: ['tech', 'technology', 'ai', 'artificial intelligence'],
    keywords: ['tech', 'technology', 'ai', 'artificial intelligence', 'apple', 'google', 'microsoft', 'meta', 'tesla', 'nvidia', 'amd']
  },
  { 
    id: 'gaming', 
    label: 'Gaming', 
    tagId: null, // Gaming might not have a specific tag_id, use query fallback
    query: 'gaming', 
    categoryValues: ['gaming', 'games', 'esports', 'esport'],
    keywords: ['gaming', 'game', 'esports', 'esport', 'lol', 'league of legends', 'dota', 'csgo', 'valorant', 'fortnite']
  },
  { 
    id: 'sports', 
    label: 'Sports', 
    tagId: 100639, // Sports tag_id from Polymarket API
    query: 'sports', 
    categoryValues: ['sports', 'sport', 'football', 'basketball', 'soccer'],
    keywords: ['sports', 'sport', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'olympics']
  },
  { 
    id: 'finance', 
    label: 'Finance', 
    tagId: 120, // Finance tag_id from Polymarket API
    query: 'finance', 
    categoryValues: ['finance', 'financial', 'stocks', 'stock market'],
    keywords: ['finance', 'financial', 'stocks', 'stock market', 'sp500', 'dow', 'nasdaq', 'fed', 'interest rate', 'inflation']
  },
  { 
    id: 'entertainment', 
    label: 'Entertainment', 
    tagId: 596, // Culture/Entertainment tag_id from Polymarket API
    query: 'entertainment', 
    categoryValues: ['entertainment', 'movies', 'music', 'tv'],
    keywords: ['entertainment', 'movie', 'music', 'tv', 'television', 'oscar', 'grammy', 'super bowl', 'halftime']
  },
  { 
    id: 'health', 
    label: 'Health', 
    tagId: null, // Health might not have a specific tag_id, use query fallback
    query: 'health', 
    categoryValues: ['health', 'medical', 'medicine', 'healthcare', 'health care'],
    keywords: [
      'health', 'medical', 'medicine', 'covid', 'vaccine', 'fda', 'drug', 'treatment', 
      'hospital', 'doctor', 'disease', 'illness', 'pandemic', 'epidemic', 'pharmaceutical', 
      'pharma', 'patient', 'surgery', 'diagnosis', 'therapy', 'clinic', 'nurse', 
      'prescription', 'medication', 'cure', 'symptom', 'infection', 'virus', 'bacteria',
      'cancer', 'diabetes', 'heart', 'blood', 'organ', 'transplant', 'mental health',
      'psychology', 'psychiatry', 'wellness', 'fitness', 'nutrition', 'diet'
    ]
  },
  { 
    id: 'weather', 
    label: 'Weather', 
    tagId: null, // Weather might not have a specific tag_id, use query fallback
    query: 'weather climate temperature hurricane', 
    categoryValues: ['weather', 'climate', 'temperature'],
    keywords: ['weather', 'climate', 'temperature', 'hurricane', 'tornado', 'rain', 'snow', 'storm', 'flood', 'drought', 'heat', 'cold', 'fahrenheit', 'celsius', 'precipitation', 'forecast']
  },
  { 
    id: 'economics', 
    label: 'Economics', 
    tagId: null, // Economics might not have a specific tag_id, use query fallback
    query: 'economics gdp unemployment inflation', 
    categoryValues: ['economics', 'economic', 'economy'],
    keywords: ['economics', 'economic', 'economy', 'gdp', 'unemployment', 'recession', 'inflation', 'deflation', 'fed', 'federal reserve', 'interest rate', 'monetary', 'fiscal', 'growth', 'recession']
  },
] as const;

export type MarketCategory = typeof POLYMARKET_CATEGORIES[number]['id'];

function normalizeSearchText(text: string | undefined): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9/%.+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWholeTerm(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeSearchText(haystack);
  const normalizedNeedle = normalizeSearchText(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;

  const pattern = normalizedNeedle
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join('\\s+');

  if (!pattern) return false;
  return new RegExp(`(^|\\b)${pattern}(\\b|$)`, 'i').test(normalizedHaystack);
}

function tokenizeSearchQuery(query: string): string[] {
  return Array.from(
    new Set(
      normalizeSearchText(query)
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
    )
  );
}

function getSearchRelevanceScore(market: PolymarketMarket, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchQuery(query);
  if (!normalizedQuery || queryTokens.length === 0) return 0;

  const question = normalizeSearchText(market.question);
  const description = normalizeSearchText(market.description);
  const category = normalizeSearchText(market.category);
  const combined = [question, description, category].filter(Boolean).join(' ');

  const questionHasPhrase = question.includes(normalizedQuery);
  const descriptionHasPhrase = description.includes(normalizedQuery);
  const categoryHasPhrase = category.includes(normalizedQuery);
  const questionExact = question === normalizedQuery;
  const questionStartsWith = question.startsWith(normalizedQuery);

  const questionWholeMatches = queryTokens.filter((token) => hasWholeTerm(question, token)).length;
  const descriptionWholeMatches = queryTokens.filter((token) => hasWholeTerm(description, token)).length;
  const categoryWholeMatches = queryTokens.filter((token) => hasWholeTerm(category, token)).length;

  const allQuestionTokensMatch = queryTokens.length > 1 && queryTokens.every((token) => hasWholeTerm(question, token));
  const allCombinedTokensMatch = queryTokens.length > 1 && queryTokens.every((token) => hasWholeTerm(combined, token));

  const hasAnySignal = questionHasPhrase
    || descriptionHasPhrase
    || categoryHasPhrase
    || questionWholeMatches > 0
    || descriptionWholeMatches > 0
    || categoryWholeMatches > 0;

  if (!hasAnySignal) return 0;

  let score = 0;

  if (questionExact) score += 220;
  else if (questionStartsWith) score += 170;
  else if (questionHasPhrase) score += 130;

  if (descriptionHasPhrase) score += 55;
  if (category === normalizedQuery) score += 45;
  else if (categoryHasPhrase) score += 28;

  if (allQuestionTokensMatch) score += 75;
  else if (allCombinedTokensMatch) score += 42;

  score += questionWholeMatches * 24;
  score += descriptionWholeMatches * 10;
  score += categoryWholeMatches * 14;

  score += Math.min((market.volume || 0) / 10_000, 8);
  score += Math.min((market.liquidity || 0) / 5_000, 5);

  const threshold = queryTokens.length > 1 ? 40 : 28;
  return score >= threshold ? score : 0;
}

export function rankMarketsForSearch(
  markets: PolymarketMarket[],
  query: string,
  limit: number = 50
): PolymarketMarket[] {
  const seen = new Set<string>();
  const scored = markets
    .map((market) => ({ market, score: getSearchRelevanceScore(market, query) }))
    .filter(({ market, score }) => {
      if (score <= 0) return false;
      if (seen.has(market.id)) return false;
      seen.add(market.id);
      return true;
    });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.volume || 0) !== (a.volume || 0)) return (b.volume || 0) - (a.volume || 0);
    if ((b.liquidity || 0) !== (a.liquidity || 0)) return (b.liquidity || 0) - (a.liquidity || 0);
    const dateA = a.market.endDate ? new Date(a.market.endDate).getTime() : 0;
    const dateB = b.market.endDate ? new Date(b.market.endDate).getTime() : 0;
    return dateB - dateA;
  });

  return scored.slice(0, limit).map(({ market }) => market);
}

/**
 * Format category name for display
 */
export function formatCategoryName(category: string | undefined): string {
  if (!category) return 'General';
  
  // Find matching category config
  const categoryConfig = POLYMARKET_CATEGORIES.find(c => {
    if (c.id === category.toLowerCase() || c.label.toLowerCase() === category.toLowerCase()) {
      return true;
    }
    if (c.categoryValues && Array.isArray(c.categoryValues)) {
      return c.categoryValues.some((v: string) => typeof v === 'string' && v.toLowerCase() === category.toLowerCase());
    }
    return false;
  });
  
  if (categoryConfig) {
    return categoryConfig.label;
  }
  
  // Capitalize first letter
  return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

function extractPriceToBeat(m: any): string | undefined {
  const question = (m.question || m.title || '').toLowerCase();
  const isUpDown = question.includes('up or down')
    || (() => {
      try {
        const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        return Array.isArray(outcomes) && outcomes.some((o: string) => /^(up|down)$/i.test(o));
      } catch { return false; }
    })();

  if (!isUpDown) return undefined;

  // Gather ALL text sources where the price might appear
  const texts: string[] = [];

  // Market-level description
  if (m.description) texts.push(m.description);

  // Event-level descriptions and titles (events array embedded in market response)
  if (Array.isArray(m.events)) {
    for (const ev of m.events) {
      if (ev.description) texts.push(ev.description);
      if (ev.title) texts.push(ev.title);
    }
  }

  // groupItemThreshold — could be the strike price or just a sort index
  if (m.groupItemThreshold != null) {
    const raw = String(m.groupItemThreshold);
    const val = parseFloat(raw);
    // Accept if it looks like a real price (has decimal OR is a big number)
    if (!isNaN(val) && val > 0 && (raw.includes('.') || val >= 10)) {
      return `$${raw}`;
    }
  }

  // Search text sources for price patterns
  const combined = texts.join(' ');
  if (combined) {
    const pricePatterns = [
      /(?:opening\s+price|initial\s+price|starting\s+price|price\s+at\s+open|snapshot\s+price|reference\s+price)[\s:]*\$?([\d,]+(?:\.\d+)?)/i,
      /(?:higher|above|greater|over|exceed|at\s+or\s+above)\s+(?:than\s+)?\$?([\d,]+(?:\.\d+)?)/i,
      /(?:price|level|value|threshold)\s+(?:of|is|was|at)\s+\$?([\d,]+(?:\.\d+)?)/i,
      /(?:lower|below|under|at\s+or\s+below)\s+(?:than\s+)?\$?([\d,]+(?:\.\d+)?)/i,
    ];
    for (const pattern of pricePatterns) {
      const match = combined.match(pattern);
      if (match) {
        const val = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(val) && val > 0) return `$${match[1].replace(/,/g, '')}`;
      }
    }

    // Fallback: any dollar amount that isn't $1 (payout reference)
    const dollars = [...combined.matchAll(/\$([\d,]+(?:\.\d+)?)/g)];
    for (const d of dollars) {
      const val = parseFloat(d[1].replace(/,/g, ''));
      if (!isNaN(val) && val > 0 && val !== 1) return `$${d[1].replace(/,/g, '')}`;
    }
  }

  // Check other raw fields that might contain a price
  for (const field of ['strike', 'strikePrice', 'strike_price', 'openPrice', 'open_price', 'referencePrice', 'reference_price', 'benchmarkPrice', 'benchmark_price', 'startPrice', 'start_price']) {
    if (m[field] != null) {
      const val = parseFloat(String(m[field]));
      if (!isNaN(val) && val > 0) return `$${m[field]}`;
    }
  }

  return undefined;
}

function mapMarket(m: any): PolymarketMarket | null {
  // Skip if no question or id (required fields)
  if (!m.question && !m.questionID && !m.id && !m.condition_id && !m.slug) {
    console.warn('[mapMarket] Skipping market with no identifier:', m);
    return null;
  }
  
  // Parse outcomes - can be JSON string or array
  let outcomes: string[] = ['Yes', 'No'];
  if (m.outcomes) {
    if (typeof m.outcomes === 'string') {
      try {
        outcomes = JSON.parse(m.outcomes);
      } catch {
        outcomes = ['Yes', 'No'];
      }
    } else if (Array.isArray(m.outcomes)) {
      outcomes = m.outcomes;
    }
  }

  // Parse outcomePrices - can be JSON string or array
  // Try multiple field names and formats
  let outcomePrices: string[] | undefined;
  
  // Try all possible field names for prices
  const pricesRaw = m.outcomePrices || m.outcome_prices || m.prices || m.price || m.outcomePrice 
    || m.tokenPrices || m.token_prices || m.poolPrices || m.pool_prices;
  
  if (pricesRaw) {
    if (typeof pricesRaw === 'string') {
      try {
        outcomePrices = JSON.parse(pricesRaw);
      } catch {
        // If parsing fails, try splitting by comma
        try {
          outcomePrices = pricesRaw.split(',').map((p: string) => p.trim());
        } catch {
          outcomePrices = undefined;
        }
      }
    } else if (Array.isArray(pricesRaw)) {
      outcomePrices = pricesRaw.map((p: any) => String(p));
    } else if (typeof pricesRaw === 'object' && pricesRaw !== null) {
      // Handle object format like {yes: 0.5, no: 0.5}
      if ('yes' in pricesRaw || 'YES' in pricesRaw || 'Yes' in pricesRaw) {
        const yesPrice = pricesRaw.yes || pricesRaw.YES || pricesRaw.Yes || '0.5';
        const noPrice = pricesRaw.no || pricesRaw.NO || pricesRaw.No || '0.5';
        outcomePrices = [String(yesPrice), String(noPrice)];
      }
    }
  }
  
  // Try extracting from tokens array (common in Polymarket API)
  if (!outcomePrices && Array.isArray(m.tokens) && m.tokens.length >= 2) {
    outcomePrices = m.tokens.map((token: any) => {
      // Try various price fields in token object
      const price = token.price || token.lastPrice || token.currentPrice || token.tokenPrice || '0.5';
      return String(price);
    });
  }
  
  // Try extracting from outcomeTokens array
  if (!outcomePrices && Array.isArray(m.outcomeTokens) && m.outcomeTokens.length >= 2) {
    outcomePrices = m.outcomeTokens.map((token: any) => {
      const price = token.price || token.lastPrice || token.currentPrice || token.tokenPrice || '0.5';
      return String(price);
    });
  }
  
  // If still no prices, try to extract from other fields
  if (!outcomePrices && (m.yesPrice !== undefined || m.noPrice !== undefined)) {
    outcomePrices = [
      String(m.yesPrice || m.yes_price || m.YES || '0.5'),
      String(m.noPrice || m.no_price || m.NO || '0.5')
    ];
  }
  
  // Last resort: if we have outcomes but no prices, default to 50/50
  // BUT we'll mark this as invalid data later
  if (!outcomePrices && outcomes.length >= 2) {
    outcomePrices = ['0.5', '0.5'];
  }

  const marketId = m.id || m.condition_id || m.questionID || m.slug || `market-${Date.now()}-${Math.random()}`;
  const question = m.question || m.title || m.name || 'Untitled Market';
  
  // Extract category - try multiple fields and normalize
  let category = m.category || m.seriesSlug || m.series || m.groupItemTitle || m.tags?.[0] || '';
  category = category.toLowerCase().trim();
  
  // Normalize common category variations
  if (!category || category === 'general' || category === 'uncategorized') {
    // Try to infer category from question/description
    const combined = normalizeSearchText(`${question} ${m.description || m.desc || ''}`);
    
    // Check against category keywords
    for (const catConfig of POLYMARKET_CATEGORIES) {
      if (catConfig.id === 'all') continue;
      const keywordHits = catConfig.keywords.filter((keyword) => hasWholeTerm(combined, keyword)).length;
      const categoryValueHits = catConfig.categoryValues.filter((value) => hasWholeTerm(combined, value)).length;
      if (keywordHits > 0 || categoryValueHits > 0 || hasWholeTerm(combined, catConfig.label)) {
        category = catConfig.id;
        break;
      }
      if (category && category !== 'general') break;
    }
    
    // If still no category, set to 'General'
    if (!category || category === 'general') {
      category = 'General';
    }
  }

  let clobTokenIds: string[] | undefined;
  if (m.clobTokenIds) {
    if (typeof m.clobTokenIds === 'string') {
      try { clobTokenIds = JSON.parse(m.clobTokenIds); } catch { clobTokenIds = undefined; }
    } else if (Array.isArray(m.clobTokenIds)) {
      clobTokenIds = m.clobTokenIds;
    }
  }
  if (!clobTokenIds && m.clob_token_ids) {
    if (typeof m.clob_token_ids === 'string') {
      try { clobTokenIds = JSON.parse(m.clob_token_ids); } catch { clobTokenIds = undefined; }
    } else if (Array.isArray(m.clob_token_ids)) {
      clobTokenIds = m.clob_token_ids.map((id: unknown) => String(id));
    }
  }
  if (!clobTokenIds && Array.isArray(m.tokens) && m.tokens.length >= 2) {
    const ids = m.tokens
      .map((token: any) => token.token_id || token.asset_id || token.clobTokenId || token.clob_token_id)
      .filter(Boolean)
      .map((id: unknown) => String(id));
    if (ids.length >= 2) {
      clobTokenIds = ids;
    }
  }

  const mappedMarket = {
    id: marketId,
    slug: m.slug || m.id || marketId,
    question: question,
    description: m.description || m.desc || '',
    category: category,
    active: m.active !== false && m.active !== 'false',
    closed: m.closed === true || m.closed === 'true',
    outcomes,
    outcomePrices,
    volume: parseFloat(m.volume || m.volumeNum || m.totalVolume || m.volumeUSD || m.volume_usd || '0') || 0,
    liquidity: parseFloat(m.liquidity || m.liquidityNum || m.totalLiquidity || m.liquidityUSD || m.liquidity_usd || '0') || 0,
    endDate: m.end_date_iso || m.endDate || m.end_date || m.endDateISO,
    image: m.image || m.imageUrl || m.img,
    startDate: m.start_date_iso || m.startDate || m.startDateIso,
    gameStartTime: m.gameStartTime || m.game_start_time,
    volume24hr: parseFloat(m.volume24hr || m.volume_24hr || '0') || 0,
    volume1wk: parseFloat(m.volume1wk || m.volume_1wk || '0') || 0,
    acceptingOrders: m.acceptingOrders ?? m.accepting_orders ?? true,
    enableOrderBook: m.enableOrderBook ?? m.enable_order_book ?? false,
    competitive: parseFloat(m.competitive || '0') || 0,
    icon: m.icon,
    clobTokenIds,
    groupItemThreshold: m.groupItemThreshold || m.group_item_threshold || undefined,
    groupItemTitle: m.groupItemTitle || m.group_item_title || undefined,
    priceToBeat: extractPriceToBeat(m),
  };
  
  // Log if critical data is missing for debugging
  if (!outcomePrices || outcomePrices.length < 2) {
    console.warn(`[mapMarket] Market ${marketId} missing outcomePrices:`, {
      hasOutcomePrices: !!outcomePrices,
      outcomePricesLength: outcomePrices?.length,
      rawPrices: pricesRaw,
      marketId
    });
  }
  
  if (mappedMarket.volume === 0 && mappedMarket.liquidity === 0) {
    console.warn(`[mapMarket] Market ${marketId} has zero volume and liquidity:`, {
      volume: mappedMarket.volume,
      liquidity: mappedMarket.liquidity,
      rawVolume: m.volume || m.volumeNum || m.totalVolume,
      rawLiquidity: m.liquidity || m.liquidityNum || m.totalLiquidity
    });
  }
  
  return mappedMarket;
}

/**
 * Check if a market has real data (not default/placeholder values)
 * Returns true if market has real probabilities, volume, or liquidity
 */
function hasRealMarketData(market: PolymarketMarket): boolean {
  // Calculate probabilities directly from outcomePrices
  let yesProb = 0.5;
  let noProb = 0.5;
  
  const prices = market.outcomePrices;
  if (prices && prices.length >= 2) {
    const yesPrice = parseFloat(prices[0]);
    const noPrice = parseFloat(prices[1]);
    
    if (!isNaN(yesPrice) && !isNaN(noPrice) && yesPrice >= 0 && noPrice >= 0) {
      const sum = yesPrice + noPrice;
      if (sum > 0) {
        yesProb = yesPrice / sum;
        noProb = noPrice / sum;
      }
    }
  }
  
  // Check if probabilities are real (not default 50/50)
  const isDefaultProb = Math.abs(yesProb - 0.5) < 0.001 && Math.abs(noProb - 0.5) < 0.001;
  
  // Market is valid if it has:
  // 1. Real probabilities (not 50/50 default) OR
  // 2. Volume > 0 OR
  // 3. Liquidity > 0
  return !isDefaultProb || market.volume > 0 || market.liquidity > 0;
}

/**
 * Filter markets to only include those with real data
 */
function filterMarketsWithRealData(markets: PolymarketMarket[]): PolymarketMarket[] {
  return markets.filter((market) => {
    const hasData = hasRealMarketData(market);
    if (!hasData) {
      // Calculate probabilities for logging
      let yesProb = 0.5;
      let noProb = 0.5;
      const prices = market.outcomePrices;
      if (prices && prices.length >= 2) {
        const yesPrice = parseFloat(prices[0]);
        const noPrice = parseFloat(prices[1]);
        if (!isNaN(yesPrice) && !isNaN(noPrice) && yesPrice >= 0 && noPrice >= 0) {
          const sum = yesPrice + noPrice;
          if (sum > 0) {
            yesProb = yesPrice / sum;
            noProb = noPrice / sum;
          }
        }
      }
      console.log(`[Polymarket API] Filtering out market ${market.id} - no real data (prob: ${yesProb.toFixed(3)}/${noProb.toFixed(3)}, vol: ${market.volume}, liq: ${market.liquidity})`);
    }
    return hasData;
  });
}

/**
 * Process raw API response into markets array
 */
function processMarketsResponse(data: unknown, cacheKey: string): PolymarketMarket[] {
  let marketsArray: unknown[] = [];
  if (Array.isArray(data)) {
    marketsArray = data;
  } else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).results)) {
    marketsArray = (data as Record<string, unknown>).results as unknown[];
  } else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).markets)) {
    marketsArray = (data as Record<string, unknown>).markets as unknown[];
  } else if (data && typeof data === 'object') {
    marketsArray = [data];
  }
  
  const markets = marketsArray.map(mapMarket).filter(Boolean) as PolymarketMarket[];
  const validMarkets = filterMarketsWithRealData(markets);
  
  if (validMarkets.length > 0) {
    cacheSet(cacheKey, validMarkets);
  }
  
  return validMarkets;
}

/**
 * Fetch markets from Polymarket API with comprehensive filtering
 * Makes direct API calls to Polymarket's gamma API
 */
export async function fetchMarkets(filters: MarketFilters = {}): Promise<PolymarketMarket[]> {
  const params: Record<string, string> = {
    closed: filters.closed === undefined ? 'false' : String(filters.closed),
    limit: String(filters.limit || 50),
  };

  // Try session cache first to avoid repeated spinners if the user revisits quickly
  const cacheKey = `markets:${JSON.stringify(filters || {})}`;
  const cached = cacheGet<PolymarketMarket[]>(cacheKey);
  if (cached && cached.length > 0) {
    console.log(`[Polymarket API] Cache hit for markets`, { filters, count: cached.length });
    return cached;
  }

  // Add query parameter (this is the search term)
  if (filters.query) {
    params._q = filters.query;
  }

  // Add category filter - use tag_id if available (Polymarket API standard)
  if (filters.tagId !== undefined && filters.tagId !== null) {
    params.tag_id = String(filters.tagId);
  } else if (filters.category) {
    params.category = filters.category;
  }

  // Add active filter
  if (filters.active !== undefined) {
    params.active = String(filters.active);
  }

  // Add date filters
  if (filters.startDateMin) {
    params.start_date_min = filters.startDateMin;
  }
  if (filters.startDateMax) {
    params.start_date_max = filters.startDateMax;
  }
  if (filters.endDateMin) {
    params.end_date_min = filters.endDateMin;
  }
  if (filters.endDateMax) {
    params.end_date_max = filters.endDateMax;
  }

  // Add volume/liquidity filters
  if (filters.minVolume) {
    params.min_volume = String(filters.minVolume);
  }
  if (filters.minLiquidity) {
    params.min_liquidity = String(filters.minLiquidity);
  }

  // Add ordering - Polymarket API uses different parameter names
  // Only include if orderBy is valid (volume, liquidity work, but 'created' might not)
  if (filters.orderBy) {
    // Map our orderBy values to API-compatible values
    const orderMap: Record<string, string> = {
      'volume': 'volume',
      'liquidity': 'liquidity',
      'endDate': 'endDate',
      'created': 'created', // Try it, but might not work
    };
    
    const apiOrder = orderMap[filters.orderBy];
    if (apiOrder) {
      // Try without order parameter first if it's 'created', use volume as fallback
      if (filters.orderBy === 'created') {
        // Don't add order for 'created' - API might not support it
        // We'll sort client-side instead
      } else {
        params.order = apiOrder;
        params.ascending = String(filters.ascending !== false);
      }
    }
  }

  // Add offset for pagination
  if (filters.offset) {
    params.offset = String(filters.offset);
  }

  // Add cache-busting timestamp with microsecond precision to ensure we always get the latest data
  // Use performance.now() for higher precision timing
  params._t = String(Date.now() + (typeof performance !== 'undefined' ? performance.now() : 0));
  // Add random component to prevent any caching
  params._r = String(Math.random());
  
  const qs = new URLSearchParams(params);
  const apiUrl = `${gammaBase}/markets?${qs.toString()}`;
  
  try {
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: { 
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    
    // Handle 304 Not Modified - this means we need to retry without cache headers
    // or the data hasn't changed (which is fine, but we need the data)
    if (res.status === 304) {
      // Retry with a fresh URL (add extra random param)
      const retryUrl = `${apiUrl}&_retry=${Date.now()}`;
      const retryRes = await fetch(retryUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'reload',
      });
      if (!retryRes.ok && retryRes.status !== 304) {
        throw new Error(`Polymarket API error: ${retryRes.status} ${retryRes.statusText}`);
      }
      if (retryRes.status === 304) {
        // If still 304, return empty and rely on cache
        const cached = cacheGet<PolymarketMarket[]>(cacheKey);
        if (cached) return cached;
        return [];
      }
      const data = await retryRes.json();
      return processMarketsResponse(data, cacheKey);
    }
    
    if (!res.ok) {
      throw new Error(`Polymarket API error: ${res.status} ${res.statusText}`);
    }
    
    const data = await res.json();
    return processMarketsResponse(data, cacheKey);
  } catch (error) {
    // On error, try to return cached data if available
    const cached = cacheGet<PolymarketMarket[]>(cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }
    throw error;
  }
}

/**
 * Search markets with live results from Polymarket API
 * This function makes direct API calls to Polymarket to get real-time results
 */
export async function searchMarkets(
  query: string,
  additionalFilters?: Omit<MarketFilters, 'query'>,
  category?: MarketCategory
): Promise<{ markets: PolymarketMarket[]; hasMore: boolean }> {
  try {
    if (!query || query.trim().length === 0) {
      // If no query, fetch latest markets
      return fetchCuratedLatest().then(markets => ({
        markets,
        hasMore: markets.length >= 50,
      }));
    }

    const trimmedQuery = query.trim();
    console.log('[Polymarket Search] Searching for:', trimmedQuery);
    const categoryConfig = category && category !== 'all' && category !== 'ending-soon'
      ? POLYMARKET_CATEGORIES.find((item) => item.id === category) ?? null
      : null;

    const filters: MarketFilters = {
      query: trimmedQuery,
      active: true,
      closed: false,
      limit: 120,
      orderBy: 'volume', // Use volume since 'created' is not supported by API
      ascending: false,
      ...additionalFilters,
    };

    // Make direct API call to Polymarket
    let markets = await fetchMarkets(filters);
    console.log(`[Polymarket Search] Found ${markets.length} markets for query: "${trimmedQuery}"`);

    if (categoryConfig) {
      markets = markets.filter((market) => marketMatchesCategory(market, categoryConfig));
    }

    let rankedMarkets = rankMarketsForSearch(markets, trimmedQuery, 50);
    console.log(`[Polymarket Search] Ranked ${rankedMarkets.length} relevant markets for "${trimmedQuery}"`);

    if (rankedMarkets.length === 0) {
      const fallbackToken = tokenizeSearchQuery(trimmedQuery).sort((a, b) => b.length - a.length)[0];
      if (fallbackToken && fallbackToken !== normalizeSearchText(trimmedQuery)) {
        console.warn(`[Polymarket Search] No strong matches for "${trimmedQuery}", retrying with fallback token "${fallbackToken}"`);
        const broaderMarkets = await fetchMarkets({
          ...filters,
          query: fallbackToken,
          limit: 160,
        });

        const scopedMarkets = categoryConfig
          ? broaderMarkets.filter((market) => marketMatchesCategory(market, categoryConfig))
          : broaderMarkets;

        rankedMarkets = rankMarketsForSearch(scopedMarkets, trimmedQuery, 50);
      }
    }

    return {
      markets: rankedMarkets,
      hasMore: rankedMarkets.length >= 50,
    };
  } catch (error) {
    console.error('[Polymarket Search] Error:', error);
    // Return empty result instead of throwing
    return { markets: [], hasMore: false };
  }
}

/**
 * Fetch latest curated markets with focus on January 2026 events
 */
/**
 * Helper function to check if a market matches a category
 * Made more lenient to ensure we get results, especially for categories without tag_id
 */
function marketMatchesCategory(market: PolymarketMarket, categoryConfig: typeof POLYMARKET_CATEGORIES[number]): boolean {
  return getCategoryMatchScore(market, categoryConfig) > 0;
}

function getCategoryMatchScore(market: PolymarketMarket, categoryConfig: typeof POLYMARKET_CATEGORIES[number]): number {
  if (categoryConfig.id === 'all') return 100;
  
  const marketCategory = normalizeSearchText(market.category);
  const question = normalizeSearchText(market.question);
  const description = normalizeSearchText(market.description);
  const combined = `${question} ${description} ${marketCategory}`.trim();
  const label = normalizeSearchText(categoryConfig.label);
  
  // For categories without tag_id (Health, Weather, Economics), be more lenient
  const isTaglessCategory = categoryConfig.tagId === null || categoryConfig.tagId === undefined;
  let score = 0;
  
  // Check if category field directly matches
  if (marketCategory) {
    // Direct match
    if (marketCategory === normalizeSearchText(categoryConfig.id)) {
      score += 160;
    }
    
    // Check category values (partial match)
    for (const catValue of categoryConfig.categoryValues) {
      const normalizedValue = normalizeSearchText(catValue);
      if (marketCategory === normalizedValue) {
        score += 120;
      } else if (hasWholeTerm(marketCategory, normalizedValue)) {
        score += 80;
      }
    }
  }
  
  // Check if keywords appear as whole terms in question/description
  let keywordMatches = 0;
  for (const keyword of categoryConfig.keywords) {
    const normalizedKeyword = normalizeSearchText(keyword);
    if (!normalizedKeyword) continue;
    if (hasWholeTerm(combined, normalizedKeyword)) {
      keywordMatches++;
    }
  }

  score += Math.min(keywordMatches, 4) * (isTaglessCategory ? 22 : 18);

  if (hasWholeTerm(combined, label)) {
    score += 42;
  }
  
  if (isTaglessCategory) {
    const categoryWords = tokenizeSearchQuery(label);
    const matchingCategoryWords = categoryWords.filter((word) => hasWholeTerm(combined, word)).length;
    if (matchingCategoryWords > 0) {
      score += matchingCategoryWords * 12;
    }
    
    // For Health: also check for medical-related terms
    if (categoryConfig.id === 'health') {
      const healthTerms = ['medical', 'medicine', 'hospital', 'doctor', 'patient', 'treatment', 'disease', 'illness'];
      for (const term of healthTerms) {
        if (hasWholeTerm(combined, term)) {
          score += 14;
        }
      }
    }
    
    // For Weather: also check for weather-related terms
    if (categoryConfig.id === 'weather') {
      const weatherTerms = ['temperature', 'rain', 'snow', 'storm', 'hurricane', 'tornado', 'climate'];
      for (const term of weatherTerms) {
        if (hasWholeTerm(combined, term)) {
          score += 12;
        }
      }
    }
    
    // For Economics: also check for economic terms
    if (categoryConfig.id === 'economics') {
      const econTerms = ['gdp', 'unemployment', 'inflation', 'economy', 'economic', 'recession', 'fed', 'federal reserve'];
      for (const term of econTerms) {
        if (hasWholeTerm(combined, term)) {
          score += 12;
        }
      }
    }
  }
  
  const threshold = isTaglessCategory ? 28 : 18;
  return score >= threshold ? score : 0;
}

/**
 * Fetch available tags from Polymarket API
 * This can be used to discover tag_id values for categories
 */
export async function fetchTags(): Promise<Array<{ id: number; label: string; slug: string }>> {
  try {
    const apiUrl = `${gammaBase}/tags?limit=200&_t=${Date.now()}`;
    console.log('[Polymarket API] Fetching tags from:', apiUrl);
    
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: { 
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      },
      cache: 'no-store',
      credentials: 'omit',
    });
    
    if (!res.ok) {
      console.warn(`[Polymarket API] Tags fetch error ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    const tags = Array.isArray(data) ? data : (data.results || data.tags || []);
    console.log(`[Polymarket API] Fetched ${tags.length} tags`);
    return tags.map((t: any) => ({
      id: t.id || t.tag_id,
      label: t.label || t.name || '',
      slug: t.slug || '',
    }));
  } catch (error) {
    console.error('[Polymarket API] Error fetching tags:', error);
    return [];
  }
}

/**
 * Fetch latest markets by category - optimized for real-time updates
 * Uses tag_id for accurate API-level filtering, with client-side filtering as backup
 */
/**
 * Fetch markets ending within 1 hour
 * Perfect for users who want to see quick settlements
 */
export async function fetchEndingSoonMarkets(limit: number = 50): Promise<PolymarketMarket[]> {
  try {
    const now = new Date();
    const cutoffMs = getBetCutoffMs();
    const firstBettableEnd = new Date(now.getTime() + cutoffMs);
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000); // Add 1 hour in milliseconds
    
    // Format as ISO strings for API
    const endDateMin = firstBettableEnd.toISOString();
    const endDateMax = oneHourFromNow.toISOString();
    
    console.log(`[fetchEndingSoonMarkets] Fetching markets ending between ${endDateMin} and ${endDateMax}`);
    
    // Fetch markets with end date between now and 1 hour from now
    const markets = await fetchMarkets({
      active: true,
      closed: false,
      endDateMin: endDateMin,
      endDateMax: endDateMax,
      limit: limit * 2, // Fetch more to account for filtering
      orderBy: 'endDate',
      ascending: true, // Soonest first
    });
    
    // Additional client-side filtering to ensure they're really ending soon
    const nowTime = now.getTime() + cutoffMs;
    const oneHourTime = oneHourFromNow.getTime();
    
    const endingSoonMarkets = markets.filter(market => {
      if (!market.endDate) return false;
      
      try {
        const marketEndTime = new Date(market.endDate).getTime();
        // Market must end between now and 1 hour from now
        return marketEndTime > nowTime && marketEndTime <= oneHourTime;
      } catch (error) {
        console.warn(`[fetchEndingSoonMarkets] Invalid endDate for market ${market.id}:`, market.endDate);
        return false;
      }
    });
    
    // Sort by end date (soonest first)
    endingSoonMarkets.sort((a, b) => {
      const dateA = a.endDate ? new Date(a.endDate).getTime() : Infinity;
      const dateB = b.endDate ? new Date(b.endDate).getTime() : Infinity;
      return dateA - dateB; // Soonest first
    });
    
    console.log(`[fetchEndingSoonMarkets] Found ${endingSoonMarkets.length} markets ending within 1 hour`);
    return endingSoonMarkets.slice(0, limit);
  } catch (error) {
    console.error('[fetchEndingSoonMarkets] Error fetching ending soon markets:', error);
    // Fallback: try without date filters
    try {
      const allMarkets = await fetchMarkets({
        active: true,
        closed: false,
        limit: limit * 3,
        orderBy: 'endDate',
        ascending: true,
      });
      
      const now = new Date();
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
      const nowTime = now.getTime() + getBetCutoffMs();
      const oneHourTime = oneHourFromNow.getTime();
      
      const endingSoon = allMarkets.filter(m => {
        if (!m.endDate) return false;
        const marketEndTime = new Date(m.endDate).getTime();
        return marketEndTime > nowTime && marketEndTime <= oneHourTime;
      });
      
      endingSoon.sort((a, b) => {
        const dateA = a.endDate ? new Date(a.endDate).getTime() : Infinity;
        const dateB = b.endDate ? new Date(b.endDate).getTime() : Infinity;
        return dateA - dateB;
      });
      
      console.log(`[fetchEndingSoonMarkets] Fallback: Found ${endingSoon.length} markets ending within 1 hour`);
      return endingSoon.slice(0, limit);
    } catch (fallbackError) {
      console.error('[fetchEndingSoonMarkets] Fallback also failed:', fallbackError);
      return [];
    }
  }
}

/**
 * Whether a market is still genuinely contested (worth showing as a new pick).
 * Hides already-decided / lopsided markets where one outcome trades at or above
 * `threshold` (default 95%) — e.g. "Bitcoin < $54k" at 0.1% / 100%. These carry
 * no prediction value and are easy to game. Markets without price data pass
 * through (we don't over-filter on missing data).
 *
 * ⚠️ DISPLAY/DISCOVERY ONLY. This is a read-side visibility predicate — it must
 * NEVER gate resolution, pricing, snapshots, by-ID lookups, or settlement. Those
 * paths must always use the raw, unfiltered Polymarket data so on-chain
 * settlement stays consistent with Polymarket. Do not call this from
 * getMarketDetails(Batch), createSnapshot, betCalculator, or the settler bot.
 */
export function isTradeableMarket(market: PolymarketMarket, threshold: number = 0.95): boolean {
  const prices = (market.outcomePrices || [])
    .map((p) => parseFloat(p))
    .filter((n) => !Number.isNaN(n));
  if (prices.length < 2) return true;
  return Math.max(...prices) <= threshold && Math.min(...prices) >= 1 - threshold;
}

export async function fetchMarketsByCategory(category: MarketCategory, limit: number = 50): Promise<PolymarketMarket[]> {
  // Handle special "ending-soon" category
  if (category === 'ending-soon') {
    return fetchEndingSoonMarkets(limit);
  }

  const categoryConfig = POLYMARKET_CATEGORIES.find(c => c.id === category);
  if (!categoryConfig || category === 'all') {
    // Fetch all markets, ordered by volume (API doesn't support 'created')
    try {
      const markets = await fetchMarkets({
        active: true,
        closed: false,
        limit,
        orderBy: 'volume',
        ascending: false,
      });
      // Sort by date client-side
      markets.sort((a, b) => {
        const dateA = a.endDate ? new Date(a.endDate).getTime() : 0;
        const dateB = b.endDate ? new Date(b.endDate).getTime() : 0;
        return dateB - dateA; // Newest first
      });
      console.log(`[fetchMarketsByCategory] All markets: ${markets.length}`);
      return markets;
    } catch (error) {
      console.error('[fetchMarketsByCategory] Error fetching all markets:', error);
      // Fallback: try without active filter
      const fallback = await fetchMarkets({
        closed: false,
        limit,
        orderBy: 'volume',
        ascending: false,
      });
      fallback.sort((a, b) => {
        const dateA = a.endDate ? new Date(a.endDate).getTime() : 0;
        const dateB = b.endDate ? new Date(b.endDate).getTime() : 0;
        return dateB - dateA;
      });
      return fallback;
    }
  }

  // For specific categories, use tag_id if available (most accurate)
  try {
    const rankCategoryMarkets = (inputMarkets: PolymarketMarket[]): PolymarketMarket[] => {
      const deduped = inputMarkets.filter((market, index, array) =>
        array.findIndex((candidate) => candidate.id === market.id) === index
      );

      return deduped
        .map((market) => ({ market, score: getCategoryMatchScore(market, categoryConfig) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if ((b.market.volume || 0) !== (a.market.volume || 0)) return (b.market.volume || 0) - (a.market.volume || 0);
          if ((b.market.liquidity || 0) !== (a.market.liquidity || 0)) return (b.market.liquidity || 0) - (a.market.liquidity || 0);
          const dateA = a.market.endDate ? new Date(a.market.endDate).getTime() : 0;
          const dateB = b.market.endDate ? new Date(b.market.endDate).getTime() : 0;
          return dateA - dateB;
        })
        .slice(0, limit)
        .map(({ market }) => market);
    };

    let markets: PolymarketMarket[] = [];
    
    // Primary method: Use tag_id if available (most accurate)
    if (categoryConfig.tagId !== null && categoryConfig.tagId !== undefined) {
      console.log(`[fetchMarketsByCategory] Fetching ${categoryConfig.label} using tag_id=${categoryConfig.tagId}`);
      try {
        markets = await fetchMarkets({
          tagId: categoryConfig.tagId,
          active: true,
          closed: false,
          limit: limit,
          // Don't use orderBy 'created' - API doesn't support it, sort client-side instead
          orderBy: 'volume',
          ascending: false,
        });
        console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (tag_id): ${markets.length} markets`);
        
        // If tag_id worked and we got results, return them (API already filtered correctly)
        if (markets.length > 0) {
          return rankCategoryMarkets(markets);
        }
      } catch (error) {
        console.warn(`[fetchMarketsByCategory] tag_id fetch failed for ${categoryConfig.label}, trying fallback:`, error);
      }
    }
    
    // Fallback method: Use query if tag_id not available or if we got few results
    console.log(`[fetchMarketsByCategory] ${categoryConfig.label} using query method`);
    
    // For Health, Weather, Economics - skip query and go straight to broad fetch
    const isProblematicCategory = categoryConfig.id === 'health' || categoryConfig.id === 'weather' || categoryConfig.id === 'economics';
    
    // For categories without tag_id, try multiple query strategies
    let queryMarkets: PolymarketMarket[] = [];
    
    // For problematic categories, skip query and go straight to broad fetch
    if (!isProblematicCategory) {
      // Strategy 1: Try the main query (use first word, as API might not support multi-word queries)
      const mainQuery = categoryConfig.query.split(' ')[0]; // Use first word of query
      try {
        queryMarkets = await fetchMarkets({
          query: mainQuery,
          active: true,
          closed: false,
          limit: limit * 3, // Fetch more for client-side filtering
          orderBy: 'volume',
          ascending: false,
        });
        console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (query: ${mainQuery}): ${queryMarkets.length} markets`);
      } catch (error) {
        console.warn(`[fetchMarketsByCategory] Query failed for ${categoryConfig.label}:`, error);
      }
      
      // Strategy 2: If we got few results, try without active filter
      if (queryMarkets.length < limit) {
        try {
          const additionalMarkets = await fetchMarkets({
            query: mainQuery,
            closed: false,
            limit: limit * 2,
            orderBy: 'volume',
            ascending: false,
          });
          
          // Merge and deduplicate
          const seen = new Set(queryMarkets.map(m => m.id));
          const newMarkets = additionalMarkets.filter(m => !seen.has(m.id));
          queryMarkets = [...queryMarkets, ...newMarkets];
          console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (query fallback): ${additionalMarkets.length} additional markets`);
        } catch (error) {
          console.warn(`[fetchMarketsByCategory] Query fallback failed for ${categoryConfig.label}:`, error);
        }
      }
    }
    
    // Strategy 3: For categories without tag_id (especially Health), fetch ALL markets and filter client-side
    // This is a more reliable fallback when API queries don't work well
    // For Health, Weather, Economics - always do this as primary method
    if (isProblematicCategory || queryMarkets.length < limit / 2) {
      console.log(`[fetchMarketsByCategory] ${categoryConfig.label} trying broad fetch + client-side filter`);
      try {
        // For Health, Weather, Economics - fetch without any filters to get maximum results
        const fetchLimit = isProblematicCategory ? 1000 : 500;
        
        // Fetch a large set of markets without query filter
        const allMarkets = await fetchMarkets({
          active: true,
          closed: false,
          limit: fetchLimit, // Fetch many markets
          orderBy: 'volume',
          ascending: false,
        });
        
        console.log(`[fetchMarketsByCategory] ${categoryConfig.label} fetched ${allMarkets.length} total markets for filtering`);
        
        // Filter client-side using our matching function
        const filtered = allMarkets.filter(m => marketMatchesCategory(m, categoryConfig));
        
        // Merge with existing results
        const seen = new Set(queryMarkets.map(m => m.id));
        const newFiltered = filtered.filter(m => !seen.has(m.id));
        queryMarkets = [...queryMarkets, ...newFiltered];
        
        console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (broad fetch): ${filtered.length} matched, ${newFiltered.length} new`);
      } catch (error) {
        console.warn(`[fetchMarketsByCategory] Broad fetch failed for ${categoryConfig.label}:`, error);
      }
    }
    
    // Strategy 4: Try keyword-based search if still not enough
    if (queryMarkets.length < limit / 2 && categoryConfig.keywords.length > 0) {
      // Try multiple top keywords
      const topKeywords = categoryConfig.keywords.slice(0, 5); // Try top 5 keywords
      for (const keyword of topKeywords) {
        if (queryMarkets.length >= limit) break;
        
        try {
          const keywordMarkets = await fetchMarkets({
            query: keyword,
            closed: false,
            limit: limit,
            orderBy: 'volume',
            ascending: false,
          });
          
          const seen = new Set(queryMarkets.map(m => m.id));
          const newMarkets = keywordMarkets.filter(m => !seen.has(m.id) && marketMatchesCategory(m, categoryConfig));
          queryMarkets = [...queryMarkets, ...newMarkets];
          console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (keyword: ${keyword}): ${keywordMarkets.length} markets, ${newMarkets.length} matched`);
        } catch (error) {
          console.warn(`[fetchMarketsByCategory] Keyword search failed for ${categoryConfig.label} (${keyword}):`, error);
        }
      }
    }
    
    console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (query total): ${queryMarkets.length} markets before filtering`);
    
    // Combine with tag_id results and deduplicate
    const seen = new Set(markets.map(m => m.id));
    const newMarkets = queryMarkets.filter(m => !seen.has(m.id));
    markets = [...markets, ...newMarkets];

    let filteredMarkets = rankCategoryMarkets(markets);
    console.log(`[fetchMarketsByCategory] ${categoryConfig.label}: ${filteredMarkets.length} markets after client-side filtering`);
    
    // If we still don't have enough, try fetching ALL markets and filtering (last resort for Health/Weather/Economics)
    if (filteredMarkets.length < limit / 2 && (categoryConfig.id === 'health' || categoryConfig.id === 'weather' || categoryConfig.id === 'economics')) {
      console.log(`[fetchMarketsByCategory] ${categoryConfig.label} using last resort: fetch all + very lenient filter`);
      try {
        // Fetch a very large batch without any filters - especially for Health
        const fetchLimit = categoryConfig.id === 'health' ? 1000 : 500;
        const allMarketsBroad = await fetchMarkets({
          closed: false,
          limit: fetchLimit, // Fetch a very large batch
          orderBy: 'volume',
          ascending: false,
        });
        
        console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (last resort): fetched ${allMarketsBroad.length} markets for lenient filtering`);
        
        const broadFiltered = rankCategoryMarkets(allMarketsBroad);
        
        // Merge with existing
        const seen = new Set(filteredMarkets.map(m => m.id));
        const newBroad = broadFiltered.filter(m => !seen.has(m.id));
        filteredMarkets = rankCategoryMarkets([...filteredMarkets, ...newBroad]);
        
        console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (last resort): ${broadFiltered.length} matched from ${allMarketsBroad.length} total, ${newBroad.length} new`);
      } catch (error) {
        console.warn(`[fetchMarketsByCategory] Last resort failed for ${categoryConfig.label}:`, error);
      }
    }
    
    // If we have results, return them
    if (filteredMarkets.length > 0) {
      return filteredMarkets;
    }
    
    // Last resort for Health: if we still have 0 results after all strategies,
    // and we fetched markets in the broad fetch, return a sample of them
    // (better than showing nothing)
    // If still not enough, try without active filter
    console.log(`[fetchMarketsByCategory] ${categoryConfig.label} trying without active filter`);
    let fallbackMarkets: PolymarketMarket[] = [];
    
    if (categoryConfig.tagId !== null && categoryConfig.tagId !== undefined) {
      fallbackMarkets = await fetchMarkets({
        tagId: categoryConfig.tagId,
        closed: false,
        limit: limit * 2,
        orderBy: 'volume',
        ascending: false,
      });
    } else {
      fallbackMarkets = await fetchMarkets({
        query: categoryConfig.query,
        closed: false,
        limit: limit * 2,
        orderBy: 'volume',
        ascending: false,
      });
    }
    
    const seenFiltered = new Set(filteredMarkets.map(m => m.id));
    const newFallback = rankCategoryMarkets(fallbackMarkets).filter(m => !seenFiltered.has(m.id));
    filteredMarkets = rankCategoryMarkets([...filteredMarkets, ...newFallback]);
    console.log(`[fetchMarketsByCategory] ${categoryConfig.label} (fallback): ${newFallback.length} additional markets`);
    
    // Remove duplicates and return
    const seenFinal = new Set<string>();
    const uniqueMarkets = filteredMarkets.filter(m => {
      if (seenFinal.has(m.id)) return false;
      seenFinal.add(m.id);
      return true;
    });
    
    console.log(`[fetchMarketsByCategory] ${categoryConfig.label} final: ${uniqueMarkets.length} unique markets`);
    return uniqueMarkets.slice(0, limit);
  } catch (error) {
    console.error(`[fetchMarketsByCategory] Error fetching ${categoryConfig.label}:`, error);
    // Return empty array on error
    return [];
  }
}

export async function fetchCuratedLatest(): Promise<PolymarketMarket[]> {
  const results: PolymarketMarket[] = [];
  const seen = new Set<string>();
  const MAX_HORIZON_DAYS = 180;
  const RECENT_PAST_DAYS = 14;
  const nowTs = Date.now();

  const getDaysFromNow = (market: PolymarketMarket): number | null => {
    if (!market.endDate) return null;
    const ts = new Date(market.endDate).getTime();
    if (!Number.isFinite(ts)) return null;
    return (ts - nowTs) / (1000 * 60 * 60 * 24);
  };

  const isReasonableHorizon = (market: PolymarketMarket): boolean => {
    const daysFromNow = getDaysFromNow(market);
    if (daysFromNow == null) return true;
    return daysFromNow >= -RECENT_PAST_DAYS && daysFromNow <= MAX_HORIZON_DAYS;
  };

  const scoreCuratedMarket = (market: PolymarketMarket): number => {
    const daysFromNow = getDaysFromNow(market);
    let score = 0;

    if (daysFromNow == null) {
      score += 35;
    } else if (daysFromNow < -RECENT_PAST_DAYS || daysFromNow > MAX_HORIZON_DAYS) {
      score -= 200;
    } else if (daysFromNow <= 1) {
      score += 130;
    } else if (daysFromNow <= 7) {
      score += 105 - daysFromNow * 6;
    } else if (daysFromNow <= 30) {
      score += 72 - (daysFromNow - 7) * 1.5;
    } else {
      score += Math.max(0, 28 - (daysFromNow - 30) * 0.18);
    }

    score += Math.min((market.volume || 0) / 25_000, 40);
    score += Math.min((market.liquidity || 0) / 10_000, 22);

    const prices = market.outcomePrices;
    if (prices && prices.length >= 2) {
      const yesProb = parseFloat(prices[0]);
      const noProb = parseFloat(prices[1]);
      const sum = yesProb + noProb;
      if (Number.isFinite(sum) && sum > 0) {
        const yesP = yesProb / sum;
        if (Math.abs(yesP - 0.5) > 0.04) score += 8;
      }
    }

    return score;
  };
  
  // Fetch MORE markets to catch new ones that might not be in top volume
  // Increased limit to ensure we capture newly created markets
  try {
    const allActiveMarkets = await fetchMarkets({
      active: true,
      closed: false,
      limit: 200, // Increased from 100 to catch more markets including new ones
      orderBy: 'volume',
      ascending: false,
    });
    
    console.log(`[fetchCuratedLatest] Fetched ${allActiveMarkets.length} active markets from API`);
    
    // Filter to get diverse markets with real data
    const filtered = allActiveMarkets
      .filter((m) => {
        if (seen.has(m.id)) return false;
        if (m.closed || !m.active) return false;
        if (!isReasonableHorizon(m)) return false;
        // Only include markets with real data (volume or liquidity > 0, or real probabilities)
        const hasRealData = (m.volume && m.volume > 0) || (m.liquidity && m.liquidity > 0);
        if (!hasRealData) {
          // Check if probabilities are real (not default 50/50)
          const prices = m.outcomePrices;
          if (prices && prices.length >= 2) {
            const yesProb = parseFloat(prices[0]);
            const noProb = parseFloat(prices[1]);
            if (!isNaN(yesProb) && !isNaN(noProb) && yesProb >= 0 && noProb >= 0) {
              const sum = yesProb + noProb;
              if (sum > 0) {
                const yesP = yesProb / sum;
                const noP = noProb / sum;
                // If probabilities are not 50/50, it's real data
                if (Math.abs(yesP - 0.5) > 0.01 || Math.abs(noP - 0.5) > 0.01) {
                  seen.add(m.id);
                  return true;
                }
              }
            }
          }
          return false; // No real data
        }
        seen.add(m.id);
        return true;
      })
      .sort((a, b) => scoreCuratedMarket(b) - scoreCuratedMarket(a))
      .slice(0, 30); // Return more markets to show variety and catch new ones
    
    if (filtered.length > 0) {
      console.log(`[fetchCuratedLatest] Found ${filtered.length} active markets with real data`);
      return filtered;
    }
  } catch (err) {
    console.warn('[fetchCuratedLatest] Failed to fetch active markets:', err);
  }
  
  // Fallback: Get current date and fetch markets from now onwards (focus on upcoming events)
  // This helps catch new markets that might not have high volume yet
  const now = new Date();
  const startDate = now.toISOString();
  const endDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(); // Next 90 days
  
  const isRecentMarket = (market: PolymarketMarket): boolean => {
    if (!market.endDate) {
      return true;
    }
    
    try {
      const marketDate = new Date(market.endDate);
      const daysDiff = (marketDate.getTime() - nowTs) / (1000 * 60 * 60 * 24);
      return daysDiff >= -RECENT_PAST_DAYS && daysDiff <= MAX_HORIZON_DAYS;
    } catch {
      return true;
    }
  };
  
  // Helper function to filter out unwanted markets
  const isUnwantedMarket = (market: PolymarketMarket): boolean => {
    const question = (market.question || '').toLowerCase();
    const description = (market.description || '').toLowerCase();
    const combined = `${question} ${description}`;
    
    // Filter out specific political/war markets
    if (combined.includes('china') && combined.includes('taiwan')) return true;
    if (combined.includes('russia') && combined.includes('ukraine')) return true;
    if (combined.includes('invade')) return true;
    if (combined.includes('ceasefire')) return true;
    
    return false;
  };
  
  // Helper function to get date for sorting (prefer endDate, fallback to current date)
  const getSortDate = (market: PolymarketMarket): Date => {
    if (market.endDate) {
      try {
        const date = new Date(market.endDate);
        if (!isNaN(date.getTime())) return date;
      } catch {
        // Invalid date, fall through
      }
    }
    return new Date(); // Fallback to current date
  };
  
  const getRelevanceScore = (market: PolymarketMarket): number => {
    return scoreCuratedMarket(market);
  };
  
  // Helper function to filter and sort markets
  const filterAndSort = (markets: PolymarketMarket[], take: number) => {
    return markets
      .filter((m) => {
        if (seen.has(m.id)) return false;
        // Only filter out closed markets, but be more lenient with active status
        if (m.closed) return false;
        if (isRecentMarket(m)) {
          if (!isUnwantedMarket(m)) {
            seen.add(m.id);
            return true;
          }
        }
        return false;
      })
      .sort((a, b) => {
        // First sort by relevance score
        const scoreA = getRelevanceScore(a);
        const scoreB = getRelevanceScore(b);
        if (scoreB !== scoreA) return scoreB - scoreA;
        
        // Then by date (latest first)
        const dateA = getSortDate(a).getTime();
        const dateB = getSortDate(b).getTime();
        if (dateB !== dateA) return dateB - dateA;
        
        // Finally by volume as tiebreaker
        return (b.volume || 0) - (a.volume || 0);
      })
      .slice(0, take);
  };
  
  // Try to fetch markets with date filters first (upcoming events focus)
  // Prioritize newest events by ordering by creation date
  try {
    const dateFilteredMarkets = await fetchMarkets({
      active: true,
      closed: false,
      endDateMin: startDate,
      endDateMax: endDate,
      limit: 100,
      orderBy: 'volume', // Use volume since 'created' not supported
      ascending: false,
    });
    
    // Sort by date client-side
    dateFilteredMarkets.sort((a, b) => {
      const dateA = a.endDate ? new Date(a.endDate).getTime() : 0;
      const dateB = b.endDate ? new Date(b.endDate).getTime() : 0;
      return dateB - dateA;
    });
    
    const filtered = filterAndSort(dateFilteredMarkets, 20);
    results.push(...filtered);
    console.log(`[fetchCuratedLatest] Date-filtered markets: ${filtered.length}`);
  } catch (err) {
    console.warn('[fetchCuratedLatest] Failed to fetch date-filtered markets:', err);
  }
  
  // If we don't have enough, fetch from diverse categories (newest first)
  if (results.length < 20) {
    const categories = [
      { query: 'crypto', take: 5 },
      { query: 'politics', take: 4 },
      { query: 'tech', take: 3 },
      { query: 'finance', take: 2 },
      { query: 'sports', take: 2 },
      { query: 'gaming', take: 2 },
      { query: 'entertainment', take: 1 },
      { query: 'health', take: 1 },
    ];
    
    for (const category of categories) {
      if (results.length >= 20) break;
      
      try {
        const markets = await fetchMarkets({ 
          query: category.query,
          active: true,
          closed: false,
          limit: 150,
          orderBy: 'volume', // Use volume since 'created' not supported
          ascending: false,
        });
        
        // Sort by date client-side
        markets.sort((a, b) => {
          const dateA = a.endDate ? new Date(a.endDate).getTime() : 0;
          const dateB = b.endDate ? new Date(b.endDate).getTime() : 0;
          return dateB - dateA;
        });
        
        const remaining = 20 - results.length;
        const take = Math.min(category.take, remaining);
        const filtered = filterAndSort(markets, take);
        results.push(...filtered);
      } catch (err) {
        console.warn(`Failed to fetch ${category.query} markets:`, err);
      }
    }
  }
  
  // If we still don't have 20, fetch without category filters (newest first)
  if (results.length < 20) {
    try {
      const allMarkets = await fetchMarkets({ 
        active: true,
        closed: false,
        limit: 200,
        orderBy: 'volume', // Use volume since 'created' not supported
        ascending: false,
      });
      
      // Sort by date client-side
      allMarkets.sort((a, b) => {
        const dateA = a.endDate ? new Date(a.endDate).getTime() : 0;
        const dateB = b.endDate ? new Date(b.endDate).getTime() : 0;
        return dateB - dateA; // Newest first
      });
      
      const remaining = 20 - results.length;
      const filtered = filterAndSort(allMarkets, remaining);
      results.push(...filtered);
      console.log(`[fetchCuratedLatest] Additional markets: ${filtered.length}`);
    } catch (err) {
      console.warn('[fetchCuratedLatest] Failed to fetch additional markets:', err);
    }
  }
  
  // Final fallback: if we still have no results, try with minimal filters
  if (results.length === 0) {
    try {
      console.log('[fetchCuratedLatest] Trying fallback: fetching with minimal filters');
      const fallbackMarkets = await fetchMarkets({ 
        limit: 50,
        orderBy: 'volume', // Order by volume as fallback
        ascending: false,
      });
      
      const filtered = fallbackMarkets
        .filter((m) => {
          if (seen.has(m.id)) return false;
          // Only exclude closed markets
          if (m.closed) return false;
          seen.add(m.id);
          return true;
        })
        .slice(0, 20);
      
      results.push(...filtered);
      console.log(`[fetchCuratedLatest] Fallback markets: ${filtered.length}`);
    } catch (err) {
      console.error('[fetchCuratedLatest] Fallback also failed:', err);
      // Last resort: try without any filters at all
      try {
        console.log('[fetchCuratedLatest] Last resort: fetching without any filters');
        const lastResortMarkets = await fetchMarkets({ 
          limit: 50,
        });
        const filtered = lastResortMarkets
          .filter((m) => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          })
          .slice(0, 20);
        results.push(...filtered);
        console.log(`[fetchCuratedLatest] Last resort markets: ${filtered.length}`);
      } catch (lastErr) {
        console.error('[fetchCuratedLatest] Last resort also failed:', lastErr);
      }
    }
  }
  
  // Filter to only markets with real data
  const validResults = filterMarketsWithRealData(results);
  console.log(`[fetchCuratedLatest] Returning ${validResults.length} markets with real data (from ${results.length} total)`);
  
  // Final ordering should prefer near-term, active, liquid markets over very long-dated contracts.
  const sortedResults = validResults.sort((a, b) => {
    const scoreDiff = scoreCuratedMarket(b) - scoreCuratedMarket(a);
    if (scoreDiff !== 0) return scoreDiff;

    const dateA = a.endDate ? new Date(a.endDate).getTime() : 0;
    const dateB = b.endDate ? new Date(b.endDate).getTime() : 0;
    return dateA - dateB;
  });
  
  return sortedResults.slice(0, 30); // Return more markets to show variety and catch new ones
}

/**
 * Fetch market details directly from Polymarket API
 * Uses short TTL cache to reduce API calls while keeping data fresh
 */
const MARKET_DETAILS_CACHE_TTL = 3000; // 3 seconds for faster updates

// In-flight request deduplication
const inFlightRequests = new Map<string, Promise<PolymarketMarket | null>>();

export async function getMarketDetails(marketId: string): Promise<PolymarketMarket | null> {
  // Check cache first
  const cacheKey = `market:${marketId}`;
  const cached = cacheGet<PolymarketMarket>(cacheKey);
  if (cached) {
    return cached;
  }

  // Check if request is already in-flight (deduplication)
  const inFlight = inFlightRequests.get(marketId);
  if (inFlight) {
    return inFlight;
  }

  // Create the fetch promise
  const fetchPromise = (async (): Promise<PolymarketMarket | null> => {
    try {
      const res = await fetch(`${gammaBase}/markets/${marketId}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      
      // Handle 304 - return cached if available
      if (res.status === 304) {
        return cacheGet<PolymarketMarket>(cacheKey);
      }
      
      if (!res.ok) return null;
      
      const m = await res.json();
      const market = mapMarket(m);
      
      if (market) {
        cacheSet(cacheKey, market, MARKET_DETAILS_CACHE_TTL);
      }
      
      return market;
    } catch {
      // On error, return cached data if available
      return cacheGet<PolymarketMarket>(cacheKey);
    } finally {
      inFlightRequests.delete(marketId);
    }
  })();

  inFlightRequests.set(marketId, fetchPromise);
  return fetchPromise;
}

/**
 * Batch fetch multiple markets in parallel with concurrency limit
 */
export async function getMarketDetailsBatch(marketIds: string[]): Promise<Map<string, PolymarketMarket>> {
  const results = new Map<string, PolymarketMarket>();
  const uncachedIds: string[] = [];
  
  // First, check cache for all markets
  for (const id of marketIds) {
    const cached = cacheGet<PolymarketMarket>(`market:${id}`);
    if (cached) {
      results.set(id, cached);
    } else {
      uncachedIds.push(id);
    }
  }
  
  // Fetch uncached markets in parallel (max 6 concurrent)
  const CONCURRENCY = 6;
  for (let i = 0; i < uncachedIds.length; i += CONCURRENCY) {
    const batch = uncachedIds.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(batch.map(id => getMarketDetails(id)));
    batch.forEach((id, idx) => {
      if (fetched[idx]) results.set(id, fetched[idx]!);
    });
  }
  
  return results;
}

export function getOutcomeProbabilities(market: PolymarketMarket): OutcomeProbabilities {
  const prices = market.outcomePrices;
  if (prices && prices.length >= 2) {
    const yesProb = parseFloat(prices[0]);
    const noProb = parseFloat(prices[1]);
    
    // If we have valid probabilities, use them
    if (!isNaN(yesProb) && !isNaN(noProb) && yesProb >= 0 && noProb >= 0) {
      // Normalize if they don't sum to 1 (sometimes API returns prices that need normalization)
      const sum = yesProb + noProb;
      if (sum > 0) {
        return {
          YES: yesProb / sum,
          NO: noProb / sum,
        };
      }
    }
  }
  
  // Fallback: try to calculate from prices if available
  // If prices are in dollar format (e.g., $0.50), convert to probability
  // Otherwise default to 50/50
  console.warn(`[getOutcomeProbabilities] Market ${market.id} missing valid outcomePrices, using default 50/50`);
  return { YES: 0.5, NO: 0.5 };
}

export function formatVolume(volume: number): string {
  if (volume >= 1000000) return `$${(volume / 1000000).toFixed(1)}M`;
  if (volume >= 1000) return `$${(volume / 1000).toFixed(0)}K`;
  return `$${volume.toFixed(0)}`;
}

export function formatProbability(prob: number): string {
  return `${(prob * 100).toFixed(1)}%`;
}

export function getOutcomePrices(market: PolymarketMarket): { YES: number; NO: number } | null {
  const prices = market.outcomePrices;
  if (prices && prices.length >= 2) {
    return {
      YES: parseFloat(prices[0]) || 0,
      NO: parseFloat(prices[1]) || 0,
    };
  }
  return null;
}

export function formatPrice(price: number): string {
  return `$${price.toFixed(4)}`;
}

export async function fetchMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
  try {
    // Add cache-busting timestamp with microsecond precision
    const apiUrl = `${gammaBase}/markets/slug/${slug}?_t=${Date.now() + (typeof performance !== 'undefined' ? performance.now() : 0)}&_r=${Math.random()}`;
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: { 
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'If-None-Match': '*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      cache: 'no-store',
      credentials: 'omit',
      ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(10000) } : {}), // 10 second timeout
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    return mapMarket(data);
  } catch (error) {
    console.error('Failed to fetch market by slug:', error);
    return null;
  }
}
