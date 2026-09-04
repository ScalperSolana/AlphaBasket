/**
 * Client for the backend read plane.
 *
 * The three GET endpoints are public, so none of this needs a wallet or a
 * token. Every call returns a discriminated result rather than throwing: a page
 * that cannot reach the API should say so, not blank out.
 */

import type {
  IndexDetail,
  IndexSummary,
  PortfolioHolding,
} from "@/types/index-basket";

const BASE = (
  import.meta.env.VITE_INDEX_API_URL || "http://127.0.0.1:3001"
).replace(/\/+$/, "");

/**
 * A single shape rather than a discriminated union.
 *
 * This project compiles with `strictNullChecks: false`, and without it
 * TypeScript does not narrow a union by a literal `ok`, so every consumer would
 * have to cast. One interface with optional halves reads the same at the call
 * site and needs no casts.
 */
export interface ApiResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
}

const get = async <T>(path: string): Promise<ApiResult<T>> => {
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
      return { ok: false, error: "not_found" };
    }
    if (!response.ok) {
      return { ok: false, error: `request failed with ${response.status}` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `could not reach the index API at ${BASE}: ${error.message}`
          : "could not reach the index API",
    };
  }
};

export const listIndexes = async (): Promise<
  ApiResult<readonly IndexSummary[]>
> => {
  const result = await get<{ indexes: IndexSummary[] }>("/v1/indexes");
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: result.data.indexes };
};

export const getIndex = async (
  address: string,
): Promise<ApiResult<IndexDetail>> => {
  const result = await get<{ index: IndexDetail }>(`/v1/indexes/${address}`);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: result.data.index };
};

export const getPortfolio = async (
  owner: string,
): Promise<ApiResult<readonly PortfolioHolding[]>> => {
  const result = await get<{ holdings: PortfolioHolding[] }>(
    `/v1/portfolio/${owner}`,
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: result.data.holdings };
};

export const INDEX_API_BASE = BASE;
