import { ActorId } from 'sails-js';

declare global {
  export interface Config {
    relayer: ActorId;
    fee_bps: number;
    fee_receiver: ActorId;
  }

  export interface Market {
    id: number | string | bigint;
    poly_slug: string;
    poly_id: string | null;
    question: string;
    end_timestamp: number | string | bigint;
    outcomes: Array<string>;
    yes_pool: number | string | bigint;
    no_pool: number | string | bigint;
    resolved: boolean;
    winning_index: number | null;
    resolver_payload: string | null;
  }

  export interface Position {
    yes_amount: number | string | bigint;
    no_amount: number | string | bigint;
    claimed: boolean;
  }
};