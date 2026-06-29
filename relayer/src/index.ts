import 'dotenv/config';
import { promises as fs } from 'fs';
import { VaraClient } from './vara.js';
import {
  fetchMarketBySlug,
  fetchMarketById,
  checkMarketResolution,
  createResolverPayload,
  type PolymarketMarket,
} from './polymarket.js';

interface MirroredMarket {
  marketId: number;
  polySlug: string;
  polyId: string | null;
  lastStatus: string;
}

const {
  VARA_RPC = 'wss://rpc.vara.network',
  VARA_PROGRAM_ID = '',
  RELAYER_SEED = '',
  POLYMARKET_POLL_INTERVAL_MS = '30000',
  MARKETS_FILE = './markets.json',
  LOG_LEVEL = 'info',
  AUTO_DISCOVER_FROM_CHAIN = 'true',
} = process.env;

const POLL_INTERVAL = parseInt(POLYMARKET_POLL_INTERVAL_MS, 10);
const SHOULD_DISCOVER = AUTO_DISCOVER_FROM_CHAIN !== 'false';

if (!VARA_PROGRAM_ID) {
  console.error('ERROR: VARA_PROGRAM_ID environment variable is required');
  process.exit(1);
}

if (!RELAYER_SEED) {
  console.error('ERROR: RELAYER_SEED environment variable is required');
  process.exit(1);
}

// Initialize Vara client
const varaClient = new VaraClient(VARA_PROGRAM_ID, VARA_RPC, RELAYER_SEED);

/**
 * Load mirrored markets from file
 */
async function loadMarkets(): Promise<MirroredMarket[]> {
  try {
    const data = await fs.readFile(MARKETS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    console.error('Failed to load markets file:', error);
    return [];
  }
}

/**
 * Save mirrored markets to file
 */
async function saveMarkets(markets: MirroredMarket[]): Promise<void> {
  try {
    await fs.writeFile(MARKETS_FILE, JSON.stringify(markets, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save markets file:', error);
  }
}

/**
 * Update market status in the list
 */
function updateMarketStatus(
  markets: MirroredMarket[],
  marketId: number,
  status: string
): MirroredMarket[] {
  return markets.map((m) =>
    m.marketId === marketId ? { ...m, lastStatus: status } : m
  );
}

async function discoverMarketsFromChain(): Promise<MirroredMarket[]> {
  const count = await varaClient.getMarketCount();
  console.log(`[relayer] Discovering markets from chain, count=${count}`);
  const discovered: MirroredMarket[] = [];
  for (let i = 0; i < count; i++) {
    const m = await varaClient.getMarket(i);
    if (!m) continue;
    discovered.push({
      marketId: m.id,
      polySlug: m.poly_slug,
      polyId: m.poly_id,
      lastStatus: 'discovered',
    });
  }
  return discovered;
}

/**
 * Process a single market: check Polymarket status and resolve on Vara if needed
 */
async function processMarket(market: MirroredMarket): Promise<void> {
  const logPrefix = `[Market ${market.marketId}]`;
  const timestamp = new Date().toISOString();

  try {
    // Check if already resolved on-chain (idempotency)
    const isResolved = await varaClient.isMarketResolved(market.marketId);
    if (isResolved) {
      console.log(`${timestamp} ${logPrefix} Already resolved on-chain, skipping`);
      return;
    }

    console.log(
      `${timestamp} ${logPrefix} Candidate market loaded: polySlug=${market.polySlug}, polyId=${market.polyId}, lastStatus=${market.lastStatus}`
    );

    // Fetch current Polymarket data
    let polyMarket: PolymarketMarket | null = null;
    if (market.polyId) {
      polyMarket = await fetchMarketById(market.polyId);
    }
    if (!polyMarket && market.polySlug) {
      polyMarket = await fetchMarketBySlug(market.polySlug);
    }

    if (!polyMarket) {
      console.warn(
        `${timestamp} ${logPrefix} Failed to fetch Polymarket data (slug: ${market.polySlug}, id: ${market.polyId})`
      );
      return;
    }

    // Check if resolved
    const resolution = checkMarketResolution(polyMarket);

    if (!resolution.isResolved) {
      console.log(
        `${timestamp} ${logPrefix} Not resolved yet: ${resolution.reason}`
      );
      return;
    }

    if (resolution.winningIndex === null) {
      console.warn(
        `${timestamp} ${logPrefix} Market appears resolved but outcome unclear: ${resolution.reason}`
      );
      return;
    }

    // Market is resolved with clear winner - resolve on Vara
    console.log(
      `${timestamp} ${logPrefix} Resolving on Vara: ${resolution.reason}`
    );

    const resolverPayload = createResolverPayload(polyMarket, resolution.winningIndex);
    const txHash = await varaClient.resolveMarket(
      market.marketId,
      resolution.winningIndex,
      resolverPayload
    );

    if (txHash) {
      console.log(
        `${timestamp} ${logPrefix} ✓ Resolved successfully: tx ${txHash}`
      );
    } else {
      console.error(
        `${timestamp} ${logPrefix} ✗ Failed to resolve (tx returned null)`
      );
    }
  } catch (error) {
    console.error(`${timestamp} ${logPrefix} Error:`, error);
  }
}

/**
 * Main relayer loop
 */
async function main() {
  console.log('Starting Polymarket Mirror Relayer...');
  console.log(`Vara RPC: ${VARA_RPC}`);
  console.log(`Program ID: ${VARA_PROGRAM_ID}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`Markets file: ${MARKETS_FILE}`);
  console.log(`Auto-discover from chain: ${SHOULD_DISCOVER}`);
  console.log('');

  await varaClient.waitForReady();
  console.log('Connected to Vara Network');
  console.log('');

  let markets = await loadMarkets();
  console.log(`Loaded ${markets.length} mirrored markets from ${MARKETS_FILE}`);

  if (SHOULD_DISCOVER && markets.length === 0) {
    console.log('markets.json empty; discovering markets from on-chain program...');
    markets = await discoverMarketsFromChain();
    console.log(`Discovered ${markets.length} markets from chain`);
    await saveMarkets(markets);
  }

  const poll = async () => {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} Polling ${markets.length} mirrored markets...`);

    if (SHOULD_DISCOVER) {
      const discovered = await discoverMarketsFromChain();
      const existingIds = new Set(markets.map((m) => m.marketId));
      let added = 0;
      for (const d of discovered) {
        if (!existingIds.has(d.marketId)) {
          markets.push(d);
          added += 1;
        }
      }
      if (added > 0) {
        console.log(`${timestamp} Added ${added} newly discovered market(s) from chain`);
      }
    }

    for (const market of markets) {
      await processMarket(market);
    }

    await saveMarkets(markets);
  };

  await poll();

  const intervalId = setInterval(poll, POLL_INTERVAL);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    clearInterval(intervalId);
    await varaClient.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    clearInterval(intervalId);
    await varaClient.disconnect();
    process.exit(0);
  });
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
