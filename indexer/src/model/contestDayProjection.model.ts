import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { bigintTransformer, requiredBigintTransformer } from "./transformers";

@Entity()
export class ContestDayProjection {
  constructor(props?: Partial<ContestDayProjection>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Index({ unique: true })
  @Column("numeric", { transformer: requiredBigintTransformer })
  dayId: bigint;

  @Index()
  @Column()
  status: string;

  @Column("numeric", { nullable: true, transformer: bigintTransformer })
  maxRealizedProfit: bigint | null;

  @Column("int")
  winnerCount: number;

  @Column("numeric", { nullable: true, transformer: bigintTransformer })
  totalReward: bigint | null;

  @Index()
  @Column("boolean")
  settledOnChain: boolean;

  @Index()
  @Column("boolean")
  indexerComplete: boolean;

  @Index()
  @Column("timestamptz")
  settlementAllowedAt: Date;

  @Index()
  @Column("timestamptz", { nullable: true })
  settledAt: Date | null;

  @Column({ nullable: true })
  resultHash: string | null;

  @Column({ nullable: true })
  evidenceHash: string | null;

  @Index()
  @Column("timestamptz")
  updatedAt: Date;
}
