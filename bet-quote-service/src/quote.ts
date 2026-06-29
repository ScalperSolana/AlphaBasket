import { randomBytes } from 'node:crypto';
import { Keyring } from '@polkadot/api';
import { TypeRegistry } from '@polkadot/types';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import type { ChainBasket, Outcome } from './chain.js';
import { extractYesNoPrices, fetchMarketById, fetchMarketBySlug } from './polymarket.js';

type QuoteServiceOptions = {
  signerSeed: string;
  targetProgramId: `0x${string}`;
  basketMarketProgramId: `0x${string}`;
  gammaBaseUrl: string;
  ttlMs: number;
  bindingPrefix: string;
  basketMarketBindingPrefix: string;
  betCutoffMs: number;
  marketEndToleranceMs: number;
  blockedMarketSlugPatterns: string[];
};

export type BetQuoteInput = {
  user: `0x${string}`;
  basketId: number;
  amount: bigint;
  basket: ChainBasket;
};

export type VaraBetQuoteInput = BetQuoteInput;

const registry = new TypeRegistry();
registry.register({
  BetQuotePayload: {
    target_program_id: '[u8;32]',
    user: '[u8;32]',
    basket_id: 'u64',
    amount: 'u256',
    quoted_index_bps: 'u16',
    deadline_ms: 'u64',
    nonce: 'u128',
  },
  VaraBetQuotePayload: {
    target_program_id: '[u8;32]',
    user: '[u8;32]',
    basket_id: 'u64',
    amount: 'u128',
    quoted_index_bps: 'u16',
    earliest_end_timestamp: 'u64',
    deadline_ms: 'u64',
    nonce: 'u128',
  },
});

const normalizeOutcome = (outcome: Outcome): 'YES' | 'NO' => {
  if (typeof outcome === 'string') {
    return outcome;
  }

  if ('YES' in outcome) {
    return 'YES';
  }

  return 'NO';
};

const clampIndexBps = (value: number): number => Math.max(1, Math.min(10_000, Math.round(value)));

export class QuoteService {
  private readonly keypair;

  constructor(private readonly options: QuoteServiceOptions) {
    const keyring = new Keyring({ type: 'sr25519', ss58Format: 137 });
    this.keypair = keyring.addFromUri(options.signerSeed);
  }

  getSignerActorId(): `0x${string}` {
    return u8aToHex(this.keypair.publicKey) as `0x${string}`;
  }

  async createSignedQuote(input: BetQuoteInput) {
    const quotedIndexBps = await this.computeQuotedIndexBps(input.basket);
    const payload = {
      target_program_id: this.options.targetProgramId,
      user: input.user,
      basket_id: input.basketId,
      amount: input.amount.toString(),
      quoted_index_bps: quotedIndexBps,
      deadline_ms: BigInt(Date.now() + this.options.ttlMs).toString(),
      nonce: BigInt(`0x${randomBytes(16).toString('hex')}`).toString(),
    };

    const message = this.createSigningMessage('BetQuotePayload', this.options.bindingPrefix, payload);
    const signature = this.keypair.sign(message);

    return {
      payload,
      signature: u8aToHex(signature) as `0x${string}`,
    };
  }

  async createSignedVaraQuote(input: VaraBetQuoteInput) {
    const quoteContext = await this.computeVaraQuoteContext(input.basket);
    const payload = {
      target_program_id: this.options.basketMarketProgramId,
      user: input.user,
      basket_id: input.basketId,
      amount: input.amount.toString(),
      quoted_index_bps: quoteContext.quotedIndexBps,
      earliest_end_timestamp: quoteContext.earliestEndTimestamp.toString(),
      deadline_ms: BigInt(Date.now() + this.options.ttlMs).toString(),
      nonce: BigInt(`0x${randomBytes(16).toString('hex')}`).toString(),
    };

    const message = this.createSigningMessage(
      'VaraBetQuotePayload',
      this.options.basketMarketBindingPrefix,
      payload,
    );
    const signature = this.keypair.sign(message);

    return {
      payload,
      signature: u8aToHex(signature) as `0x${string}`,
    };
  }

  private async computeQuotedIndexBps(basket: ChainBasket): Promise<number> {
    let weightedTotal = 0;

    for (const item of basket.items) {
      const market =
        (item.poly_market_id
          ? await fetchMarketById(item.poly_market_id, this.options.gammaBaseUrl)
          : null) ??
        (item.poly_slug
          ? await fetchMarketBySlug(item.poly_slug, this.options.gammaBaseUrl)
          : null);

      if (!market) {
        throw new Error(`Failed to load Polymarket data for basket item ${item.poly_slug || item.poly_market_id}`);
      }

      const prices = extractYesNoPrices(market);
      if (!prices) {
        throw new Error(`Missing YES/NO prices for basket item ${item.poly_slug || item.poly_market_id}`);
      }

      const selectedOutcome = normalizeOutcome(item.selected_outcome);
      const selectedPrice = selectedOutcome === 'YES' ? prices.yesPrice : prices.noPrice;
      weightedTotal += selectedPrice * item.weight_bps;
    }

    return clampIndexBps(weightedTotal);
  }

  private async computeVaraQuoteContext(
    basket: ChainBasket,
  ): Promise<{ quotedIndexBps: number; earliestEndTimestamp: bigint }> {
    let weightedTotal = 0;
    let earliestEndTimestamp: bigint | null = null;
    const now = Date.now();

    for (const item of basket.items) {
      const marketRef = item.poly_slug || item.poly_market_id;
      if (this.isBlockedSlug(item.poly_slug)) {
        throw new Error(`Market ${item.poly_slug} is blocked for native VARA bets`);
      }

      const market =
        (item.poly_market_id
          ? await fetchMarketById(item.poly_market_id, this.options.gammaBaseUrl)
          : null) ??
        (item.poly_slug
          ? await fetchMarketBySlug(item.poly_slug, this.options.gammaBaseUrl)
          : null);

      if (!market) {
        throw new Error(`Failed to load Polymarket data for basket item ${marketRef}`);
      }
      if (market.closed || market.active === false) {
        throw new Error(`Market ${marketRef} is not open`);
      }
      if (!market.endDate) {
        throw new Error(`Market ${marketRef} has no endDate`);
      }

      const parsedMarketEndTimestamp = new Date(market.endDate).getTime();
      if (!Number.isFinite(parsedMarketEndTimestamp) || parsedMarketEndTimestamp <= 0) {
        throw new Error(`Market ${marketRef} has invalid endDate`);
      }
      const marketEndTimestamp = BigInt(parsedMarketEndTimestamp);

      const itemEndTimestamp = BigInt(item.end_timestamp);
      const delta =
        marketEndTimestamp > itemEndTimestamp
          ? marketEndTimestamp - itemEndTimestamp
          : itemEndTimestamp - marketEndTimestamp;
      if (delta > BigInt(this.options.marketEndToleranceMs)) {
        throw new Error(`Market ${marketRef} endDate does not match basket item end_timestamp`);
      }

      if (now + this.options.betCutoffMs >= Number(itemEndTimestamp)) {
        throw new Error(`Bet cutoff reached for market ${marketRef}`);
      }

      earliestEndTimestamp =
        earliestEndTimestamp === null || itemEndTimestamp < earliestEndTimestamp
          ? itemEndTimestamp
          : earliestEndTimestamp;

      const prices = extractYesNoPrices(market);
      if (!prices) {
        throw new Error(`Missing YES/NO prices for basket item ${marketRef}`);
      }

      const selectedOutcome = normalizeOutcome(item.selected_outcome);
      const selectedPrice = selectedOutcome === 'YES' ? prices.yesPrice : prices.noPrice;
      weightedTotal += selectedPrice * item.weight_bps;
    }

    if (earliestEndTimestamp === null) {
      throw new Error('Basket has no items');
    }

    return {
      quotedIndexBps: clampIndexBps(weightedTotal),
      earliestEndTimestamp,
    };
  }

  private createSigningMessage(typeName: string, bindingPrefix: string, payload: Record<string, unknown>): Uint8Array {
    const encodedPrefix = stringToU8a(bindingPrefix);
    const encodedPayload = registry.createType(typeName, payload).toU8a();

    return new Uint8Array([
      ...stringToU8a('<Bytes>'),
      ...encodedPrefix,
      ...encodedPayload,
      ...stringToU8a('</Bytes>'),
    ]);
  }

  private isBlockedSlug(slug: string): boolean {
    const normalizedSlug = slug.toLowerCase();
    return this.options.blockedMarketSlugPatterns.some((pattern) =>
      normalizedSlug.includes(pattern.toLowerCase()),
    );
  }
}
