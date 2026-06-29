import { BadRequestException } from '@nestjs/common';
import { XService } from './x.service';

const config = {
  get: (key: string) => {
    if (key === 'polyBasketsXUsername') return 'poly_baskets';
    return undefined;
  },
  getOrThrow: (key: string) => {
    if (key === 'xBearerToken') return 'test-token';
    throw new Error(`Missing config ${key}`);
  },
};

describe('XService', () => {
  const service = new XService(config as never);

  it('accepts a repost of a PolyBaskets post', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '1',
        text: '',
        author_id: '99',
        referenced_tweets: [{ type: 'retweeted', id: '10' }],
      },
      includedTweets: [{ id: '10', text: 'Campaign post', author_id: '42' }],
      includedUsers: [
        { id: '42', username: 'poly_baskets' },
        { id: '99', username: 'TimurMedov' },
      ],
    }, 'repost', '@TimurMedov')).resolves.toBe('timurmedov');
  });

  it('rejects a repost of a non-PolyBaskets post', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '1',
        text: '',
        author_id: '99',
        referenced_tweets: [{ type: 'retweeted', id: '10' }],
      },
      includedTweets: [{ id: '10', text: 'Other post', author_id: '7' }],
      includedUsers: [
        { id: '7', username: 'other_account' },
        { id: '99', username: 'TimurMedov' },
      ],
    }, 'repost', '@TimurMedov')).rejects.toThrow(BadRequestException);
  });

  it('accepts a repost submission with the original PolyBaskets post URL and username', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      data: [{ id: '99', username: 'TimurMedov' }],
    }));

    try {
      await expect(service.verifyTask({
        tweet: {
          id: '10',
          text: 'PolyBaskets campaign post',
          author_id: '42',
        },
        includedTweets: [],
        includedUsers: [{ id: '42', username: 'poly_baskets' }],
      }, 'repost', '@TimurMedov')).resolves.toBe('timurmedov');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: '/2/tweets/10/retweeted_by',
        }),
        expect.objectContaining({
          headers: { authorization: 'Bearer test-token' },
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects an original PolyBaskets post when the user has not reposted it', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      data: [{ id: '99', username: 'someone_else' }],
    }));

    try {
      await expect(service.verifyTask({
        tweet: {
          id: '10',
          text: 'PolyBaskets campaign post',
          author_id: '42',
        },
        includedTweets: [],
        includedUsers: [{ id: '42', username: 'poly_baskets' }],
      }, 'repost', '@TimurMedov')).rejects.toThrow(/has not reposted/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects an original PolyBaskets post repost submission without username', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '10',
        text: 'PolyBaskets campaign post',
        author_id: '42',
      },
      includedTweets: [],
      includedUsers: [{ id: '42', username: 'poly_baskets' }],
    }, 'repost', '')).rejects.toThrow(/X username/);
  });

  it('accepts a quote of a PolyBaskets post with marketing context', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '2',
        text: 'Trading baskets on PolyBaskets with VARA freebets',
        author_id: '99',
        referenced_tweets: [{ type: 'quoted', id: '10' }],
      },
      includedTweets: [{ id: '10', text: 'Campaign post', author_id: '42' }],
      includedUsers: [
        { id: '42', username: 'poly_baskets' },
        { id: '99', username: 'TimurMedov' },
      ],
    }, 'quote')).resolves.toBe('timurmedov');
  });

  it('accepts the weekly standalone PolyBaskets marketing post', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '3',
        author_id: '99',
        text: [
          'Trading on PolyBaskets: get VARA freebet credits, place basket bets, and win real upside on-chain.',
          '',
          'https://t.co/example',
          '',
          'Pick a market thesis, back the basket, and claim the winning tokens if your trade lands.',
        ].join('\n'),
        entities: {
          urls: [{ url: 'https://t.co/example', expanded_url: 'https://app.polybaskets.xyz/' }],
        },
      },
      includedTweets: [],
      includedUsers: [{ id: '99', username: 'TimurMedov' }],
    }, 'quote')).resolves.toBe('timurmedov');
  });

  it('rejects standalone quote task posts without the PolyBaskets app URL', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '4',
        author_id: '99',
        text: [
          'Trading on PolyBaskets: get VARA freebet credits, place basket bets, and win real upside on-chain.',
          'Pick a market thesis, back the basket, and claim the winning tokens if your trade lands.',
        ].join('\n'),
      },
      includedTweets: [],
      includedUsers: [{ id: '99', username: 'TimurMedov' }],
    }, 'quote', '@TimurMedov')).rejects.toThrow(/app\.polybaskets\.xyz/);
  });

  it('rejects standalone quote task posts with a lookalike PolyBaskets URL host', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '5',
        author_id: '99',
        text: [
          'Trading on PolyBaskets: get VARA freebet credits, place basket bets, and win real upside on-chain.',
          'https://app.polybaskets.xyz.evil/',
          'Pick a market thesis, back the basket, and claim the winning tokens if your trade lands.',
        ].join('\n'),
      },
      includedTweets: [],
      includedUsers: [{ id: '99', username: 'TimurMedov' }],
    }, 'quote', '@TimurMedov')).rejects.toThrow(/app\.polybaskets\.xyz/);
  });

  it('rejects a quote post authored by a different X account', async () => {
    await expect(service.verifyTask({
      tweet: {
        id: '6',
        text: 'Trading baskets on PolyBaskets with VARA freebets',
        author_id: '88',
        referenced_tweets: [{ type: 'quoted', id: '10' }],
      },
      includedTweets: [{ id: '10', text: 'Campaign post', author_id: '42' }],
      includedUsers: [
        { id: '42', username: 'poly_baskets' },
        { id: '88', username: 'someone_else' },
      ],
    }, 'quote', '@TimurMedov')).rejects.toThrow(/authored by @timurmedov/);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
