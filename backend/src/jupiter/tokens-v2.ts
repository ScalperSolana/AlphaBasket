import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { JsonHttpClient } from "../polymarket/http-json.js";
import type {
  JupiterTokenDirectoryPort,
  JupiterTokenMetadata,
} from "./types.js";

const publicKeyString = z.string().refine((value) => {
  try {
    return !new PublicKey(value).equals(PublicKey.default);
  } catch {
    return false;
  }
}, "must be a non-zero Solana public key");

const tokenSchema = z.object({
  id: publicKeyString,
  name: z.string().min(1).max(256),
  symbol: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(18),
  tokenProgram: publicKeyString,
  isVerified: z.boolean(),
  tags: z.array(z.string().min(1).max(64)).max(64).default([]),
  updatedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).passthrough();

const responseSchema = z.array(tokenSchema).max(100);

function validatedApiKey(value: string): string {
  const apiKey = value.trim();
  if (apiKey.length === 0 || apiKey.length > 512) {
    throw new TypeError("Jupiter API key must contain 1-512 characters");
  }
  return apiKey;
}

export class JupiterTokensV2Client implements JupiterTokenDirectoryPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(
    private readonly http: JsonHttpClient,
    apiKey: string,
    baseUrl = "https://api.jup.ag/tokens/v2",
  ) {
    this.apiKey = validatedApiKey(apiKey);
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    if (!this.baseUrl.startsWith("https://")) {
      throw new TypeError("Jupiter Tokens API URL must use HTTPS");
    }
  }

  public async lookup(
    mints: readonly PublicKey[],
  ): Promise<readonly JupiterTokenMetadata[]> {
    if (mints.length === 0 || mints.length > 100) {
      throw new RangeError("Jupiter token lookup requires 1-100 mints");
    }
    const requested = new Set<string>();
    for (const mint of mints) {
      if (!(mint instanceof PublicKey) || mint.equals(PublicKey.default)) {
        throw new TypeError("Jupiter token lookup mint must be a non-zero PublicKey");
      }
      const key = mint.toBase58();
      if (requested.has(key)) {
        throw new RangeError(`duplicate Jupiter token lookup mint ${key}`);
      }
      requested.add(key);
    }

    const query = [...requested].join(",");
    const rows = await this.http.get(
      `${this.baseUrl}/search?${new URLSearchParams({ query }).toString()}`,
      responseSchema,
      { "x-api-key": this.apiKey },
    );
    const byMint = new Map<string, JupiterTokenMetadata>();
    for (const row of rows) {
      if (!requested.has(row.id)) continue;
      if (byMint.has(row.id)) {
        throw new Error(`Jupiter Tokens API returned duplicate mint ${row.id}`);
      }
      byMint.set(row.id, Object.freeze({
        mint: new PublicKey(row.id),
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        tokenProgram: new PublicKey(row.tokenProgram),
        isVerified: row.isVerified,
        tags: Object.freeze([...row.tags]),
        updatedAt: row.updatedAt ?? null,
      }));
    }
    return Object.freeze(
      mints.flatMap((mint) => {
        const token = byMint.get(mint.toBase58());
        return token === undefined ? [] : [token];
      }),
    );
  }

  public async requireVerified(mint: PublicKey): Promise<JupiterTokenMetadata> {
    const [token] = await this.lookup([mint]);
    if (token === undefined) {
      throw new Error(`Jupiter has no token metadata for ${mint.toBase58()}`);
    }
    if (!token.isVerified || !token.tags.includes("verified")) {
      throw new Error(`Jupiter token ${mint.toBase58()} is not verified`);
    }
    return token;
  }
}
