import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RewardSubmission } from '../entities/reward-submission.entity';
import { ReferralReward } from '../entities/referral-reward.entity';
import { ReferralProgress } from '../entities/referral-progress.entity';
import { Referral } from '../entities/referral.entity';
import { ChainService } from '../chain/chain.service';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { XService } from './x.service';

@Module({
  imports: [TypeOrmModule.forFeature([RewardSubmission, ReferralReward, Referral, ReferralProgress])],
  controllers: [RewardsController],
  providers: [RewardsService, XService, ChainService],
})
export class RewardsModule {}
