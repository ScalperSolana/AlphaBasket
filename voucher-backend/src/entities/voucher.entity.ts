import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('voucher')
export class Voucher {
  constructor(props?: Partial<Voucher>) {
    if (props) Object.assign(this, props);
  }

  @PrimaryGeneratedColumn('uuid')
  id?: string;

  @Column({ name: 'voucher_id', nullable: false, unique: true })
  voucherId: string;

  @Column({ nullable: false })
  account: string;

  @Column({ type: 'jsonb' })
  programs: string[];

  @Column({ name: 'vara_to_issue', type: 'float', nullable: false, default: 0 })
  varaToIssue: number;

  @Column({
    name: 'created_at',
    type: 'timestamp without time zone',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt?: Date;

  @Column({ type: 'bigint', name: 'valid_up_to_block', nullable: false })
  validUpToBlock: bigint;

  @Column({
    name: 'valid_up_to',
    type: 'timestamp without time zone',
    nullable: false,
  })
  validUpTo: Date;

  @Column({ name: 'revoked', type: 'boolean', default: false })
  revoked: boolean;

  // Funding marker: advances on VoucherService.issue() and VoucherService.update()
  // when the voucher gets a balance top-up. Does NOT advance on appendProgramOnly()
  // — same-UTC-day program appends are free in Path B. GaslessService uses
  // `lastRenewedAt >= todayMidnight` as the daily-gate check to decide whether to
  // top up the voucher to DAILY_VARA_CAP or just append the program.
  @Column({
    name: 'last_renewed_at',
    type: 'timestamp without time zone',
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastRenewedAt: Date;
}
