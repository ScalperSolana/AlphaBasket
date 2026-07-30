import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { z } from "zod";

import type { SigningAlgorithm } from "../signer/types.js";
import {
  REMOTE_SIGNER_MAXIMUM_PAYLOAD_BYTES,
  REMOTE_SIGNER_REQUEST_VERSION,
  RemoteSignerAccessError,
  type RemoteSignerAuditEvent,
  type RemoteSignerAuditSink,
  type RemoteSignerKeyProvider,
} from "./types.js";

const canonicalBase64 = z.string().min(4).max(16_384).regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
);
const signRequestSchema = z.object({
  keyReference: z.string().min(1).max(512).regex(/^[A-Za-z0-9_.:/-]+$/u),
  algorithm: z.enum(["ed25519", "secp256k1"]),
  payloadBase64: canonicalBase64,
}).strict();

class RemoteSignerHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "RemoteSignerHttpError";
  }
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function payloadDigest(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  requestId: string,
  additionalHeaders: Readonly<Record<string, string>> = {},
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-alphabasket-request-id": requestId,
    "x-content-type-options": "nosniff",
    ...additionalHeaders,
  });
  response.end(encoded);
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBodyBytes: number,
): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new RemoteSignerHttpError(415, "content_type_required");
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 1 || size > maximumBodyBytes) {
      throw new RemoteSignerHttpError(413, "body_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maximumBodyBytes) {
      throw new RemoteSignerHttpError(413, "body_too_large");
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new RemoteSignerHttpError(400, "empty_body");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RemoteSignerHttpError(400, "invalid_json");
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new RemoteSignerHttpError(400, "invalid_request");
  }
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > REMOTE_SIGNER_MAXIMUM_PAYLOAD_BYTES
  ) {
    throw new RemoteSignerHttpError(400, "invalid_payload");
  }
  return Uint8Array.from(decoded);
}

function assertSignatureShape(
  algorithm: SigningAlgorithm,
  publicKey: Uint8Array,
  signature: Uint8Array,
): void {
  if (algorithm === "ed25519") {
    if (publicKey.byteLength !== 32 || signature.byteLength !== 64) {
      throw new Error("key provider returned an invalid Ed25519 signature");
    }
    return;
  }
  if (
    (publicKey.byteLength !== 33 && publicKey.byteLength !== 65) ||
    signature.byteLength !== 65
  ) {
    throw new Error("key provider returned an invalid secp256k1 signature");
  }
}

export class JsonRemoteSignerAuditSink implements RemoteSignerAuditSink {
  public record(event: RemoteSignerAuditEvent): void {
    const level = event.outcome === "failed" ? "error" : "info";
    process.stdout.write(`${JSON.stringify({
      level,
      message: "remote_signer_request",
      requestId: event.requestId,
      keyReference: event.keyReference,
      algorithm: event.algorithm,
      payloadHash: event.payloadHash,
      outcome: event.outcome,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      occurredAt: event.occurredAt.toISOString(),
    })}\n`);
  }
}

export interface RemoteSignerHttpServerOptions {
  readonly provider: RemoteSignerKeyProvider;
  readonly bearerToken: string;
  readonly maximumBodyBytes?: number;
  readonly maximumConcurrentSignatures?: number;
  readonly auditSink?: RemoteSignerAuditSink;
  readonly now?: () => Date;
  readonly requestId?: () => string;
}

export function createRemoteSignerHttpServer(
  options: RemoteSignerHttpServerOptions,
): Server {
  if (options.bearerToken.length < 32 || options.bearerToken.length > 4_096) {
    throw new RangeError(
      "remote signer bearer token must contain 32-4096 characters",
    );
  }
  const expectedToken = tokenDigest(options.bearerToken);
  const maximumBodyBytes = options.maximumBodyBytes ?? 16_384;
  const maximumConcurrentSignatures = options.maximumConcurrentSignatures ?? 16;
  if (
    !Number.isSafeInteger(maximumBodyBytes) ||
    maximumBodyBytes < 1_024 ||
    maximumBodyBytes > 1_048_576
  ) {
    throw new RangeError("remote signer maximum body bytes is invalid");
  }
  if (
    !Number.isSafeInteger(maximumConcurrentSignatures) ||
    maximumConcurrentSignatures < 1 ||
    maximumConcurrentSignatures > 1_024
  ) {
    throw new RangeError("remote signer concurrency limit is invalid");
  }
  const audit = options.auditSink ?? new JsonRemoteSignerAuditSink();
  const now = options.now ?? (() => new Date());
  const createRequestId = options.requestId ?? randomUUID;
  let activeSignatures = 0;

  const server = createServer(async (request, response) => {
    const requestId = createRequestId();
    let keyReference: string | null = null;
    let algorithm: SigningAlgorithm | null = null;
    let hash: string | null = null;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, {
          status: "ok",
          service: "alphabasket-remote-signer",
        }, requestId);
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/sign") {
        throw new RemoteSignerHttpError(404, "not_found");
      }
      if (
        request.headers["x-alphabasket-request-version"] !==
        REMOTE_SIGNER_REQUEST_VERSION
      ) {
        throw new RemoteSignerHttpError(400, "unsupported_request_version");
      }
      const authorization = request.headers.authorization;
      const suppliedToken = authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length)
        : "";
      if (!timingSafeEqual(expectedToken, tokenDigest(suppliedToken))) {
        throw new RemoteSignerHttpError(401, "unauthorized");
      }
      const parsed = signRequestSchema.safeParse(
        await readJsonBody(request, maximumBodyBytes),
      );
      if (!parsed.success) throw new RemoteSignerHttpError(400, "invalid_request");
      keyReference = parsed.data.keyReference;
      algorithm = parsed.data.algorithm;
      const payload = decodeCanonicalBase64(parsed.data.payloadBase64);
      hash = payloadDigest(payload);
      if (activeSignatures >= maximumConcurrentSignatures) {
        throw new RemoteSignerHttpError(429, "signer_busy");
      }
      activeSignatures += 1;
      try {
        const signed = await options.provider.sign({
          keyReference,
          algorithm,
          payload,
        });
        assertSignatureShape(algorithm, signed.publicKey, signed.signature);
        audit.record({
          requestId,
          keyReference,
          algorithm,
          payloadHash: hash,
          outcome: "signed",
          occurredAt: now(),
        });
        writeJson(response, 200, {
          keyReference,
          algorithm,
          publicKeyBase64: Buffer.from(signed.publicKey).toString("base64"),
          signatureBase64: Buffer.from(signed.signature).toString("base64"),
        }, requestId);
      } finally {
        activeSignatures -= 1;
      }
    } catch (error) {
      if (error instanceof RemoteSignerAccessError) {
        audit.record({
          requestId,
          keyReference,
          algorithm,
          payloadHash: hash,
          outcome: "denied",
          occurredAt: now(),
          reason: "policy_denied",
        });
        writeJson(response, 403, { error: "signing_denied" }, requestId);
        return;
      }
      if (error instanceof RemoteSignerHttpError) {
        if (error.status === 401) {
          audit.record({
            requestId,
            keyReference: null,
            algorithm: null,
            payloadHash: null,
            outcome: "denied",
            occurredAt: now(),
            reason: "unauthorized",
          });
        }
        writeJson(
          response,
          error.status,
          { error: error.code },
          requestId,
          error.status === 401 ? { "www-authenticate": "Bearer" } : {},
        );
        return;
      }
      audit.record({
        requestId,
        keyReference,
        algorithm,
        payloadHash: hash,
        outcome: "failed",
        occurredAt: now(),
        reason: "provider_failure",
      });
      process.stderr.write(`${JSON.stringify({
        level: "error",
        message: "remote_signer_provider_failed",
        requestId,
      })}\n`);
      writeJson(response, 503, { error: "signer_unavailable" }, requestId);
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });
  return server;
}
