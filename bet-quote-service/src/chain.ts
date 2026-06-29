import { BaseGearProgram, GearApi } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { QueryBuilder } from 'sails-js';

export type Outcome = 'YES' | 'NO' | { YES?: null } | { NO?: null };

export type ChainBasket = {
  id: number;
  status: 'Active' | 'SettlementPending' | 'Settled' | Record<string, unknown>;
  asset_kind: 'Bet' | 'Vara' | Record<string, unknown>;
  items: Array<{
    poly_market_id: string;
    poly_slug: string;
    weight_bps: number;
    selected_outcome: Outcome;
    end_timestamp: number | string | bigint;
  }>;
};

type BasketQueryResult<T> = { ok: T } | { err: string };

type BasketReaderOptions = {
  reconnectAttempts: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
};

class BasketMarketClient {
  constructor(
    private readonly api: GearApi,
    private readonly registry: TypeRegistry,
    private readonly programId: `0x${string}`,
  ) {}

  getBasket(
    basketId: number,
  ): QueryBuilder<BasketQueryResult<ChainBasket>> {
    return new QueryBuilder<BasketQueryResult<ChainBasket>>(
      this.api,
      this.registry,
      this.programId,
      'BasketMarket',
      'GetBasket',
      basketId,
      'u64',
      'Result<(Basket), String>',
    );
  }
}

const types = {
  BasketItem: {
    poly_market_id: 'String',
    poly_slug: 'String',
    weight_bps: 'u16',
    selected_outcome: 'Outcome',
    end_timestamp: 'u64',
  },
  Outcome: { _enum: ['YES', 'NO'] },
  BasketAssetKind: { _enum: ['Vara', 'Bet'] },
  BasketStatus: { _enum: ['Active', 'SettlementPending', 'Settled'] },
  Basket: {
    id: 'u64',
    creator: '[u8;32]',
    name: 'String',
    description: 'String',
    items: 'Vec<BasketItem>',
    created_at: 'u64',
    status: 'BasketStatus',
    asset_kind: 'BasketAssetKind',
  },
};

const registry = new TypeRegistry();
registry.setKnownTypes({ types });
registry.register(types);

const getStatusName = (value: ChainBasket['status']): string =>
  typeof value === 'string' ? value : Object.keys(value ?? {})[0] ?? 'Unknown';

const getAssetKindName = (value: ChainBasket['asset_kind']): string =>
  typeof value === 'string' ? value : Object.keys(value ?? {})[0] ?? 'Unknown';

export class BasketReader {
  private api: GearApi | null = null;
  private client: BasketMarketClient | null = null;
  private isConnected = false;
  private reconnectPromise: Promise<void> | null = null;

  constructor(
    private readonly rpcUrl: string,
    private readonly basketMarketProgramId: `0x${string}`,
    private readonly options: BasketReaderOptions,
  ) {}

  async init(force = false) {
    if (!force && this.api && this.client && this.isConnected) {
      return;
    }

    if (this.api) {
      try {
        await this.api.disconnect();
      } catch {
        // Ignore cleanup errors while replacing a broken provider.
      }
    }

    this.isConnected = false;
    const api = await GearApi.create({ providerAddress: this.rpcUrl });
    this.api = api;
    this.client = new BasketMarketClient(api, registry, this.basketMarketProgramId);
    await BaseGearProgram.new(this.basketMarketProgramId, api);
    this.setupConnectionListeners(api);
    this.isConnected = true;
  }

  isReady(): boolean {
    return Boolean(this.api && this.client && this.isConnected);
  }

  private setupConnectionListeners(api: GearApi) {
    const provider = (api as any).provider;
    if (!provider || typeof provider.on !== 'function') {
      return;
    }

    provider.on('connected', () => {
      this.isConnected = true;
      console.log('[bet-quote-service] Vara RPC connected');
    });
    provider.on('disconnected', () => {
      console.warn('[bet-quote-service] Vara RPC disconnected');
      this.isConnected = false;
      this.scheduleReconnect();
    });
    provider.on('error', (error: Error) => {
      console.warn('[bet-quote-service] Vara RPC error:', error.message);
      this.isConnected = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectPromise) {
      return;
    }

    this.reconnectPromise = this.reconnectWithRetries()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[bet-quote-service] Vara RPC reconnect failed: ${message}`);
      })
      .finally(() => {
        this.reconnectPromise = null;
      });
  }

  private async ensureConnected() {
    if (this.isReady()) {
      return;
    }

    if (!this.reconnectPromise) {
      this.scheduleReconnect();
    }

    await this.reconnectPromise;

    if (!this.isReady()) {
      throw new Error('Vara RPC is not connected');
    }
  }

  private async reconnectWithRetries() {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.reconnectAttempts; attempt += 1) {
      if (attempt > 1) {
        const delayMs = Math.min(
          this.options.reconnectDelayMs * 2 ** (attempt - 2),
          this.options.reconnectMaxDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      try {
        console.warn(
          `[bet-quote-service] reconnecting to Vara RPC (attempt ${attempt}/${this.options.reconnectAttempts})`,
        );
        await this.init(true);
        console.log('[bet-quote-service] Vara RPC reconnected');
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[bet-quote-service] Vara RPC reconnect attempt ${attempt} failed: ${message}`);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to reconnect to Vara RPC');
  }

  private markDisconnected(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/disconnected|abnormal closure|normal closure|websocket|connection closed|connection error|timed out|1006::/i.test(message)) {
      this.isConnected = false;
      return true;
    }

    return false;
  }

  async getBasket(basketId: number, expectedAssetKind: 'Bet' | 'Vara' = 'Bet'): Promise<ChainBasket> {
    const attempts = this.options.reconnectAttempts + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.ensureConnected();

      try {
        return await this.readBasket(basketId, expectedAssetKind);
      } catch (error) {
        if (!this.markDisconnected(error) || attempt === attempts) {
          throw error;
        }
      }
    }

    throw new Error('Failed to read basket from Vara RPC');
  }

  private async readBasket(basketId: number, expectedAssetKind: 'Bet' | 'Vara'): Promise<ChainBasket> {
    const result = await this.client!.getBasket(basketId).call();
    if ('err' in result) {
      throw new Error(`Basket ${basketId} not found`);
    }

    const basket = result.ok;
    if (getStatusName(basket.status) !== 'Active') {
      throw new Error(`Basket ${basketId} is not active`);
    }
    if (getAssetKindName(basket.asset_kind) !== expectedAssetKind) {
      throw new Error(`Basket ${basketId} is not a ${expectedAssetKind} basket`);
    }

    return basket;
  }
}
