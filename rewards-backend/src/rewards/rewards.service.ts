import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RewardSubmission } from '../entities/reward-submission.entity';
import { ReferralReward, ReferralRecipient } from '../entities/referral-reward.entity';
import { ReferralProgress } from '../entities/referral-progress.entity';
import { Referral } from '../entities/referral.entity';
import { ChainService } from '../chain/chain.service';
import { ManualGrantDto } from './dto/manual-grant.dto';
import { ReferralMilestoneDto } from './dto/referral-milestone.dto';
import { RegisterReferralDto } from './dto/register-referral.dto';
import { SyncReferralActivityDto } from './dto/sync-referral-activity.dto';
import { SubmitXTaskDto } from './dto/submit-x-task.dto';
import {
  REFERRAL_AMOUNTS_VARA,
  X_TASK_AMOUNTS_VARA,
  getUtcWeekKey,
  normalizeActorId,
  parseTweetUrl,
  varaToPlanck,
} from './reward-utils';
import { XService, normalizeXUsername } from './x.service';

@Injectable()
export class RewardsService {
  constructor(
    @InjectRepository(RewardSubmission)
    private readonly submissions: Repository<RewardSubmission>,
    @InjectRepository(ReferralReward)
    private readonly referrals: Repository<ReferralReward>,
    @InjectRepository(Referral)
    private readonly referralPairs: Repository<Referral>,
    @InjectRepository(ReferralProgress)
    private readonly referralProgress: Repository<ReferralProgress>,
    private readonly xService: XService,
    private readonly chain: ChainService,
  ) {}

  async submitXTask(body: SubmitXTaskDto) {
    const actorId = normalizeActorId(body.wallet);
    const { tweetId, username: urlUsername } = parseTweetUrl(body.tweetUrl);
    const weekKey = getUtcWeekKey();
    const amountPlanck = varaToPlanck(X_TASK_AMOUNTS_VARA[body.taskType]);
    const grantId = `x:${weekKey}:${actorId}:${body.taskType}`;
    const reason = `x ${body.taskType} ${weekKey}`;
    const submittedUsername = body.xUsername
      ? normalizeXUsername(body.xUsername)
      : urlUsername;

    if (submittedUsername) {
      await this.ensureXAccountCanSubmit(submittedUsername, body.taskType, tweetId, weekKey);
    }

    const existing = await this.submissions.findOne({
      where: {
        actorId,
        taskType: body.taskType,
        weekKey,
      },
    });
    if (existing) {
      throw new ConflictException(`This wallet already received the ${body.taskType} reward this week`);
    }

    const tweet = await this.xService.fetchTweet(tweetId);
    const xUsername = await this.xService.verifyTask(
      tweet,
      body.taskType,
      body.xUsername ?? urlUsername,
    );

    if (xUsername !== submittedUsername) {
      await this.ensureXAccountCanSubmit(xUsername, body.taskType, tweetId, weekKey);
    }

    const submission = this.submissions.create({
      wallet: body.wallet,
      actorId,
      taskType: body.taskType,
      tweetUrl: body.tweetUrl,
      tweetId,
      xUsername,
      weekKey,
      rewardAmountPlanck: amountPlanck.toString(),
      grantId,
      reason,
      status: 'approved',
    });

    try {
      await this.submissions.save(submission);
    } catch (error) {
      throw new ConflictException('This reward was already paid or the weekly limit was already used');
    }

    await this.chain.grantLedgerFreebet(actorId, amountPlanck, grantId, reason);
    submission.status = 'paid';
    submission.paidAt = new Date();
    return this.submissions.save(submission);
  }

  private async ensureXAccountCanSubmit(
    xUsername: string,
    taskType: SubmitXTaskDto['taskType'],
    tweetId: string,
    weekKey: string,
  ): Promise<void> {
    const existingPost = await this.submissions.findOne({
      where: {
        xUsername,
        taskType,
        tweetId,
      },
    });
    if (existingPost) {
      throw new ConflictException('This X post has already been paid for this reward task');
    }

    const existingWeeklyTask = await this.submissions.findOne({
      where: {
        xUsername,
        taskType,
        weekKey,
      },
    });
    if (existingWeeklyTask) {
      throw new ConflictException(`This X account already received the ${taskType} reward this week`);
    }
  }

  async getSubmission(id: string) {
    const submission = await this.submissions.findOne({ where: { id } });
    if (!submission) throw new NotFoundException('Submission not found');
    return submission;
  }

  async getXSubmissions(wallet: string) {
    const actorId = normalizeActorId(wallet);
    return this.submissions.find({
      where: { actorId },
      order: { createdAt: 'DESC' },
    });
  }

  async manualGrant(body: ManualGrantDto) {
    const actorId = normalizeActorId(body.wallet);
    const amountPlanck = varaToPlanck(BigInt(Math.trunc(body.amountVara)));
    await this.chain.grantLedgerFreebet(actorId, amountPlanck, body.grantId, body.reason);
    return {
      actorId,
      amountPlanck: amountPlanck.toString(),
      grantId: body.grantId,
      status: 'paid',
    };
  }

  async registerReferral(body: RegisterReferralDto) {
    const referrerActorId = normalizeActorId(body.referrer);
    const friendActorId = normalizeActorId(body.friend);

    if (referrerActorId === friendActorId) {
      throw new BadRequestException('referrer and friend must be different wallets');
    }

    const existing = await this.referralPairs.findOne({ where: { friendActorId } });
    if (existing) {
      if (existing.referrerActorId === referrerActorId) {
        return existing;
      }
      throw new ConflictException('friend already accepted another referral');
    }

    return this.referralPairs.save(this.referralPairs.create({
      referrer: body.referrer,
      referrerActorId,
      friend: body.friend,
      friendActorId,
      status: 'active',
      acceptedAt: new Date(),
    }));
  }

  async getReferralDashboard(wallet: string) {
    const actorId = normalizeActorId(wallet);
    const invited = await this.referralPairs.find({
      where: { referrerActorId: actorId },
      order: { createdAt: 'DESC' },
    });
    const accepted = await this.referralPairs.findOne({ where: { friendActorId: actorId } });
    const friendIds = Array.from(new Set([
      ...invited.map((referral) => referral.friendActorId),
      ...(accepted ? [accepted.friendActorId] : []),
    ]));
    const progressRows = friendIds.length
      ? await this.referralProgress.findBy(friendIds.map((friendActorId) => ({ friendActorId })))
      : [];
    const progressByFriend = new Map(progressRows.map((row) => [row.friendActorId, row]));
    const rewards = await this.referrals.find({
      where: [
        { referrerActorId: actorId },
        { friendActorId: actorId },
      ],
      order: { createdAt: 'DESC' },
    });

    return {
      actorId,
      invited: invited.map((referral) => ({
        ...referral,
        progress: this.buildProgress(progressByFriend.get(referral.friendActorId)),
        rewards: rewards.filter((reward) =>
          reward.referrerActorId === referral.referrerActorId &&
          reward.friendActorId === referral.friendActorId,
        ),
      })),
      accepted: accepted
        ? {
            ...accepted,
            progress: this.buildProgress(progressByFriend.get(accepted.friendActorId)),
            rewards: rewards.filter((reward) =>
              reward.referrerActorId === accepted.referrerActorId &&
              reward.friendActorId === accepted.friendActorId,
            ),
          }
        : null,
    };
  }

  async syncReferralActivity(body: SyncReferralActivityDto) {
    const friendActorId = normalizeActorId(body.friend);
    const progress = await this.referralProgress.save(this.referralProgress.create({
      friendActorId,
      txCount: body.txCount,
      activeDays: body.activeDays,
      qualifyingActiveDays: body.qualifyingActiveDays,
      firstTxAt: body.firstTxAt ? new Date(body.firstTxAt) : null,
      lastTxAt: body.lastTxAt ? new Date(body.lastTxAt) : null,
    }));

    const referral = await this.referralPairs.findOne({
      where: {
        friendActorId,
        status: 'active',
      },
    });
    if (!referral || !this.isReferralEligible(progress)) {
      return { progress: this.buildProgress(progress), grants: [] };
    }

    const grants: ReferralReward[] = [];
    if (progress.txCount >= 50) {
      grants.push(...await this.grantReferralMilestone({
        referrer: referral.referrerActorId,
        friend: referral.friendActorId,
        milestone: 50,
      }));
    }
    if (progress.txCount >= 500) {
      grants.push(...await this.grantReferralMilestone({
        referrer: referral.referrerActorId,
        friend: referral.friendActorId,
        milestone: 500,
      }));
    }

    return { progress: this.buildProgress(progress), grants };
  }

  async grantReferralMilestone(body: ReferralMilestoneDto) {
    const referrerActorId = normalizeActorId(body.referrer);
    const friendActorId = normalizeActorId(body.friend);
    const weekKey = getUtcWeekKey();
    const created: ReferralReward[] = [];

    for (const recipient of ['referrer', 'friend'] as ReferralRecipient[]) {
      const recipientActorId = recipient === 'referrer' ? referrerActorId : friendActorId;
      const amountPlanck = varaToPlanck(REFERRAL_AMOUNTS_VARA[body.milestone][recipient]);
      const grantId = `ref:${referrerActorId}:${friendActorId}:${body.milestone}:${recipient}`;
      const reason = `referral ${body.milestone} ${recipient}`;

      const existing = await this.referrals.findOne({ where: { grantId } });
      if (existing) {
        created.push(existing);
        continue;
      }

      if (recipient === 'referrer') {
        const weeklyPaidCount = await this.referrals.count({
          where: {
            referrerActorId,
            milestone: body.milestone,
            recipient: 'referrer',
            weekKey,
          },
        });
        if (weeklyPaidCount >= 5) {
          throw new ForbiddenException('Referrer weekly referral reward cap reached');
        }
      }

      await this.chain.grantLedgerFreebet(recipientActorId, amountPlanck, grantId, reason);
      const reward = await this.referrals.save(this.referrals.create({
        referrer: body.referrer,
        referrerActorId,
        friend: body.friend,
        friendActorId,
        milestone: body.milestone,
        recipient,
        recipientActorId,
        weekKey,
        amountPlanck: amountPlanck.toString(),
        grantId,
        paidAt: new Date(),
      }));
      created.push(reward);
    }

    return created;
  }

  private isReferralEligible(progress: ReferralProgress): boolean {
    const firstTxAt = progress.firstTxAt?.getTime();
    const activeFor48h = firstTxAt ? Date.now() - firstTxAt >= 48 * 60 * 60 * 1000 : false;
    return activeFor48h && progress.qualifyingActiveDays >= 3 && progress.txCount >= 50;
  }

  private buildProgress(progress?: ReferralProgress | null) {
    const firstTxAt = progress?.firstTxAt?.getTime();
    const activeForHours = firstTxAt ? Math.max(0, (Date.now() - firstTxAt) / 3_600_000) : 0;
    return {
      txCount: progress?.txCount ?? 0,
      activeDays: progress?.activeDays ?? 0,
      qualifyingActiveDays: progress?.qualifyingActiveDays ?? 0,
      firstTxAt: progress?.firstTxAt ?? null,
      lastTxAt: progress?.lastTxAt ?? null,
      activeForHours,
      active48hPassed: activeForHours >= 48,
      livenessPassed: (progress?.qualifyingActiveDays ?? 0) >= 3,
      milestone50Passed: (progress?.txCount ?? 0) >= 50,
      milestone500Passed: (progress?.txCount ?? 0) >= 500,
    };
  }
}
