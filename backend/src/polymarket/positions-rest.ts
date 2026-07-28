import { z } from "zod";

import { parseDecimalToFixed } from "./fixed-point.js";
import { JsonHttpClient } from "./http-json.js";
import { SHARE_DECIMALS } from "./types.js";

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const conditionId = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const unsignedDecimal = z.union([
  z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u),
  z.number().finite().nonnegative().transform((value) => value.toString()),
]);
const positionSchema = z.object({
  proxyWallet: evmAddress,
  asset: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  conditionId,
  size: unsignedDecimal,
  curPrice: unsignedDecimal,
  redeemable: z.boolean(),
  outcome: z.string().min(1).max(128),
  outcomeIndex: z.number().int().min(0).max(255),
  negativeRisk: z.boolean(),
}).passthrough();
const positionsSchema = z.array(positionSchema).max(500);
const PAGE_SIZE = 500;
const MAXIMUM_OFFSET = 10_000;

export interface PolymarketPosition {
  readonly proxyWallet: string;
  readonly tokenId: string;
  readonly conditionId: string;
  readonly sizeUnits: bigint;
  readonly currentPriceUnits: bigint;
  readonly redeemable: boolean;
  readonly outcome: string;
  readonly outcomeIndex: number;
  readonly negativeRisk: boolean;
}

export interface PolymarketPositionsPort {
  listPositions?(proxyWallet: string): Promise<readonly PolymarketPosition[]>;
  listRedeemable(proxyWallet: string): Promise<readonly PolymarketPosition[]>;
}

export class PolymarketPositionsRest implements PolymarketPositionsPort {
  private readonly baseUrl: string;

  public constructor(
    private readonly http: JsonHttpClient,
    options: { readonly baseUrl?: string } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://data-api.polymarket.com").replace(/\/$/u, "");
  }

  public async listRedeemable(proxyWallet: string): Promise<readonly PolymarketPosition[]> {
    return this.list(proxyWallet, true);
  }

  public async listPositions(proxyWallet: string): Promise<readonly PolymarketPosition[]> {
    return this.list(proxyWallet, false);
  }

  private async list(
    proxyWallet: string,
    redeemableOnly: boolean,
  ): Promise<readonly PolymarketPosition[]> {
    if (!/^0x[0-9a-fA-F]{40}$/u.test(proxyWallet)) throw new TypeError("invalid Polymarket proxy wallet address");
    const allRows: z.infer<typeof positionSchema>[] = [];
    for (let offset = 0; offset <= MAXIMUM_OFFSET; offset += PAGE_SIZE) {
      const query = new URLSearchParams({
        user: proxyWallet,
        ...(redeemableOnly ? { redeemable: "true" } : {}),
        sizeThreshold: "0",
        limit: PAGE_SIZE.toString(10),
        offset: offset.toString(10),
      });
      const page = await this.http.get(`${this.baseUrl}/positions?${query.toString()}`, positionsSchema);
      allRows.push(...page);
      if (page.length < PAGE_SIZE) break;
      if (offset === MAXIMUM_OFFSET) throw new Error("Polymarket positions exceed the supported pagination window");
    }
    const seenTokens = new Set<string>();
    return Object.freeze(allRows.map((row) => {
      if (row.proxyWallet.toLowerCase() !== proxyWallet.toLowerCase()) throw new Error("Polymarket returned a position for a different wallet");
      if (seenTokens.has(row.asset)) throw new Error("Polymarket returned a duplicate token position across pages");
      seenTokens.add(row.asset);
      const sizeUnits = parseDecimalToFixed(row.size, SHARE_DECIMALS);
      const currentPriceUnits = parseDecimalToFixed(row.curPrice, SHARE_DECIMALS);
      if (sizeUnits <= 0n || (redeemableOnly && !row.redeemable)) {
        throw new Error("Polymarket position response contains an invalid row");
      }
      if (
        redeemableOnly &&
        currentPriceUnits !== 0n &&
        currentPriceUnits !== 1_000_000n
      ) {
        throw new Error("redeemable position price must be exactly zero or one");
      }
      return Object.freeze({
        proxyWallet: row.proxyWallet,
        tokenId: row.asset,
        conditionId: row.conditionId.toLowerCase(),
        sizeUnits,
        currentPriceUnits,
        redeemable: row.redeemable,
        outcome: row.outcome,
        outcomeIndex: row.outcomeIndex,
        negativeRisk: row.negativeRisk,
      });
    }));
  }
}
