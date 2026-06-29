import { webcrypto } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { RewardSubmission } from './entities/reward-submission.entity';
import { ReferralReward } from './entities/referral-reward.entity';
import { Referral } from './entities/referral.entity';
import { ReferralProgress } from './entities/referral-progress.entity';
import { RewardsModule } from './rewards/rewards.module';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as typeof globalThis.crypto;
}

@Module({
  imports: [
    ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 3600000, limit: 100 }]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('database.host'),
        port: config.get('database.port'),
        username: config.get('database.user'),
        password: config.get('database.password'),
        database: config.get('database.name'),
        entities: [RewardSubmission, ReferralReward, Referral, ReferralProgress],
        synchronize: config.get<boolean>('database.synchronize'),
      }),
      inject: [ConfigService],
    }),
    RewardsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
