import { createHash } from "node:crypto";

import { z } from "zod";

import { JsonHttpClient } from "../polymarket/index.js";
import type {
  PredictMarket,
  PredictOrderBuild,
  PredictOrderStatus,
  PredictRestPort,
} from "./types.js";

const PRICE_SCALE = 1_000_000n;

/** The API reports six-decimal micro-USD as JSON numbers or strings. */
const microUnits = z.union([
  z.string().regex(/^(?:0|[1-9][0-9]*)$/u).transform(BigInt),
  z.number().int().nonnegative().safe().transform(BigInt),
]);
const optionalUnits = microUnits.nullish().transform((value) => value ?? null);

const pricingSchema = z.object({
  buyYesPriceUsd: optionalUnits,
  buyNoPriceUsd: optionalUnits,
  sellYesPriceUsd: optionalUnits,
  sellNoPriceUsd: optionalUnits,
}).passthrough();

const marketSchema = z.object({
  marketId: z.union([z.string().min(1).max(128), z.number().int().transform(String)]),
  eventId: z.union([z.string(), z.number().int().transform(String)]).nullish(),
  provider: z.string().nullish(),
  status: z.string().min(1).max(64),
  outcomes: z.array(z.string().max(128)).max(8).nullish(),
  pricing: pricingSchema.nullish(),
}).passthrough();

const base64Transaction = z.string().min(4).max(262_144).refine((value) => {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength > 0 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
});

const orderBuildSchema = z.object({
  transaction: base64Transaction,
  txMeta: z.object({
    blockhash: z.string().optional(),
    lastValidBlockHeight: z.union([
      z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
      z.number().int().nonnegative().safe().transform(String),
    ]).optional(),
  }).passthrough().nullish(),
  order: z.object({
    orderPubkey: z.string().min(32).max(64),
    positionPubkey: z.string().min(32).max(64).nullish(),
    contractsMicro: microUnits.nullish(),
  }).passthrough(),
}).passthrough();

const orderStatusSchema = z.object({
  status: z.enum(["created", "partiallyfilled", "filled", "failed"]),
}).passthrough();

const eventsSchema = z.object({
  data: z.array(z.object({
    markets: z.array(z.unknown()).nullish(),
  }).passthrough()).max(500),
}).passthrough();

/**
 * Pulls every string that could be an external (Polymarket) identifier out of a
 * permissively parsed market payload. The Prediction API is in beta and does
 * not document which field carries the provider's condition/token ids, so the
 * resolver matches against all id-shaped values rather than one guessed field.
 */
function externalIds(raw: Record<string, unknown>): readonly string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      const normalized = String(value).trim().toLowerCase();
      if (/^0x[0-9a-f]{64}$/u.test(normalized) || /^[0-9]{10,80}$/u.test(normalized)) {
        ids.add(normalized);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>).slice(0, 64)) {
        visit(item, depth + 1);
      }
    }
  };
  visit(raw, 0);
  return Object.freeze([...ids]);
}

function toMarket(raw: z.output<typeof marketSchema>, observedAtMs: bigint): PredictMarket {
  const bounded = (value: bigint | null): bigint | null =>
    value !== null && value > 0n && value < PRICE_SCALE ? value : null;
  const pricing = raw.pricing ?? {
    buyYesPriceUsd: null,
    buyNoPriceUsd: null,
    sellYesPriceUsd: null,
    sellNoPriceUsd: null,
  };
  return Object.freeze({
    marketId: raw.marketId,
    eventId: raw.eventId ?? null,
    provider: raw.provider?.toLowerCase() ?? null,
    status: raw.status.toLowerCase(),
    outcomes: Object.freeze(raw.outcomes ?? []),
    pricing: Object.freeze({
      buyYesPriceUnits: bounded(pricing.buyYesPriceUsd),
      buyNoPriceUnits: bounded(pricing.buyNoPriceUsd),
      sellYesPriceUnits: bounded(pricing.sellYesPriceUsd),
      sellNoPriceUnits: bounded(pricing.sellNoPriceUsd),
    }),
    externalIds: externalIds(raw as Record<string, unknown>),
    sourceHash: createHash("sha256")
      .update(
        JSON.stringify(raw, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString(10) : value),
        "utf8",
      )
      .digest("hex"),
    observedAtMs,
  });
}

export interface JupiterPredictRestOptions {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly nowMs?: () => bigint;
}

export class JupiterPredictRest implements PredictRestPort {
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly nowMs: () => bigint;

  public constructor(
    private readonly http: JsonHttpClient,
    options: JupiterPredictRestOptions,
  ) {
    this.baseUrl = (options.baseUrl ?? "https://api.jup.ag/prediction/v1").replace(/\/+$/u, "");
    if (!this.baseUrl.startsWith("https://")) {
      throw new TypeError("Jupiter Predict API URL must use HTTPS");
    }
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0 || apiKey.length > 512) {
      throw new TypeError("Jupiter API key must contain 1-512 characters");
    }
    this.headers = Object.freeze({ "x-api-key": apiKey });
    this.nowMs = options.nowMs ?? (() => BigInt(Date.now()));
  }

  public async getMarket(marketId: string): Promise<PredictMarket> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(marketId)) {
      throw new TypeError("Jupiter Predict market id is invalid");
    }
    const raw = await this.http.get(
      `${this.baseUrl}/markets/${encodeURIComponent(marketId)}`,
      marketSchema,
      this.headers,
    );
    const market = toMarket(raw, this.nowMs());
    if (market.marketId !== marketId) {
      throw new Error("Jupiter Predict returned a different market than requested");
    }
    return market;
  }

  public async listCatalogMarkets(options: {
    readonly start: number;
    readonly end: number;
  }): Promise<readonly PredictMarket[]> {
    if (
      !Number.isSafeInteger(options.start) || options.start < 0 ||
      !Number.isSafeInteger(options.end) || options.end <= options.start ||
      options.end - options.start > 500
    ) {
      throw new RangeError("Jupiter Predict catalog page bounds are invalid");
    }
    const query = new URLSearchParams({
      provider: "polymarket",
      includeMarkets: "true",
      start: options.start.toString(10),
      end: options.end.toString(10),
    });
    const raw = await this.http.get(
      `${this.baseUrl}/events?${query.toString()}`,
      eventsSchema,
      this.headers,
    );
    const observedAtMs = this.nowMs();
    const markets: PredictMarket[] = [];
    for (const event of raw.data) {
      for (const candidate of event.markets ?? []) {
        const parsed = marketSchema.safeParse(candidate);
        if (parsed.success) markets.push(toMarket(parsed.data, observedAtMs));
      }
    }
    return Object.freeze(markets);
  }

  public async buildOrder(request: {
    readonly ownerPubkey: string;
    readonly depositMint: string;
    readonly amountUnits: bigint;
    readonly marketId: string;
    readonly isYes: boolean;
    readonly isBuy: boolean;
  }): Promise<PredictOrderBuild> {
    if (request.amountUnits <= 0n) throw new RangeError("Jupiter Predict order amount must be positive");
    // Beta-API shape: sells reuse the buy body with isBuy=false, carrying the
    // contract amount in depositAmount. Nothing is signed until the returned
    // transaction passes the gateway's policy checks, so a shape change in the
    // API fails loudly here rather than executing anything.
    const raw = await this.http.post(
      `${this.baseUrl}/orders`,
      {
        ownerPubkey: request.ownerPubkey,
        depositAmount: request.amountUnits.toString(10),
        depositMint: request.depositMint,
        marketId: request.marketId,
        isYes: request.isYes,
        isBuy: request.isBuy,
      },
      orderBuildSchema,
      this.headers,
    );
    return Object.freeze({
      transactionBase64: raw.transaction,
      orderPubkey: raw.order.orderPubkey,
      positionPubkey: raw.order.positionPubkey ?? null,
      contractsMicro: raw.order.contractsMicro ?? null,
      lastValidBlockHeight: raw.txMeta?.lastValidBlockHeight === undefined
        ? null
        : BigInt(raw.txMeta.lastValidBlockHeight),
    });
  }

  public async getOrderStatus(orderPubkey: string): Promise<PredictOrderStatus> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(orderPubkey)) {
      throw new TypeError("Jupiter Predict order pubkey is invalid");
    }
    const raw = await this.http.get(
      `${this.baseUrl}/orders/status/${orderPubkey}`,
      orderStatusSchema,
      this.headers,
    );
    return raw.status;
  }
}
