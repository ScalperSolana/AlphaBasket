import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { decodeAddress } from '@polkadot/util-crypto';
import { SailsProgram } from '../sails-client/lib.js';

export interface VaraMarket {
  id: number;
  poly_slug: string;
  poly_id: string | null;
  question: string;
  end_timestamp: number;
  outcomes: string[];
  yes_pool: string;
  no_pool: string;
  resolved: boolean;
  winning_index: number | null;
  resolver_payload: string | null;
}

export interface VaraPosition {
  yes_amount: string;
  no_amount: string;
  claimed: boolean;
}

export class VaraClient {
  private api: GearApi | null = null;
  private program: SailsProgram | null = null;
  private relayerAccount: ReturnType<Keyring['addFromUri']> | null = null;

  constructor(
    private readonly programId: string,
    private readonly rpcUrl: string,
    private readonly relayerSeed?: string
  ) {}

  async init(): Promise<void> {
    this.api = await GearApi.create({ providerAddress: this.rpcUrl });
    this.program = new SailsProgram(this.api, this.programId as `0x${string}`);

    if (this.relayerSeed) {
      const keyring = new Keyring({ type: 'sr25519', ss58Format: 137 });
      this.relayerAccount = keyring.addFromUri(this.relayerSeed);
      const actorId = this.actorIdFromAddress(this.relayerAccount.address);
      console.log('Relayer address:', this.relayerAccount.address);
      console.log('Relayer ActorId [u8;32]:', JSON.stringify(actorId));
    }

    console.log('Vara client initialized');
  }

  async waitForReady(): Promise<void> {
    if (!this.api || !this.program) {
      await this.init();
    }
  }

  private ctx() {
    if (!this.api || !this.program) {
      throw new Error('Vara client not initialized');
    }
    return { api: this.api, program: this.program };
  }

  async getMarket(marketId: number): Promise<VaraMarket | null> {
    const { program } = this.ctx();
    const result = await program.polymarketMirror.getMarket(marketId).call();
    if ('err' in result) {
      return null;
    }
    const m = result.ok;
    return {
      id: Number(m.id),
      poly_slug: m.poly_slug,
      poly_id: m.poly_id ?? null,
      question: m.question,
      end_timestamp: Number(m.end_timestamp),
      outcomes: m.outcomes,
      yes_pool: m.yes_pool.toString(),
      no_pool: m.no_pool.toString(),
      resolved: m.resolved,
      winning_index: m.winning_index ?? null,
      resolver_payload: m.resolver_payload ?? null,
    };
  }

  async getMarketCount(): Promise<number> {
    const { program } = this.ctx();
    const count = await program.polymarketMirror.getMarketCount().call();
    return Number(count);
  }

  async isMarketResolved(marketId: number): Promise<boolean> {
    const market = await this.getMarket(marketId);
    return market?.resolved ?? false;
  }

  async resolveMarket(
    marketId: number,
    winningIndex: number,
    resolverPayload: string
  ): Promise<string | null> {
    const { program } = this.ctx();
    if (!this.relayerAccount) {
      throw new Error('Relayer account not configured');
    }

    const tx = program.polymarketMirror
      .resolveMarket(marketId, winningIndex, resolverPayload)
      .withAccount(this.relayerAccount);

    console.log(`[relayer] Market ${marketId}: calculating gas for resolveMarket(winningIndex=${winningIndex})`);
    await tx.calculateGas(false, 20);
    console.log(`[relayer] Market ${marketId}: signing and sending resolveMarket`);
    const { txHash, response } = await tx.signAndSend();
    console.log(`[relayer] Market ${marketId}: resolve tx submitted (${txHash}), waiting for response`);
    const result = await response();
    if (result && typeof result === 'object' && 'err' in result) {
      throw new Error(`ResolveMarket error: ${result.err}`);
    }
    return txHash;
  }

  actorIdFromAddress(address: string): number[] {
    const bytes = decodeAddress(address);
    return Array.from(bytes);
  }

  async disconnect(): Promise<void> {
    if (this.api) {
      await this.api.disconnect();
    }
  }
}
