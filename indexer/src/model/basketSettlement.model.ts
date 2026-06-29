import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { bigintTransformer } from "./transformers";

@Entity()
export class BasketSettlement {
  constructor(props?: Partial<BasketSettlement>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  basketId: string;

  @Index()
  @Column("numeric", { nullable: true, transformer: bigintTransformer })
  dayId: bigint | null;

  @Index()
  @Column("timestamptz", { nullable: true })
  finalizedAt: Date | null;

  @Column("numeric", { transformer: bigintTransformer })
  payoutPerShare: bigint | null;

  @Index()
  @Column()
  status: string;
}
