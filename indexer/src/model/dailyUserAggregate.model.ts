import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { requiredBigintTransformer } from "./transformers";

@Entity()
export class DailyUserAggregate {
  constructor(props?: Partial<DailyUserAggregate>) {
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

  @Column("numeric", { transformer: requiredBigintTransformer })
  realizedProfit: bigint;

  @Column("int")
  basketCount: number;

  @Index()
  @Column("timestamptz")
  updatedAt: Date;
}
