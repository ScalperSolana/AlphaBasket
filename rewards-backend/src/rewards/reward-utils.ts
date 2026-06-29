import { BadRequestException } from '@nestjs/common';
import { decodeAddress } from '@polkadot/util-crypto';

export const PLANCK_PER_VARA = 1_000_000_000_000n;

export const X_TASK_AMOUNTS_VARA = {
  repost: 100n,
  quote: 300n,
} as const;

export const REFERRAL_AMOUNTS_VARA = {
  50: {
    referrer: 200n,
    friend: 100n,
  },
  500: {
    referrer: 400n,
    friend: 200n,
  },
} as const;

export function varaToPlanck(vara: bigint): bigint {
  return vara * PLANCK_PER_VARA;
}

export function normalizeActorId(walletOrActorId: string): string {
  const value = walletOrActorId.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }

  try {
    const bytes = decodeAddress(value);
    return `0x${Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;
  } catch (error) {
    throw new BadRequestException('wallet must be a valid Vara address or 0x actor id');
  }
}

export type ParsedTweetUrl = {
  tweetId: string;
  username?: string;
};

export function parseTweetUrl(tweetUrl: string): ParsedTweetUrl {
  let parsed: URL;
  try {
    parsed = new URL(tweetUrl);
  } catch {
    throw new BadRequestException('tweetUrl must be a valid URL');
  }

  const host = parsed.hostname.toLowerCase();
  if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(host)) {
    throw new BadRequestException('tweetUrl must point to x.com or twitter.com');
  }

  const match = parsed.pathname.match(/\/status(?:es)?\/(\d+)/);
  if (!match) {
    throw new BadRequestException('tweetUrl must include /status/<tweet id>');
  }

  const username = parsed.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '').toLowerCase();

  return {
    tweetId: match[1],
    username: username && /^[a-z0-9_]{1,15}$/.test(username) ? username : undefined,
  };
}

export function parseTweetId(tweetUrl: string): string {
  return parseTweetUrl(tweetUrl).tweetId;
}

export function getUtcWeekKey(date = new Date()): string {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = date.getUTCDay() || 7;
  const monday = new Date(midnight - (day - 1) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}
