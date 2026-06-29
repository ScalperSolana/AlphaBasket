import { Column, Entity, PrimaryColumn } from "typeorm";
import { bigintTransformer } from "./transformers";

@Entity()
export class IndexerState {
  constructor(props?: Partial<IndexerState>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Column("numeric", { nullable: true, transformer: bigintTransformer })
  lastProcessedBlock: bigint | null;

  @Column("timestamptz", { nullable: true })
  lastProcessedAt: Date | null;

  @Column("boolean")
  knownGapDetected: boolean;

  @Column("numeric", { nullable: true, transformer: bigintTransformer })
  startDayId: bigint | null;

  @Column("numeric", { nullable: true, transformer: bigintTransformer })
  lastMaterializedDayId: bigint | null;

  @Column("timestamptz")
  updatedAt: Date;
}
