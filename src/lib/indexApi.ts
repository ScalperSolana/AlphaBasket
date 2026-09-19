/**
 * Client for the backend API.
 *
 * Reads (`/v1/indexes`, `/v1/portfolio`) are public. Quotes are unauthenticated
 * too; intents and funding carry a user signature and an idempotency key. Every
 * call returns a discriminated result rather than throwing: a page that cannot
 * reach the API should say so, not blank out.
 */

import { ENV } from "@/env";
import type {
  DepositOperation,
  DepositQuote,
  IndexDetail,
  IndexSummary,
  Operation,
  PortfolioHolding,
  WithdrawalQuote,
} from "@/types/index-basket";

const BASE = ENV.INDEX_API_URL;

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
  /** Human-readable, already mapped through `describeApiError`. */
  readonly error?: string;
  /** The backend's machine code (`stale_nav`, `perp_basket_unsupported`, …). */
  readonly code?: string;
  readonly status?: number;
}

/** Quotes are valid for five minutes; intents must be signed inside that window. */
export const QUOTE_TTL_SECONDS = 300;
export const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * Turns the backend's error codes into sentences a user can act on. Unknown
 * codes fall back to the backend's own message, which is at least specific.
 */
export const describeApiError = (code: string | undefined, message: string | undefined, status?: number): string => {
  switch (code) {
    case "perp_basket_unsupported":
      return "Deposits and withdrawals for perpetual indexes are not open yet.";
    case "prediction_venue_disabled":
      return "Prediction-market indexes are not enabled on this deployment.";
    case "stale_nav":
    case "nav_unavailable":
      return "This index's valuation is being refreshed. Try again in a moment.";
    case "index_not_ready":
      return "The indexer has not finalized this index yet. Try again shortly.";
    case "basket_not_active":
      return "This index is not accepting deposits or withdrawals right now.";
    case "insufficient_shares":
      return "You do not hold that many shares.";
    case "slippage_above_protocol_limit":
      return "That slippage is above the protocol limit.";
    case "quote_mismatch":
      return "The index changed since this quote. Get a fresh quote.";
    case "spot_execution_unavailable":
      return "Spot funding is not configured on this deployment.";
    case "origin_not_allowed":
      return "This site is not allowed to call the API. Check API_ALLOWED_ORIGINS on the backend.";
    case "internal_server_error":
      return "The API hit an unexpected error. Try again in a moment.";
    case "not_found":
      return "Not found.";
    default:
      if (message) return message;
      if (status !== undefined) return `The API answered with status ${status}.`;
      return "Something went wrong.";
  }
};

// A fetch that throws is either a backend that is down, or one that answered
// without CORS headers, which the browser reports the same way. The backend's
// unexpected-error path (HTTP 500) currently sends no CORS headers, so a
// refused intent looks like an outage from here. The copy says both.
const unreachable = (error: unknown): ApiResult<never> => ({
  ok: false,
  code: "unreachable",
  error:
    error instanceof DOMException && error.name === "TimeoutError"
      ? `The API at ${BASE} did not answer in time.`
      : `No usable answer from the API at ${BASE}. It may be down, or it hit an internal error.`,
});

const request = async <T>(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<ApiResult<T>> => {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    } & Record<string, unknown>;
    if (!response.ok) {
      const code = typeof payload.error === "string" ? payload.error : undefined;
      return {
        ok: false,
        code,
        status: response.status,
        error: describeApiError(code, payload.message, response.status),
      };
    }
    return { ok: true, data: payload as unknown as T, status: response.status };
  } catch (error) {
    return unreachable(error);
  }
};

// --- read plane ----------------------------------------------------------------

export const listIndexes = async (): Promise<ApiResult<readonly IndexSummary[]>> => {
  const result = await request<{ indexes: IndexSummary[] }>("GET", "/v1/indexes");
  if (!result.ok) return result as ApiResult<never>;
  return { ok: true, data: result.data.indexes };
};

export const getIndex = async (address: string): Promise<ApiResult<IndexDetail>> => {
  const result = await request<{ index: IndexDetail }>("GET", `/v1/indexes/${address}`);
  if (!result.ok) return result as ApiResult<never>;
  return { ok: true, data: result.data.index };
};

export const getPortfolio = async (owner: string): Promise<ApiResult<readonly PortfolioHolding[]>> => {
  const result = await request<{ holdings: PortfolioHolding[] }>("GET", `/v1/portfolio/${owner}`);
  if (!result.ok) return result as ApiResult<never>;
  return { ok: true, data: result.data.holdings };
};

// --- quotes ---------------------------------------------------------------------

const expiresAtSeconds = (): string => String(Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS);

export const createDepositQuote = (input: {
  readonly basket: string;
  readonly user: string;
  readonly grossAmount: bigint;
  readonly maxSlippageBps?: number;
}): Promise<ApiResult<DepositQuote>> =>
  request<DepositQuote>("POST", "/v1/quotes/deposit", {
    body: {
      basket: input.basket,
      user: input.user,
      grossAmount: input.grossAmount.toString(10),
      maxSlippageBps: input.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
      expiresAtSeconds: expiresAtSeconds(),
    },
  });

export const createWithdrawalQuote = (input: {
  readonly basket: string;
  readonly user: string;
  readonly shareAmount: bigint;
  readonly maxSlippageBps?: number;
}): Promise<ApiResult<WithdrawalQuote>> =>
  request<WithdrawalQuote>("POST", "/v1/quotes/withdrawal", {
    body: {
      basket: input.basket,
      user: input.user,
      shareAmount: input.shareAmount.toString(10),
      maxSlippageBps: input.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
      expiresAtSeconds: expiresAtSeconds(),
    },
  });

// --- intents and operations ----------------------------------------------------

export const submitDepositIntent = (
  input: { readonly quote: DepositQuote; readonly nonce: bigint; readonly signature: string },
  idempotencyKey: string,
): Promise<ApiResult<DepositOperation>> =>
  request<DepositOperation>("POST", "/v1/intents/deposit", {
    idempotencyKey,
    timeoutMs: 30_000,
    body: { quote: input.quote, nonce: input.nonce.toString(10), signature: input.signature },
  });

export const submitWithdrawalIntent = (
  input: {
    readonly quote: WithdrawalQuote;
    readonly nonce: bigint;
    readonly destination: string;
    readonly signature: string;
  },
  idempotencyKey: string,
): Promise<ApiResult<Operation>> =>
  request<Operation>("POST", "/v1/intents/withdrawal", {
    idempotencyKey,
    timeoutMs: 30_000,
    body: {
      quote: input.quote,
      nonce: input.nonce.toString(10),
      destination: input.destination,
      signature: input.signature,
    },
  });

export const submitDepositFunding = (
  operationId: string,
  transactionSignature: string,
  idempotencyKey: string,
): Promise<ApiResult<Operation>> =>
  request<Operation>("POST", `/v1/operations/${operationId}/funding`, {
    idempotencyKey,
    body: { transactionSignature },
  });

export const getOperation = (operationId: string): Promise<ApiResult<Operation>> =>
  request<Operation>("GET", `/v1/operations/${operationId}`);

export const INDEX_API_BASE = BASE;
