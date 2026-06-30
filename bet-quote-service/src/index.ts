import { createServer } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { getBasketItems } from './escrow.js';
import { computeEntryIndexBps, signQuote, signer } from './quote.js';

type QuoteRequestBody = {
  /** hex of the 32-byte on-chain basket_id (sha256 of the string id). */
  basketId?: string;
  /** staker pubkey (base58). */
  owner?: string;
};

const isAllowedOrigin = (origin?: string): boolean => {
  if (config.allowedOrigins.length === 0) return true; // dev: allow all
  return !!origin && config.allowedOrigins.includes(origin);
};

function setCors(res: import('node:http').ServerResponse, origin?: string): void {
  res.setHeader('access-control-allow-origin', isAllowedOrigin(origin) ? origin ?? '*' : 'null');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
}

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, signer: signer.publicKey.toBase58() }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/quote')) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    void (async () => {
      try {
        const { basketId, owner } = JSON.parse(body) as QuoteRequestBody;
        if (typeof basketId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(basketId)) {
          throw new Error('basketId must be 32-byte hex');
        }
        if (typeof owner !== 'string') {
          throw new Error('owner (base58 pubkey) is required');
        }
        const ownerPk = new PublicKey(owner);
        const idBytes = Buffer.from(basketId, 'hex');

        // Read the basket composition straight from the on-chain account.
        const items = await getBasketItems(idBytes);
        if (!items) {
          throw new Error('Unknown basket id (not found on-chain)');
        }

        // Recompute the index server-side; never trust a client-supplied value.
        const entryIndexBps = await computeEntryIndexBps(items);
        const quote = signQuote(idBytes, ownerPk, entryIndexBps);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(quote));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'bad request' }));
      }
    })();
  });
});

server.listen(config.port, () => {
  console.log(`PolyBaskets quote signer listening on :${config.port}`);
  console.log(`Quote signer pubkey: ${signer.publicKey.toBase58()}`);
  console.log(`RPC: ${config.rpcUrl}`);
});
