import { z } from "zod";

import { JsonHttpClient } from "../polymarket/http-json.js";
import type { KeySignature, KeySignerPort, KeySigningRequest } from "./types.js";

const base64 = z.string().min(4).max(8_192).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const responseSchema = z.object({
  keyReference: z.string().min(1).max(512),
  algorithm: z.enum(["ed25519", "secp256k1"]),
  publicKeyBase64: base64,
  signatureBase64: base64,
}).strict();

function decodeCanonicalBase64(value: string, name: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`remote signer returned non-canonical ${name}`);
  return Uint8Array.from(decoded);
}

/**
 * Thin client for an internal KMS/HSM signing gateway. The gateway owns cloud
 * credentials and non-exportable keys; this process receives signatures only.
 */
export class HttpKeySigner implements KeySignerPort {
  private readonly baseUrl: string;

  public constructor(
    private readonly http: JsonHttpClient,
    private readonly bearerToken: string,
    options: { readonly baseUrl: string; readonly allowInsecureLocalhost?: boolean },
  ) {
    const parsed = new URL(options.baseUrl);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !(options.allowInsecureLocalhost === true && local)) {
      throw new TypeError("remote signer URL must use HTTPS outside localhost development");
    }
    if (bearerToken.length < 32 || bearerToken.length > 4_096) throw new RangeError("remote signer bearer token must contain 32-4096 characters");
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
  }

  public async sign(request: KeySigningRequest): Promise<KeySignature> {
    if (request.keyReference.length === 0 || request.keyReference.length > 512) throw new RangeError("invalid remote signer key reference");
    if (request.payload.byteLength === 0 || request.payload.byteLength > 8_192) throw new RangeError("remote signing payload must contain 1-8192 bytes");
    const result = await this.http.post(`${this.baseUrl}/v1/sign`, {
      keyReference: request.keyReference,
      algorithm: request.algorithm,
      payloadBase64: Buffer.from(request.payload).toString("base64"),
    }, responseSchema, {
      authorization: `Bearer ${this.bearerToken}`,
      "x-alphabasket-request-version": "1",
    });
    if (result.keyReference !== request.keyReference || result.algorithm !== request.algorithm) {
      throw new Error("remote signer response does not match the signing request");
    }
    return Object.freeze({
      publicKey: decodeCanonicalBase64(result.publicKeyBase64, "public key"),
      signature: decodeCanonicalBase64(result.signatureBase64, "signature"),
    });
  }
}
