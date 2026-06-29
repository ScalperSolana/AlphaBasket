import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';
import { waitReady } from '@polkadot/wasm-crypto';
import { FreebetLedgerProgram } from './freebet-ledger.client';

const SIGN_AND_SEND_TIMEOUT_MS = 180_000;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), SIGN_AND_SEND_TIMEOUT_MS),
    ),
  ]);
}

@Injectable()
export class ChainService implements OnModuleInit {
  private readonly logger = new Logger('ChainService');
  private readonly nodeUrl: string;
  private readonly ledgerProgramId: `0x${string}`;
  private api: GearApi;
  private ledgerProgram: FreebetLedgerProgram;
  private account: ReturnType<Keyring['addFromUri']>;

  constructor(private readonly configService: ConfigService) {
    this.nodeUrl = this.configService.getOrThrow<string>('nodeUrl');
    const configuredLedgerProgramId = this.configService.getOrThrow<string>('freebetLedgerId');
    if (!/^0x[0-9a-fA-F]{64}$/.test(configuredLedgerProgramId)) {
      throw new Error('FREEBET_LEDGER_ID must be a 0x-prefixed 32-byte program id');
    }
    this.ledgerProgramId = configuredLedgerProgramId as `0x${string}`;
    this.api = new GearApi({ providerAddress: this.nodeUrl });
  }

  async onModuleInit() {
    await Promise.all([this.api.isReadyOrError, waitReady()]);

    const keyring = new Keyring({ type: 'sr25519', ss58Format: 137 });
    const seed = this.configService.getOrThrow<string>('rewardsAccount');

    if (seed.startsWith('0x')) {
      this.account = keyring.addFromSeed(hexToU8a(seed));
    } else {
      this.account = keyring.addFromUri(seed);
    }

    this.ledgerProgram = new FreebetLedgerProgram(this.api, this.ledgerProgramId);
    this.logger.log(`Rewards issuer: ${this.account.address}`);
    this.logger.log(`Freebet ledger program: ${this.ledgerProgramId}`);
  }

  private async ensureConnected(): Promise<void> {
    if (this.api.isConnected) return;

    this.logger.warn('GearApi disconnected; reconnecting');
    try {
      await this.api.disconnect();
    } catch {
      // stale socket may already be closed
    }
    this.api = new GearApi({ providerAddress: this.nodeUrl });
    await this.api.isReadyOrError;
    this.ledgerProgram = new FreebetLedgerProgram(this.api, this.ledgerProgramId);
  }

  async grantLedgerFreebet(
    actorId: string,
    amountPlanck: bigint,
    grantId: string,
    reason: string,
  ): Promise<string | null> {
    await this.ensureConnected();

    const tx = this.ledgerProgram.freebetLedger
      .grant(actorId as `0x${string}`, grantId, reason)
      .withValue(amountPlanck)
      .withAccount(this.account);

    await tx.calculateGas(false, 20);
    const { txHash, response } = await tx.signAndSend();
    await withTimeout(response(), `freebet ledger grant timed out after ${SIGN_AND_SEND_TIMEOUT_MS}ms`);

    this.logger.log(`Granted ledger freebet: actor=${actorId} amount=${amountPlanck} grant=${grantId}`);
    return txHash ?? null;
  }
}
