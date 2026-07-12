import { z } from "zod";
import { parseDecimalToFixed } from "./fixed-point.js";
import { JsonHttpClient } from "./http-json.js";
import type {
  GammaMarket,
  GammaMarketDataPort,
  GammaMarketPage,
  GammaMarketToken,
} from "./types.js";

const decimalText = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const documentedDecimal = z.union([
  decimalText,
  z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .transform((value, context) => {
      // Gamma documents these values as JSON numbers. Convert to text immediately;
      // all fixed-point arithmetic remains bigint-only after this boundary.
      const text = String(value);
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "numeric decimal must not use exponent notation" });
        return z.NEVER;
      }
      return text;
    }),
]);
const encodedStringArray = z.union([z.array(z.string()), z.string()]);
const gammaId = z.union([z.string(), z.number().int().nonnegative().safe()]).transform(String);

const marketSchema = z
  .object({
    id: gammaId,
    conditionId: z.string().min(1),
    events: z.array(z.object({ id: gammaId }).passthrough()).optional(),
    question: z.string(),
    slug: z.string(),
    active: z.boolean().optional(),
    closed: z.boolean(),
    acceptingOrders: z.boolean().optional(),
    endDate: z.string().datetime({ offset: true }).nullish(),
    volume24hr: documentedDecimal.optional(),
    volume24h: documentedDecimal.optional(),
    liquidity: documentedDecimal.optional(),
    clobTokenIds: encodedStringArray,
    outcomes: encodedStringArray,
  })
  .passthrough();

const marketPageSchema = z.object({
  markets: z.array(marketSchema),
  next_cursor: z.string().nullable().optional(),
});

const decodeStringArray = (value: string | readonly string[], field: string): readonly string[] => {
  if (typeof value !== "string") {
    return Object.freeze([...value]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} must be a JSON-encoded string array`);
  }
  const result = z.array(z.string()).safeParse(parsed);
  if (!result.success) {
    throw new Error(`${field} must be a JSON-encoded string array`);
  }
  return Object.freeze(result.data);
};

const parseIsoTime = (value: string | null | undefined): bigint | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`Invalid market endDate ${value}`);
  }
  return BigInt(timestamp);
};

const mapMarket = (raw: z.output<typeof marketSchema>): GammaMarket => {
  const tokenIds = decodeStringArray(raw.clobTokenIds, "clobTokenIds");
  const outcomes = decodeStringArray(raw.outcomes, "outcomes");
  if (tokenIds.length !== outcomes.length || tokenIds.length === 0) {
    throw new Error(`Market ${raw.conditionId} has inconsistent token and outcome arrays`);
  }
  const tokens: GammaMarketToken[] = tokenIds.map((tokenId, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined) {
      throw new Error(`Market ${raw.conditionId} is missing outcome ${index}`);
    }
    return Object.freeze({ tokenId, outcome });
  });
  const volumeText = raw.volume24hr ?? raw.volume24h ?? "0";
  const events = raw.events ?? [];
  if (events.length > 1) {
    throw new Error(
      `Market ${raw.conditionId} maps to multiple Gamma events; event-level concentration is ambiguous`,
    );
  }
  return Object.freeze({
    marketId: raw.id,
    conditionId: raw.conditionId,
    eventId: events[0]?.id ?? null,
    question: raw.question,
    slug: raw.slug,
    active: raw.active ?? !raw.closed,
    closed: raw.closed,
    acceptingOrders: raw.acceptingOrders ?? false,
    endTimeMs: parseIsoTime(raw.endDate),
    volume24hUnits: parseDecimalToFixed(volumeText, 6),
    liquidityUnits: parseDecimalToFixed(raw.liquidity ?? "0", 6),
    tokens: Object.freeze(tokens),
  });
};

export interface GammaRestMarketDataOptions {
  readonly baseUrl?: string;
}

export class GammaRestMarketData implements GammaMarketDataPort {
  private readonly baseUrl: string;

  public constructor(
    private readonly http: JsonHttpClient,
    options: GammaRestMarketDataOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://gamma-api.polymarket.com").replace(/\/$/, "");
  }

  public async listMarkets(
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<GammaMarketPage> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Gamma market limit must be an integer between 1 and 100");
    }
    const query = new URLSearchParams({ closed: "false", limit: limit.toString() });
    if (options.cursor !== undefined) {
      query.set("after_cursor", options.cursor);
    }
    const raw = await this.http.get(
      `${this.baseUrl}/markets/keyset?${query.toString()}`,
      marketPageSchema,
    );
    return Object.freeze({
      markets: Object.freeze(raw.markets.map(mapMarket)),
      nextCursor: raw.next_cursor ?? null,
    });
  }
}
