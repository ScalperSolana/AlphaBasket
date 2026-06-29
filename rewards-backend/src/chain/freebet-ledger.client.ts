import { GearApi, BaseGearProgram } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, ActorId } from 'sails-js';

export class FreebetLedgerProgram {
  public readonly registry: TypeRegistry;
  public readonly freebetLedger: FreebetLedger;
  private readonly program: BaseGearProgram;

  constructor(public api: GearApi, programId: `0x${string}`) {
    const types: Record<string, any> = {
      FreebetGrant: {
        id: 'String',
        recipient: '[u8;32]',
        amount: 'u128',
        reason: 'String',
        granted_at: 'u64',
      },
    };

    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    this.program = new BaseGearProgram(programId, api);
    this.freebetLedger = new FreebetLedger(this);
  }

  get programId(): `0x${string}` {
    return this.program.id;
  }
}

export class FreebetLedger {
  constructor(private readonly program: FreebetLedgerProgram) {}

  grant(to: ActorId, grantId: string, reason: string): TransactionBuilder<number | string | bigint> {
    return new TransactionBuilder<number | string | bigint>(
      this.program.api,
      this.program.registry,
      'send_message',
      'FreebetLedger',
      'Grant',
      [to, grantId, reason],
      '([u8;32], String, String)',
      'u128',
      this.program.programId,
    );
  }
}
