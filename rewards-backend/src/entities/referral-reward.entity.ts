import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ReferralMilestone = 50 | 500;
export type ReferralRecipient = 'referrer' | 'friend';

@Entity('referral_reward')
@Index(['grantId'], { unique: true })
export class ReferralReward {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'referrer', nullable: false })
  referrer: string;

  @Column({ name: 'referrer_actor_id', nullable: false })
  referrerActorId: string;

  @Column({ name: 'friend', nullable: false })
  friend: string;

  @Column({ name: 'friend_actor_id', nullable: false })
  friendActorId: string;

  @Column({ name: 'milestone', type: 'integer', nullable: false })
  milestone: ReferralMilestone;

  @Column({ name: 'recipient', nullable: false })
  recipient: ReferralRecipient;

  @Column({ name: 'recipient_actor_id', nullable: false })
  recipientActorId: string;

  @Column({ name: 'week_key', nullable: false })
  weekKey: string;

  @Column({ name: 'amount_planck', type: 'numeric', precision: 39, scale: 0 })
  amountPlanck: string;

  @Column({ name: 'grant_id', nullable: false })
  grantId: string;

  @Column({ name: 'paid_at', type: 'timestamp without time zone', nullable: true })
  paidAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp without time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp without time zone' })
  updatedAt: Date;
}
