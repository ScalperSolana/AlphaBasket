import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { config } from './config.js';
import { extractYesNoPrices, fetchMarketById } from './polymarket.js';
import type { ChainBasketItem } from './escrow.js';

/** The quote signer keypair — its pubkey must equal the program's config.quote_signer. */
export const signer = Keypair.fromSecretKey(bs58.decode(config.signerKeypairBase58));

export interface SignedQuote {
  entryIndexBps: number;
  nonce: number;
  expiry: number;
  signerPubkey: string;
  message: string;
  signature: string;
}

/**
 * Canonical quote message the program rebuilds and compares against:
 * basket_id(32) | owner(32) | entry_index_bps(u16 LE) | nonce(u64 LE) | expiry(i64 LE)
 */
function buildMessage(
  basketId: Buffer,
  owner: PublicKey,
  entryIndexBps: number,
  nonce: number,
  expiry: number,
): Buffer {
  const b = Buffer.alloc(82);
  basketId.copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeUInt16LE(entryIndexBps, 64);
  b.writeBigUInt64LE(BigInt(nonce), 66);
  b.writeBigInt64LE(BigInt(expiry), 74);
  return b;
}

async function itemProbability(item: ChainBasketItem): Promise<number> {
  const market = await fetchMarketById(item.marketId, config.polymarketGammaBaseUrl);
  if (!market) {
    throw new Error(`Polymarket market not found for item (${item.marketId})`);
  }
  const prices = extractYesNoPrices(market);
  if (!prices) {
    throw new Error(`No prices available for item (${item.marketId})`);
  }
  return item.outcome === 'YES' ? prices.yesPrice : prices.noPrice;
}

/**
 * Recompute the entry index server-side from live Polymarket prices so a client
 * cannot forge a favorable index: entry_index_bps = Σ weightBps × P(chosen outcome).
 * Clamped to the escrow's accepted range [1, 10000]. Items come straight from the
 * on-chain Basket account.
 */
export async function computeEntryIndexBps(items: ChainBasketItem[]): Promise<number> {
  let acc = 0;
  for (const item of items) {
    const prob = await itemProbability(item);
    if (!Number.isFinite(prob) || prob < 0 || prob > 1) {
      throw new Error(`Invalid probability ${prob} for item (${item.marketId})`);
    }
    acc += item.weightBps * prob;
  }
  return Math.min(Math.max(Math.round(acc), 1), 10_000);
}

/** Sign a quote for {basketId, owner, entryIndexBps}. */
export function signQuote(basketId: Buffer, owner: PublicKey, entryIndexBps: number): SignedQuote {
  const nonce = Date.now();
  const expiry = Math.floor(Date.now() / 1000) + Math.floor(config.quoteTtlMs / 1000);
  const message = buildMessage(basketId, owner, entryIndexBps, nonce, expiry);
  const signature = nacl.sign.detached(message, signer.secretKey);
  return {
    entryIndexBps,
    nonce,
    expiry,
    signerPubkey: signer.publicKey.toBase58(),
    message: Buffer.from(message).toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
  };
}
