import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { ReconciliationRun, ReconciliationStorePort } from "../reconciliation/index.js";
import {
  RECONCILIATION_DASHBOARD_CSS,
  RECONCILIATION_DASHBOARD_HTML,
  RECONCILIATION_DASHBOARD_JS,
} from "../reconciliation/index.js";
import { ApiRequestError, type FinancialApiPort } from "./api-types.js";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface BackendHttpServerOptions {
  readonly environment: "development" | "test" | "production";
  readonly version: string;
  readonly readiness: ReadinessProbe;
  readonly operations?: Readonly<{
    bearerToken: string;
    reconciliationScope: string;
    reconciliation: Pick<ReconciliationStorePort, "latest">;
  }>;
  readonly api?: Readonly<{
    financial: FinancialApiPort;
    composerBearerToken: string;
    allowedOrigins: ReadonlySet<string>;
    maximumBodyBytes?: number;
  }>;
}

export interface BackendHttpResponse {
  readonly statusCode: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly rawBody?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export async function resolveBackendHttpResponse(
  method: string | undefined,
  requestUrl: string | undefined,
  options: BackendHttpServerOptions,
  requestHeaders: Readonly<Record<string, string | readonly string[] | undefined>> = {},
  requestBody?: unknown,
): Promise<BackendHttpResponse> {
  const url = new URL(requestUrl ?? "/", "http://localhost");
  const api = options.api;
  if (api !== undefined && method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
    const origin = singleHeader(requestHeaders.origin);
    if (origin === null || !api.allowedOrigins.has(origin)) {
      return { statusCode: 403, body: { error: "origin_not_allowed" } };
    }
    return {
      statusCode: 204,
      body: {},
      headers: corsHeaders(origin, true),
    };
  }
  if (api !== undefined && url.pathname.startsWith("/v1/")) {
    return resolveFinancialApiResponse(method, url, api, requestHeaders, requestBody);
  }
  if (method !== "GET") {
    return { statusCode: 405, headers: { allow: "GET" }, body: { error: "method_not_allowed" } };
  }
  if (url.pathname === "/healthz") {
    return { statusCode: 200, body: { status: "ok", service: "alphabasket-backend" } };
  }
  if (url.pathname === "/readyz") {
    try {
      await options.readiness.check();
      return { statusCode: 200, body: { status: "ready", service: "alphabasket-backend" } };
    } catch {
      return { statusCode: 503, body: { status: "not_ready", service: "alphabasket-backend" } };
    }
  }
  if (url.pathname === "/ops/reconciliation/dashboard" || url.pathname === "/ops/reconciliation/dashboard.js" || url.pathname === "/ops/reconciliation/dashboard.css") {
    if (options.operations === undefined) return { statusCode: 404, body: { error: "not_found" } };
    if (url.pathname.endsWith(".js")) return {
      statusCode: 200,
      body: {},
      rawBody: RECONCILIATION_DASHBOARD_JS,
      contentType: "text/javascript; charset=utf-8",
      headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
    };
    if (url.pathname.endsWith(".css")) return {
      statusCode: 200,
      body: {},
      rawBody: RECONCILIATION_DASHBOARD_CSS,
      contentType: "text/css; charset=utf-8",
      headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
    };
    return {
      statusCode: 200,
      body: {},
      rawBody: RECONCILIATION_DASHBOARD_HTML,
      contentType: "text/html; charset=utf-8",
      headers: {
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      },
    };
  }
  if (url.pathname === "/ops/reconciliation") {
    const operations = options.operations;
    if (operations === undefined) return { statusCode: 404, body: { error: "not_found" } };
    const authorization = requestHeaders.authorization;
    const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    const expectedBytes = Buffer.from(operations.bearerToken, "utf8");
    const suppliedBytes = Buffer.from(supplied, "utf8");
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      return {
        statusCode: 401,
        headers: { "www-authenticate": "Bearer" },
        body: { error: "unauthorized" },
      };
    }
    const limitValue = url.searchParams.get("limit") ?? "10";
    if (!/^(?:[1-9]|1[0-9]|20)$/u.test(limitValue)) {
      return { statusCode: 400, body: { error: "invalid_limit" } };
    }
    const runs = await operations.reconciliation.latest(operations.reconciliationScope, Number(limitValue));
    return {
      statusCode: 200,
      body: {
        scope: operations.reconciliationScope,
        runs: runs.map(serializeReconciliationRun),
      },
    };
  }
  if (url.pathname === "/") {
    return {
      statusCode: 200,
      body: {
        service: "alphabasket-backend",
        version: options.version,
        environment: options.environment,
        health: "/healthz",
        readiness: "/readyz",
      },
    };
  }
  return { statusCode: 404, body: { error: "not_found" } };
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function corsHeaders(origin: string, preflight = false): Readonly<Record<string, string>> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "false",
    "access-control-expose-headers": "content-type",
    vary: "Origin",
    ...(preflight
      ? {
          "access-control-allow-headers": "Content-Type, Idempotency-Key, Authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-max-age": "600",
        }
      : {}),
  };
}

function authorizedBearer(
  requestHeaders: Readonly<Record<string, string | readonly string[] | undefined>>,
  expected: string,
): boolean {
  const authorization = singleHeader(requestHeaders.authorization);
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function resolveFinancialApiResponse(
  method: string | undefined,
  url: URL,
  api: NonNullable<BackendHttpServerOptions["api"]>,
  requestHeaders: Readonly<Record<string, string | readonly string[] | undefined>>,
  requestBody: unknown,
): Promise<BackendHttpResponse> {
  const origin = singleHeader(requestHeaders.origin);
  if (origin !== null && !api.allowedOrigins.has(origin)) {
    return { statusCode: 403, body: { error: "origin_not_allowed" } };
  }
  const headers = origin === null ? {} : corsHeaders(origin);
  try {
    if (method === "POST" && url.pathname === "/v1/quotes/deposit") {
      return { statusCode: 200, body: await api.financial.createDepositQuote(requestBody), headers };
    }
    if (method === "POST" && url.pathname === "/v1/quotes/withdrawal") {
      return { statusCode: 200, body: await api.financial.createWithdrawalQuote(requestBody), headers };
    }
    if (method === "POST" && url.pathname === "/v1/intents/deposit") {
      return {
        statusCode: 202,
        body: await api.financial.submitDepositIntent(
          requestBody,
          requireIdempotencyKey(requestHeaders),
        ),
        headers,
      };
    }
    if (method === "POST" && url.pathname === "/v1/intents/withdrawal") {
      return {
        statusCode: 202,
        body: await api.financial.submitWithdrawalIntent(
          requestBody,
          requireIdempotencyKey(requestHeaders),
        ),
        headers,
      };
    }
    const funding = /^\/v1\/operations\/([A-Za-z0-9_.:-]+)\/funding$/u.exec(url.pathname);
    if (method === "POST" && funding !== null) {
      return {
        statusCode: 202,
        body: await api.financial.submitDepositFunding(
          funding[1] as string,
          requestBody,
          requireIdempotencyKey(requestHeaders),
        ),
        headers,
      };
    }
    const operation = /^\/v1\/operations\/([A-Za-z0-9_.:-]+)$/u.exec(url.pathname);
    if (method === "GET" && operation !== null) {
      return {
        statusCode: 200,
        body: await api.financial.getOperation(operation[1] as string),
        headers,
      };
    }
    if (url.pathname === "/v1/baskets") {
      if (method !== "POST") {
        return { statusCode: 405, body: { error: "method_not_allowed" }, headers: { ...headers, allow: "POST" } };
      }
      if (!authorizedBearer(requestHeaders, api.composerBearerToken)) {
        return {
          statusCode: 401,
          body: { error: "unauthorized" },
          headers: { ...headers, "www-authenticate": "Bearer" },
        };
      }
      return {
        statusCode: 201,
        body: await api.financial.createBasket(requestBody),
        headers,
      };
    }
    return { statusCode: 404, body: { error: "not_found" }, headers };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return {
        statusCode: error.statusCode,
        body: { error: error.code, message: error.message },
        headers,
      };
    }
    throw error;
  }
}

function requireIdempotencyKey(
  requestHeaders: Readonly<Record<string, string | readonly string[] | undefined>>,
): string {
  const value = singleHeader(requestHeaders["idempotency-key"]);
  if (value === null) {
    throw new ApiRequestError(400, "missing_idempotency_key", "Idempotency-Key header is required");
  }
  return value;
}

async function readJsonBody(request: IncomingMessage, maximumBodyBytes: number): Promise<unknown> {
  const contentType = singleHeader(request.headers["content-type"]);
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new ApiRequestError(400, "invalid_content_type", "Content-Type must be application/json");
  }
  const declared = singleHeader(request.headers["content-length"]);
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || BigInt(declared) > BigInt(maximumBodyBytes)) {
      throw new ApiRequestError(400, "request_too_large", "request body exceeds the configured limit");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maximumBodyBytes) {
      request.destroy();
      throw new ApiRequestError(400, "request_too_large", "request body exceeds the configured limit");
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new ApiRequestError(400, "empty_body", "JSON request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiRequestError(400, "invalid_json", "request body is not valid JSON");
  }
}

function sendJson(response: ServerResponse, result: BackendHttpResponse): void {
  const payload = result.rawBody ?? JSON.stringify(result.body);
  response.writeHead(result.statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": result.contentType ?? "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...result.headers,
  });
  response.end(payload);
}

export function createBackendHttpServer(options: BackendHttpServerOptions): Server {
  const server = createServer(async (request, response) => {
    try {
      const apiRoute = request.url?.startsWith("/v1/") === true;
      const requestBody = apiRoute && request.method === "POST"
        ? await readJsonBody(request, options.api?.maximumBodyBytes ?? 65_536)
        : undefined;
      sendJson(response, await resolveBackendHttpResponse(
        request.method,
        request.url,
        options,
        request.headers,
        requestBody,
      ));
    } catch (error) {
      if (error instanceof ApiRequestError) {
        sendJson(response, {
          statusCode: error.statusCode,
          body: { error: error.code, message: error.message },
        });
      } else {
        sendJson(response, { statusCode: 500, body: { error: "internal_server_error" } });
      }
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function serializeReconciliationRun(run: ReconciliationRun): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: run.id,
    scope: run.scope,
    observedAt: run.observedAt.toISOString(),
    status: run.status,
    observations: run.observations.map((observation) => ({
      basketId: observation.basketId,
      onchainTotalSharesUnits: observation.onchainTotalSharesUnits.toString(10),
      positionShareSumUnits: observation.positionShareSumUnits.toString(10),
      protocolFeeSharesUnits: observation.protocolFeeSharesUnits.toString(10),
      ledgerAttributedPusdUnits: observation.ledgerAttributedPusdUnits.toString(10),
      walletAttributedPusdUnits: observation.walletAttributedPusdUnits.toString(10),
      navGrossPusdUnits: observation.navGrossPusdUnits.toString(10),
      navObservedAtMs: observation.navObservedAtMs.toString(10),
      oldestPendingOperationAtMs: observation.oldestPendingOperationAtMs?.toString(10) ?? null,
    })),
    findings: run.findings.map((finding) => ({
      ...finding,
      observedAt: finding.observedAt.toISOString(),
    })),
  });
}
