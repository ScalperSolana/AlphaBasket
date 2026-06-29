import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { requiredBigintTransformer } from "./transformers";

@Entity()
export class DailyUserActivityAggregate {
  constructor(props?: Partial<DailyUserActivityAggregate>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Index()
  @Column("numeric", { transformer: requiredBigintTransformer })
  dayId: bigint;

  @Index()
  @Column()
  user: string;

  @Index()
  @Column()
  userPublicId: string;

  @Column("int")
  txCount: number;

  @Column("int")
  basketsMade: number;

  @Column("int")
  betsPlaced: number;

  @Column("int")
  approvesCount: number;

  @Column("int")
  claimsCount: number;

  @Index()
  @Column("timestamptz")
  firstTxAt: Date;

  @Column("numeric", { transformer: requiredBigintTransformer })
  firstTxBlock: bigint;

  @Column()
  firstTxMessageId: string;

  @Index()
  @Column("timestamptz")
  lastTxAt: Date;

  @Column("numeric", { transformer: requiredBigintTransformer })
  lastTxBlock: bigint;

  @Column()
  lastTxMessageId: string;

  @Index()
  @Column("timestamptz")
  updatedAt: Date;
}
