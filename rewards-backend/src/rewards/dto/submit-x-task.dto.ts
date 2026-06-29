import { IsIn, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import type { XTaskType } from '../../entities/reward-submission.entity';

export class SubmitXTaskDto {
  @IsString()
  @MaxLength(128)
  wallet: string;

  @IsIn(['repost', 'quote'])
  taskType: XTaskType;

  @IsUrl({ require_protocol: true })
  @MaxLength(512)
  tweetUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  @Matches(/^@?[A-Za-z0-9_]{1,15}$/)
  xUsername?: string;
}
