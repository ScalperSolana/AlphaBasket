import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type XTaskType = 'repost' | 'quote';
export type RewardSubmissionStatus = 'pending' | 'approved' | 'rejected' | 'paid';

@Entity('reward_submission')
@Index(['actorId', 'taskType', 'weekKey'], { unique: true })
@Index(['xUsername', 'taskType', 'weekKey'], { unique: true, where: '"x_username" IS NOT NULL' })
@Index(['xUsername', 'taskType', 'tweetId'], { unique: true, where: '"x_username" IS NOT NULL' })
@Index(['grantId'], { unique: true })
export class RewardSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'wallet', nullable: false })
  wallet: string;

  @Column({ name: 'actor_id', nullable: false })
  actorId: string;

  @Column({ name: 'task_type', nullable: false })
  taskType: XTaskType;

  @Column({ name: 'tweet_url', nullable: false })
  tweetUrl: string;

  @Column({ name: 'tweet_id', nullable: false })
  tweetId: string;

  @Column({ name: 'x_username', type: 'character varying', nullable: true })
  xUsername?: string | null;

  @Column({ name: 'week_key', nullable: false })
  weekKey: string;

  @Column({ name: 'reward_amount_planck', type: 'numeric', precision: 39, scale: 0 })
  rewardAmountPlanck: string;

  @Column({ name: 'grant_id', nullable: false })
  grantId: string;

  @Column({ name: 'reason', nullable: false })
  reason: string;

  @Column({ name: 'status', nullable: false, default: 'pending' })
  status: RewardSubmissionStatus;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string | null;

  @Column({ name: 'paid_at', type: 'timestamp without time zone', nullable: true })
  paidAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp without time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp without time zone' })
  updatedAt: Date;
}
