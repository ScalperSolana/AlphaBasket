import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { JsonHttpClient } from "../polymarket/index.js";
import type {
  JupiterPriceMark,
  JupiterPricePort,
} from "./types.js";

const priceEntry = z.object({
  usdPrice: z.number().finite().positive(),
  blockId: z.number().int().nonnegative().safe().optional(),
  decimals: z.number().int().min(0).max(18).optional(),
}).passthrough();
const responseSchema = z.record(z.string(), priceEntry);

export class JupiterPriceV3Client implements JupiterPricePort {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  public constructor(
    private readonly http: JsonHttpClient,
    apiKey: string,
    baseUrl = "https://api.jup.ag/price/v3",
    private readonly nowMs: () => bigint = () => BigInt(Date.now()),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.apiKey = apiKey.trim();
    if (!this.baseUrl.startsWith("https://")) {
      throw new TypeError("Jupiter Price API URL must use HTTPS");
    }
    if (this.apiKey.length === 0 || this.apiKey.length > 512) {
      throw new TypeError("Jupiter API key must contain 1-512 characters");
    }
  }

  public async getUsdcPrices(
    mints: readonly PublicKey[],
    usdcMint: PublicKey,
  ): Promise<readonly JupiterPriceMark[]> {
    const unique = [...new Map(
      [...mints, usdcMint].map((mint) => [mint.toBase58(), mint]),
    ).values()];
    if (unique.length === 0 || unique.length > 50) {
      throw new RangeError("Jupiter Price V3 request must contain 1-50 unique mints");
    }
    const ids = unique.map((mint) => mint.toBase58()).join(",");
    const raw = await this.http.get(
      `${this.baseUrl}?ids=${encodeURIComponent(ids)}`,
      responseSchema,
      { "x-api-key": this.apiKey },
    );
    const usdc = raw[usdcMint.toBase58()];
    if (usdc === undefined) {
      throw new Error("Jupiter omitted the configured USDC price");
    }
    const observedAtMs = this.nowMs();
    return Object.freeze(mints.map((mint): JupiterPriceMark => {
      const entry = raw[mint.toBase58()];
      if (entry === undefined) {
        throw new Error(`Jupiter omitted an unreliable or unavailable price for ${mint.toBase58()}`);
      }
      const scaled = Math.round((entry.usdPrice / usdc.usdPrice) * 1_000_000);
      if (!Number.isSafeInteger(scaled) || scaled <= 0) {
        throw new Error(`Jupiter price is outside the six-decimal NAV range for ${mint.toBase58()}`);
      }
      const sourceHash = createHash("sha256").update(JSON.stringify([
        "JUPITER_PRICE_V3",
        mint.toBase58(),
        entry.usdPrice,
        entry.blockId ?? null,
        usdc.usdPrice,
        usdc.blockId ?? null,
      ]), "utf8").digest("hex");
      return Object.freeze({
        mint,
        priceUsdcUnits: BigInt(scaled),
        observedAtMs,
        sourceHash,
      });
    }));
  }
}
