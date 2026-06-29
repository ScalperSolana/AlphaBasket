import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ReferralStatus = 'active' | 'blocked';

@Entity('referral')
@Index(['friendActorId'], { unique: true })
@Index(['referrerActorId'])
export class Referral {
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

  @Column({ name: 'status', nullable: false, default: 'active' })
  status: ReferralStatus;

  @Column({ name: 'accepted_at', type: 'timestamp without time zone', nullable: false })
  acceptedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp without time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp without time zone' })
  updatedAt: Date;
}
