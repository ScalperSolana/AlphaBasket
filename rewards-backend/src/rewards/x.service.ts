import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { XTaskType } from '../entities/reward-submission.entity';

type XReferencedTweet = {
  type: 'retweeted' | 'quoted' | 'replied_to';
  id: string;
};

type XTweet = {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  referenced_tweets?: XReferencedTweet[];
  entities?: {
    urls?: Array<{
      url?: string;
      expanded_url?: string;
      display_url?: string;
      unwound_url?: string;
    }>;
  };
};

type XUser = {
  id: string;
  username?: string;
};

type XTweetLookup = {
  tweet: XTweet;
  includedTweets: XTweet[];
  includedUsers: XUser[];
};

const RETWEETED_BY_PAGE_LIMIT = 10;

@Injectable()
export class XService {
  constructor(private readonly configService: ConfigService) {}

  async fetchTweet(tweetId: string): Promise<XTweetLookup> {
    const token = this.configService.getOrThrow<string>('xBearerToken');
    const url = new URL(`https://api.x.com/2/tweets/${tweetId}`);
    url.searchParams.set('tweet.fields', 'author_id,conversation_id,created_at,entities,referenced_tweets,text');
    url.searchParams.set('user.fields', 'username');
    url.searchParams.set('expansions', 'author_id,referenced_tweets.id,referenced_tweets.id.author_id');

    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BadRequestException(`X API rejected tweet lookup (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = await response.json() as {
      data?: XTweet;
      includes?: {
        tweets?: XTweet[];
        users?: XUser[];
      };
    };
    if (!json.data) {
      throw new BadRequestException('Tweet not found');
    }

    return {
      tweet: json.data,
      includedTweets: json.includes?.tweets ?? [],
      includedUsers: json.includes?.users ?? [],
    };
  }

  async verifyTask(lookup: XTweetLookup, taskType: XTaskType, xUsername?: string): Promise<string> {
    const refs = lookup.tweet.referenced_tweets ?? [];

    if (taskType === 'repost') {
      const retweet = refs.find((ref) => ref.type === 'retweeted');
      if (retweet) {
        this.ensurePolyBasketsSource(lookup, retweet.id, 'Repost');
        return this.resolveTweetAuthorUsername(lookup, xUsername, 'Repost');
      }

      this.ensureTweetAuthorIsPolyBaskets(lookup, 'Repost');
      const normalizedUsername = normalizeXUsername(
        xUsername,
        'X username is required when submitting the original PolyBaskets post URL',
      );
      await this.ensureUserRepostedTweet(lookup.tweet.id, normalizedUsername);
      return normalizedUsername;
    }

    if (taskType === 'quote') {
      const quote = refs.find((ref) => ref.type === 'quoted');
      if (quote) {
        this.ensurePolyBasketsSource(lookup, quote.id, 'Quote');
        const normalizedUsername = this.resolveTweetAuthorUsername(lookup, xUsername, 'Quote');
        if (!/polybaskets|freebet|basket/i.test(lookup.tweet.text)) {
          throw new BadRequestException('Quote text must mention PolyBaskets, freebet, or basket context');
        }
        return normalizedUsername;
      }

      const normalizedUsername = this.resolveTweetAuthorUsername(lookup, xUsername, 'Post');
      this.ensureStandaloneMarketingPost(lookup.tweet);
      return normalizedUsername;
    }

    throw new BadRequestException('Unsupported task type');
  }

  private ensurePolyBasketsSource(lookup: XTweetLookup, referencedTweetId: string, label: string): void {
    const username = this.findIncludedTweetAuthorUsername(lookup, referencedTweetId);

    if (username !== this.sourceUsername()) {
      throw new BadRequestException(`${label} must target a post from @${this.sourceUsername()}`);
    }
  }

  private ensureTweetAuthorIsPolyBaskets(lookup: XTweetLookup, label: string): void {
    const username = this.findTweetAuthorUsername(lookup);

    if (username !== this.sourceUsername()) {
      throw new BadRequestException(`${label} must target a post from @${this.sourceUsername()}`);
    }
  }

  private resolveTweetAuthorUsername(lookup: XTweetLookup, xUsername: string | undefined, label: string): string {
    const username = this.findTweetAuthorUsername(lookup);
    if (!username) {
      throw new BadRequestException(`${label} post author could not be verified`);
    }

    if (xUsername) {
      const normalizedUsername = normalizeXUsername(xUsername);
      if (username !== normalizedUsername) {
        throw new BadRequestException(`${label} post must be authored by @${normalizedUsername}`);
      }
    }

    return username;
  }

  private findTweetAuthorUsername(lookup: XTweetLookup): string | undefined {
    const author = lookup.tweet.author_id
      ? lookup.includedUsers.find((user) => user.id === lookup.tweet.author_id)
      : undefined;
    return author?.username?.toLowerCase();
  }

  private findIncludedTweetAuthorUsername(lookup: XTweetLookup, referencedTweetId: string): string | undefined {
    const sourceTweet = lookup.includedTweets.find((tweet) => tweet.id === referencedTweetId);
    const authorId = sourceTweet?.author_id;
    const author = authorId
      ? lookup.includedUsers.find((user) => user.id === authorId)
      : undefined;
    return author?.username?.toLowerCase();
  }

  private sourceUsername(): string {
    const sourceUsername = (this.configService.get<string>('polyBasketsXUsername') || 'poly_baskets')
      .replace(/^@/, '')
      .toLowerCase();
    return sourceUsername;
  }

  private async ensureUserRepostedTweet(tweetId: string, normalizedUsername: string): Promise<void> {
    if (!(await this.didUserRepostTweet(tweetId, normalizedUsername))) {
      throw new BadRequestException(`@${normalizedUsername} has not reposted this PolyBaskets post`);
    }
  }

  private async didUserRepostTweet(tweetId: string, username: string): Promise<boolean> {
    let paginationToken: string | null = null;
    for (let page = 0; page < RETWEETED_BY_PAGE_LIMIT; page += 1) {
      const url = new URL(`https://api.x.com/2/tweets/${tweetId}/retweeted_by`);
      url.searchParams.set('user.fields', 'username');
      url.searchParams.set('max_results', '100');
      if (paginationToken) url.searchParams.set('pagination_token', paginationToken);

      const json = await this.xApiGet<{
        data?: XUser[];
        meta?: { next_token?: string };
      }>(url);

      if ((json.data ?? []).some((user) => user.username?.toLowerCase() === username)) {
        return true;
      }
      paginationToken = json.meta?.next_token ?? null;
      if (!paginationToken) break;
    }
    return false;
  }

  private async xApiGet<T>(url: URL): Promise<T> {
    const token = this.configService.getOrThrow<string>('xBearerToken');
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BadRequestException(`X API rejected repost lookup (${response.status}): ${body.slice(0, 300)}`);
    }

    return response.json() as Promise<T>;
  }

  private ensureStandaloneMarketingPost(tweet: XTweet): void {
    const text = normalizeText(tweet.text);
    const requiredPhrases = [
      'trading on polybaskets',
      'vara freebet credits',
      'place basket bets',
      'win real upside on-chain',
      'pick a market thesis',
      'claim the winning tokens',
    ];

    const missingPhrase = requiredPhrases.find((phrase) => !text.includes(phrase));
    if (missingPhrase) {
      throw new BadRequestException('Submitted post must include the suggested PolyBaskets text');
    }

    if (!hasPolyBasketsAppUrl(tweet)) {
      throw new BadRequestException('Submitted post must include https://app.polybaskets.xyz/');
    }
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeXUsername(value?: string, message = 'X username must be a valid username'): string {
  const normalized = value?.trim().replace(/^@/, '').toLowerCase();
  if (!normalized || !/^[a-z0-9_]{1,15}$/.test(normalized)) {
    throw new BadRequestException(message);
  }
  return normalized;
}

function hasPolyBasketsAppUrl(tweet: XTweet): boolean {
  const textUrls = tweet.text.match(/https?:\/\/\S+/gi) ?? [];

  return [
    ...textUrls,
    ...(tweet.entities?.urls ?? []).flatMap((url) => [url.expanded_url, url.display_url, url.unwound_url]),
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => {
      try {
        return new URL(value.startsWith('http') ? value : `https://${value}`).hostname.toLowerCase() ===
          'app.polybaskets.xyz';
      } catch {
        return false;
      }
    });
}
