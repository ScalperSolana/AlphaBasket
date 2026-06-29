import { createServer } from 'node:http';
import { config } from './config.js';
import { BasketReader } from './chain.js';
import { QuoteService } from './quote.js';

type QuoteRequestBody = {
  targetProgramId?: string;
  user?: string;
  basketId?: number;
  amount?: string;
};

const basketReader = new BasketReader(config.varaRpcUrl, config.basketMarketProgramId, {
  reconnectAttempts: config.varaReconnectAttempts,
  reconnectDelayMs: config.varaReconnectDelayMs,
  reconnectMaxDelayMs: config.varaReconnectMaxDelayMs,
});
const quoteService = new QuoteService({
  signerSeed: config.quoteSignerSeed,
  targetProgramId: config.betLaneProgramId,
  basketMarketProgramId: config.basketMarketProgramId,
  gammaBaseUrl: config.polymarketGammaBaseUrl,
  ttlMs: config.quoteTtlMs,
  bindingPrefix: config.bindingPrefix,
  basketMarketBindingPrefix: config.basketMarketBindingPrefix,
  betCutoffMs: config.betCutoffMs,
  marketEndToleranceMs: config.marketEndToleranceMs,
  blockedMarketSlugPatterns: config.blockedMarketSlugPatterns,
});

const isAllowedOrigin = (origin?: string): boolean => {
  if (!origin) {
    return false;
  }

  if (!config.allowedOrigins.length) {
    return true;
  }

  return config.allowedOrigins.includes(origin);
};

function setCors(res: import('node:http').ServerResponse, origin?: string) {
  if (!origin || !isAllowedOrigin(origin)) {
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS,GET');
}

function respondJson(
  res: import('node:http').ServerResponse,
  statusCode: number,
  body: unknown,
  origin?: string,
) {
  setCors(res, origin);
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    setCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const chainReady = basketReader.isReady();
    respondJson(
      res,
      chainReady ? 200 : 503,
      {
        ok: chainReady,
        service: 'bet-quote-service',
        varaRpcConnected: chainReady,
        signerActorId: quoteService.getSignerActorId(),
      },
      origin,
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bet-lane/quote') {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as QuoteRequestBody;

      if (body.targetProgramId !== config.betLaneProgramId) {
        throw new Error('targetProgramId does not match configured BET_LANE_PROGRAM_ID');
      }
      if (!body.user || !/^0x[0-9a-fA-F]{64}$/.test(body.user)) {
        throw new Error('Invalid user actor id');
      }
      if (!Number.isInteger(body.basketId) || Number(body.basketId) < 0) {
        throw new Error('Invalid basketId');
      }
      if (!body.amount || BigInt(body.amount) <= 0n) {
        throw new Error('Invalid amount');
      }

      const basket = await basketReader.getBasket(Number(body.basketId), 'Bet');
      const quote = await quoteService.createSignedQuote({
        user: body.user as `0x${string}`,
        basketId: Number(body.basketId),
        amount: BigInt(body.amount),
        basket,
      });

      console.log(
        `[bet-quote-service] issued quote nonce=${quote.payload.nonce} user=${quote.payload.user} basket=${quote.payload.basket_id} amount=${quote.payload.amount} quoted_index_bps=${quote.payload.quoted_index_bps} deadline_ms=${quote.payload.deadline_ms}`,
      );

      respondJson(res, 200, quote, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to issue quote';
      respondJson(res, 400, { error: message }, origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/basket-market/quote') {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as QuoteRequestBody;

      if (body.targetProgramId !== config.basketMarketProgramId) {
        throw new Error('targetProgramId does not match configured BASKET_MARKET_PROGRAM_ID');
      }
      if (!body.user || !/^0x[0-9a-fA-F]{64}$/.test(body.user)) {
        throw new Error('Invalid user actor id');
      }
      if (!Number.isInteger(body.basketId) || Number(body.basketId) < 0) {
        throw new Error('Invalid basketId');
      }
      if (!body.amount || BigInt(body.amount) <= 0n) {
        throw new Error('Invalid amount');
      }

      const basket = await basketReader.getBasket(Number(body.basketId), 'Vara');
      const quote = await quoteService.createSignedVaraQuote({
        user: body.user as `0x${string}`,
        basketId: Number(body.basketId),
        amount: BigInt(body.amount),
        basket,
      });

      console.log(
        `[bet-quote-service] issued VARA quote nonce=${quote.payload.nonce} user=${quote.payload.user} basket=${quote.payload.basket_id} amount=${quote.payload.amount} quoted_index_bps=${quote.payload.quoted_index_bps} earliest_end_timestamp=${quote.payload.earliest_end_timestamp} deadline_ms=${quote.payload.deadline_ms}`,
      );

      respondJson(res, 200, quote, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to issue quote';
      respondJson(res, 400, { error: message }, origin);
    }
    return;
  }

  respondJson(res, 404, { error: 'Not found' }, origin);
});

server.listen(config.port, async () => {
  await basketReader.init();
  console.log(`[bet-quote-service] listening on :${config.port}`);
  console.log(`[bet-quote-service] quote signer actor: ${quoteService.getSignerActorId()}`);
});
