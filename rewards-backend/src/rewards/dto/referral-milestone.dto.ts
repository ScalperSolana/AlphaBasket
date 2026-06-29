import { IsIn, IsString, MaxLength } from 'class-validator';
import type { ReferralMilestone } from '../../entities/referral-reward.entity';

export class ReferralMilestoneDto {
  @IsString()
  @MaxLength(128)
  referrer: string;

  @IsString()
  @MaxLength(128)
  friend: string;

  @IsIn([50, 500])
  milestone: ReferralMilestone;
}
