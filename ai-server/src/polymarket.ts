import { config } from './config.js';

export interface PolymarketMarket {
  id: string;
  slug?: string;
  question: string;
  description?: string;
  outcomes: string[];
  outcomePrices: number[];
  volume: number;
  liquidity: number;
  endDate?: string;
  acceptingOrders: boolean;
}

type UnknownRecord = Record<string, unknown>;

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMarket(raw: UnknownRecord, event?: UnknownRecord): PolymarketMarket | null {
  if (raw.closed === true || raw.active === false || event?.closed === true || event?.active === false) {
    return null;
  }
  const id = String(raw.id ?? '').trim();
  const question = String(raw.question ?? raw.title ?? event?.title ?? '').trim();
  if (!id || id.length > 64 || !question) return null;

  const outcomes = arrayValue(raw.outcomes).map(String);
  const outcomePrices = arrayValue(raw.outcomePrices).map(numeric);
  if (outcomes.length < 2 || outcomePrices.length < 2) return null;

  const endDate = String(raw.endDate ?? raw.end_date_iso ?? event?.endDate ?? '').trim() || undefined;
  return {
    id,
    slug: String(raw.slug ?? event?.slug ?? '').trim() || undefined,
    question,
    description: String(raw.description ?? event?.description ?? '').trim() || undefined,
    outcomes,
    outcomePrices,
    volume: numeric(raw.volume ?? event?.volume),
    liquidity: numeric(raw.liquidity ?? event?.liquidity),
    endDate,
    acceptingOrders: raw.acceptingOrders !== false && raw.enableOrderBook !== false,
  };
}

async function getJson(path: string, params: Record<string, string | number | boolean>): Promise<unknown> {
  const url = new URL(`${config.gammaBaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Polymarket returned ${response.status} for ${url.pathname}`);
  return response.json();
}

export async function fetchActiveMarkets(pageCount = 3): Promise<PolymarketMarket[]> {
  const deduped = new Map<string, PolymarketMarket>();
  for (let page = 0; page < pageCount; page += 1) {
    const payload = await getJson('/events', {
      active: true,
      closed: false,
      order: 'volume24hr',
      ascending: false,
      limit: 100,
      offset: page * 100,
    });
    const events = Array.isArray(payload) ? payload as UnknownRecord[] : [];
    for (const event of events) {
      const markets = Array.isArray(event.markets) ? event.markets as UnknownRecord[] : [];
      for (const raw of markets) {
        const market = normalizeMarket(raw, event);
        if (market?.acceptingOrders) deduped.set(market.id, market);
      }
    }
    if (events.length < 100) break;
  }
  return [...deduped.values()];
}

export async function fetchMarketById(marketId: string): Promise<PolymarketMarket | null> {
  const payload = await getJson('/markets', { id: marketId });
  const raw = Array.isArray(payload) ? payload[0] as UnknownRecord | undefined : undefined;
  return raw ? normalizeMarket(raw) : null;
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

const GENERIC_SEARCH_TOKENS = new Set([
  'all', 'before', 'could', 'high', 'into', 'market', 'markets', 'more', 'new',
  'reach', 'reaches', 'than', 'that', 'this', 'time', 'will', 'with', 'year',
]);

function meaningfulTokens(value: string): string[] {
  return tokenize(value).filter((token) => !GENERIC_SEARCH_TOKENS.has(token));
}

export function relevanceScore(thesis: string, market: PolymarketMarket, keywords: string[]): number {
  const question = `${market.question} ${market.description ?? ''}`.toLowerCase();
  const marketTokens = new Set(meaningfulTokens(question));
  const thesisTokens = [...new Set(meaningfulTokens(thesis))];
  const overlap = thesisTokens.filter((token) => marketTokens.has(token)).length;
  let score = overlap * 3;
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase().trim();
    if (normalized && question.includes(normalized)) score += 5;
    else {
      const tokens = meaningfulTokens(normalized);
      if (tokens.length === 0) continue;
      const matches = tokens.filter((token) => marketTokens.has(token)).length;
      if (matches >= Math.max(1, Math.ceil(tokens.length * 0.6))) score += matches;
    }
  }
  score += Math.min(2, Math.log10(1 + market.volume + market.liquidity));
  return score;
}

async function publicSearch(query: string): Promise<PolymarketMarket[]> {
  const payload = await getJson('/public-search', {
    q: query,
    events_status: 'active',
    limit_per_type: 30,
    search_profiles: false,
  }) as UnknownRecord;
  const events = Array.isArray(payload.events) ? payload.events as UnknownRecord[] : [];
  const markets: PolymarketMarket[] = [];
  for (const event of events) {
    const eventMarkets = Array.isArray(event.markets) ? event.markets as UnknownRecord[] : [];
    for (const raw of eventMarkets) {
      const market = normalizeMarket(raw, event);
      if (market?.acceptingOrders) markets.push(market);
    }
  }
  return markets;
}

export async function searchVerifiedMarkets(
  thesis: string,
  keywords: string[],
  limit = 24,
): Promise<PolymarketMarket[]> {
  const queries = [...new Set([thesis, ...keywords])].slice(0, 5);
  const searched = await Promise.all(queries.map((query) => publicSearch(query).catch(() => [])));
  const deduped = new Map<string, PolymarketMarket>();
  for (const market of searched.flat()) deduped.set(market.id, market);
  if (deduped.size === 0) {
    for (const market of await fetchActiveMarkets()) deduped.set(market.id, market);
  }
  return [...deduped.values()]
    .map((market) => ({ market, score: relevanceScore(thesis, market, keywords) }))
    .filter(({ score }) => score >= 3)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ market }) => market);
}

export function selectedProbability(market: PolymarketMarket, outcome: 'YES' | 'NO'): number {
  const index = market.outcomes.findIndex((value) => value.toUpperCase() === outcome);
  const probability = index >= 0 ? market.outcomePrices[index] : outcome === 'YES' ? market.outcomePrices[0] : market.outcomePrices[1];
  return Math.max(0, Math.min(1, probability ?? 0.5));
}
