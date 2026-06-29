import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity()
export class AllTimeAgentStat {
  constructor(props?: Partial<AllTimeAgentStat>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  address: string;

  @Index()
  @Column()
  publicId: string;

  @Index()
  @Column("integer")
  basketCount: number;

  @Index()
  @Column("numeric")
  totalRewards: string;

  @Column("jsonb")
  basketIds: string[];

  @Index()
  @Column("timestamptz")
  updatedAt: Date;
}
