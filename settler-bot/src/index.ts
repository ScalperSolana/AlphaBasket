import { config } from './config.js';
import {
  getAllBaskets,
  proposeSettlement,
  finalizeSettlement,
  oracleAuthority,
  CHALLENGE_WINDOW_SECS,
  type OnChainBasket,
} from './escrow.js';
import { fetchMarketById, checkMarketResolution } from './polymarket.js';

const nowSecs = (): number => Math.floor(Date.now() / 1000);

/**
 * Active basket: if every Polymarket market has resolved, compute the settlement
 * index (Σ weightBps where the market resolved to the item's chosen outcome) and
 * propose it on-chain.
 */
async function tryPropose(basket: OnChainBasket): Promise<void> {
  const prefix = `[Basket ${basket.label}]`;
  const markets = await Promise.all(
    basket.items.map((item) => fetchMarketById(item.marketId, config.polymarketGammaBaseUrl)),
  );

  const resolutions = markets.map((market) =>
    market
      ? checkMarketResolution(market)
      : { isResolved: false, resolved: null as 'YES' | 'NO' | null, reason: 'market not found' },
  );

  const allResolved = resolutions.every((r) => r.isResolved && r.resolved !== null);
  if (!allResolved) {
    const done = resolutions.filter((r) => r.isResolved && r.resolved !== null).length;
    console.log(`${prefix} settlement pending: ${done}/${resolutions.length} markets resolved`);
    return;
  }

  let settlementIndexBps = 0;
  basket.items.forEach((item, i) => {
    if (resolutions[i].resolved === item.outcome) {
      settlementIndexBps += item.weightBps;
    }
  });
  settlementIndexBps = Math.min(settlementIndexBps, 10_000);

  console.log(
    `${prefix} all markets resolved → proposing settlement index ${settlementIndexBps} bps (${(settlementIndexBps / 100).toFixed(2)}%)`,
  );
  const sig = await proposeSettlement(basket.pubkey, settlementIndexBps);
  console.log(`${prefix} ✓ proposed (finalizable in ${CHALLENGE_WINDOW_SECS}s)  tx: ${sig}`);
}

/** Proposed basket: finalize once the challenge window has elapsed. */
async function tryFinalize(basket: OnChainBasket): Promise<void> {
  const prefix = `[Basket ${basket.label}]`;
  const remaining = basket.settlementProposedAt + CHALLENGE_WINDOW_SECS - nowSecs();
  if (remaining > 0) {
    console.log(`${prefix} proposed; ${remaining}s left in challenge window`);
    return;
  }
  console.log(`${prefix} challenge window elapsed → finalizing`);
  const sig = await finalizeSettlement(basket.pubkey);
  console.log(`${prefix} ✓ finalized  tx: ${sig}`);
}

async function processBasket(basket: OnChainBasket): Promise<void> {
  const prefix = `[Basket ${basket.label}]`;
  try {
    if (basket.status === 'Active' && config.shouldPropose) {
      await tryPropose(basket);
    } else if (basket.status === 'Proposed' && config.shouldFinalize) {
      await tryFinalize(basket);
    }
    // 'Settled' → terminal state; nothing to do.
  } catch (error) {
    console.error(`${prefix} error:`, error instanceof Error ? error.message : error);
  }
}

async function poll(): Promise<void> {
  const ts = new Date().toISOString();
  let baskets: OnChainBasket[];
  try {
    baskets = await getAllBaskets();
  } catch (error) {
    console.error(`${ts} failed to enumerate baskets:`, error instanceof Error ? error.message : error);
    return;
  }

  const actionable = baskets.filter((b) => b.status === 'Active' || b.status === 'Proposed');
  console.log(`${ts} polling ${actionable.length}/${baskets.length} unsettled baskets…`);
  for (const basket of actionable) {
    await processBasket(basket);
  }
}

async function main(): Promise<void> {
  console.log('Starting PolyBaskets Solana settler bot…');
  console.log(`RPC:                ${config.rpcUrl}`);
  console.log(`Oracle authority:   ${oracleAuthority.toBase58()}`);
  console.log(`Challenge window:   ${CHALLENGE_WINDOW_SECS}s`);
  console.log(`Poll interval:      ${config.pollIntervalMs}ms`);
  console.log(`Propose / Finalize: ${config.shouldPropose} / ${config.shouldFinalize}`);
  console.log('');

  let inFlight = false;
  const runPoll = async () => {
    if (inFlight) {
      console.warn(`${new Date().toISOString()} previous poll still running, skipping`);
      return;
    }
    inFlight = true;
    try {
      await poll();
    } catch (error) {
      console.error('poll cycle error:', error);
    } finally {
      inFlight = false;
    }
  };

  await runPoll();
  const intervalId = setInterval(() => void runPoll(), config.pollIntervalMs);

  const shutdown = () => {
    console.log('\nShutting down…');
    clearInterval(intervalId);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
