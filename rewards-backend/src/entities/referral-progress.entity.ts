import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('referral_progress')
@Index(['updatedAt'])
export class ReferralProgress {
  @PrimaryColumn({ name: 'friend_actor_id' })
  friendActorId: string;

  @Column({ name: 'tx_count', type: 'integer', nullable: false, default: 0 })
  txCount: number;

  @Column({ name: 'active_days', type: 'integer', nullable: false, default: 0 })
  activeDays: number;

  @Column({ name: 'qualifying_active_days', type: 'integer', nullable: false, default: 0 })
  qualifyingActiveDays: number;

  @Column({ name: 'first_tx_at', type: 'timestamp without time zone', nullable: true })
  firstTxAt?: Date | null;

  @Column({ name: 'last_tx_at', type: 'timestamp without time zone', nullable: true })
  lastTxAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp without time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp without time zone' })
  updatedAt: Date;
}
