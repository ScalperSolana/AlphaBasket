/* eslint-disable */

import { GearApi, HexString } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, ActorId, QueryBuilder } from 'sails-js';

type ProgramRef = { id: `0x${string}` };

export class SailsProgram {
  public readonly registry: TypeRegistry;
  public readonly polymarketMirror: PolymarketMirror;
  private _program?: ProgramRef;

  constructor(public api: GearApi, programId?: `0x${string}`) {
    const types: Record<string, any> = {
      Config: { relayer: '[u8;32]', fee_bps: 'u16', fee_receiver: '[u8;32]' },
      Market: {
        id: 'u64',
        poly_slug: 'String',
        poly_id: 'Option<String>',
        question: 'String',
        end_timestamp: 'u64',
        outcomes: 'Vec<String>',
        yes_pool: 'u128',
        no_pool: 'u128',
        resolved: 'bool',
        winning_index: 'Option<u8>',
        resolver_payload: 'Option<String>',
      },
      Position: { yes_amount: 'u128', no_amount: 'u128', claimed: 'bool' },
    };

    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    if (programId) {
      this._program = { id: programId };
    }

    this.polymarketMirror = new PolymarketMirror(this);
  }

  public get programId(): `0x${string}` {
    if (!this._program) throw new Error(`Program ID is not set`);
    return this._program.id;
  }

  newCtorFromCode(
    code: Uint8Array | Buffer | HexString,
    relayer: ActorId,
    fee_bps: number,
    fee_receiver: ActorId
  ): TransactionBuilder<null> {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'upload_program',
      null,
      'New',
      [relayer, fee_bps, fee_receiver],
      '([u8;32], u16, [u8;32])',
      'String',
      code,
      async (programId) => {
        this._program = { id: programId as `0x${string}` };
      }
    );
    return builder;
  }

  newCtorFromCodeId(
    codeId: `0x${string}`,
    relayer: ActorId,
    fee_bps: number,
    fee_receiver: ActorId
  ) {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'create_program',
      null,
      'New',
      [relayer, fee_bps, fee_receiver],
      '([u8;32], u16, [u8;32])',
      'String',
      codeId,
      async (programId) => {
        this._program = { id: programId as `0x${string}` };
      }
    );
    return builder;
  }
}

export class PolymarketMirror {
  constructor(private _program: SailsProgram) {}

  public betNo(market_id: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: string }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: string }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PolymarketMirror',
      'BetNo',
      market_id,
      'u64',
      'Result<u128, String>',
      this._program.programId,
    );
  }

  public betYes(market_id: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: string }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: string }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PolymarketMirror',
      'BetYes',
      market_id,
      'u64',
      'Result<u128, String>',
      this._program.programId,
    );
  }

  public claim(market_id: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: string }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: string }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PolymarketMirror',
      'Claim',
      market_id,
      'u64',
      'Result<u128, String>',
      this._program.programId,
    );
  }

  public createMarket(
    poly_slug: string,
    poly_id: string | null,
    question: string,
    end_timestamp: number | string | bigint,
    outcomes: Array<string>
  ): TransactionBuilder<{ ok: number | string | bigint } | { err: string }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: string }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PolymarketMirror',
      'CreateMarket',
      [poly_slug, poly_id, question, end_timestamp, outcomes],
      '(String, Option<String>, String, u64, Vec<String>)',
      'Result<u64, String>',
      this._program.programId,
    );
  }

  public init(_relayer: ActorId, _fee_bps: number, _fee_receiver: ActorId): TransactionBuilder<{ ok: null } | { err: string }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: string }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PolymarketMirror',
      'Init',
      [_relayer, _fee_bps, _fee_receiver],
      '([u8;32], u16, [u8;32])',
      'Result<Null, String>',
      this._program.programId,
    );
  }

  public resolveMarket(
    market_id: number | string | bigint,
    winning_index: number,
    resolver_payload: string
  ): TransactionBuilder<{ ok: null } | { err: string }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: string }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PolymarketMirror',
      'ResolveMarket',
      [market_id, winning_index, resolver_payload],
      '(u64, u8, String)',
      'Result<Null, String>',
      this._program.programId,
    );
  }

  public getConfig(): QueryBuilder<Config> {
    return new QueryBuilder<Config>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PolymarketMirror',
      'GetConfig',
      null,
      null,
      'Config',
    );
  }

  public getMarket(market_id: number | string | bigint): QueryBuilder<{ ok: Market } | { err: string }> {
    return new QueryBuilder<{ ok: Market } | { err: string }>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PolymarketMirror',
      'GetMarket',
      market_id,
      'u64',
      'Result<Market, String>',
    );
  }

  public getMarketCount(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PolymarketMirror',
      'GetMarketCount',
      null,
      null,
      'u64',
    );
  }

  public getPosition(market_id: number | string | bigint, user: ActorId): QueryBuilder<{ ok: Position | null } | { err: string }> {
    return new QueryBuilder<{ ok: Position | null } | { err: string }>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PolymarketMirror',
      'GetPosition',
      [market_id, user],
      '(u64, [u8;32])',
      'Result<Option<Position>, String>',
    );
  }
}
