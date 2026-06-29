import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { requiredBigintTransformer } from "./transformers";

@Entity()
export class DailyBasketContribution {
  constructor(props?: Partial<DailyBasketContribution>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Index()
  @Column("numeric", { transformer: requiredBigintTransformer })
  dayId: bigint;

  @Index()
  @Column()
  basketId: string;

  @Index()
  @Column()
  user: string;

  @Index()
  @Column()
  userPublicId: string;

  @Column("numeric", { transformer: requiredBigintTransformer })
  realizedProfit: bigint;

  @Column("numeric", { transformer: requiredBigintTransformer })
  payout: bigint;

  @Column("numeric", { transformer: requiredBigintTransformer })
  principal: bigint;

  @Index()
  @Column("timestamptz")
  finalizedAt: Date;
}
