import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity()
export class Basket {
  constructor(props?: Partial<Basket>) {
    Object.assign(this, props);
  }

  @PrimaryColumn()
  id: string;

  @Index()
  @Column("numeric")
  basketId: string;

  @Index()
  @Column()
  basketProgramId: string;

  @Index()
  @Column()
  assetKind: string;

  @Index()
  @Column()
  creator: string;

  @Index()
  @Column()
  creatorPublicId: string;

  @Index()
  @Column("timestamptz")
  createdAt: Date;

  @Index()
  @Column()
  status: string;
}
