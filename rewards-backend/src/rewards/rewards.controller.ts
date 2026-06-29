import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ManualGrantDto } from './dto/manual-grant.dto';
import { ReferralMilestoneDto } from './dto/referral-milestone.dto';
import { RegisterReferralDto } from './dto/register-referral.dto';
import { SyncReferralActivityDto } from './dto/sync-referral-activity.dto';
import { SubmitXTaskDto } from './dto/submit-x-task.dto';
import { RewardsService } from './rewards.service';

const X_SUBMIT_THROTTLE = { default: { limit: 10, ttl: 3600000 } };

@Controller()
export class RewardsController {
  constructor(
    private readonly rewards: RewardsService,
    private readonly configService: ConfigService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'polybaskets-rewards' };
  }

  @Post('rewards/x/submit')
  @Throttle(X_SUBMIT_THROTTLE)
  submitXTask(@Body() body: SubmitXTaskDto) {
    return this.rewards.submitXTask(body);
  }

  @Get('rewards/submissions/:id')
  getSubmission(@Param('id') id: string) {
    return this.rewards.getSubmission(id);
  }

  @Get('rewards/x/:wallet')
  getXSubmissions(@Param('wallet') wallet: string) {
    return this.rewards.getXSubmissions(wallet);
  }

  @Post('rewards/referrals/register')
  registerReferral(@Body() body: RegisterReferralDto) {
    return this.rewards.registerReferral(body);
  }

  @Get('rewards/referrals/:wallet')
  getReferralDashboard(@Param('wallet') wallet: string) {
    return this.rewards.getReferralDashboard(wallet);
  }

  @Post('rewards/referrals/activity')
  syncReferralActivity(@Body() body: SyncReferralActivityDto, @Headers('x-api-key') apiKey: string) {
    this.requireAdmin(apiKey);
    return this.rewards.syncReferralActivity(body);
  }

  @Post('rewards/grants/manual')
  manualGrant(@Body() body: ManualGrantDto, @Headers('x-api-key') apiKey: string) {
    this.requireAdmin(apiKey);
    return this.rewards.manualGrant(body);
  }

  @Post('rewards/referrals/milestone')
  referralMilestone(@Body() body: ReferralMilestoneDto, @Headers('x-api-key') apiKey: string) {
    this.requireAdmin(apiKey);
    return this.rewards.grantReferralMilestone(body);
  }

  private requireAdmin(apiKey: string) {
    const expected = this.configService.get<string>('adminApiKey');
    if (!expected) throw new ForbiddenException();

    const hmac = (value: string) =>
      createHmac('sha256', 'polybaskets-rewards-admin').update(value).digest();
    if (!timingSafeEqual(hmac(apiKey ?? ''), hmac(expected))) {
      throw new ForbiddenException();
    }
  }
}
