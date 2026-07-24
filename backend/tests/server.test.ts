import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveBackendHttpResponse } from "../src/server/index.js";

function options(readiness: () => Promise<void>) {
  return {
    environment: "test",
    version: "test",
    readiness: { check: readiness },
  } as const;
}

describe("backend HTTP server", () => {
  it("serves liveness independently from database readiness", async () => {
    const serverOptions = options(async () => { throw new Error("database unavailable"); });
    const health = await resolveBackendHttpResponse("GET", "/healthz", serverOptions);
    const readiness = await resolveBackendHttpResponse("GET", "/readyz", serverOptions);
    assert.equal(health.statusCode, 200);
    assert.equal(readiness.statusCode, 503);
    assert.deepEqual(readiness.body, { status: "not_ready", service: "alphabasket-backend" });
  });

  it("reports readiness and rejects unsupported methods", async () => {
    const serverOptions = options(async () => undefined);
    assert.equal((await resolveBackendHttpResponse("GET", "/readyz", serverOptions)).statusCode, 200);
    const response = await resolveBackendHttpResponse("POST", "/healthz", serverOptions);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers?.allow, "GET");
  });

  it("protects the reconciliation dashboard with a bearer token", async () => {
    const serverOptions = {
      ...options(async () => undefined),
      operations: {
        bearerToken: "a".repeat(32),
        reconciliationScope: "test",
        reconciliation: {
          latest: async () => [{
            id: "run-1",
            scope: "test",
            observedAt: new Date("2026-01-01T00:00:00Z"),
            status: "healthy" as const,
            observations: [],
            findings: [],
          }],
        },
      },
    };
    assert.equal((await resolveBackendHttpResponse("GET", "/ops/reconciliation", serverOptions)).statusCode, 401);
    const response = await resolveBackendHttpResponse(
      "GET",
      "/ops/reconciliation?limit=1",
      serverOptions,
      { authorization: `Bearer ${"a".repeat(32)}` },
    );
    assert.equal(response.statusCode, 200);
    assert.equal((response.body.runs as readonly unknown[]).length, 1);
  });

  it("assembles financial quote, intent, status, funding, and Composer routes", async () => {
    const calls: string[] = [];
    const financial = {
      createDepositQuote: async () => { calls.push("deposit-quote"); return { kind: "deposit" }; },
      createWithdrawalQuote: async () => { calls.push("withdrawal-quote"); return { kind: "withdrawal" }; },
      submitDepositIntent: async (_input: unknown, key: string) => {
        calls.push(`deposit-intent:${key}`);
        return { operationId: "deposit-operation" };
      },
      submitWithdrawalIntent: async (_input: unknown, key: string) => {
        calls.push(`withdrawal-intent:${key}`);
        return { operationId: "withdrawal-operation" };
      },
      submitDepositFunding: async (operationId: string, _input: unknown, key: string) => {
        calls.push(`funding:${operationId}:${key}`);
        return { operationId };
      },
      getOperation: async (operationId: string) => {
        calls.push(`status:${operationId}`);
        return { operationId };
      },
      createBasket: async () => {
        calls.push("basket");
        return { basketAddress: "basket" };
      },
    };
    const serverOptions = {
      ...options(async () => undefined),
      api: {
        financial,
        composerBearerToken: "c".repeat(32),
        allowedOrigins: new Set(["https://app.alphabasket.test"]),
      },
    };
    const origin = { origin: "https://app.alphabasket.test" };
    assert.equal((await resolveBackendHttpResponse(
      "POST",
      "/v1/quotes/deposit",
      serverOptions,
      origin,
      {},
    )).statusCode, 200);
    assert.equal((await resolveBackendHttpResponse(
      "POST",
      "/v1/intents/deposit",
      serverOptions,
      { ...origin, "idempotency-key": "deposit-request-1" },
      {},
    )).statusCode, 202);
    assert.equal((await resolveBackendHttpResponse(
      "POST",
      "/v1/operations/deposit-operation/funding",
      serverOptions,
      { ...origin, "idempotency-key": "funding-request-1" },
      {},
    )).statusCode, 202);
    assert.equal((await resolveBackendHttpResponse(
      "GET",
      "/v1/operations/deposit-operation",
      serverOptions,
      origin,
    )).statusCode, 200);
    assert.equal((await resolveBackendHttpResponse(
      "POST",
      "/v1/baskets",
      serverOptions,
      { ...origin, authorization: `Bearer ${"c".repeat(32)}` },
      {},
    )).statusCode, 201);
    assert.deepEqual(calls, [
      "deposit-quote",
      "deposit-intent:deposit-request-1",
      "funding:deposit-operation:funding-request-1",
      "status:deposit-operation",
      "basket",
    ]);
  });

  it("requires idempotency, Composer authentication, and an allowlisted origin", async () => {
    const unreachable = async () => ({ ok: true });
    const serverOptions = {
      ...options(async () => undefined),
      api: {
        financial: {
          createDepositQuote: unreachable,
          createWithdrawalQuote: unreachable,
          submitDepositIntent: unreachable,
          submitWithdrawalIntent: unreachable,
          submitDepositFunding: unreachable,
          getOperation: unreachable,
          createBasket: unreachable,
        },
        composerBearerToken: "c".repeat(32),
        allowedOrigins: new Set(["https://app.alphabasket.test"]),
      },
    };
    assert.equal((await resolveBackendHttpResponse(
      "POST",
      "/v1/intents/deposit",
      serverOptions,
      {},
      {},
    )).statusCode, 400);
    assert.equal((await resolveBackendHttpResponse(
      "POST",
      "/v1/baskets",
      serverOptions,
      {},
      {},
    )).statusCode, 401);
    assert.equal((await resolveBackendHttpResponse(
      "POST",
      "/v1/quotes/deposit",
      serverOptions,
      { origin: "https://evil.example" },
      {},
    )).statusCode, 403);
  });
});
