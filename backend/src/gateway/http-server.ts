import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { z } from "zod";

import type { ExecutionGatewayServicePort } from "./types.js";

const canonicalUnsigned = z.string().regex(/^(?:0|[1-9][0-9]*)$/u).transform(BigInt);
const positiveUnsigned = canonicalUnsigned.refine((value) => value > 0n);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const mode = z.enum(["local", "hybrid_devnet", "production_canary", "production"]);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/u);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const solanaAddress = z.string().min(32).max(64);
const transactionSignature = z.string().min(64).max(128);

const fakSchema = z.object({
  requestHash: hash,
  deploymentMode: mode,
  clientOrderId: z.string().min(40).max(160),
  tokenId: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  side: z.enum(["BUY", "SELL"]),
  negativeRisk: z.boolean(),
  makerAmountUnits: positiveUnsigned,
  takerAmountUnits: positiveUnsigned,
}).strict();
const transferSchema = z.object({
  requestHash: hash,
  deploymentMode: mode,
  idempotencyKey,
  destinationEvmAddress: evmAddress,
  amountUnits: positiveUnsigned,
}).strict();
const splitSchema = z.object({
  requestHash: hash,
  deploymentMode: mode,
  idempotencyKey,
  sourceBridgeTransaction: transactionSignature,
  mint: solanaAddress,
  userDestination: solanaAddress,
  creatorDestination: solanaAddress,
  protocolDestination: solanaAddress,
  userAmountUnits: canonicalUnsigned,
  creatorAmountUnits: canonicalUnsigned,
  protocolAmountUnits: canonicalUnsigned,
}).strict();

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maximumBodyBytes: number): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new GatewayHttpError(415, "content_type_required");
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBodyBytes) {
      throw new GatewayHttpError(413, "body_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maximumBodyBytes) throw new GatewayHttpError(413, "body_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GatewayHttpError(400, "invalid_json");
  }
}

class GatewayHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function createExecutionGatewayHttpServer(options: {
  readonly service: ExecutionGatewayServicePort;
  readonly bearerToken: string;
  readonly maximumBodyBytes?: number;
}) {
  if (options.bearerToken.length < 32 || options.bearerToken.length > 4_096) {
    throw new RangeError("execution gateway bearer token must contain 32-4096 characters");
  }
  const expectedToken = tokenDigest(options.bearerToken);
  const maximumBodyBytes = options.maximumBodyBytes ?? 65_536;
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST") throw new GatewayHttpError(404, "not_found");
      if (request.headers["x-alphabasket-request-version"] !== "1") {
        throw new GatewayHttpError(400, "unsupported_request_version");
      }
      const authorization = request.headers.authorization;
      if (authorization?.startsWith("Bearer ") !== true) {
        throw new GatewayHttpError(401, "unauthorized");
      }
      const supplied = tokenDigest(authorization.slice("Bearer ".length));
      if (!timingSafeEqual(expectedToken, supplied)) {
        throw new GatewayHttpError(401, "unauthorized");
      }
      const raw = await readBody(request, maximumBodyBytes);
      if (request.url === "/v1/polymarket/fak-order") {
        const parsed = fakSchema.safeParse(raw);
        if (!parsed.success) throw new GatewayHttpError(400, "invalid_request");
        writeJson(response, 200, await options.service.signFakOrder(parsed.data));
        return;
      }
      if (request.url === "/v1/polymarket/pusd-transfer") {
        const parsed = transferSchema.safeParse(raw);
        if (!parsed.success) throw new GatewayHttpError(400, "invalid_request");
        writeJson(response, 200, await options.service.transferPusd(parsed.data));
        return;
      }
      if (request.url === "/v1/solana/atomic-split") {
        const parsed = splitSchema.safeParse(raw);
        if (!parsed.success) throw new GatewayHttpError(400, "invalid_request");
        const result = await options.service.splitSolanaUsdc(parsed.data);
        writeJson(response, 200, {
          ...result,
          finalizedSlot: result.finalizedSlot.toString(10),
        });
        return;
      }
      throw new GatewayHttpError(404, "not_found");
    } catch (error) {
      if (error instanceof GatewayHttpError) {
        writeJson(response, error.status, { error: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : "unknown gateway failure";
      process.stderr.write(`${JSON.stringify({
        level: "error",
        message: "execution_gateway_request_failed",
        error: message,
      })}\n`);
      writeJson(response, 503, { error: "execution_unavailable" });
    }
  });
}
