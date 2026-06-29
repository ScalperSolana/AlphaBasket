import { ConflictException } from '@nestjs/common';
import { RewardsService } from './rewards.service';

describe('RewardsService', () => {
  it('rejects a second wallet claiming the same X account task in the same week', async () => {
    const submissions = {
      findOne: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'existing', xUsername: 'timurmedov' }),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const xService = {
      fetchTweet: jest.fn().mockResolvedValue({ tweet: { id: '123', text: '' }, includedTweets: [], includedUsers: [] }),
      verifyTask: jest.fn().mockResolvedValue('timurmedov'),
    };
    const chain = {
      grantLedgerFreebet: jest.fn(),
    };
    const service = new RewardsService(
      submissions as never,
      {} as never,
      {} as never,
      {} as never,
      xService as never,
      chain as never,
    );

    await expect(service.submitXTask({
      wallet: '0x'.padEnd(66, '1'),
      taskType: 'repost',
      tweetUrl: 'https://x.com/poly_baskets/status/123',
      xUsername: '@TimurMedov',
    })).rejects.toThrow(ConflictException);

    expect(submissions.findOne).toHaveBeenNthCalledWith(1, {
      where: {
        xUsername: 'timurmedov',
        taskType: 'repost',
        tweetId: '123',
      },
    });
    expect(submissions.findOne).toHaveBeenNthCalledWith(2, {
      where: {
        xUsername: 'timurmedov',
        taskType: 'repost',
        weekKey: expect.any(String),
      },
    });
    expect(xService.fetchTweet).not.toHaveBeenCalled();
    expect(xService.verifyTask).not.toHaveBeenCalled();
    expect(chain.grantLedgerFreebet).not.toHaveBeenCalled();
  });

  it('rejects the same X account claiming the same task post again outside the weekly wallet limit', async () => {
    const submissions = {
      findOne: jest.fn()
        .mockResolvedValueOnce({ id: 'existing', xUsername: 'timurmedov', tweetId: '123' }),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const xService = {
      fetchTweet: jest.fn().mockResolvedValue({ tweet: { id: '123', text: '' }, includedTweets: [], includedUsers: [] }),
      verifyTask: jest.fn().mockResolvedValue('timurmedov'),
    };
    const service = new RewardsService(
      submissions as never,
      {} as never,
      {} as never,
      {} as never,
      xService as never,
      { grantLedgerFreebet: jest.fn() } as never,
    );

    await expect(service.submitXTask({
      wallet: '0x'.padEnd(66, '2'),
      taskType: 'quote',
      tweetUrl: 'https://x.com/timurmedov/status/123',
    })).rejects.toThrow('This X post has already been paid');

    expect(xService.fetchTweet).not.toHaveBeenCalled();
    expect(xService.verifyTask).not.toHaveBeenCalled();
  });

  it('rejects a wallet that already used this weekly task before X lookup', async () => {
    const submissions = {
      findOne: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'existing-wallet' }),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const xService = {
      fetchTweet: jest.fn(),
      verifyTask: jest.fn(),
    };
    const service = new RewardsService(
      submissions as never,
      {} as never,
      {} as never,
      {} as never,
      xService as never,
      { grantLedgerFreebet: jest.fn() } as never,
    );

    await expect(service.submitXTask({
      wallet: '0x'.padEnd(66, '3'),
      taskType: 'quote',
      tweetUrl: 'https://x.com/timurmedov/status/456',
    })).rejects.toThrow('This wallet already received the quote reward this week');

    expect(xService.fetchTweet).not.toHaveBeenCalled();
  });
});
