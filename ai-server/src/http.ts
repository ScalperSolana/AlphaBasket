import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';
import { config } from './config.js';
import { fetchActiveMarkets, relevanceScore } from './polymarket.js';
import { buyBasketSchema, canonicalBasketSchema, thesisRequestSchema } from './schema.js';
import { researchThesis, extractKeywords } from './thesis.js';
import {
  createBasketOnchain,
  claimWithOperator,
  escrowInfo,
  getBasket,
  getWalletPositions,
  listBaskets,
  prepareClaimTransaction,
  prepareStakeTransaction,
  stakeWithOperator,
  sweepSurplusWithOperator,
} from './solana.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin))) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-headers', 'content-type,x-api-key');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function requireWriteKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.writeApiKey) {
    res.status(503).json({ error: 'HTTP writes are disabled until AI_WRITE_API_KEY is configured' });
    return;
  }
  if (req.header('x-api-key') !== config.writeApiKey) {
    res.status(401).json({ error: 'Invalid or missing x-api-key' });
    return;
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'polybaskets-ai-server',
    escrow: escrowInfo,
    capabilities: {
      gemini: Boolean(config.geminiApiKey),
      backboard: Boolean(config.backboardApiKey),
      operator: Boolean(config.operatorSecret),
      httpWrites: Boolean(config.writeApiKey),
    },
  });
});

app.get('/api/polymarket/trending', asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20) || 20));
  const markets = (await fetchActiveMarkets(1))
    .sort((left, right) => right.volume - left.volume)
    .slice(0, limit);
  res.json({ markets, count: markets.length });
}));

app.get('/api/polymarket/search', asyncRoute(async (req, res) => {
  const query = String(req.query.q ?? req.query.query ?? '').trim();
  if (!query) {
    res.status(400).json({ error: 'q query parameter is required' });
    return;
  }
  const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
  const keywords = await extractKeywords(query);
  const markets = (await fetchActiveMarkets())
    .map((market) => ({ market, score: relevanceScore(query, market, keywords) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ market, score }) => ({ ...market, relevanceScore: score }));
  res.json({ markets, count: markets.length, query, keywords });
}));

const thesisHandler = asyncRoute(async (req, res) => {
  const request = thesisRequestSchema.parse(req.body);
  res.json(await researchThesis(request));
});
app.post('/api/thesis/map', thesisHandler);
app.post('/api/thesis/polymarket', thesisHandler);
app.post('/api/analyze', thesisHandler);

app.get('/api/baskets', asyncRoute(async (_req, res) => {
  res.json({ baskets: await listBaskets() });
}));

app.get('/api/baskets/:basketId', asyncRoute(async (req, res) => {
  const basket = await getBasket(String(req.params.basketId));
  if (!basket) {
    res.status(404).json({ error: 'Basket not found' });
    return;
  }
  res.json(basket);
}));

app.get('/api/positions/:owner', asyncRoute(async (req, res) => {
  res.json({ positions: await getWalletPositions(String(req.params.owner)) });
}));

app.post('/api/baskets/create', requireWriteKey, asyncRoute(async (req, res) => {
  const basket = canonicalBasketSchema.parse(req.body);
  res.json(await createBasketOnchain(basket));
}));

app.post('/api/baskets/buy', requireWriteKey, asyncRoute(async (req, res) => {
  const request = buyBasketSchema.parse(req.body);
  const created = await createBasketOnchain(request.basket);
  const staked = await stakeWithOperator(created.basketId, request.amountUsdc);
  res.json({ created, staked });
}));

app.post('/api/baskets/research-and-create', requireWriteKey, asyncRoute(async (req, res) => {
  const research = await researchThesis(thesisRequestSchema.parse(req.body));
  const created = await createBasketOnchain(research.basket);
  res.json({ research, created });
}));

app.post('/api/baskets/prepare-stake', asyncRoute(async (req, res) => {
  const request = z.object({
    basketId: z.string().trim().min(1),
    owner: z.string().trim().min(32),
    amountUsdc: z.union([z.string(), z.number()]),
  }).parse(req.body);
  res.json(await prepareStakeTransaction(request.basketId, request.owner, request.amountUsdc));
}));

app.post('/api/baskets/prepare-claim', asyncRoute(async (req, res) => {
  const request = z.object({
    basketId: z.string().trim().min(1),
    owner: z.string().trim().min(32),
  }).parse(req.body);
  res.json(await prepareClaimTransaction(request.basketId, request.owner));
}));

app.post('/api/baskets/claim', requireWriteKey, asyncRoute(async (req, res) => {
  const request = z.object({ basketId: z.string().trim().min(1) }).parse(req.body);
  res.json(await claimWithOperator(request.basketId));
}));

app.post('/api/baskets/sweep-surplus', requireWriteKey, asyncRoute(async (req, res) => {
  const request = z.object({ basketId: z.string().trim().min(1) }).parse(req.body);
  res.json(await sweepSurplusWithOperator(request.basketId));
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', issues: error.issues });
    return;
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  console.error(`[ai-server] ${message}`);
  res.status(500).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`PolyBaskets AI server listening on :${config.port}`);
  console.log(`Escrow program: ${escrowInfo.programId} (${escrowInfo.cluster})`);
});
