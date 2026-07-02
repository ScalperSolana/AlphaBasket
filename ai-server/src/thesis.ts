/**
 * Adapted from SliceFund's thesisMapper and ThesisResearcher agents:
 * https://github.com/sxnnywu/slicefund
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import {
  type PolymarketMarket,
  searchVerifiedMarkets,
  selectedProbability,
  tokenize,
} from './polymarket.js';
import { normalizeWeightBps, type CanonicalBasket, type CanonicalMarket, type ThesisRequest } from './schema.js';

type RankedSelection = {
  id: string;
  outcome: 'YES' | 'NO';
  relevanceScore: number;
  explanation?: string;
  weight?: number;
};

function parseJsonArray(text: string): unknown[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fallbackKeywords(thesis: string): string[] {
  const ignored = new Set([
    'all', 'about', 'from', 'have', 'high', 'into', 'market', 'markets', 'new',
    'reach', 'reaches', 'that', 'this', 'time', 'will', 'with', 'year',
  ]);
  return [...new Set(tokenize(thesis).filter((word) => !ignored.has(word)))].slice(0, 5);
}

async function geminiText(prompt: string): Promise<string> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured');
  const client = new GoogleGenerativeAI(config.geminiApiKey);
  const model = client.getGenerativeModel({ model: config.geminiModel });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

export async function extractKeywords(thesis: string): Promise<string[]> {
  if (!config.geminiApiKey) return fallbackKeywords(thesis);
  try {
    const text = await geminiText(
      `Extract 3-5 concise search keywords or phrases for finding Polymarket markets relevant to this thesis. ` +
      `Return only a JSON array of strings. Thesis: ${JSON.stringify(thesis)}`,
    );
    const keywords = parseJsonArray(text).filter((value): value is string => typeof value === 'string').slice(0, 5);
    return keywords.length > 0 ? keywords : fallbackKeywords(thesis);
  } catch {
    return fallbackKeywords(thesis);
  }
}

function hydrateSelections(raw: unknown[], candidates: PolymarketMarket[], limit: number): RankedSelection[] {
  const byId = new Map(candidates.map((market) => [market.id, market]));
  const seen = new Set<string>();
  const selections: RankedSelection[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const id = String(entry.id ?? '');
    if (!byId.has(id) || seen.has(id)) continue;
    const outcome = String(entry.outcome ?? entry.suggested_position ?? 'YES').toUpperCase() === 'NO' ? 'NO' : 'YES';
    const relevanceScore = Number(entry.relevanceScore ?? entry.relevance_score ?? 5);
    const weight = Number(entry.weight);
    selections.push({
      id,
      outcome,
      relevanceScore: Number.isFinite(relevanceScore) ? relevanceScore : 5,
      explanation: typeof entry.explanation === 'string' ? entry.explanation : undefined,
      weight: Number.isFinite(weight) && weight > 0 ? weight : undefined,
    });
    seen.add(id);
    if (selections.length >= limit) break;
  }
  return selections;
}

async function rankCandidates(thesis: string, candidates: PolymarketMarket[], limit: number): Promise<RankedSelection[]> {
  if (!config.geminiApiKey) {
    return candidates.slice(0, limit).map((market, index) => ({
      id: market.id,
      outcome: 'YES',
      relevanceScore: Math.max(1, 10 - index),
    }));
  }

  const candidatePayload = candidates.map((market) => ({
    id: market.id,
    question: market.question,
    outcomes: market.outcomes,
    prices: market.outcomePrices,
    endDate: market.endDate,
    volume: market.volume,
  }));
  const text = await geminiText(
    `Select up to ${limit} markets that best express this thesis: ${JSON.stringify(thesis)}. ` +
    `Use only IDs from the candidate list. Choose an outcome YES or NO for each. ` +
    `Return only a JSON array of objects with id, outcome, relevanceScore, explanation, and weight. ` +
    `Weights may be relative positive numbers. Candidates: ${JSON.stringify(candidatePayload)}`,
  );
  return hydrateSelections(parseJsonArray(text), candidates, limit);
}

async function optionalBackboardAnalysis(thesis: string): Promise<unknown | null> {
  if (!config.backboardApiKey || !config.backboardAssistantId) return null;
  try {
    const threadResponse = await fetch(
      `https://app.backboard.io/api/assistants/${config.backboardAssistantId}/threads`,
      { method: 'POST', headers: { 'X-API-Key': config.backboardApiKey } },
    );
    if (!threadResponse.ok) return null;
    const threadPayload = await threadResponse.json() as Record<string, unknown>;
    const threadId = String(threadPayload.thread_id ?? threadPayload.threadId ?? threadPayload.id ?? '');
    if (!threadId) return null;
    const analysisResponse = await fetch(`https://app.backboard.io/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.backboardApiKey },
      body: JSON.stringify({ content: `Thesis: ${thesis}`, stream: false }),
    });
    return analysisResponse.ok ? analysisResponse.json() : null;
  } catch {
    return null;
  }
}

export async function researchThesis(request: ThesisRequest): Promise<{
  basket: CanonicalBasket;
  keywords: string[];
  analysis: unknown | null;
}> {
  const keywords = await extractKeywords(request.thesis);
  const candidates = await searchVerifiedMarkets(request.thesis, keywords, 24);
  if (candidates.length === 0) throw new Error('No verified active Polymarket markets matched this thesis');

  let selections = await rankCandidates(request.thesis, candidates, request.limit);
  if (selections.length === 0) {
    selections = candidates.slice(0, request.limit).map((market, index) => ({
      id: market.id,
      outcome: 'YES',
      relevanceScore: Math.max(1, 10 - index),
    }));
  }

  const byId = new Map(candidates.map((market) => [market.id, market]));
  const weights = normalizeWeightBps(selections.map((selection) => selection.weight ?? selection.relevanceScore));
  const markets: CanonicalMarket[] = selections.map((selection, index) => {
    const market = byId.get(selection.id);
    if (!market) throw new Error(`Selected market ${selection.id} was not in the verified candidate set`);
    return {
      marketId: market.id,
      slug: market.slug,
      question: market.question,
      outcome: selection.outcome,
      weightBps: weights[index] ?? 1,
      probability: selectedProbability(market, selection.outcome),
      endDate: market.endDate,
    };
  });

  const basket: CanonicalBasket = {
    name: request.name ?? request.thesis.slice(0, 100),
    thesis: request.thesis,
    markets,
  };
  const analysis = await optionalBackboardAnalysis(request.thesis);
  return { basket, keywords, analysis };
}
