import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity()
export class AllTimeBasketStat {
  constructor(props?: Partial<AllTimeBasketStat>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  basketId: string;

  @Index()
  @Column("numeric")
  totalPayout: string;

  @Index()
  @Column("numeric")
  totalRealizedProfit: string;

  @Column("numeric")
  totalPrincipal: string;

  @Column("integer")
  participantCount: number;

  @Index()
  @Column("timestamptz")
  updatedAt: Date;
}
